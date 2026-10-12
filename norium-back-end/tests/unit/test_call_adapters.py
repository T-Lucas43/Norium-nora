"""Regressions for call document merging under the shared writer lock."""
from __future__ import annotations

import asyncio
import copy
import threading
import unittest
from unittest.mock import AsyncMock, patch

from app.modules.team.call_adapters import JsonCallStateStore
from app.modules.team.call_coordinator import CallState


class CallStateAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.lock = asyncio.Lock()
        self.document = {"activeCalls": [{"callId": "keep", "participantIds": ["a"]}],
                         "endedCallIds": {}, "messages": [{"id": "old"}],
                         "subteams": [{"id": "private"}], "recordings": [{"id": "video"}]}
        self.io_threads = []
        self.order = []

    def read(self, team_id):
        self.assertEqual("team-a", team_id)
        self.assertTrue(self.lock.locked())
        self.io_threads.append(threading.get_ident())
        self.order.append("read")
        return copy.deepcopy(self.document)

    def write(self, team_id, document):
        self.assertEqual("team-a", team_id)
        self.assertTrue(self.lock.locked())
        self.io_threads.append(threading.get_ident())
        self.order.append("write")
        self.document = copy.deepcopy(document)

    def adapter(self, callback=None):
        return JsonCallStateStore(read_document=self.read, write_document=self.write,
                                  lock=lambda _team: self.lock, on_call_removed=callback)

    async def test_normal_save_uses_one_worker_and_preserves_other_document_fields(self):
        callback = AsyncMock()
        state = CallState([{"callId": "keep", "participantIds": ["a", "b"]}], {"ended": "date"})
        dispatch = asyncio.to_thread
        with patch("app.modules.team.call_adapters.asyncio.to_thread", wraps=dispatch) as worker:
            await self.adapter(callback).save("team-a", state, append_messages=({"id": "new"},))
        self.assertEqual(1, worker.call_count)
        self.assertEqual(2, len(self.io_threads))
        self.assertEqual(self.io_threads[0], self.io_threads[1])
        self.assertNotEqual(threading.get_ident(), self.io_threads[0])
        self.assertEqual(["read", "write"], self.order)
        self.assertEqual([{"id": "old"}, {"id": "new"}], self.document["messages"])
        self.assertEqual([{"id": "private"}], self.document["subteams"])
        self.assertEqual([{"id": "video"}], self.document["recordings"])
        self.assertEqual(state.active_calls, self.document["activeCalls"])
        self.assertEqual(state.ended_call_ids, self.document["endedCallIds"])
        callback.assert_not_awaited()
        state.active_calls[0]["participantIds"].append("c")
        self.assertEqual(["a", "b"], self.document["activeCalls"][0]["participantIds"])
        self.assertFalse(self.lock.locked())

    async def test_async_removal_finishes_under_lock_before_document_write(self):
        async def cleanup(call):
            self.assertTrue(self.lock.locked())
            self.assertEqual("keep", call["callId"])
            self.order.append("cleanup-start")
            await asyncio.sleep(0)
            self.order.append("cleanup-end")
        await self.adapter(cleanup).save("team-a", CallState([], {"keep": "date"}))
        self.assertEqual(["read", "cleanup-start", "cleanup-end", "write"], self.order)
        self.assertEqual([], self.document["activeCalls"])

    async def test_sync_removal_callback_keeps_order_and_does_not_remove_retained_call(self):
        self.document["activeCalls"].append({"callId": "removed"})
        def cleanup(call):
            self.assertEqual("removed", call["callId"])
            self.assertTrue(self.lock.locked())
            self.order.append("cleanup")
        await self.adapter(cleanup).save("team-a", CallState([{"callId": "keep"}], {}))
        self.assertEqual(["read", "cleanup", "write"], self.order)

    async def test_failed_cleanup_does_not_write_or_lose_existing_messages(self):
        before = copy.deepcopy(self.document)
        callback = AsyncMock(side_effect=OSError("synthetic cleanup failure"))
        with self.assertRaises(OSError):
            await self.adapter(callback).save("team-a", CallState([], {}), append_messages=({"id": "new"},))
        self.assertEqual(before, self.document)
        self.assertEqual(["read"], self.order)
        self.assertFalse(self.lock.locked())

    async def test_failed_read_never_writes_defaults(self):
        adapter = self.adapter()
        with patch.object(adapter, "_read_document", side_effect=OSError("synthetic unreadable store")):
            with self.assertRaises(OSError):
                await adapter.save("team-a", CallState([], {}))
        self.assertEqual([], self.order)
        self.assertFalse(self.lock.locked())

    async def test_message_retention_stays_bounded(self):
        self.document["messages"] = [{"id": index} for index in range(2000)]
        await self.adapter().save("team-a", CallState(self.document["activeCalls"], {}),
                                  append_messages=({"id": 2000}, {"id": 2001}))
        self.assertEqual(2000, len(self.document["messages"]))
        self.assertEqual(2, self.document["messages"][0]["id"])
        self.assertEqual(2001, self.document["messages"][-1]["id"])

    async def test_repeated_cancellation_keeps_lock_until_worker_finishes(self):
        entered, release = threading.Event(), threading.Event()
        original_read = self.read
        def blocked_read(team_id):
            snapshot = original_read(team_id)
            entered.set()
            if not release.wait(timeout=5):
                raise TimeoutError('synthetic worker not released')
            return snapshot
        adapter = self.adapter()
        adapter._read_document = blocked_read
        mutation = asyncio.create_task(adapter.save('team-a', CallState([{'callId': 'keep'}], {})))
        changed = asyncio.Event()
        async def concurrent_change():
            async with self.lock:
                self.document['messages'].append({'id': 'concurrent'})
                changed.set()
        next_writer = None
        try:
            for _ in range(1000):
                if entered.is_set():
                    break
                await asyncio.sleep(.001)
            self.assertTrue(entered.is_set())
            mutation.cancel()
            await asyncio.sleep(0)
            next_writer = asyncio.create_task(concurrent_change())
            mutation.cancel()
            await asyncio.sleep(0)
            self.assertTrue(self.lock.locked())
            self.assertFalse(mutation.done())
            self.assertFalse(changed.is_set())
        finally:
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await mutation
            if next_writer is not None:
                await next_writer
        self.assertFalse(self.lock.locked())
        self.assertEqual([{'id': 'old'}, {'id': 'concurrent'}], self.document['messages'])
        self.assertEqual(['read', 'write'], self.order)

    async def test_cancellation_during_cleanup_write_keeps_lock_until_write_finishes(self):
        entered, release = threading.Event(), threading.Event()
        original_write = self.write
        def blocked_write(team_id, document):
            entered.set()
            if not release.wait(timeout=5):
                raise TimeoutError('synthetic write not released')
            original_write(team_id, document)
        adapter = self.adapter(AsyncMock())
        adapter._write_document = blocked_write
        mutation = asyncio.create_task(adapter.save('team-a', CallState([], {})))
        try:
            for _ in range(1000):
                if entered.is_set():
                    break
                await asyncio.sleep(.001)
            self.assertTrue(entered.is_set())
            mutation.cancel()
            await asyncio.sleep(0)
            self.assertTrue(self.lock.locked())
            self.assertFalse(mutation.done())
        finally:
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await mutation
        self.assertEqual([], self.document['activeCalls'])
        self.assertFalse(self.lock.locked())

    async def test_worker_failure_after_cancellation_is_reported_without_releasing_early(self):
        entered, release = threading.Event(), threading.Event()
        before = copy.deepcopy(self.document)
        def failed_write(team_id, document):
            entered.set()
            if not release.wait(timeout=5):
                raise TimeoutError('synthetic write not released')
            raise OSError('synthetic storage failure')
        adapter = self.adapter()
        adapter._write_document = failed_write
        mutation = asyncio.create_task(adapter.save('team-a', CallState([{'callId': 'keep'}], {})))
        try:
            for _ in range(1000):
                if entered.is_set():
                    break
                await asyncio.sleep(.001)
            self.assertTrue(entered.is_set())
            mutation.cancel()
            await asyncio.sleep(0)
            self.assertTrue(self.lock.locked())
            self.assertFalse(mutation.done())
        finally:
            release.set()
            # A real storage error takes precedence over cancellation: the
            # caller must not treat an unsuccessful write as a completed one.
            with self.assertRaisesRegex(OSError, 'synthetic storage failure'):
                await mutation
        self.assertFalse(self.lock.locked())
        self.assertEqual(before, self.document)


if __name__ == "__main__":
    unittest.main()
