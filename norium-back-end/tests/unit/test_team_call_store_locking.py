from __future__ import annotations

import asyncio
import copy
import gc
import unittest
import weakref

from app.modules.team import router
from app.modules.team.call_adapters import JsonCallStateStore
from app.modules.team.recording_adapters import JsonRecordingStore


class TeamCallStoreLockingTests(unittest.IsolatedAsyncioTestCase):
    async def test_call_and_recording_share_team_lock_without_blocking_other_team(self):
        documents = {team: {"messages": [], "recordings": [], "activeCalls": [], "endedCallIds": {}}
                     for team in ("locking-a", "locking-b")}
        def read(team):
            return copy.deepcopy(documents[team])
        def write(team, payload):
            documents[team] = copy.deepcopy(payload)
        fallback = asyncio.Lock()
        calls = JsonCallStateStore(read_document=read, write_document=write,
                                   lock=fallback, lock_for_team=router.team_chat_lock)
        recordings = JsonRecordingStore(read_document=read, write_document=write,
                                         lock=fallback, lock_for_team=router.team_chat_lock)
        entered, release = asyncio.Event(), asyncio.Event()
        async def mutation(document):
            entered.set()
            await release.wait()
            document["messages"].append({"id": "preserved"})
        recording_task = asyncio.create_task(recordings.transact("locking-a", mutation))
        await asyncio.wait_for(entered.wait(), 2)
        same_team = asyncio.create_task(calls.load("locking-a"))
        try:
            other_state = await asyncio.wait_for(calls.load("locking-b"), 2)
            self.assertEqual([], other_state.active_calls)
            self.assertFalse(same_team.done())
        finally:
            release.set()
            await recording_task
            await same_team
        self.assertEqual([{"id": "preserved"}], documents["locking-a"]["messages"])
        self.assertEqual([], documents["locking-b"]["messages"])

    async def test_concurrent_writers_keep_both_updates_in_same_document(self):
        document = {"messages": [], "recordings": []}
        def read(_team):
            return copy.deepcopy(document)
        def write(_team, value):
            document.clear()
            document.update(copy.deepcopy(value))
        store = JsonRecordingStore(read_document=read, write_document=write,
                                   lock=asyncio.Lock(), lock_for_team=router.team_chat_lock)
        async def append(value):
            async def update(payload):
                payload["messages"].append({"id": value})
            await store.transact("locking-shared", update)
        await asyncio.gather(append("one"), append("two"))
        self.assertEqual({"one", "two"}, {message["id"] for message in document["messages"]})

    async def test_inactive_team_locks_are_released(self):
        held = router.team_chat_lock("locking-unused")
        self.assertIs(held, router.team_chat_lock("locking-unused"))
        reference = weakref.ref(held)
        del held
        gc.collect()
        self.assertIsNone(reference())
