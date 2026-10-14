"""Regressions for independent team documents and cancellation-safe JSON writes."""
from __future__ import annotations

import asyncio
import gc
import ntpath
import os
import tempfile
import threading
import unittest
import weakref
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.core import tenant
from app.core.request_context import current_workspace_id, reset_request_context, set_request_context
from app.infrastructure.persistence import json_repository, postgres_store
from app.modules.team import router
from app.modules.team.call_adapters import JsonCallStateStore
from app.modules.team.call_coordinator import CallState
from app.modules.team.recording_adapters import JsonRecordingStore


class TeamDocumentLockTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory(prefix="norium_document_locks_")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.addCleanup(reset_request_context, set_request_context("synthetic-lock-test", "primary"))
        for item in (
            patch.object(router, "_chat_locks", weakref.WeakValueDictionary()),
            patch.object(router, "team_chat_path", side_effect=lambda team_id:
                         str(self.root / current_workspace_id() / f"{team_id}.json")),
            patch.object(postgres_store, "configured", return_value=False),
            patch.object(postgres_store, "required", return_value=False),
            patch.object(tenant, "get_data_root", return_value=self.root / "managed"),
            patch.object(router, "thread_participant_ids", AsyncMock(return_value={"team-a"})),
            patch.object(router, "validated_mentions", AsyncMock(return_value=[])),
            patch.object(router, "user_avatar_url", return_value=""),
            patch.object(router, "has_nora_mention", return_value=False),
            patch.object(router.manager, "send_to_users", AsyncMock()),
            patch.object(router, "record_team_event", AsyncMock()),
        ):
            item.start()
            self.addCleanup(item.stop)

    def seed(self, team_id="team-a", call_id="keep"):
        document = router.empty_store()
        document.update(messages=[{"id": "old", "text": "old"}],
                        subteams=[{"id": "synthetic-private"}],
                        activeCalls=[{"callId": call_id}],
                        recordings=[{"id": "old-recording", "status": "recording"}])
        router.write_chat_store(team_id, document)

    def call_store(self, cleanup=None):
        return JsonCallStateStore(read_document=router.read_chat_store,
                                  write_document=router.write_chat_store,
                                  lock=router.chat_lock_for, on_call_removed=cleanup)

    def recording_store(self):
        return JsonRecordingStore(read_document=router.read_chat_store,
                                  write_document=router.write_chat_store,
                                  lock=router.chat_lock_for)

    async def add_recording(self, team_id, recording_id):
        async def operation(document):
            document.setdefault("recordings", []).append({"id": recording_id, "status": "recording"})
        await self.recording_store().transact(team_id, operation)

    async def message(self, team_id, text):
        return await router.persist_message(
            scope="team", recipient_id=None, subteam_id=None, text=text, attachment_payloads=[],
            user={"id": team_id, "nome": "Synthetic owner", "teamOwnerId": team_id,
                  "status": "ativo", "teamChatEnabled": True, "permissions": {"chat": True}},
        )

    @asynccontextmanager
    async def block_first_write(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        started = threading.Event()
        guard = threading.Lock()
        real_fsync, real_write = json_repository.os.fsync, router.write_chat_store

        def blocked_fsync(file_descriptor):
            if not entered.is_set():
                entered.set()
                if not release.wait(timeout=5):
                    raise TimeoutError("synthetic JSON write not released")
            real_fsync(file_descriptor)

        def write(team_id, document):
            with guard:
                first = not started.is_set()
                started.set()
            try:
                real_write(team_id, document)
            finally:
                if first:
                    finished.set()

        with patch.object(json_repository.os, "fsync", side_effect=blocked_fsync), \
             patch.object(router, "write_chat_store", side_effect=write):
            try:
                yield entered, release
            finally:
                release.set()
                if started.is_set():
                    self.assertTrue(await asyncio.to_thread(finished.wait, 5), "real JSON worker did not exit")

    async def wait_for_write(self, entered):
        self.assertTrue(await asyncio.to_thread(entered.wait, 2), "real JSON writer did not reach fsync")

    async def test_path_aliases_share_lock_without_filesystem_probes(self):
        base = str(self.root / "owner.json")
        paths = {"base": base, "dot": os.path.join(str(self.root), ".", "owner.json"),
                 "parent": os.path.join(str(self.root), "unused", "..", "owner.json"),
                 "relative": os.path.relpath(base)}
        with patch.object(router, "team_chat_path", side_effect=paths.__getitem__), \
             patch.object(Path, "resolve", side_effect=AssertionError("lock identity probed filesystem")), \
             patch.object(Path, "stat", side_effect=AssertionError("lock identity probed filesystem")), \
             patch.object(Path, "exists", side_effect=AssertionError("lock identity probed filesystem")):
            locks = [router.chat_lock_for(team_id) for team_id in paths]
        self.assertTrue(all(lock is locks[0] for lock in locks))
        self.assertEqual(1, len(router._chat_locks))

    async def test_windows_case_aliases_share_lock(self):
        paths = {"upper": r"C:\Synthetic\Owner\TEAM_CHAT.JSON",
                 "lower": r"c:\synthetic\owner\team_chat.json"}
        # Exercise Windows identity rules on the Linux release runner as well.
        with patch.object(router, "team_chat_path", side_effect=paths.__getitem__), \
             patch.object(router.os.path, "normcase", ntpath.normcase):
            upper = router.chat_lock_for("upper")
            self.assertIs(upper, router.chat_lock_for("lower"))

    async def test_same_team_in_different_workspaces_advances_independently(self):
        self.seed(call_id="primary-call")
        store = self.call_store()
        primary_lock = router.chat_lock_for("team-a")
        tokens = set_request_context("synthetic-lock-test", "secondary")
        try:
            self.seed(call_id="secondary-call")
            secondary_lock = router.chat_lock_for("team-a")
        finally:
            reset_request_context(tokens)
        self.assertIsNot(primary_lock, secondary_lock)
        primary_read = None
        try:
            async with primary_lock:
                primary_read = asyncio.create_task(store.load("team-a"))
                await asyncio.sleep(0)
                tokens = set_request_context("synthetic-lock-test", "secondary")
                try:
                    secondary = await asyncio.wait_for(store.load("team-a"), 2)
                finally:
                    reset_request_context(tokens)
                self.assertFalse(primary_read.done())
                self.assertEqual("secondary-call", secondary.active_calls[0]["callId"])
            primary = await asyncio.wait_for(primary_read, 2)
        finally:
            if primary_read is not None:
                await asyncio.gather(primary_read, return_exceptions=True)
        self.assertEqual("primary-call", primary.active_calls[0]["callId"])

    async def test_weak_registry_does_not_retain_abandoned_locks(self):
        lock = router.chat_lock_for("team-a")
        reference = weakref.ref(lock)
        self.assertEqual(1, len(router._chat_locks))
        del lock
        gc.collect()
        self.assertIsNone(reference())
        self.assertEqual(0, len(router._chat_locks))

    async def test_other_team_call_recording_and_message_writes_advance_while_one_is_blocked(self):
        tasks = []
        async with self.block_first_write() as (entered, release):
            try:
                blocked = asyncio.create_task(self.call_store().save("team-a", CallState([{"callId": "a"}], {})))
                tasks.append(blocked)
                await self.wait_for_write(entered)
                tasks.extend((
                    asyncio.create_task(self.call_store().save("team-b", CallState([{"callId": "b"}], {}))),
                    asyncio.create_task(self.add_recording("team-c", "c")),
                    asyncio.create_task(self.message("team-d", "independent-message")),
                ))
                await asyncio.wait_for(asyncio.gather(*tasks[1:]), 2)
                self.assertFalse(blocked.done())
                self.assertTrue(router.chat_lock_for("team-a").locked())
                self.assertEqual("b", router.read_chat_store("team-b")["activeCalls"][0]["callId"])
                self.assertEqual("c", router.read_chat_store("team-c")["recordings"][0]["id"])
                self.assertEqual("independent-message", router.read_chat_store("team-d")["messages"][0]["text"])
            finally:
                release.set()
                await asyncio.gather(*tasks, return_exceptions=True)
        self.assertEqual("a", router.read_chat_store("team-a")["activeCalls"][0]["callId"])

    async def test_same_document_message_call_and_recording_updates_all_survive(self):
        self.seed()
        tasks = []
        async with self.block_first_write() as (entered, release):
            try:
                tasks.append(asyncio.create_task(self.call_store().save(
                    "team-a", CallState([{"callId": "keep", "participantIds": ["synthetic-member"]}], {}),
                    append_messages=({"id": "call-message", "text": "call-message"},))))
                await self.wait_for_write(entered)
                tasks.extend((asyncio.create_task(self.message("team-a", "router-message")),
                              asyncio.create_task(self.add_recording("team-a", "new-recording"))))
                await asyncio.sleep(0)
                self.assertTrue(all(not task.done() for task in tasks))
                release.set()
                await asyncio.wait_for(asyncio.gather(*tasks), 2)
            finally:
                release.set()
                await asyncio.gather(*tasks, return_exceptions=True)
        document = router.read_chat_store("team-a")
        self.assertEqual(["synthetic-member"], document["activeCalls"][0]["participantIds"])
        self.assertEqual({"old", "call-message", "router-message"}, {item["text"] for item in document["messages"]})
        self.assertEqual({"old-recording", "new-recording"}, {item["id"] for item in document["recordings"]})
        self.assertEqual([{"id": "synthetic-private"}], document["subteams"])

    async def test_repeated_cancellation_keeps_document_lock_until_real_write_finishes(self):
        for kind in ("call", "call-cleanup", "recording", "message"):
            with self.subTest(writer=kind):
                self.seed()
                tasks = []
                async with self.block_first_write() as (entered, release):
                    try:
                        if kind == "recording":
                            operation = self.add_recording("team-a", "cancelled-recording")
                        elif kind == "message":
                            operation = self.message("team-a", "cancelled-message")
                        else:
                            active_calls = [] if kind == "call-cleanup" else [{"callId": "keep"}]
                            operation = self.call_store(AsyncMock() if kind == "call-cleanup" else None).save(
                                "team-a", CallState(active_calls, {}),
                                append_messages=({"id": "cancelled-call", "text": "cancelled-call"},))
                        mutation = asyncio.create_task(operation)
                        tasks.append(mutation)
                        await self.wait_for_write(entered)
                        follower = asyncio.create_task(self.message("team-a", "after-cancellation"))
                        tasks.append(follower)
                        lock = router.chat_lock_for("team-a")
                        for _ in range(3):
                            mutation.cancel()
                            await asyncio.sleep(0)
                            self.assertTrue(lock.locked())
                            self.assertFalse(mutation.done())
                            self.assertFalse(follower.done())
                        release.set()
                        with self.assertRaises(asyncio.CancelledError):
                            await mutation
                        await asyncio.wait_for(follower, 2)
                    finally:
                        release.set()
                        await asyncio.gather(*tasks, return_exceptions=True)
                document = router.read_chat_store("team-a")
                texts = {item["text"] for item in document["messages"]}
                self.assertIn("after-cancellation", texts)
                self.assertIn("old", texts)
                if kind == "message":
                    self.assertIn("cancelled-message", texts)
                elif kind == "recording":
                    self.assertIn("cancelled-recording", {item["id"] for item in document["recordings"]})
                else:
                    self.assertIn("cancelled-call", texts)
                    self.assertEqual([] if kind == "call-cleanup" else [{"callId": "keep"}], document["activeCalls"])
                self.assertFalse(lock.locked())