from __future__ import annotations

import copy
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

from app.infrastructure import auth_sessions as sessions
from app.modules.auth import router as auth
from app.modules.inbox import router as inbox
from app.modules.brainstorm import router as brainstorm
from tests.unit.test_persistent_sessions import TemporarySessionFixture


def socket():
    result = Mock()
    result.accept = AsyncMock(); result.close = AsyncMock(); result.send_json = AsyncMock()
    return result


class SessionSocketRevocationTests(TemporarySessionFixture, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        record, _, _ = sessions.create("alice", 0)
        self.user = {"id": "alice", "status": "ativo", "sessionVersion": 0, "permissions": {"equipe": True}, "_authSession": record["id"]}
        self.directory = {"users": [self.user]}
        active = patch.object(auth, "read_user_store", AsyncMock(side_effect=lambda: copy.deepcopy(self.directory)))
        active.start(); self.addCleanup(active.stop)

    async def test_inbox_broadcast_does_not_deliver_after_session_revocation(self):
        manager, client = inbox.ConnectionManager(), socket()
        await manager.connect("alice", client, self.user)
        sessions.revoke("alice", sid=self.user["_authSession"])
        await manager.broadcast("alice", {"type": "synthetic-private"})
        client.send_json.assert_not_called()
        client.close.assert_awaited_once_with(code=4401)
        self.assertEqual({}, manager.active_connections)

    async def test_brainstorm_broadcast_checks_current_session_and_permissions(self):
        for reason in ("session", "permission", "team"):
            manager, client = brainstorm.BrainstormConnectionManager(), socket()
            await manager.connect("alice", "board", client, self.user)
            if reason == "session":
                sessions.revoke("alice", sid=self.user["_authSession"])
            elif reason == "permission":
                self.directory["users"][0]["permissions"] = {}
            else:
                self.directory["users"][0]["permissions"] = {"equipe": True}
                self.directory["users"][0]["teamOwnerId"] = "another-team"
            await manager.broadcast("alice", "board", {"type": "synthetic-private"})
            client.send_json.assert_not_called()
            client.close.assert_awaited_once_with(code=4401)
            if reason == "session":
                fresh, _, _ = sessions.create("alice", 0)
                self.user["_authSession"] = fresh["id"]

    async def test_revoked_message_is_rejected_before_processing(self):
        client = socket()
        client.receive_text = AsyncMock(return_value="synthetic-mutation")
        sessions.revoke("alice", sid=self.user["_authSession"])
        with self.assertRaises(HTTPException):
            await auth.guarded_socket_receive(client, self.user)
        client.close.assert_awaited_once_with(code=4401)

    async def test_a_received_message_is_revalidated_before_returning(self):
        client = socket()
        client.receive_text = AsyncMock(return_value="synthetic-mutation")
        with patch.object(auth, "revalidate_socket_user", AsyncMock(side_effect=[self.user, HTTPException(401, "revoked")])) as validate:
            with self.assertRaises(HTTPException):
                await auth.guarded_socket_receive(client, self.user)
        self.assertEqual(2, validate.await_count)
        client.close.assert_awaited_once_with(code=4401)
