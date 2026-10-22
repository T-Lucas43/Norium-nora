import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from app.modules.commercial import service
from app.modules.operations import repository


class PdfCreationAuditGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_checks_record_one_audit_and_one_notification(self):
        saved = []
        async def read(*args):
            await asyncio.sleep(0)
            return list(saved)
        async def audit(*args):
            await asyncio.sleep(0)
            saved.append({"action": "proposal_created_from_pdf", "entityId": "synthetic"})
        recorder = AsyncMock(side_effect=audit)
        with patch.object(repository, "list_items", new=AsyncMock(side_effect=read)), \
             patch.object(service, "audit_proposal_created_from_pdf", recorder), \
             patch("app.core.tenant.get_user_db_path", return_value="/synthetic/primary/audit.json"):
            results = await asyncio.gather(*(service.ensure_pdf_creation_audit({"id": "actor"}, {"proposal": {"id": "synthetic"}}) for _ in range(10)))
        self.assertEqual(1, sum(results))
        recorder.assert_awaited_once()
        self.assertEqual(1, len(saved))

    async def test_audit_failure_releases_guard_for_retry(self):
        recorder = AsyncMock(side_effect=[RuntimeError("synthetic failure"), None])
        with patch.object(repository, "list_items", new=AsyncMock(return_value=[])), \
             patch.object(service, "audit_proposal_created_from_pdf", recorder), \
             patch("app.core.tenant.get_user_db_path", return_value="/synthetic/primary/audit.json"):
            with self.assertRaises(RuntimeError):
                await service.ensure_pdf_creation_audit({"id": "actor"}, {"proposal": {"id": "synthetic"}})
            self.assertTrue(await service.ensure_pdf_creation_audit({"id": "actor"}, {"proposal": {"id": "synthetic"}}))
        self.assertEqual(2, recorder.await_count)
