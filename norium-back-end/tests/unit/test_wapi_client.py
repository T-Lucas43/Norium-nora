from __future__ import annotations

import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.services import wapi_client as wapi_client_module
from app.services.wapi_client import WapiClient, WapiConfig, WapiError, load_wapi_config
from app.modules.chat import router as chat_router


class WapiClientSecurityTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _production_environment(base_url: str) -> dict[str, str]:
        return {
            "APP_ENV": "production",
            "ENVIRONMENT": "production",
            "WAPI_BASE_URL": base_url,
            "WAPI_MASTER_API_KEY": "configuration-secret-must-not-leak",
        }

    def _assert_invalid_base_url(self, base_url: str) -> None:
        secret = "configuration-secret-must-not-leak"
        with patch.dict(os.environ, self._production_environment(base_url), clear=False):
            with self.assertRaisesRegex(RuntimeError, "WAPI_BASE_URL") as error:
                WapiClient()
        public_error = str(error.exception)
        self.assertNotIn(secret, public_error)
        self.assertNotIn(base_url, public_error)

    def test_http_base_url_is_rejected_in_production(self) -> None:
        self._assert_invalid_base_url("http://api.w-api.app")

    def test_unapproved_host_is_rejected_during_startup(self) -> None:
        self._assert_invalid_base_url("https://attacker.example")

    def test_injected_config_cannot_bypass_origin_validation(self) -> None:
        with patch.dict(
            os.environ,
            {"APP_ENV": "production", "ENVIRONMENT": "production"},
            clear=False,
        ):
            with self.assertRaisesRegex(RuntimeError, "WAPI_BASE_URL"):
                WapiClient(
                    WapiConfig(
                        base_url="https://attacker.example",
                        master_api_key="injected-secret",
                        webhook_secret="",
                    )
                )

    def test_embedded_userinfo_is_rejected_without_echoing_it(self) -> None:
        self._assert_invalid_base_url("https://browser-user:browser-password@api.w-api.app")

    def test_deceptive_hostname_is_rejected(self) -> None:
        self._assert_invalid_base_url("https://api.w-api.app.attacker.example")

    def test_unexpected_port_is_rejected(self) -> None:
        self._assert_invalid_base_url("https://api.w-api.app:8443/v1")

    def test_authorized_url_is_normalized_before_use(self) -> None:
        with patch.dict(
            os.environ,
            self._production_environment("HTTPS://API.W-API.APP.:443/v1/"),
            clear=False,
        ):
            config = load_wapi_config()
            client = WapiClient(config)

        self.assertEqual("https://api.w-api.app", config.base_url)
        self.assertEqual("https://api.w-api.app", client.config.base_url)
        self.assertEqual(
            "https://api.w-api.app/v1/instance/status-instance",
            client._url("/instance/status-instance"),
        )

    def test_http_loopback_is_limited_to_explicit_local_tests(self) -> None:
        with patch.dict(
            os.environ,
            {"APP_ENV": "test", "ENVIRONMENT": "test"},
            clear=False,
        ):
            client = WapiClient(
                WapiConfig(
                    base_url="http://127.0.0.1:8765/v1/",
                    master_api_key="test-only-key",
                    webhook_secret="",
                )
            )

        self.assertEqual("http://127.0.0.1:8765", client.config.base_url)

    async def test_cross_origin_redirect_is_rejected_without_forwarding_bearer(self) -> None:
        requests: list[tuple[str, bool]] = []

        def redirect_response(request: httpx.Request) -> httpx.Response:
            requests.append((request.url.host, "authorization" in request.headers))
            return httpx.Response(
                302,
                headers={"Location": "https://attacker.example/collect"},
            )

        transport_client = httpx.AsyncClient(transport=httpx.MockTransport(redirect_response))
        client = WapiClient(
            WapiConfig(
                base_url="https://api.w-api.app",
                master_api_key="",
                webhook_secret="",
            )
        )
        with patch.object(
            wapi_client_module.httpx,
            "AsyncClient",
            return_value=transport_client,
        ) as client_factory:
            with self.assertRaises(WapiError) as error:
                await client.status("INSTANCE", "opaque-test-token")

        self.assertEqual("redirect_not_allowed", error.exception.code)
        self.assertNotIn("opaque-test-token", str(error.exception))
        self.assertEqual([("api.w-api.app", True)], requests)
        client_factory.assert_called_once_with(follow_redirects=False)

    async def test_master_api_key_is_never_placed_in_request_url(self) -> None:
        secret = "master-key-must-not-appear-in-url"
        instances = [
            {"instanceId": "INSTANCE-1", "instanceName": "norium-a", "token": "token-a"},
            {"instanceId": "INSTANCE-2", "instanceName": "norium-b", "token": "token-b"},
        ]
        payloads = (
            {"instances": []},
            {"instances": instances},
            {"data": instances},
            instances,
        )

        for payload in payloads:
            with self.subTest(payload_type=type(payload).__name__, payload=payload):
                requests: list[httpx.Request] = []

                def ok_response(request: httpx.Request) -> httpx.Response:
                    requests.append(request)
                    return httpx.Response(200, json=payload)

                transport_client = httpx.AsyncClient(
                    transport=httpx.MockTransport(ok_response)
                )
                client = WapiClient(
                    WapiConfig(
                        base_url="https://api.w-api.app",
                        master_api_key=secret,
                        webhook_secret="",
                    )
                )
                with patch.object(
                    wapi_client_module.httpx,
                    "AsyncClient",
                    return_value=transport_client,
                ):
                    result = await client.list_instances()

                self.assertEqual(payload, result)
                self.assertEqual(1, len(requests))
                request = requests[0]
                self.assertEqual("GET", request.method)
                self.assertEqual(
                    "https://api.w-api.app/v1/client/list-instances",
                    str(request.url),
                )
                self.assertEqual({}, dict(request.url.params))
                self.assertNotIn(secret, str(request.url))
                self.assertEqual(
                    f"Bearer {secret}",
                    request.headers.get("Authorization"),
                )

    async def test_list_instances_authentication_error_is_safe(self) -> None:
        secret = "master-key-must-not-leak-on-auth-error"
        requests: list[httpx.Request] = []

        def rejected_response(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                401,
                json={"message": f"invalid bearer {secret}"},
            )

        transport_client = httpx.AsyncClient(
            transport=httpx.MockTransport(rejected_response)
        )
        client = WapiClient(
            WapiConfig(
                base_url="https://api.w-api.app",
                master_api_key=secret,
                webhook_secret="",
            )
        )
        with (
            patch.object(
                wapi_client_module.httpx,
                "AsyncClient",
                return_value=transport_client,
            ),
            self.assertLogs(wapi_client_module.logger.name, level="WARNING") as logs,
        ):
            with self.assertRaises(WapiError) as error:
                await client.list_instances()

        self.assertEqual(401, error.exception.status)
        self.assertEqual(1, len(requests))
        request = requests[0]
        self.assertEqual(
            "https://api.w-api.app/v1/client/list-instances",
            str(request.url),
        )
        self.assertEqual({}, dict(request.url.params))
        self.assertNotIn(secret, str(request.url))
        self.assertEqual(
            f"Bearer {secret}",
            request.headers.get("Authorization"),
        )
        self.assertNotIn(secret, str(error.exception))
        self.assertNotIn(secret, "\n".join(logs.output))

    async def test_provider_error_does_not_echo_instance_token(self) -> None:
        secret = "instance-token-must-not-leak"

        def rejected_response(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"message": f"invalid bearer {secret}"})

        transport_client = httpx.AsyncClient(transport=httpx.MockTransport(rejected_response))
        client = WapiClient(
            WapiConfig(
                base_url="https://api.w-api.app",
                master_api_key="",
                webhook_secret="",
            )
        )
        with patch.object(wapi_client_module.httpx, "AsyncClient", return_value=transport_client):
            with self.assertRaises(WapiError) as error:
                await client.status("INSTANCE", secret)

        self.assertNotIn(secret, str(error.exception))

    async def test_network_error_does_not_retain_or_log_bearer(self) -> None:
        secret = "network-token-must-not-leak"

        def failed_request(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError(f"internal failure for {secret}", request=request)

        transport_client = httpx.AsyncClient(transport=httpx.MockTransport(failed_request))
        client = WapiClient(
            WapiConfig(
                base_url="https://api.w-api.app",
                master_api_key="",
                webhook_secret="",
            )
        )
        with (
            patch.object(wapi_client_module.httpx, "AsyncClient", return_value=transport_client),
            self.assertLogs(wapi_client_module.logger.name, level="WARNING") as logs,
        ):
            with self.assertRaises(WapiError) as error:
                await client.send_text("INSTANCE", secret, "5511999999999", "hello")

        self.assertNotIn(secret, str(error.exception))
        self.assertNotIn(secret, "\n".join(logs.output))
        self.assertIsNone(error.exception.__cause__)
        self.assertIsNone(error.exception.__context__)


class WapiClientContactContractTests(unittest.IsolatedAsyncioTestCase):
    """Trava os caminhos/params de contatos verificados ao vivo (/contacts/*, phoneNumber)."""

    def setUp(self) -> None:
        self.client = WapiClient()
        self._request = AsyncMock(return_value={})
        self._patch = patch.object(self.client, "_request", self._request)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    async def test_phone_exists_path_and_param(self) -> None:
        await self.client.phone_exists("INST", "tok", "5511999998888")
        args = self._request.await_args.args
        kwargs = self._request.await_args.kwargs
        self.assertEqual("GET", args[0])
        self.assertEqual("/contacts/phone-exists", args[1])
        self.assertEqual({"phoneNumber": "5511999998888"}, kwargs["params"])

    async def test_fetch_contacts_path(self) -> None:
        await self.client.fetch_contacts("INST", "tok")
        self.assertEqual("/contacts/fetch-contacts", self._request.await_args.args[1])

    async def test_qr_code_enables_contact_sync(self) -> None:
        await self.client.qr_code("INST", "tok")
        self.assertEqual("/instance/qr-code", self._request.await_args.args[1])
        self.assertEqual({"syncContacts": "enable"}, self._request.await_args.kwargs["params"])

    async def test_pairing_code_uses_phone_number_and_enables_contact_sync(self) -> None:
        await self.client.pairing_code("INST", "tok", "5511999998888")
        self.assertEqual("/instance/pairing-code", self._request.await_args.args[1])
        self.assertEqual(
            {"phoneNumber": "5511999998888", "syncContacts": "enable"},
            self._request.await_args.kwargs["params"],
        )

    async def test_profile_picture_path_and_param(self) -> None:
        await self.client.contact_profile_picture("INST", "tok", "5511999998888")
        args = self._request.await_args.args
        kwargs = self._request.await_args.kwargs
        self.assertEqual("/contacts/profile-picture", args[1])
        self.assertEqual({"phoneNumber": "5511999998888"}, kwargs["params"])

    async def test_block_contact_path_and_body(self) -> None:
        await self.client.block_contact("INST", "tok", "5511999998888", True)
        args = self._request.await_args.args
        kwargs = self._request.await_args.kwargs
        self.assertEqual("POST", args[0])
        self.assertEqual("/contacts/block-contact", args[1])
        self.assertEqual({"phoneNumber": "5511999998888", "blockStatus": True}, kwargs["json_body"])

    async def test_router_sends_plain_number_to_profile_picture(self) -> None:
        profile = AsyncMock(return_value={"link": "https://cdn.example/avatar.jpg"})
        with (
            patch.object(chat_router, "wapi_creds", return_value=("INST", "tok")),
            patch.object(chat_router.wapi_client, "contact_profile_picture", profile),
        ):
            result = await chat_router.fetch_profile_picture("user-a", "5511999999999@c.us")
        self.assertEqual("https://cdn.example/avatar.jpg", result)
        self.assertEqual("5511999999999", profile.await_args.args[2])

    async def test_list_groups_uses_official_path(self) -> None:
        await self.client.get_all_groups("INST", "tok")
        self.assertEqual("GET", self._request.await_args.args[0])
        self.assertEqual("/group/get-all-groups", self._request.await_args.args[1])

    async def test_create_group_uses_official_body(self) -> None:
        await self.client.create_group(
            "INST",
            "tok",
            "Equipe",
            ["5511999999999"],
            profile_picture_url="https://cdn.example/group.jpg",
            auto_invite=False,
        )
        self.assertEqual("/group/create-group", self._request.await_args.args[1])
        self.assertEqual(
            {
                "groupName": "Equipe",
                "participants": ["5511999999999"],
                "profilePictureUrl": "https://cdn.example/group.jpg",
                "autoInvite": False,
            },
            self._request.await_args.kwargs["json_body"],
        )

    async def test_delete_message_uses_official_query_contract(self) -> None:
        await self.client.delete_message("INST", "tok", "5511999999999", "MSG-1")
        args = self._request.await_args.args
        kwargs = self._request.await_args.kwargs
        self.assertEqual("DELETE", args[0])
        self.assertEqual("/message/delete-message", args[1])
        self.assertEqual({"phone": "5511999999999", "messageId": "MSG-1"}, kwargs["params"])
        self.assertNotIn("json_body", kwargs)

    async def test_group_participants_uses_published_case_sensitive_path(self) -> None:
        await self.client.group_participants("INST", "tok", "120363000000000000@g.us")
        args = self._request.await_args.args
        kwargs = self._request.await_args.kwargs
        self.assertEqual("GET", args[0])
        self.assertEqual("/group/get-Participants", args[1])
        self.assertEqual({"groupId": "120363000000000000@g.us"}, kwargs["params"])

    async def test_message_status_webhook_uses_official_put_contract(self) -> None:
        await self.client.set_webhook(
            "INST",
            "tok",
            "message-status",
            "https://api.norium.example/api/whatsapp/webhook?secret=hook",
        )
        args = self._request.await_args.args
        kwargs = self._request.await_args.kwargs
        self.assertEqual("PUT", args[0])
        self.assertEqual("/webhook/update-webhook-message-status", args[1])
        self.assertEqual("INST", kwargs["instance_id"])
        self.assertEqual(
            {"value": "https://api.norium.example/api/whatsapp/webhook?secret=hook"},
            kwargs["json_body"],
        )

    async def test_chat_presence_webhook_uses_official_path(self) -> None:
        await self.client.set_webhook(
            "INST",
            "tok",
            "chat-presence",
            "https://api.norium.example/api/whatsapp/webhook",
        )
        self.assertEqual("PUT", self._request.await_args.args[0])
        self.assertEqual("/webhook/update-webhook-chat-presence", self._request.await_args.args[1])


    async def test_media_view_once_uses_wapi_boolean_contract(self) -> None:
        await self.client.send_media(
            "INST",
            "tok",
            "image",
            "5511999999999",
            "data:image/png;base64,AAAA",
            view_once=True,
        )

        body = self._request.await_args.kwargs["json_body"]
        self.assertIs(body["viewOnce"], True)


if __name__ == "__main__":
    unittest.main()
