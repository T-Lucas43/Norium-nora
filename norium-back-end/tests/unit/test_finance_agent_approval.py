"""Exclusão e alteração financeira pela Nora só acontecem com aprovação exata."""

import os
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app.core.request_context import reset_request_context, set_request_context
from app.modules.finance import router as finance_router
from app.modules.operations import service as ops
from app.modules.operations.repository import APPROVAL_DB, list_items, replace_item
from app.modules.operations.schemas import ApprovalCreate, ApprovalDecision
from app.services.finance_store import create_lancamento, list_finance


OWNER = "finance-owner"


def owner() -> dict:
    return {"id": OWNER, "nome": "Tester", "role": "owner", "plan": "individual"}


class FinanceAgentApprovalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name, "ENVIRONMENT": "test", "NORIUM_DATABASE_URL": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.request_context = set_request_context("test-finance-approval", "primary")
        self.addCleanup(reset_request_context, self.request_context)
        getattr(ops, "approval_decision_locks", {}).clear()

    def entries(self) -> list[dict]:
        return list_finance(OWNER)["lancamentos"]

    async def test_delete_creates_exact_approval_and_keeps_entry(self) -> None:
        create_lancamento(OWNER, {"title": "Mercado do mes", "amount": 83.9, "status": "pago"})

        result = await finance_router.handle_finance_agent(OWNER, "excluir o lancamento mercado do mes", user=owner())

        self.assertEqual("aguardando_aprovacao", result["status"])
        self.assertEqual(1, len(self.entries()))
        approval = result["approval"]
        self.assertEqual("nora_finance_exact", approval["action"])
        self.assertTrue(approval["digest"])
        self.assertEqual("delete_lancamento", approval["payload"]["financeExact"]["operation"])

    async def test_approval_deletes_only_the_approved_id(self) -> None:
        target = create_lancamento(OWNER, {"title": "Mercado do mes", "amount": 83.9})
        other = create_lancamento(OWNER, {"title": "Aluguel", "amount": 4800})
        result = await finance_router.handle_finance_agent(OWNER, "apagar lancamento mercado do mes", user=owner())
        approval = result["approval"]

        decided = await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))

        self.assertEqual("executed", decided["status"])
        remaining = [item["id"] for item in self.entries()]
        self.assertNotIn(target["id"], remaining)
        self.assertIn(other["id"], remaining)

    async def test_wrong_digest_is_rejected_and_nothing_is_deleted(self) -> None:
        create_lancamento(OWNER, {"title": "Mercado do mes", "amount": 83.9})
        result = await finance_router.handle_finance_agent(OWNER, "excluir lancamento mercado do mes", user=owner())

        with self.assertRaises(ValueError):
            await ops.decide_approval(owner(), result["approval"]["id"], ApprovalDecision(decision="approved", expectedDigest="0" * 64))

        self.assertEqual(1, len(self.entries()))

    async def test_changed_item_after_preview_is_not_deleted(self) -> None:
        item = create_lancamento(OWNER, {"title": "Mercado do mes", "amount": 83.9})
        result = await finance_router.handle_finance_agent(OWNER, "excluir lancamento mercado do mes", user=owner())
        finance_router.update_lancamento(OWNER, item["id"], {"amount": 99})
        approval = result["approval"]

        decided = await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))

        self.assertEqual("failed", decided["status"])
        self.assertEqual(1, len(self.entries()))

    async def test_similar_titles_return_options_instead_of_guessing(self) -> None:
        create_lancamento(OWNER, {"title": "Mercado bairro", "amount": 50})
        create_lancamento(OWNER, {"title": "Mercado centro", "amount": 70})

        result = await finance_router.handle_finance_agent(OWNER, "excluir lancamento mercado", user=owner())

        self.assertEqual("precisa_confirmar_alvo", result["status"])
        self.assertEqual(2, len(result["candidates"]))
        self.assertEqual([], await list_items(OWNER, APPROVAL_DB))
        self.assertEqual(2, len(self.entries()))

    async def test_without_user_context_nothing_is_changed(self) -> None:
        create_lancamento(OWNER, {"title": "Mercado do mes", "amount": 83.9})

        result = await finance_router.handle_finance_agent(OWNER, "excluir lancamento mercado do mes")

        self.assertEqual("precisa_aprovacao", result["status"])
        self.assertEqual(1, len(self.entries()))

    async def test_update_requires_approval_then_applies_changes(self) -> None:
        item = create_lancamento(OWNER, {"title": "Internet", "amount": 120, "status": "pendente"})

        result = await finance_router.handle_finance_agent(OWNER, "marcar internet como pago", user=owner())
        self.assertEqual("aguardando_aprovacao", result["status"])
        self.assertEqual("pendente", self.entries()[0]["status"])

        approval = result["approval"]
        await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        updated = next(entry for entry in self.entries() if entry["id"] == item["id"])
        self.assertEqual("pago", updated["status"])

    async def test_exact_preview_rejects_another_owner(self) -> None:
        with self.assertRaises(PermissionError):
            await ops.create_exact_finance_approval(
                owner(), "another-owner",
                {"operation": "delete_lancamento", "itemId": "other-entry", "snapshot": {}},
                "Excluir lançamento", "Excluir um lançamento de outra conta.",
            )
        self.assertEqual([], await list_items(OWNER, APPROVAL_DB))

    async def test_forged_approval_cannot_delete_another_owners_entry(self) -> None:
        other_owner = "another-owner"
        target = create_lancamento(other_owner, {"title": "Outro lançamento", "amount": 17})
        payload = {"kind": "nora_finance_exact", "ownerId": other_owner,
                   "financeExact": {"operation": "delete_lancamento", "itemId": target["id"], "snapshot": {}}}
        title, description = "Excluir lançamento", "Prévia forjada de outra conta."
        digest = ops.approval_digest("nora_finance_exact", "financeiro", title, description,
                                     payload, "primary", OWNER, ops.FINANCE_EXACT_VERSION)
        approval = await ops.create_approval(owner(), ApprovalCreate(
            title=title, description=description, action="nora_finance_exact", source="financeiro",
            payload=payload, digest=digest,
        ))
        decided = await ops.decide_approval(owner(), approval["id"],
                                           ApprovalDecision(decision="approved", expectedDigest=digest))
        self.assertEqual("failed", decided["status"])
        self.assertEqual([target["id"]], [entry["id"] for entry in list_finance(other_owner)["lancamentos"]])

    async def test_modified_exact_payload_is_rejected(self) -> None:
        create_lancamento(OWNER, {"title": "Internet", "amount": 120})
        result = await finance_router.handle_finance_agent(OWNER, "alterar o valor da internet para 150", user=owner())
        approval = result["approval"]
        changed = approval["payload"]
        changed["financeExact"]["updates"]["amount"] = 999
        await replace_item(OWNER, APPROVAL_DB, approval["id"], {"payload": changed})
        decided = await ops.decide_approval(owner(), approval["id"],
                                           ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        self.assertEqual("failed", decided["status"])
        self.assertEqual(120, self.entries()[0]["amount"])

    async def test_revoked_finance_permission_prevents_execution(self) -> None:
        create_lancamento(OWNER, {"title": "Internet", "amount": 120})
        result = await finance_router.handle_finance_agent(OWNER, "excluir lancamento internet", user=owner())
        approval = result["approval"]
        with patch("app.routers.auth_router.effective_permissions", return_value={"gastos": False}):
            decided = await ops.decide_approval(owner(), approval["id"],
                                               ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        self.assertEqual("failed", decided["status"])
        self.assertEqual(1, len(self.entries()))

    async def test_exact_finance_approval_without_digest_is_rejected(self) -> None:
        target = create_lancamento(OWNER, {"title": "Internet", "amount": 120})
        approval = await ops.create_approval(owner(), ApprovalCreate(
            title="Excluir lançamento", action="nora_finance_exact", source="financeiro",
            payload={"kind": "nora_finance_exact", "ownerId": OWNER,
                     "financeExact": {"operation": "delete_lancamento", "itemId": target["id"], "snapshot": {}}},
        ))
        with self.assertRaises(ValueError):
            await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved"))
        self.assertEqual(1, len(self.entries()))

    def test_destructive_detection(self) -> None:
        self.assertTrue(finance_router.is_finance_destructive_message("apagar o lançamento do mercado"))
        self.assertTrue(finance_router.is_finance_destructive_message("alterar o valor da internet para 150"))
        self.assertFalse(finance_router.is_finance_destructive_message("gastei 30 reais no almoço"))


if __name__ == "__main__":
    unittest.main()
