from __future__ import annotations

import hashlib
import hmac
import os
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

from app.modules.chat import router as chat_router


def chat_user(user_id: str) -> dict:
    return {
        "id": user_id,
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"chat": True, "integracao_whatsapp": True},
    }


class _StreamingResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        chunks: list[bytes] | None = None,
        enter_error: Exception | None = None,
        read_error: Exception | None = None,
    ) -> None:
        self.status_code = status_code
        self.headers = headers or {}
        self.chunks = chunks or []
        self.enter_error = enter_error
        self.read_error = read_error
        self.entered = False
        self.exited = False
        self.iterated_chunks = 0

    async def __aenter__(self) -> "_StreamingResponse":
        if self.enter_error is not None:
            raise self.enter_error
        self.entered = True
        return self

    async def __aexit__(self, *_args: object) -> None:
        self.exited = True

    async def aiter_bytes(self):
        for chunk in self.chunks:
            self.iterated_chunks += 1
            yield chunk
        if self.read_error is not None:
            raise self.read_error


class _StreamingClient:
    def __init__(self, *responses: _StreamingResponse) -> None:
        self.responses = list(responses)
        self.stream_calls: list[tuple[str, str, dict[str, object]]] = []
        self.entered = False
        self.exited = False

    async def __aenter__(self) -> "_StreamingClient":
        self.entered = True
        return self

    async def __aexit__(self, *_args: object) -> None:
        self.exited = True

    def stream(self, method: str, url: str, **kwargs: object) -> _StreamingResponse:
        self.stream_calls.append((method, url, kwargs))
        if not self.responses:
            raise AssertionError("A politica tentou abrir um segundo stream inesperado.")
        return self.responses.pop(0)


class RemoteMediaPolicyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        registry = getattr(chat_router, "remote_media_registry", None)
        if isinstance(registry, dict):
            registry.clear()

    def tearDown(self) -> None:
        registry = getattr(chat_router, "remote_media_registry", None)
        if isinstance(registry, dict):
            registry.clear()

    @staticmethod
    def _public_dns() -> list[tuple[object, ...]]:
        return [
            (
                chat_router.socket.AF_INET,
                chat_router.socket.SOCK_STREAM,
                6,
                "",
                ("93.184.216.34", 443),
            )
        ]

    async def _fetch(
        self,
        response: _StreamingResponse,
        *,
        temp_dir: Path,
        connect_timeout: float = 2.5,
        read_timeout: float = 7.5,
    ) -> tuple[object, _StreamingClient, dict[str, object]]:
        client = _StreamingClient(response)
        client_options: dict[str, object] = {}

        def make_client(**options: object) -> _StreamingClient:
            client_options.update(options)
            return client

        with (
            patch.object(chat_router, "WHATSAPP_MEDIA_HOSTS", {"cdn.w-api.app"}),
            patch.object(chat_router.socket, "getaddrinfo", return_value=self._public_dns()),
            patch.object(chat_router.httpx, "AsyncClient", side_effect=make_client),
            patch.object(chat_router, "REMOTE_MEDIA_TEMP_DIR", temp_dir),
        ):
            result = await chat_router.fetch_external_whatsapp_media(
                "https://cdn.w-api.app/media/photo.jpg",
                connect_timeout=connect_timeout,
                read_timeout=read_timeout,
            )
        return result, client, client_options

    async def test_arbitrary_public_host_is_rejected_before_network_access(self) -> None:
        with patch.object(chat_router, "WHATSAPP_MEDIA_HOSTS", {"cdn.w-api.app"}):
            with self.assertRaises(HTTPException) as error:
                chat_router.validate_external_media_url("https://public.example/media.jpg")

        self.assertEqual(400, error.exception.status_code)
        self.assertEqual("Origem de midia nao autorizada.", error.exception.detail)

    async def test_media_id_is_opaque_and_scoped_to_the_authenticated_tenant(self) -> None:
        source = "https://cdn.w-api.app/media/photo.jpg?token=provider-secret"
        with patch.object(chat_router, "WHATSAPP_MEDIA_HOSTS", {"cdn.w-api.app"}):
            media_id = chat_router.register_remote_media("owner", source)
            proxy_url = chat_router.proxied_media_url(source, "owner")

        parsed = urlparse(proxy_url)
        query = parse_qs(parsed.query)
        self.assertEqual([media_id], query.get("media_id"))
        self.assertNotIn("url", query)
        self.assertNotIn("cdn.w-api.app", proxy_url)
        self.assertNotIn("provider-secret", proxy_url)
        self.assertEqual(source, chat_router.resolve_remote_media("owner", media_id))
        with self.assertRaises(HTTPException) as error:
            chat_router.resolve_remote_media("other-tenant", media_id)
        self.assertEqual(404, error.exception.status_code)
        self.assertEqual("Midia indisponivel no WhatsApp.", error.exception.detail)

    async def test_private_reserved_and_metadata_urls_are_rejected_without_network(self) -> None:
        blocked = (
            "https://127.0.0.1/media.jpg",
            "https://10.0.0.8/media.jpg",
            "https://169.254.169.254/latest/meta-data",
            "https://192.168.1.20/media.jpg",
            "https://[::1]/media.jpg",
        )
        allowed_for_test = {"127.0.0.1", "10.0.0.8", "169.254.169.254", "192.168.1.20", "::1"}
        with patch.object(chat_router, "WHATSAPP_MEDIA_HOSTS", allowed_for_test):
            for source in blocked:
                with self.subTest(source=source), self.assertRaises(HTTPException) as error:
                    chat_router.register_remote_media("owner", source)
                self.assertEqual(400, error.exception.status_code)
                self.assertEqual("Origem de midia nao autorizada.", error.exception.detail)

    async def test_hostname_resolving_to_private_ip_is_rejected_before_stream(self) -> None:
        private_dns = [
            (
                chat_router.socket.AF_INET,
                chat_router.socket.SOCK_STREAM,
                6,
                "",
                ("10.20.30.40", 443),
            )
        ]
        client_factory = AsyncMock()
        with (
            patch.object(chat_router, "WHATSAPP_MEDIA_HOSTS", {"cdn.w-api.app"}),
            patch.object(chat_router.socket, "getaddrinfo", return_value=private_dns),
            patch.object(chat_router.httpx, "AsyncClient", client_factory),
        ):
            with self.assertRaises(HTTPException) as error:
                await chat_router.fetch_external_whatsapp_media(
                    "https://cdn.w-api.app/media/photo.jpg",
                    connect_timeout=2.5,
                    read_timeout=7.5,
                )

        self.assertEqual(400, error.exception.status_code)
        self.assertEqual("Origem de midia nao autorizada.", error.exception.detail)
        client_factory.assert_not_called()

    async def test_redirect_is_rejected_without_opening_a_second_stream(self) -> None:
        response = _StreamingResponse(
            status_code=302,
            headers={"Location": "https://cdn.w-api.app/media/redirected.jpg"},
        )
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(HTTPException) as error:
                await self._fetch(response, temp_dir=Path(directory))
            self.assertEqual([], list(Path(directory).iterdir()))

        self.assertEqual(404, error.exception.status_code)
        self.assertEqual("Midia indisponivel no WhatsApp.", error.exception.detail)
        self.assertEqual(0, response.iterated_chunks)
        self.assertTrue(response.exited)

    async def test_content_length_over_limit_is_rejected_before_body_iteration(self) -> None:
        response = _StreamingResponse(
            headers={
                "Content-Type": "image/jpeg",
                "Content-Length": str(chat_router.MAX_UPLOAD_BYTES + 1),
            },
            chunks=[b"must-not-be-read"],
        )
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(HTTPException) as error:
                await self._fetch(response, temp_dir=Path(directory))
            self.assertEqual([], list(Path(directory).iterdir()))

        self.assertEqual(413, error.exception.status_code)
        self.assertEqual("Midia acima do limite permitido.", error.exception.detail)
        self.assertEqual(0, response.iterated_chunks)

    async def test_missing_content_length_stops_on_first_chunk_over_limit_and_cleans_temp(self) -> None:
        response = _StreamingResponse(
            headers={"Content-Type": "image/jpeg"},
            chunks=[b"abc", b"def", b"must-not-be-read"],
        )
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(chat_router, "MAX_UPLOAD_BYTES", 5),
                self.assertRaises(HTTPException) as error,
            ):
                await self._fetch(response, temp_dir=Path(directory))
            self.assertEqual([], list(Path(directory).iterdir()))

        self.assertEqual(413, error.exception.status_code)
        self.assertEqual("Midia acima do limite permitido.", error.exception.detail)
        self.assertEqual(2, response.iterated_chunks)
        self.assertTrue(response.exited)

    async def test_invalid_mime_is_rejected_before_body_iteration(self) -> None:
        response = _StreamingResponse(
            headers={"Content-Type": "text/html", "Content-Length": "12"},
            chunks=[b"<html></html>"],
        )
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(HTTPException) as error:
                await self._fetch(response, temp_dir=Path(directory))
            self.assertEqual([], list(Path(directory).iterdir()))

        self.assertEqual(415, error.exception.status_code)
        self.assertEqual("Tipo de midia nao permitido.", error.exception.detail)
        self.assertEqual(0, response.iterated_chunks)

    async def test_connect_and_read_timeouts_have_the_same_stable_public_response(self) -> None:
        timeout_cases = (
            _StreamingResponse(
                enter_error=httpx.ConnectTimeout("internal connect details"),
            ),
            _StreamingResponse(
                headers={"Content-Type": "image/jpeg"},
                chunks=[b"partial"],
                read_error=httpx.ReadTimeout("internal read details"),
            ),
        )
        for response in timeout_cases:
            with self.subTest(error=type(response.enter_error or response.read_error).__name__):
                with tempfile.TemporaryDirectory() as directory:
                    with self.assertRaises(HTTPException) as error:
                        await self._fetch(response, temp_dir=Path(directory))
                    self.assertEqual([], list(Path(directory).iterdir()))
                self.assertEqual(404, error.exception.status_code)
                self.assertEqual("Midia indisponivel no WhatsApp.", error.exception.detail)
                self.assertNotIn("internal", str(error.exception.detail).lower())

    async def test_valid_download_streams_chunks_with_explicit_timeouts_and_cleanup(self) -> None:
        payload = b"\xff\xd8\xffvalid-image"
        response = _StreamingResponse(
            headers={"Content-Type": "image/jpeg", "Content-Length": str(len(payload))},
            chunks=[payload[:4], payload[4:]],
        )
        with tempfile.TemporaryDirectory() as directory:
            result, client, client_options = await self._fetch(response, temp_dir=Path(directory))
            self.assertEqual(payload, result.path.read_bytes())
            self.assertEqual("image/jpeg", result.mime_type)
            self.assertEqual(len(payload), result.size)
            self.assertEqual([("GET", "https://cdn.w-api.app/media/photo.jpg", {})], client.stream_calls)
            timeout = client_options.get("timeout")
            self.assertIsInstance(timeout, httpx.Timeout)
            self.assertEqual(2.5, timeout.connect)
            self.assertEqual(7.5, timeout.read)
            self.assertFalse(client_options.get("follow_redirects"))
            self.assertFalse(client_options.get("trust_env"))
            self.assertTrue(response.exited)
            result.cleanup()
            self.assertFalse(result.path.exists())
            self.assertEqual([], list(Path(directory).iterdir()))

    async def test_browser_url_is_not_authority_for_media_proxy(self) -> None:
        fetch = AsyncMock()
        with (
            patch.object(chat_router, "WHATSAPP_MEDIA_HOSTS", {"cdn.w-api.app"}),
            patch.object(chat_router, "fetch_external_whatsapp_media", fetch),
        ):
            with self.assertRaises(HTTPException) as error:
                await chat_router.media_proxy(
                    media_id=None,
                    url="https://cdn.w-api.app/media/unregistered.jpg",
                    user=chat_user("owner"),
                )

        self.assertEqual(400, error.exception.status_code)
        self.assertEqual("Origem de midia nao autorizada.", error.exception.detail)
        fetch.assert_not_awaited()

    async def test_media_proxy_downloads_a_registered_opaque_media_id(self) -> None:
        source = "https://cdn.w-api.app/media/registered.jpg"
        payload = b"\xff\xd8\xffregistered-image"
        with tempfile.TemporaryDirectory() as directory:
            artifact_path = Path(directory) / "registered.jpg"
            artifact_path.write_bytes(payload)
            artifact = chat_router.DownloadedRemoteMedia(
                path=artifact_path,
                mime_type="image/jpeg",
                size=len(payload),
            )
            fetch = AsyncMock(return_value=artifact)
            with (
                patch.object(chat_router, "WHATSAPP_MEDIA_HOSTS", {"cdn.w-api.app"}),
                patch.object(chat_router, "fetch_external_whatsapp_media", fetch),
            ):
                media_id = chat_router.register_remote_media("owner", source)
                response = await chat_router.media_proxy(
                    url=None,
                    media_id=media_id,
                    user=chat_user("owner"),
                )

            self.assertFalse(artifact_path.exists())

        self.assertEqual(payload, response.body)
        self.assertEqual("image/jpeg", response.media_type)
        fetch.assert_awaited_once_with(
            source,
            connect_timeout=5.0,
            read_timeout=25.0,
        )


class ChatSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_chat_details_uses_contact_catalog_and_persists_conversation(self) -> None:
        conversation_id = "5511999999999@c.us"
        catalog = {
            "contacts": [{
                "id": conversation_id,
                "phone": "5511999999999",
                "pushname": "Joao da Silva",
                "profilePictureUrl": "https://example.test/avatar.jpg",
            }]
        }
        save = AsyncMock()

        with (
            patch.object(chat_router, "load_conversations", AsyncMock(return_value={})),
            patch.object(chat_router, "load_whatsapp_catalog_cache", AsyncMock(return_value=catalog)),
            patch.object(chat_router, "save_conversations", save),
            patch.object(chat_router, "wapi_creds", return_value=None),
        ):
            result = await chat_router.obter_detalhes_conversa(conversation_id, chat_user("owner"))

        self.assertEqual("Joao da Silva", result["contato"])
        self.assertEqual("https://example.test/avatar.jpg", result["photoUrl"])
        self.assertEqual("5511999999999", result["metadados"]["numeroCompleto"])
        save.assert_awaited_once()

    async def test_media_proxy_rejects_untrusted_host_before_network_access(self) -> None:
        with self.assertRaises(HTTPException) as error:
            await chat_router.media_proxy("https://example.invalid/private", chat_user("owner"))
        self.assertEqual(400, error.exception.status_code)

    async def test_whatsapp_webhook_rejects_unknown_instance(self) -> None:
        # Modelo W-API: o dono e resolvido pelo instanceId (mapa seguro). Uma
        # instancia desconhecida nao pode entregar eventos e nao revela existencia.
        with patch.dict(os.environ, {"ENVIRONMENT": "test", "APP_ENV": "test"}), patch.object(
            chat_router,
            "WAPI_WEBHOOK_SECRET",
            "",
        ):
            with self.assertRaises(HTTPException) as error:
                await chat_router.webhook_whatsapp(
                    {
                        "event": "webhookReceived",
                        "instanceId": "INSTANCIA-DESCONHECIDA",
                        "phone": "5511999999999@c.us",
                    },
                )
        self.assertEqual(404, error.exception.status_code)

    async def test_two_authenticated_users_receive_only_their_own_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(os.environ, {"NORIUM_DATA_DIR": temp_dir}):
            # Simula lixo persistido por uma versão antiga; a leitura deve limpar.
            stores: dict[str, dict] = {
                "user-a": {"status@broadcast": {"id": "status@broadcast"}},
                "user-b": {"status@broadcast": {"id": "status@broadcast"}},
            }

            async def load(user_id: str) -> dict:
                return stores.setdefault(user_id, {})

            async def save(payload: dict, user_id: str) -> None:
                stores[user_id] = payload

            async def fetch_chats(instance_id: str, token: str, **_kwargs):
                # O catalogo depende da instancia (isolada por conta), nao do userId.
                now = int(chat_router.time.time())
                return {"chats": [
                    {
                        "id": f"chat-{instance_id}@c.us",
                        "phone": f"chat-{instance_id}@c.us",
                        "name": f"Contato {instance_id}",
                        "timestamp": now,
                        "messages": [{
                            "id": f"message-{instance_id}",
                            "timestamp": now,
                            "content": "oi",
                            "type": "chat",
                            "fromMe": False,
                        }],
                    },
                    {
                        "id": "status@broadcast",
                        "phone": "status@broadcast",
                        "name": "Status",
                        "timestamp": now,
                    },
                ]}

            async def fetch_contacts(instance_id: str, token: str, **_kwargs):
                return {"contacts": []}

            with (
                patch.object(
                    chat_router,
                    "wapi_creds",
                    side_effect=lambda user_id: {
                        "user-a": ("inst-a", "t-a"),
                        "user-b": ("inst-b", "t-b"),
                    }.get(user_id),
                ),
                patch.object(chat_router.wapi_connect, "status", AsyncMock(return_value={"status": "conectado"})),
                patch.object(chat_router.wapi_client, "fetch_chats", side_effect=fetch_chats) as chats_request,
                patch.object(chat_router.wapi_client, "fetch_contacts", side_effect=fetch_contacts),
                patch.object(chat_router, "load_conversations", side_effect=load),
                patch.object(chat_router, "save_conversations", side_effect=save),
                patch.object(chat_router, "should_try_profile_picture", return_value=False),
            ):
                # A listagem interativa agora e cache-first e nunca espera a
                # W-API. Executa os dois workers, como ocorreria em background,
                # antes de validar que cada conta recebeu apenas seu catalogo.
                sync_a = await chat_router._run_contact_sync("user-a")
                sync_b = await chat_router._run_contact_sync("user-b")
                self.assertEqual("complete", sync_a["status"], sync_a)
                self.assertEqual("complete", sync_b["status"], sync_b)
                self.assertIn("chat-inst-a@c.us", stores["user-a"], stores["user-a"])
                self.assertIn("chat-inst-b@c.us", stores["user-b"], stores["user-b"])
                catalog_a = await chat_router.obter_conversas(
                    user_id="user-b", since=None, limit=100, refresh=False, user=chat_user("user-a")
                )
                catalog_b = await chat_router.obter_conversas(
                    user_id="user-a", since=None, limit=100, refresh=False, user=chat_user("user-b")
                )

        self.assertEqual(
            [("inst-a", "t-a"), ("inst-b", "t-b")],
            [request.args for request in chats_request.await_args_list],
        )
        self.assertEqual({"chat-inst-a@c.us"}, {item["id"] for item in catalog_a})
        self.assertEqual({"chat-inst-b@c.us"}, {item["id"] for item in catalog_b})
        self.assertNotIn("chat-inst-b@c.us", stores["user-a"])
        self.assertNotIn("chat-inst-a@c.us", stores["user-b"])
        self.assertNotIn("status@broadcast", stores["user-a"])
        self.assertNotIn("status@broadcast", stores["user-b"])

    async def test_local_chat_upload_is_scoped_to_authenticated_user(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            owner_dir = root / "owner"
            owner_dir.mkdir(parents=True)
            (owner_dir / "arquivo.txt").write_text("privado", encoding="utf-8")

            with patch.object(chat_router, "UPLOAD_DIR", root):
                with self.assertRaises(HTTPException) as error:
                    await chat_router.obter_upload_local("arquivo.txt", {"id": "intruso"})
        self.assertEqual(404, error.exception.status_code)


if __name__ == "__main__":
    unittest.main()
