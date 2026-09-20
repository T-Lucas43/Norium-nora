"""AUD-08: leases never release an unknown mutation without reconciliation."""
from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone

from app.core.tenant import read_user_db, write_user_db
from app.infrastructure.reliability.idempotency import (
    DB_NAME,
    begin_request,
    complete_request,
    reconcile_request,
    reliability_snapshot,
)


class AuditIdempotencyRecoveryTests(unittest.IsolatedAsyncioTestCase):
    user_id = "synthetic-idempotency-user"

    async def test_concurrent_claim_has_exactly_one_active_lease(self):
        results = await asyncio.gather(*[
            begin_request(self.user_id, "concurrent", "POST", "/api/test", "digest")
            for _ in range(8)
        ])
        self.assertEqual(1, sum(item["state"] == "started" for item in results))
        self.assertEqual(7, sum(item["state"] == "processing" for item in results))
        self.assertEqual(1, len({item["record"]["leaseId"] for item in results}))

    async def test_expired_lease_is_uncertain_until_no_effect_is_proved(self):
        first = await begin_request(self.user_id, "expired", "POST", "/api/test", "digest")
        store = read_user_db(self.user_id, DB_NAME, {})
        record = next(item for item in store["idempotency"] if item["key"] == "expired")
        record["leaseExpiresAt"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        write_user_db(self.user_id, DB_NAME, store)

        blocked = await begin_request(self.user_id, "expired", "POST", "/api/test", "digest")
        self.assertEqual("uncertain", blocked["state"])
        self.assertEqual(1, (await reliability_snapshot(self.user_id))["needsReconciliation"])
        stale = await complete_request(
            self.user_id, "expired", 200, {"ok": True}, {}, lease_id=first["record"]["leaseId"]
        )
        self.assertFalse(stale)

        await reconcile_request(self.user_id, "expired", "no_effect")
        retry = await begin_request(self.user_id, "expired", "POST", "/api/test", "digest")
        self.assertEqual("started", retry["state"])
        self.assertEqual(2, retry["record"]["attempt"])
        self.assertNotEqual(first["record"]["leaseId"], retry["record"]["leaseId"])

    async def test_confirmed_effect_replays_without_running_again(self):
        started = await begin_request(self.user_id, "confirmed", "PATCH", "/api/test", "digest")
        store = read_user_db(self.user_id, DB_NAME, {})
        record = next(item for item in store["idempotency"] if item["key"] == "confirmed")
        record["leaseExpiresAt"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        write_user_db(self.user_id, DB_NAME, store)
        retry = await begin_request(self.user_id, "confirmed", "PATCH", "/api/test", "digest")
        self.assertEqual("uncertain", retry["state"])
        await reconcile_request(
            self.user_id, "confirmed", "completed", status_code=201,
            payload={"id": "synthetic"}, headers={"content-type": "application/json"},
        )
        replay = await begin_request(self.user_id, "confirmed", "PATCH", "/api/test", "digest")
        self.assertEqual("completed", replay["state"])
        self.assertEqual(201, replay["record"]["statusCode"])
        self.assertEqual({"id": "synthetic"}, replay["record"]["payload"])
        self.assertTrue(started["record"]["leaseId"])

    async def test_server_error_requires_reconciliation(self):
        started = await begin_request(self.user_id, "server-error", "POST", "/api/test", "digest")
        saved = await complete_request(
            self.user_id, "server-error", 503, {"detail": "failed"}, {},
            lease_id=started["record"]["leaseId"],
        )
        self.assertTrue(saved)
        retry = await begin_request(self.user_id, "server-error", "POST", "/api/test", "digest")
        self.assertEqual("uncertain", retry["state"])


if __name__ == "__main__":
    unittest.main()
