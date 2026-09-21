"""AUD-08: mutacao incerta so libera retry/replay apos conciliacao explicita."""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from pydantic import ValidationError

from app.core.tenant import read_user_db, write_user_db
from app.infrastructure.reliability.idempotency import (
    DB_NAME,
    begin_request,
    complete_request,
    reconcile_request,
    reliability_snapshot,
)
from app.modules.system.router import (
    IdempotencyReconciliationPayload,
    reconcile_idempotency,
)


def _expire_lease(user_id: str, key: str) -> None:
    store = read_user_db(user_id, DB_NAME, {})
    record = next(item for item in store["idempotency"] if item["key"] == key)
    record["leaseExpiresAt"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    write_user_db(user_id, DB_NAME, store)


class AuditIdempotencyReconcileTests(unittest.IsolatedAsyncioTestCase):
    user_id = "synthetic-idempotency-reconcile"
    other_id = "synthetic-idempotency-reconcile-other"

    async def test_unknown_key_raises_key_error_and_endpoint_returns_404(self):
        with self.assertRaises(KeyError):
            await reconcile_request(self.user_id, "missing", "no_effect")
        with self.assertRaises(HTTPException) as ctx:
            await reconcile_idempotency(
                IdempotencyReconciliationPayload(
                    key="missing", outcome="no_effect", note="Nada a conciliar."
                ),
                {"id": self.user_id},
            )
        self.assertEqual(404, ctx.exception.status_code)

    async def test_reconcile_requires_uncertain_state(self):
        started = await begin_request(self.user_id, "active", "POST", "/api/test", "digest")
        with self.assertRaises(ValueError):
            await reconcile_request(self.user_id, "active", "no_effect")
        with self.assertRaises(HTTPException) as ctx:
            await reconcile_idempotency(
                IdempotencyReconciliationPayload(
                    key="active", outcome="no_effect", note="Ainda em processamento."
                ),
                {"id": self.user_id},
            )
        self.assertEqual(409, ctx.exception.status_code)
        saved = await complete_request(
            self.user_id, "active", 200, {"ok": True}, {},
            lease_id=started["record"]["leaseId"],
        )
        self.assertTrue(saved)
        with self.assertRaises(HTTPException) as done:
            await reconcile_idempotency(
                IdempotencyReconciliationPayload(
                    key="active", outcome="completed", note="Ja concluida."
                ),
                {"id": self.user_id},
            )
        self.assertEqual(409, done.exception.status_code)

    async def test_no_effect_releases_retry_without_duplicating_effect(self):
        first = await begin_request(self.user_id, "retry", "POST", "/api/test", "digest")
        _expire_lease(self.user_id, "retry")
        blocked = await begin_request(self.user_id, "retry", "POST", "/api/test", "digest")
        self.assertEqual("uncertain", blocked["state"])
        self.assertEqual(1, (await reliability_snapshot(self.user_id))["needsReconciliation"])

        # Lease expirado nao pode finalizar nem ser reutilizado pelo worker antigo.
        stale = await complete_request(
            self.user_id, "retry", 200, {"ok": True}, {}, lease_id=first["record"]["leaseId"]
        )
        self.assertFalse(stale)

        result = await reconcile_idempotency(
            IdempotencyReconciliationPayload(
                key="retry", outcome="no_effect",
                note="Canal confirmado sem o envio; retry liberado.",
            ),
            {"id": self.user_id},
        )
        self.assertEqual("retryable", result["status"])
        self.assertEqual(0, (await reliability_snapshot(self.user_id))["needsReconciliation"])

        retry = await begin_request(self.user_id, "retry", "POST", "/api/test", "digest")
        self.assertEqual("started", retry["state"])
        self.assertEqual(2, retry["record"]["attempt"])
        self.assertNotEqual(first["record"]["leaseId"], retry["record"]["leaseId"])
        saved = await complete_request(
            self.user_id, "retry", 200, {"ok": True}, {}, lease_id=retry["record"]["leaseId"]
        )
        self.assertTrue(saved)
        replay = await begin_request(self.user_id, "retry", "POST", "/api/test", "digest")
        self.assertEqual("completed", replay["state"])
        self.assertEqual({"ok": True}, replay["record"]["payload"])

    async def test_completed_reconciliation_replays_without_reexecution(self):
        started = await begin_request(self.user_id, "confirmed", "PATCH", "/api/test", "digest")
        _expire_lease(self.user_id, "confirmed")
        blocked = await begin_request(self.user_id, "confirmed", "PATCH", "/api/test", "digest")
        self.assertEqual("uncertain", blocked["state"])

        result = await reconcile_idempotency(
            IdempotencyReconciliationPayload(
                key="confirmed", outcome="completed",
                note="Efeito localizado no dominio; sem reenvio.",
            ),
            {"id": self.user_id},
        )
        self.assertEqual("completed", result["status"])
        self.assertEqual(self.user_id, result["record"]["reconciledBy"])

        # O worker original nao pode reescrever a evidencia reconciliada.
        stale = await complete_request(
            self.user_id, "confirmed", 200, {"ok": True}, {},
            lease_id=started["record"]["leaseId"],
        )
        self.assertFalse(stale)
        replay = await begin_request(self.user_id, "confirmed", "PATCH", "/api/test", "digest")
        self.assertEqual("completed", replay["state"])
        self.assertEqual(200, replay["record"]["statusCode"])
        self.assertIn("conciliacao", str(replay["record"]["payload"]))

    async def test_other_tenant_cannot_observe_or_reconcile(self):
        await begin_request(self.user_id, "tenant", "POST", "/api/test", "digest")
        _expire_lease(self.user_id, "tenant")
        blocked = await begin_request(self.user_id, "tenant", "POST", "/api/test", "digest")
        self.assertEqual("uncertain", blocked["state"])
        with self.assertRaises(HTTPException) as ctx:
            await reconcile_idempotency(
                IdempotencyReconciliationPayload(
                    key="tenant", outcome="no_effect", note="Tentativa de outro tenant."
                ),
                {"id": self.other_id},
            )
        self.assertEqual(404, ctx.exception.status_code)
        # O namespace e por tenant: a mesma chave segue livre para o outro usuario.
        fresh = await begin_request(self.other_id, "tenant", "POST", "/api/test", "digest")
        self.assertEqual("started", fresh["state"])

    async def test_payload_validation_rejects_empty_evidence(self):
        with self.assertRaises(ValidationError):
            IdempotencyReconciliationPayload(key="", outcome="no_effect", note="Nota valida.")
        with self.assertRaises(ValidationError):
            IdempotencyReconciliationPayload(key="k", outcome="no_effect", note="ok")
        with self.assertRaises(ValidationError):
            IdempotencyReconciliationPayload(key="k", outcome="completed", note="Nota valida.", statusCode=503)


if __name__ == "__main__":
    unittest.main()
