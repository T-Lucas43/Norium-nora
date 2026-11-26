import unittest
import tempfile
import os
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from app.modules.chat import router
from app.modules.chat import private_history
from app.modules.chat import message_state
from app.services import evolution_history

REMOTE = "5511999990000@s.whatsapp.net"


def record(identifier, timestamp=100, cid=REMOTE):
    return {"key": {"id": identifier, "remoteJid": cid, "fromMe": False}, "messageTimestamp": timestamp,
            "messageType": "conversation", "message": {"conversation": "Synthetic text"}, "status": "DELIVERY_ACK"}


class PrivateHistoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": temporary.name})
        environment.start(); self.addCleanup(environment.stop)
        self.binding = SimpleNamespace(exists=True, instance_id="synthetic-instance", created_at=1)
        for active in (patch.object(router, "is_evolution", return_value=True),
                       patch.object(router, "wapi_owned_binding", return_value=self.binding),
                       patch.object(private_history.evolution_data, "database_configured", return_value=True)):
            active.start(); self.addCleanup(active.stop)

    async def test_reads_beyond_snapshot_with_equal_timestamp_cursor(self):
        records = [record(f"m{index:04d}") for index in range(750)]
        snapshot = {"id": REMOTE, "mensagens": [{"id": f"m{index:04d}", "timestamp": 100, "texto": "Synthetic cached"} for index in range(500, 750)]}
        def read(*args, before, before_id, limit):
            eligible = [row for row in records if (row["messageTimestamp"], row["key"]["id"]) < (before, before_id)]
            eligible.sort(key=lambda row: (row["messageTimestamp"], row["key"]["id"]), reverse=True)
            return {"records": eligible[:limit], "hasMore": len(eligible) > limit}
        seen = []
        before, before_id = 101, "z"
        with patch.object(evolution_history, "page", side_effect=read):
            for _ in range(20):
                result = await private_history.page(router, "owner", REMOTE, snapshot, before=before, before_id=before_id, limit=50)
                seen.extend(row["id"] for row in result["items"])
                if not result["hasMore"]:
                    break
                before, before_id = result["cursor"], result["cursorId"]
        self.assertEqual(750, len(seen))
        self.assertEqual(750, len(set(seen)))
        self.assertEqual({row["key"]["id"] for row in records}, set(seen))
        self.assertEqual(250, len(snapshot["mensagens"]))

    async def test_rotation_discards_late_page_and_reference(self):
        def rotate(*args, **kwargs):
            router.wapi_owned_binding.return_value = SimpleNamespace(exists=True, instance_id="synthetic-instance", created_at=2)
            return {"records": [record("m1")], "hasMore": False}
        with patch.object(evolution_history, "page", side_effect=rotate):
            with self.assertRaises(HTTPException) as denied:
                await private_history.page(router, "owner", REMOTE, {}, before=101, before_id="z", limit=50)
        self.assertEqual(404, denied.exception.status_code)

    async def test_reference_normalized_and_wrong_conversation_rejected(self):
        with patch.object(evolution_history, "reference", return_value=record("old")):
            result = await private_history.reference(router, "owner", "old", REMOTE)
            self.assertEqual((REMOTE, "old"), (result[0], result[1]["id"]))
            self.assertEqual("Synthetic text", result[1]["texto"])
            self.assertIsNone(await private_history.reference(router, "owner", "old", "foreign@g.us"))

    async def test_database_failure_is_retryable_not_false_end_of_history(self):
        with patch.object(evolution_history, "page", side_effect=RuntimeError("Synthetic unavailable")):
            with self.assertRaises(HTTPException) as unavailable:
                await private_history.page(router, "owner", REMOTE, {}, before=100, before_id="z", limit=50)
        self.assertEqual(503, unavailable.exception.status_code)

    async def test_unconfigured_uses_existing_api_without_database_calls(self):
        with patch.object(private_history.evolution_data, "database_configured", return_value=False), patch.object(evolution_history, "page") as read:
            self.assertIsNone(await private_history.page(router, "owner", REMOTE, {}, before=100, before_id="z", limit=50))
            read.assert_not_called()

    async def test_visibility_and_reactions_are_binding_and_account_scoped(self):
        message_state.update(router, "owner", REMOTE, "hidden", {"hidden": True})
        message_state.update(router, "owner", REMOTE, "visible", {"reacoes": [{"emoji": "👍", "count": 1, "fromMe": True}]})
        with patch.object(evolution_history, "page", return_value={"records": [record("visible"), record("hidden")], "hasMore": False}):
            result = await private_history.page(router, "owner", REMOTE, {}, before=101, before_id="z", limit=50)
            self.assertEqual(["visible"], [row["id"] for row in result["items"]])
            self.assertEqual("👍", result["items"][0]["reacoes"][0]["emoji"])
        with patch.object(evolution_history, "reference", return_value=record("hidden")):
            self.assertIsNone(await private_history.reference(router, "owner", "hidden", REMOTE))
            self.assertIsNotNone(await private_history.reference(router, "other", "hidden", REMOTE))
            router.wapi_owned_binding.return_value = SimpleNamespace(exists=True, instance_id="synthetic-instance", created_at=2)
            self.assertIsNotNone(await private_history.reference(router, "owner", "hidden", REMOTE))

    async def test_hidden_page_still_advances_cursor(self):
        message_state.update(router, "owner", REMOTE, "m1", {"hidden": True})
        with patch.object(evolution_history, "page", return_value={"records": [record("m1")], "hasMore": True}):
            result = await private_history.page(router, "owner", REMOTE, {}, before=101, before_id="z", limit=1)
        self.assertEqual([], result["items"])
        self.assertEqual((100, "m1", True), (result["cursor"], result["cursorId"], result["hasMore"]))

    async def test_provider_deleted_message_never_reveals_old_body_or_media(self):
        deleted = {**record("deleted"), "status": "DELETED", "message": {"conversation": "must not be visible"}}
        with patch.object(evolution_history, "page", return_value={"records": [deleted], "hasMore": False}):
            result = await private_history.page(router, "owner", REMOTE, {"mensagens": [{"id": "deleted", "timestamp": 100, "texto": "stale cache"}]}, before=101, before_id="z", limit=50)
        self.assertEqual("[Mensagem apagada]", result["items"][0]["texto"])
        self.assertNotIn("must not be visible", str(result))
        with patch.object(evolution_history, "reference", return_value=deleted):
            self.assertIsNone(await private_history.reference(router, "owner", "deleted", REMOTE))


