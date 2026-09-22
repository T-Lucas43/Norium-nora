"""Tarefa 3 (revisão 20/09): proposta derivada fiel, privada e verificada.

A fonte é preservada integralmente; somente os campos pedidos têm o valor
substituído no próprio trecho. Campo ausente, ambíguo ou inseguro gera 422
pedindo o dado indispensável — nunca rascunho enganoso. PDF privado gera
rascunho privado, invisível a outros membros na listagem e na leitura.
Tudo com dados sintéticos.
"""

from __future__ import annotations

import base64
import os
import shutil
import tempfile
import unittest
from io import BytesIO
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException


TEST_DATA_DIR = tempfile.mkdtemp(prefix="norium_pdf_proposal_")
os.environ["NORIUM_DATA_DIR"] = TEST_DATA_DIR

from app.modules.clients.router import ClientCreate, create_client  # noqa: E402
from app.modules.commercial.router import (  # noqa: E402
    export_proposal_pdf,
    get_proposal,
    post_submit,
)
from app.modules.commercial.schemas import (  # noqa: E402
    ProposalCreate,
    ProposalFromPdfRequest,
    ProposalSubmit,
    ProposalUpdate,
)
from app.modules.commercial.service import (  # noqa: E402
    _parse_pdf_amount,
    _verify_generated_pdf_draft,
    collaboration_tenant_id,
    create_proposal,
    create_proposal_from_knowledge_pdf,
    delete_proposal,
    list_commercial_data,
    plain_text,
    submit_proposal,
    update_proposal,
)
from app.modules.commercial.repository import read_store  # noqa: E402
from app.modules.inbox.router import read_events  # noqa: E402
from app.modules.platform.router import upload_knowledge_pdf  # noqa: E402
from app.modules.platform.schemas import KnowledgePdfPayload  # noqa: E402
from app.modules.platform.service import list_collection  # noqa: E402


async def team_events(team_id: str, entity_id: str) -> list[dict]:
    return [
        event
        for event in await read_events(team_id)
        if isinstance(event.get("metadata"), dict)
        and str(event["metadata"].get("entityId")) == entity_id
    ]


SOURCE_PAGES = [
    "Proposta de implantacao: escopo inclui configuracao, treinamento e suporte.",
    "Condicao de pagamento: 30 dias apos o faturamento, sem multa inicial.",
    "Clausula de vigencia: 12 meses a partir da assinatura do contrato.",
]


def make_pdf(pages: list[str]) -> bytes:
    from reportlab.pdfgen import canvas

    buffer = BytesIO()
    doc = canvas.Canvas(buffer)
    for text in pages:
        pos_y = 750
        for line in text.split("\n"):
            if line:
                doc.drawString(72, pos_y, line)
                pos_y -= 14
        doc.showPage()
    doc.save()
    return buffer.getvalue()


def user_for(test_name: str) -> dict:
    return {
        "id": f"pdf-prop-user-{test_name}",
        "nome": "Operador de teste",
        "email": "operador@norium.local",
        "plan": "solo",
        "role": "owner",
    }


class ProposalFromPdfTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)

    async def setup_user(self, pages=None, title="Base sintetica", visibility="workspace"):
        user = user_for(self._testMethodName)
        client = await create_client(
            ClientCreate(name="Cliente Sintetico", email="cliente@empresa.local", document="12345678901"),
            user,
        )
        pdf = make_pdf(pages or SOURCE_PAGES)
        item = (
            await upload_knowledge_pdf(
                KnowledgePdfPayload(
                    fileName="base-sintetica.pdf",
                    dataUrl="data:application/pdf;base64," + base64.b64encode(pdf).decode("ascii"),
                    title=title,
                    visibility=visibility,
                ),
                user,
            )
        )["item"]
        return user, client["item"]["id"], item["id"]

    async def test_substitutes_value_in_place_and_stays_draft(self) -> None:
        user, client_id, document_id = await self.setup_user()
        result = await create_proposal_from_knowledge_pdf(
            user,
            document_id,
            ProposalFromPdfRequest(
                documentId=document_id,
                clientId=client_id,
                fieldOverrides={"pagamento": "15 dias apos o faturamento"},
                amount=15_000,
            ),
        )
        proposal = result["proposal"]
        self.assertEqual("draft", proposal["status"])
        self.assertEqual(15_000, proposal["amount"])
        self.assertIn("pagamento", result["changedFields"])
        body = plain_text(proposal["contentHtml"])
        # Novo valor no próprio trecho, com o rótulo original; antigo some.
        self.assertIn("Condicao de pagamento: 15 dias apos o faturamento.", body)
        self.assertNotIn("30 dias", body)
        # Demais cláusulas intactas.
        self.assertIn("Clausula de vigencia: 12 meses a partir da assinatura do contrato.", body)
        self.assertIn("Proposta de implantacao: escopo inclui configuracao, treinamento e suporte.", body)
        self.assertTrue(result["verified"])
        self.assertEqual(0, result["modelTokensUsed"])
        self.assertEqual("Base sintetica", result["source"]["title"])
        self.assertEqual(3, result["source"]["pageCount"])

    async def test_payload_amount_rewrites_single_price_clause(self) -> None:
        # Reproducao: amount direto precisa sair na clausula de valor do corpo.
        user, client_id, document_id = await self.setup_user(
            pages=["Prazo de entrega: 30 dias.", "Valor total: R$ 10.000."]
        )
        result = await create_proposal_from_knowledge_pdf(
            user,
            document_id,
            ProposalFromPdfRequest(
                documentId=document_id, clientId=client_id, amount=20_000
            ),
        )
        proposal = result["proposal"]
        self.assertEqual(20_000, proposal["amount"])
        body = plain_text(proposal["contentHtml"])
        self.assertIn("Valor total: R$ 20.000", body)
        self.assertNotIn("10.000", body)
        self.assertIn("total da proposta", result["changedFields"])
        self.assertTrue(result["verified"])

    async def test_payload_amount_with_two_price_clauses_asks_clarification(self) -> None:
        # Duas clausulas candidatas: 422 pedindo o esclarecimento, sem rascunho.
        user, client_id, document_id = await self.setup_user(
            pages=["Valor total: R$ 10.000.", "Valor da entrada: R$ 2.000."]
        )
        tenant = collaboration_tenant_id(user)
        before = list(read_store(tenant)["proposals"])
        with self.assertRaises(HTTPException) as ctx:
            await create_proposal_from_knowledge_pdf(
                user,
                document_id,
                ProposalFromPdfRequest(
                    documentId=document_id, clientId=client_id, amount=20_000
                ),
            )
        self.assertEqual(422, ctx.exception.status_code)
        self.assertIn("trechos", str(ctx.exception.detail))
        self.assertEqual(before, list(read_store(tenant)["proposals"]))

    async def test_payload_amount_without_safe_delimiter_asks_clarification(self) -> None:
        # Clausula unica sem delimitacao segura: 422, sem rascunho.
        user, client_id, document_id = await self.setup_user(pages=["Valor 10.000"])
        tenant = collaboration_tenant_id(user)
        before = list(read_store(tenant)["proposals"])
        with self.assertRaises(HTTPException) as ctx:
            await create_proposal_from_knowledge_pdf(
                user,
                document_id,
                ProposalFromPdfRequest(
                    documentId=document_id, clientId=client_id, amount=20_000
                ),
            )
        self.assertEqual(422, ctx.exception.status_code)
        self.assertEqual(before, list(read_store(tenant)["proposals"]))

    async def test_substitution_keeps_rest_of_line(self) -> None:
        # Reprodução P1: trocar o prazo não pode apagar a multa da mesma linha.
        user, client_id, document_id = await self.setup_user(
            pages=["Prazo: 30 dias; Multa: 10%"]
        )
        result = await create_proposal_from_knowledge_pdf(
            user,
            document_id,
            ProposalFromPdfRequest(
                documentId=document_id, clientId=client_id, fieldOverrides={"prazo": "15 dias"}
            ),
        )
        body = plain_text(result["proposal"]["contentHtml"])
        self.assertIn("Prazo: 15 dias; Multa: 10%", body)
        self.assertNotIn("30 dias", body)
        self.assertTrue(result["verified"])
        self.assertEqual([], result["warnings"])

    async def test_long_pdf_keeps_final_clause(self) -> None:
        filler = [
            "Linha de preenchimento numero %d com texto sintetico para alongar o documento alem do limite antigo." % n
            for n in range(90)
        ]
        pages = ["\n".join(filler[:45]), "\n".join(filler[45:]), "Clausula final: foro da comarca central."]
        user, client_id, document_id = await self.setup_user(pages=pages)
        result = await create_proposal_from_knowledge_pdf(
            user,
            document_id,
            ProposalFromPdfRequest(
                documentId=document_id,
                clientId=client_id,
                fieldOverrides={"final": "foro da comarca norte"},
            ),
        )
        body = plain_text(result["proposal"]["contentHtml"])
        self.assertGreater(len(body), 8000)
        self.assertIn("Clausula final: foro da comarca norte", body)
        self.assertNotIn("comarca central", body)
        self.assertIn("Linha de preenchimento numero 0", body)
        self.assertIn("Linha de preenchimento numero 89", body)
        self.assertTrue(result["verified"])

    async def test_missing_field_is_422_asking_for_datum(self) -> None:
        user, client_id, document_id = await self.setup_user()
        with self.assertRaises(HTTPException) as ctx:
            await create_proposal_from_knowledge_pdf(
                user,
                document_id,
                ProposalFromPdfRequest(
                    documentId=document_id,
                    clientId=client_id,
                    fieldOverrides={"garantia estendida": "24 meses"},
                ),
            )
        self.assertEqual(422, ctx.exception.status_code)
        self.assertIn("trecho atual", str(ctx.exception.detail))

    async def test_ambiguous_field_is_422(self) -> None:
        user, client_id, document_id = await self.setup_user(
            pages=["Prazo de entrega: 10 dias.", "Prazo de garantia: 20 dias."]
        )
        with self.assertRaises(HTTPException) as ctx:
            await create_proposal_from_knowledge_pdf(
                user,
                document_id,
                ProposalFromPdfRequest(
                    documentId=document_id, clientId=client_id, fieldOverrides={"prazo": "30 dias"}
                ),
            )
        self.assertEqual(422, ctx.exception.status_code)
        self.assertIn("2 trechos", str(ctx.exception.detail))

    async def test_unsafe_line_is_422(self) -> None:
        user, client_id, document_id = await self.setup_user(
            pages=["Prazo de entrega 30 dias sem separador"]
        )
        with self.assertRaises(HTTPException) as ctx:
            await create_proposal_from_knowledge_pdf(
                user,
                document_id,
                ProposalFromPdfRequest(
                    documentId=document_id, clientId=client_id, fieldOverrides={"prazo": "15 dias"}
                ),
            )
        self.assertEqual(422, ctx.exception.status_code)
        self.assertIn("seguranca", str(ctx.exception.detail))

    async def setup_team(self, suffix: str):
        owner = {"id": f"team-owner-{suffix}", "nome": "Dono", "email": "dono@norium.local", "role": "owner"}
        member = {
            "id": f"team-member-{suffix}",
            "teamOwnerId": f"team-owner-{suffix}",
            "nome": "Membro",
            "email": "membro@norium.local",
            "role": "member",
        }
        client = await create_client(
            ClientCreate(name="Cliente do Membro", email="m@empresa.local", document="12345678901"),
            member,
        )
        return owner, member, client["item"]["id"]

    async def derive_member_draft(self, member, client_id, visibility="private"):
        pdf = make_pdf(SOURCE_PAGES)
        item = (
            await upload_knowledge_pdf(
                KnowledgePdfPayload(
                    fileName="base.pdf",
                    dataUrl="data:application/pdf;base64," + base64.b64encode(pdf).decode("ascii"),
                    title="PDF do membro",
                    visibility=visibility,
                ),
                member,
            )
        )["item"]
        return await create_proposal_from_knowledge_pdf(
            member,
            item["id"],
            ProposalFromPdfRequest(
                documentId=item["id"],
                clientId=client_id,
                fieldOverrides={"pagamento": "15 dias"},
            ),
        )

    async def test_any_source_yields_private_draft(self) -> None:
        # muse.md: toda proposta derivada de PDF nasce em rascunho privado.
        for visibility in ("private", "workspace"):
            _owner, member, client_id = await self.setup_team(f"priv-{visibility}")
            result = await self.derive_member_draft(member, client_id, visibility=visibility)
            self.assertEqual("private", result["visibility"], visibility)
            self.assertEqual("private", result["proposal"]["visibility"], visibility)

    async def test_private_draft_hidden_from_owner_actions(self) -> None:
        owner, member, client_id = await self.setup_team("hidden")
        result = await self.derive_member_draft(member, client_id)
        proposal_id = result["proposal"]["id"]
        owner_data = await list_commercial_data(owner)
        self.assertEqual([], [p for p in owner_data["proposals"] if p["id"] == proposal_id])
        with self.assertRaises(HTTPException) as ctx:
            await get_proposal(proposal_id, owner)
        self.assertEqual(404, ctx.exception.status_code)
        with self.assertRaises(HTTPException) as ctx:
            await export_proposal_pdf(proposal_id, owner)
        self.assertEqual(404, ctx.exception.status_code)
        with self.assertRaises(HTTPException) as ctx:
            await update_proposal(owner, proposal_id, ProposalUpdate(title="Tentativa do dono"))
        self.assertEqual(404, ctx.exception.status_code)
        with self.assertRaises(HTTPException) as ctx:
            await delete_proposal(owner, proposal_id)
        self.assertEqual(404, ctx.exception.status_code)
        with self.assertRaises(HTTPException) as ctx:
            await submit_proposal(owner, proposal_id, "")
        self.assertEqual(404, ctx.exception.status_code)
        # Autor lista e lê.
        member_data = await list_commercial_data(member)
        self.assertEqual(1, len([p for p in member_data["proposals"] if p["id"] == proposal_id]))
        seen = await get_proposal(proposal_id, member)
        self.assertEqual(proposal_id, seen["proposal"]["id"])

    async def test_private_submit_blocked_without_team_notification(self) -> None:
        owner, member, client_id = await self.setup_team("lifecycle")
        result = await self.derive_member_draft(member, client_id)
        proposal_id = result["proposal"]["id"]
        with self.assertRaises(HTTPException) as ctx:
            await post_submit(proposal_id, ProposalSubmit(note=""), member)
        self.assertEqual(409, ctx.exception.status_code)
        self.assertEqual("draft", read_store(collaboration_tenant_id(member))["proposals"][0]["status"])
        self.assertEqual([], await team_events(owner["id"], proposal_id))
        with self.assertRaises(HTTPException) as ctx:
            await get_proposal(proposal_id, owner)
        self.assertEqual(404, ctx.exception.status_code)

    async def test_explicit_transition_to_team_then_review(self) -> None:
        owner, member, client_id = await self.setup_team("transition")
        result = await self.derive_member_draft(member, client_id)
        proposal_id = result["proposal"]["id"]
        # Transição explícita e autorizada: só o autor torna visível à equipe.
        with self.assertRaises(HTTPException) as ctx:
            await update_proposal(owner, proposal_id, ProposalUpdate(visibility="team"))
        self.assertEqual(404, ctx.exception.status_code)
        flipped = await update_proposal(member, proposal_id, ProposalUpdate(visibility="team"))
        self.assertEqual("team", flipped["visibility"])
        submitted = await post_submit(proposal_id, ProposalSubmit(note="revisar"), member)
        self.assertIn(submitted["proposal"]["status"], ("in_review", "approved"))
        members = [owner, member]
        with patch(
            "app.modules.team.router.visible_team_members", new=AsyncMock(return_value=members)
        ):
            seen = await get_proposal(proposal_id, owner)
        self.assertEqual(proposal_id, seen["proposal"]["id"])
        if submitted["proposal"]["status"] == "in_review":
            # Eventos sao por usuario na main: o recibo da submissao fica na caixa do autor.
            self.assertTrue(len(await team_events(member["id"], proposal_id)) >= 1)

    async def test_team_visibility_does_not_bypass_explicit_access(self) -> None:
        owner = {"id": "team-owner-team", "nome": "Dono", "email": "dono@norium.local", "role": "owner"}
        member = {
            "id": "team-member-team",
            "teamOwnerId": "team-owner-team",
            "nome": "Membro",
            "email": "membro@norium.local",
            "role": "member",
        }
        client = await create_client(
            ClientCreate(name="Cliente Equipe", email="e@empresa.local", document="12345678901"),
            member,
        )
        proposal = await create_proposal(
            member,
            ProposalCreate(clientId=client["item"]["id"], title="Proposta normal da equipe"),
        )
        self.assertEqual("team", proposal["visibility"])
        # Na base atual, visibility descreve o estado do documento; acesso entre
        # membros continua exigindo compartilhamento explícito em access.
        member_data = await list_commercial_data(member)
        self.assertIn(proposal["id"], [p["id"] for p in member_data["proposals"]])
        seen = await get_proposal(proposal["id"], member)
        self.assertEqual(proposal["id"], seen["proposal"]["id"])
        visible_members = [owner, member]
        with patch(
            "app.modules.team.router.visible_team_members", new=AsyncMock(return_value=visible_members)
        ):
            owner_data = await list_commercial_data(owner)
            self.assertNotIn(proposal["id"], [p["id"] for p in owner_data["proposals"]])
            with self.assertRaises(HTTPException) as ctx:
                await get_proposal(proposal["id"], owner)
        self.assertEqual(404, ctx.exception.status_code)

    async def test_visibility_flip_requires_creator(self) -> None:
        owner, member, client_id = await self.setup_team("flip")
        peer = {
            "id": "team-peer-flip",
            "teamOwnerId": owner["id"],
            "nome": "Colega",
            "email": "colega@norium.local",
            "role": "member",
        }
        proposal = await create_proposal(
            member,
            ProposalCreate(clientId=client_id, title="Proposta do membro"),
        )
        members = [owner, member, peer]
        with patch(
            "app.modules.team.router.visible_team_members", new=AsyncMock(return_value=members)
        ):
            with self.assertRaises(HTTPException) as ctx:
                await update_proposal(peer, proposal["id"], ProposalUpdate(visibility="private"))
        self.assertEqual(403, ctx.exception.status_code)
        flipped = await update_proposal(member, proposal["id"], ProposalUpdate(visibility="private"))
        self.assertEqual("private", flipped["visibility"])
        owner_data = await list_commercial_data(owner)
        self.assertEqual([], [p for p in owner_data["proposals"] if p["id"] == proposal["id"]])

    async def test_original_pdf_is_not_overwritten(self) -> None:
        user, client_id, document_id = await self.setup_user()
        before = await list_collection(user, "knowledge")
        await create_proposal_from_knowledge_pdf(
            user,
            document_id,
            ProposalFromPdfRequest(
                documentId=document_id, clientId=client_id, title="Proposta com novo titulo"
            ),
        )
        after = await list_collection(user, "knowledge")
        self.assertEqual(before, after)
        store = read_store(user["id"])
        self.assertEqual(1, len(store["proposals"]))
        self.assertEqual("Proposta com novo titulo", store["proposals"][0]["title"])
        self.assertEqual("draft", store["proposals"][0]["status"])

    async def test_other_tenant_cannot_derive(self) -> None:
        _owner, _client_id, document_id = await self.setup_user()
        intruder = user_for(f"{self._testMethodName}-intruder")
        intruder_client = await create_client(
            ClientCreate(name="Outro Cliente", email="outro@empresa.local", document="99999999999"),
            intruder,
        )
        with self.assertRaises(HTTPException) as ctx:
            await create_proposal_from_knowledge_pdf(
                intruder,
                document_id,
                ProposalFromPdfRequest(
                    documentId=document_id, clientId=intruder_client["item"]["id"]
                ),
            )
        self.assertEqual(404, ctx.exception.status_code)

    async def test_non_pdf_document_is_404(self) -> None:
        user, client_id, _document_id = await self.setup_user()
        with self.assertRaises(HTTPException) as ctx:
            await create_proposal_from_knowledge_pdf(
                user,
                "knowledge_inexistente",
                ProposalFromPdfRequest(documentId="knowledge_inexistente", clientId=client_id),
            )
        self.assertEqual(404, ctx.exception.status_code)


