from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app.services.wapi_client import WapiClient
from app.modules.chat import router as chat_router


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


if __name__ == "__main__":
    unittest.main()
