from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app.services.wapi_client import WapiClient


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


if __name__ == "__main__":
    unittest.main()