class QueryContractTests(unittest.TestCase):
    def test_sql_is_parameterized_instance_conversation_and_cursor_scoped(self):
        calls = []
        class Database:
            def execute(self, query, params=()):
                calls.append((query, params))
                return SimpleNamespace(fetchall=lambda: [record("m1"), record("m0")])
        @contextmanager
        def database():
            yield Database()
        with patch.object(evolution_history, "_instance"), patch.object(evolution_history.evolution_data, "_database", database):
            result = evolution_history.page("owner", "synthetic-instance", REMOTE, before=100, before_id="m2", limit=1)
        query, params = calls[-1]
        self.assertEqual(("synthetic-instance", REMOTE, REMOTE, 100, 100, "m2", 2), params)
        self.assertIn('COLLATE "C"', query)
        self.assertNotIn(REMOTE, query)
        self.assertTrue(result["hasMore"])
        self.assertEqual(1, len(result["records"]))

    def test_instance_guard_does_not_read_foreign_or_missing_ownership(self):
        data = evolution_history.evolution_data
        instance = data.instance_name("owner")
        with patch.object(data, "owned_names", return_value=[]), patch.object(data, "_database") as database:
            with self.assertRaises(HTTPException):
                evolution_history.reference("owner", instance, "old")
            with self.assertRaises(HTTPException):
                evolution_history.reference("other", instance, "old")
            database.assert_not_called()


if __name__ == "__main__":
    unittest.main()
