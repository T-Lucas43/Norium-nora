from __future__ import annotations

import asyncio
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.modules.team import router
from app.modules.team.recording_adapters import JsonRecordingStore
from app.modules.team.recording_coordinator import LocalRecordingFiles, RecordingCoordinator, RecordingLimits
from tests.unit.test_recording_coordinator import FixedClock, MemoryCallAccess, MemoryEvents


class RecordingRetentionStorageTests(unittest.IsolatedAsyncioTestCase):
    async def test_orphan_final_media_is_removed_but_referenced_recording_and_chat_file_survive(self):
        with tempfile.TemporaryDirectory(prefix="norium_retention_") as directory:
            root = Path(directory)
            for name in ("team-recording-orphan.webm", "team-recording-retained.webm", "chat-attachment.webm"):
                (root / name).write_bytes(b"synthetic")
                os.utime(root / name, (0, 0))
            document = {"recordings": [{"id": "kept", "status": "completed",
                "storedName": "team-recording-retained.webm", "expiresAt": "2099-01-01T00:00:00+00:00"}],
                "messages": []}
            store = JsonRecordingStore(read_document=lambda _team: document,
                write_document=lambda *_args: None, lock=asyncio.Lock())
            coordinator = RecordingCoordinator(store=store, files=LocalRecordingFiles(root),
                call_access=MemoryCallAccess(), events=MemoryEvents(), clock=FixedClock(), limits=RecordingLimits())
            result = await coordinator.maintain(["owner"])
            self.assertEqual(1, result["deletedOrphans"])
            self.assertFalse((root / "team-recording-orphan.webm").exists())
            self.assertTrue((root / "team-recording-retained.webm").exists())
            self.assertTrue((root / "chat-attachment.webm").exists())

    async def test_secondary_workspace_cannot_replace_primary_call_state(self):
        from app.core.request_context import set_request_context, reset_request_context
        tokens = set_request_context("test", "secondary")
        try:
            with patch.object(router, "_call_coordinator_instance") as coordinator:
                with self.assertRaises(HTTPException):
                    await router.list_active_calls({"id": "owner", "permissions": {"chat": True}})
                coordinator.active_calls_for.assert_not_called()
                self.assertEqual([], await router.active_calls_snapshot("owner"))
                with self.assertRaises(HTTPException):
                    router.recording_coordinator()
        finally:
            reset_request_context(tokens)

    async def test_incomplete_workspace_inventory_keeps_possible_orphan_files(self):
        with tempfile.TemporaryDirectory(prefix="norium_retention_") as directory:
            root = Path(directory)
            part = root / "secondary.part"
            part.write_bytes(b"synthetic")
            os.utime(part, (0, 0))
            store = JsonRecordingStore(read_document=lambda _team: {"recordings": [], "messages": []},
                write_document=lambda *_args: None, lock=asyncio.Lock())
            coordinator = RecordingCoordinator(store=store, files=LocalRecordingFiles(root),
                call_access=MemoryCallAccess(), events=MemoryEvents(), clock=FixedClock(), limits=RecordingLimits())
            with self.assertRaises(OSError):
                await coordinator.maintain(["owner"], inventory_complete=False)
            self.assertTrue(part.exists())

    async def test_unreadable_real_store_preserves_raw_bytes_and_does_not_delete_orphans(self):
        with tempfile.TemporaryDirectory(prefix="norium_retention_") as directory:
            root = Path(directory)
            database = root / "team_chat_db.json"
            original = b'{"recordings": ['
            database.write_bytes(original)
            part = root / "team-recording-referenced.webm.part"
            part.write_bytes(b"synthetic")
            os.utime(part, (0, 0))
            store = JsonRecordingStore(read_document=router.read_chat_store,
                write_document=router.write_chat_store, lock=asyncio.Lock())
            coordinator = RecordingCoordinator(store=store, files=LocalRecordingFiles(root),
                call_access=MemoryCallAccess(), events=MemoryEvents(), clock=FixedClock(), limits=RecordingLimits())
            with patch.object(router, "team_chat_path", return_value=str(database)):
                with self.assertRaises(OSError):
                    await coordinator.maintain(["owner"])
            self.assertEqual(original, database.read_bytes())
            self.assertTrue(part.exists())

    async def test_invalid_document_shape_is_not_replaced_by_an_empty_store(self):
        for payload in ([], {"recordings": {}}, {"recordings": [None]}):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory(prefix="norium_retention_") as directory:
                database = Path(directory) / "team_chat_db.json"
                database.write_text(json.dumps(payload), encoding="utf-8")
                with patch.object(router, "team_chat_path", return_value=str(database)), self.assertRaises(OSError):
                    router.read_chat_store("owner")

    async def test_record_pruning_keeps_files_pending_deletion_and_unexpired_media(self):
        protected = [{"id": "active", "status": "recording"},
                     {"id": "pending", "status": "deleted", "storedName": "pending.webm"},
                     {"id": "completed", "status": "completed", "expiresAt": "2099-01-01T00:00:00+00:00"}]
        document = {"recordings": protected + [{"id": str(index), "status": "deleted",
                    "filesDeletedAt": "2026-09-01T00:00:00+00:00"} for index in range(205)], "messages": []}
        written = []
        store = JsonRecordingStore(read_document=lambda _team: copy.deepcopy(document),
            write_document=lambda _team, value: written.append(copy.deepcopy(value)), lock=asyncio.Lock())
        await store.transact("owner", AsyncMock())
        retained = written[0]["recordings"]
        self.assertTrue({"active", "pending", "completed"}.issubset({item["id"] for item in retained}))
        self.assertEqual(203, len(retained))

    async def test_missing_metadata_denies_recording_download_even_with_visible_attachment(self):
        with tempfile.TemporaryDirectory(prefix="norium_retention_") as directory:
            name = "team-recording-old.webm"
            (Path(directory) / name).write_bytes(b"synthetic")
            document = {"recordings": [], "messages": [{"scope": "team", "attachments": [
                {"storedName": name, "recordingId": "old", "expiresAt": "2020-01-01T00:00:00+00:00"}]}]}
            with patch.object(router, "require_team_chat"), patch.object(router, "active_calls_snapshot", AsyncMock()), \
                 patch.object(router, "read_pruned_chat_store", AsyncMock(return_value=document)), \
                 patch.object(router, "UPLOAD_DIR", Path(directory)):
                with self.assertRaises(HTTPException) as raised:
                    await router.download_attachment(name, {"id": "owner"})
                self.assertEqual(404, raised.exception.status_code)