class VerifyDraftTests(unittest.TestCase):
    LINES = ["Primeira clausula: valor X.", "Segunda clausula: prazo Y."]

    def test_ok(self) -> None:
        plain = "Primeira clausula: valor X. Segunda clausula: prazo Z."
        verified, warnings = _verify_generated_pdf_draft(
            self.LINES, {1: "Segunda clausula: prazo Z."}, {}, plain, ["prazo Z"]
        )
        self.assertTrue(verified)
        self.assertEqual([], warnings)

    def test_old_condition_remaining_fails(self) -> None:
        plain = "Primeira clausula: valor X. Segunda clausula: prazo Y. Segunda clausula: prazo Z."
        verified, warnings = _verify_generated_pdf_draft(
            self.LINES, {1: "Segunda clausula: prazo Z."}, {}, plain, ["prazo Z"]
        )
        self.assertFalse(verified)
        self.assertTrue(any("antigas" in warning for warning in warnings))

    def test_dropped_preserved_clause_fails(self) -> None:
        # A linha foi trocada mas o restante ("Multa: 10%") sumiu do rascunho.
        lines = ["Prazo: 30 dias; Multa: 10%"]
        plain = "Prazo: 15 dias"
        verified, warnings = _verify_generated_pdf_draft(
            lines, {0: "Prazo: 15 dias"}, {0: "; Multa: 10%"}, plain, ["15 dias"]
        )
        self.assertFalse(verified)
        self.assertTrue(any("preservada" in warning for warning in warnings))

    def test_omitted_source_fails(self) -> None:
        plain = "Segunda clausula: prazo Z."
        verified, warnings = _verify_generated_pdf_draft(
            self.LINES, {1: "Segunda clausula: prazo Z."}, {}, plain, ["prazo Z"]
        )
        self.assertFalse(verified)
        self.assertTrue(any("ausentes" in warning for warning in warnings))


class ParsePdfAmountTests(unittest.TestCase):
    def test_brazilian_formats(self) -> None:
        self.assertEqual(20_000, _parse_pdf_amount("R$ 20.000"))
        self.assertEqual(20_000.5, _parse_pdf_amount("R$ 20.000,50"))
        self.assertEqual(20_000.5, _parse_pdf_amount("R$ 20000,50"))
        self.assertEqual(20.5, _parse_pdf_amount("20,5"))
        self.assertEqual(20_000, _parse_pdf_amount("20000"))
        self.assertEqual(1_234_567, _parse_pdf_amount("1.234.567"))
        self.assertEqual(1_234_567.89, _parse_pdf_amount("1.234.567,89"))

    def test_ambiguous_or_invalid_asks_clarification(self) -> None:
        for raw in (
            "",
            "R$",
            "abc",
            "20.00",
            "20.5",
            "20.0000",
            "20,123",
            "1,2,3",
            "1.234,567",
            "1,234.56",
            "20.000,50.25",
            "-5",
            "999.999.999.999",
        ):
            with self.subTest(raw=raw):
                self.assertIsNone(_parse_pdf_amount(raw))


if __name__ == "__main__":
    unittest.main()
