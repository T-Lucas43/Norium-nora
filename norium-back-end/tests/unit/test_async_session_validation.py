"""Fresh bounded session reads; no authorization cache or shared result scope."""
from __future__ import annotations

import asyncio
import threading
import unittest

from app.infrastructure.async_session_validation import FreshSessionValidator
from app.infrastructure.auth_sessions import SessionError


class FreshSessionValidatorTests(unittest.IsolatedAsyncioTestCase):
    async def wait_thread(self, event):
        for _ in range(1000):
            if event.is_set():
                return
            await asyncio.sleep(.001)
        self.fail('synthetic worker did not enter')

    async def test_contemporaneous_requests_share_one_fresh_read_with_separate_results(self):
        bindings = [('sid-a', 'user-a', 1), ('sid-b', 'user-b', 2)]
        reads = []
        def lookup(requested):
            reads.append(set(requested))
            return {bindings[0]}
        validator = FreshSessionValidator(lookup)
        result = await asyncio.gather(*(validator.validate([binding]) for binding in bindings))
        self.assertEqual([{bindings[0]}, set()], result)
        self.assertEqual([set(bindings)], reads)
        self.assertEqual(0, validator._outstanding_size)

    async def test_later_request_is_not_authorized_from_prior_result(self):
        binding = ('sid-a', 'user-a', 1)
        valid = {binding}
        reads = []
        def lookup(requested):
            reads.append(tuple(requested))
            return valid.copy()
        validator = FreshSessionValidator(lookup)
        self.assertEqual({binding}, await validator.validate([binding]))
        valid.clear()
        self.assertEqual(set(), await validator.validate([binding]))
        self.assertEqual(2, len(reads))

    async def test_requests_arriving_during_read_use_a_new_snapshot(self):
        entered, release = threading.Event(), threading.Event()
        binding = ('sid-a', 'user-a', 1)
        valid = {binding}
        reads = []
        def lookup(requested):
            snapshot = valid.copy()
            reads.append(set(requested))
            if len(reads) == 1:
                entered.set()
                if not release.wait(timeout=5):
                    raise TimeoutError('synthetic lookup not released')
            return snapshot
        validator = FreshSessionValidator(lookup)
        first = asyncio.create_task(validator.validate([binding]))
        later = None
        try:
            await self.wait_thread(entered)
            valid.clear()
            later = asyncio.create_task(validator.validate([binding]))
            await asyncio.sleep(0)
            self.assertFalse(later.done())
        finally:
            release.set()
        self.assertEqual({binding}, await first)
        self.assertEqual(set(), await later)
        self.assertEqual(2, len(reads))

    async def test_foreign_user_and_stale_version_do_not_share_valid_sid_authority(self):
        good = ('sid-a', 'user-a', 2)
        validator = FreshSessionValidator(lambda requested: {good})
        result = await asyncio.gather(validator.validate([good]),
                                     validator.validate([('sid-a', 'user-b', 2)]),
                                     validator.validate([('sid-a', 'user-a', 1)]))
        self.assertEqual([{good}, set(), set()], result)

    async def test_registry_failure_denies_every_waiter_and_next_read_recovers_fresh(self):
        binding = ('sid-a', 'user-a', 1)
        count = 0
        def lookup(requested):
            nonlocal count
            count += 1
            if count == 1:
                raise OSError('synthetic unavailable registry')
            return set(requested)
        validator = FreshSessionValidator(lookup)
        self.assertEqual([set(), set()], await asyncio.gather(validator.validate([binding]), validator.validate([binding])))
        self.assertEqual({binding}, await validator.validate([binding]))

    async def test_cancelled_waiter_does_not_cancel_shared_read(self):
        entered, release = threading.Event(), threading.Event()
        binding = ('sid-a', 'user-a', 1)
        def lookup(requested):
            entered.set()
            if not release.wait(timeout=5):
                raise TimeoutError('synthetic lookup not released')
            return set(requested)
        validator = FreshSessionValidator(lookup)
        cancelled = asyncio.create_task(validator.validate([binding]))
        retained = asyncio.create_task(validator.validate([binding]))
        try:
            await self.wait_thread(entered)
            cancelled.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await cancelled
            self.assertFalse(retained.done())
        finally:
            release.set()
        self.assertEqual({binding}, await retained)
        self.assertEqual(0, validator._outstanding_size)

    async def test_outstanding_limit_counts_waiters_with_identical_bindings(self):
        entered, release = threading.Event(), threading.Event()
        binding = ('sid-a', 'user-a', 1)
        def lookup(requested):
            entered.set()
            if not release.wait(timeout=5):
                raise TimeoutError('synthetic lookup not released')
            return set(requested)
        validator = FreshSessionValidator(lookup)
        waiters = [asyncio.create_task(validator.validate([binding])) for _ in range(1000)]
        try:
            await self.wait_thread(entered)
            self.assertEqual(1000, validator._outstanding_size)
            with self.assertRaises(SessionError) as caught:
                await validator.validate([binding])
            self.assertEqual('session_batch_limit', caught.exception.code)
        finally:
            release.set()
        self.assertEqual([{binding}] * 1000, await asyncio.gather(*waiters))
        self.assertEqual(0, validator._outstanding_size)

    async def test_input_limit_is_enforced_before_deduplicating(self):
        validator = FreshSessionValidator(lambda requested: set(requested))
        with self.assertRaises(SessionError):
            await validator.validate([('same', 'same', 1)] * 1001)
        self.assertEqual(set(), await validator.validate([]))

    async def test_scheduler_cancellation_denies_active_and_queued_requests(self):
        entered, release = threading.Event(), threading.Event()
        binding = ('sid-a', 'user-a', 1)
        def lookup(requested):
            entered.set()
            if not release.wait(timeout=5):
                raise TimeoutError('synthetic lookup not released')
            return set(requested)
        validator = FreshSessionValidator(lookup)
        first = asyncio.create_task(validator.validate([binding]))
        later = None
        try:
            await self.wait_thread(entered)
            later = asyncio.create_task(validator.validate([binding]))
            await asyncio.sleep(0)
            worker = validator._worker
            worker.cancel()
            await asyncio.sleep(0)
            self.assertFalse(worker.done())
            self.assertIs(validator._worker, worker)
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await worker
            self.assertEqual(set(), await first)
            self.assertEqual(set(), await later)
        finally:
            release.set()
        self.assertIsNone(validator._worker)
        self.assertEqual(0, validator._outstanding_size)

    async def test_cancel_before_worker_first_step_denies_waiter_and_recovers(self):
        binding = ('sid-a', 'user-a', 1)
        reads = []
        def lookup(requested):
            reads.append(set(requested))
            return set(requested)
        validator = FreshSessionValidator(lookup)
        first = asyncio.create_task(validator.validate([binding]))
        await asyncio.sleep(0)
        worker = validator._worker
        self.assertIsNotNone(worker)
        worker.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await worker
        self.assertEqual(set(), await asyncio.wait_for(first, 1))
        self.assertEqual([], reads)
        self.assertEqual(0, validator._outstanding_size)
        self.assertEqual({binding}, await validator.validate([binding]))

    async def test_old_worker_done_callback_does_not_clear_new_generation(self):
        binding = ('sid-a', 'user-a', 1)
        validator = FreshSessionValidator(lambda requested: set(requested))
        old = asyncio.create_task(asyncio.sleep(0))
        await old
        new_request = asyncio.create_task(validator.validate([binding]))
        await asyncio.sleep(0)
        new_worker = validator._worker
        validator._worker_finished(old)
        self.assertIs(new_worker, validator._worker)
        self.assertEqual({binding}, await new_request)


if __name__ == '__main__':
    unittest.main()
