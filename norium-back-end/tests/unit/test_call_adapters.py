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
                                  lock=self.lock, on_call_removed=callback)

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


if __name__ == "__main__":
    unittest.main()
