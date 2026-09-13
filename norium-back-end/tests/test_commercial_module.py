from __future__ import annotations

import os
import base64
import io
import json
import re
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException


TEST_DATA_DIR = tempfile.mkdtemp(prefix="norium_commercial_")
os.environ["NORIUM_DATA_DIR"] = TEST_DATA_DIR

from app.modules.clients.router import ClientCreate, create_client  # noqa: E402
from app.modules.commercial.schemas import (  # noqa: E402
    ContractUpdate,
    DocumentDuplicateRequest,
    DocumentImportRequest,
    InstantiateObligationsRequest,
    ProposalBriefRequest,
    ProposalCreate,
    ProposalPdfUpload,
    ProposalStatusChange,
    ProposalUpdate,
    SignatureRequest,
    SignerInput,
    SmartDocumentRequest,
    TemplateCreate,
    TemplateUpdate,
    PdfProcessRequest,
)
from app.modules.commercial.document_files import (  # noqa: E402
    create_processing_job,
    import_document,
    pdf_capabilities,
    run_processing_job,
    update_imported_document,
)
from app.modules.commercial.schemas import ImportedDocumentUpdate  # noqa: E402
from pypdf import PdfReader, PdfWriter  # noqa: E402
from app.modules.commercial.nora_agent import _extract_amount, handle_commercial_agent, is_document_creation_request  # noqa: E402
from app.modules.commercial.pdf_export import build_commercial_pdf  # noqa: E402
from app.services.nora_files import list_library_files  # noqa: E402
from app.modules.commercial.repository import read_store, write_store  # noqa: E402
from app.modules.commercial.service import (  # noqa: E402
    _briefing_sentence_count,
    _draft_requires_expansion,
    _ensure_briefing_detail,
    _parse_briefing_response,
    _proposal_html_from_briefing,
    cancel_contract,
    change_proposal_status,
    create_contract,
    create_proposal,
    create_smart_document,
    create_template,
    delete_template,
    decide_suggestion,
    decide_proposal,
    duplicate_proposal,
    duplicate_template,
    delete_contract,
    document_for_response,
    instantiate_obligations,
    list_commercial_data,
    replace_visible_text,
    public_signature_data,
    send_for_signature,
    sign_contract_public,
    sign_contract,
    signature_links,
    submit_proposal,
    update_template,
    update_contract,
    update_proposal,
    upload_proposal_pdf,
    standard_templates,
)


class CommercialModuleTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)

    async def asyncSetUp(self) -> None:
        self.user = {
            "id": f"user-{self._testMethodName}",
            "nome": "Operador de teste",
            "email": "operador@norium.local",
            "plan": "solo",
            "role": "owner",
        }
        response = await create_client(
            ClientCreate(
                name="Cliente Comercial",
                email="cliente@empresa.local",
                document="12345678901",
            ),
            self.user,
        )
        self.client_id = response["item"]["id"]

    def proposal_pdf_payload(self, *, signed=False, expected_version=None):
        output = io.BytesIO()
        from reportlab.pdfgen import canvas
        page = canvas.Canvas(output, pagesize=(600, 800))
        page.drawString(60, 700, "Proposta original do cliente")
        if signed:
            page.drawString(60, 200, "Assinatura recebida: Cliente Teste")
        page.save()
        return ProposalPdfUpload(fileName="proposta-assinada.pdf" if signed else "proposta.pdf", dataBase64=base64.b64encode(output.getvalue()).decode(), title="Proposta importada", clientId=self.client_id, signed=signed, expectedVersion=expected_version), output.getvalue()

    async def test_imported_proposal_edits_and_signed_upload_update_counts(self):
        from app.modules.commercial.pdf_export import build_commercial_pdf
        from app.modules.commercial.document_files import delete_imported_document, document_path
        from fastapi import HTTPException
        payload, original_bytes = self.proposal_pdf_payload()
        proposal = await upload_proposal_pdf(self.user, payload)
        self.assertEqual(proposal["status"], "draft")
        original_id = proposal["sourceDocumentId"]
        original_export, _ = build_commercial_pdf(proposal, "proposal", tenant_id=self.user["id"])
        self.assertEqual(original_export, original_bytes)
        edits = {"layers": [{"id":"text", "type":"text", "page":0, "x":.1, "y":.4, "width":.5, "height":.1, "text":"Condicao negociada"}]}
        proposal = await update_proposal(self.user, proposal["id"], ProposalUpdate(expectedVersion=proposal["version"], pdfEdits=edits))
        edited_export, _ = build_commercial_pdf(proposal, "proposal", tenant_id=self.user["id"])
        self.assertIn("Condicao negociada", PdfReader(io.BytesIO(edited_export)).pages[0].extract_text())
        for status in ["approved", "awaiting_signatures"]:
            proposal = await change_proposal_status(self.user, proposal["id"], ProposalStatusChange(status=status, expectedVersion=proposal["version"]))
        self.assertEqual((await list_commercial_data(self.user))["summary"]["awaitingSignatureCount"], 1)
        with self.assertRaises(HTTPException) as missing_evidence:
            await change_proposal_status(self.user, proposal["id"], ProposalStatusChange(status="signed"))
        self.assertEqual(missing_evidence.exception.status_code, 422)
        signed_payload, signed_bytes = self.proposal_pdf_payload(signed=True, expected_version=proposal["version"])
        proposal = await upload_proposal_pdf(self.user, signed_payload, proposal["id"])
        self.assertEqual(proposal["status"], "signed")
        self.assertEqual(len(proposal["fileVersions"]), 2)
        counts = (await list_commercial_data(self.user))["summary"]
        self.assertEqual((counts["documentCount"], counts["awaitingSignatureCount"], counts["signedCount"]), (1, 0, 1))
        signed_export, _ = build_commercial_pdf(proposal, "proposal", tenant_id=self.user["id"])
        self.assertEqual(signed_export, signed_bytes)
        stored = read_store(self.user["id"])
        original = next(file for file in stored["uploadedDocuments"] if file["id"] == original_id)
        self.assertEqual(document_path(self.user["id"], original).read_bytes(), original_bytes)
        edited_id = proposal["fileVersions"][1]["editedDocumentId"]
        edited_history = next(file for file in stored["uploadedDocuments"] if file["id"] == edited_id)
        self.assertIn("Condicao negociada", PdfReader(document_path(self.user["id"], edited_history)).pages[0].extract_text())
        with self.assertRaises(HTTPException) as locked:
            await update_proposal(self.user, proposal["id"], ProposalUpdate(expectedVersion=proposal["version"], pdfEdits=edits))
        self.assertEqual(locked.exception.status_code, 409)
        with self.assertRaises(HTTPException):
            await delete_imported_document(self.user["id"], original_id)
        new_payload, _ = self.proposal_pdf_payload(expected_version=proposal["version"])
        proposal = await upload_proposal_pdf(self.user, new_payload, proposal["id"])
        self.assertEqual(proposal["status"], "draft")
        self.assertIsNone(proposal["signedDocumentId"])
        self.assertEqual(len(proposal["fileVersions"]), 3)
        self.assertEqual((await list_commercial_data(self.user))["summary"]["signedCount"], 0)

    async def test_existing_proposal_upload_rejects_stale_foreign_invalid_and_locked_pdf(self):
        from fastapi import HTTPException
        proposal = await create_proposal(self.user, ProposalCreate(clientId=self.client_id, title="Proposta existente"))
        payload, _ = self.proposal_pdf_payload(expected_version=proposal["version"])
        uploaded = await upload_proposal_pdf(self.user, payload, proposal["id"])
        self.assertEqual(uploaded["id"], proposal["id"])
        self.assertEqual(uploaded["title"], proposal["title"])
        self.assertEqual(uploaded["revisions"][0]["contentHtml"], proposal["contentHtml"])
        for actor, request, target, code in [
            (self.user, payload, proposal["id"], 409),
            ({**self.user,"id":"foreign-tenant"}, payload, proposal["id"], 404),
            (self.user, payload.model_copy(update={"dataBase64":base64.b64encode(b"%PDF-invalid").decode()}), None, 422),
        ]:
            with self.assertRaises(HTTPException) as failure:
                await upload_proposal_pdf(actor, request, target)
            self.assertEqual(failure.exception.status_code, code)
        writer = PdfWriter(); writer.add_blank_page(width=600,height=800); writer.encrypt("test-password")
        content = io.BytesIO(); writer.write(content)
        with self.assertRaises(HTTPException) as encrypted:
            await upload_proposal_pdf(self.user, payload.model_copy(update={"dataBase64":base64.b64encode(content.getvalue()).decode()}))
        self.assertEqual(encrypted.exception.status_code, 422)
        self.assertEqual(len(read_store(self.user["id"])["uploadedDocuments"]), 1)

    async def test_visual_pdf_edits_persist_with_proposal_version_control(self) -> None:
        from app.modules.commercial.pdf_export import build_commercial_pdf
        from fastapi import HTTPException
        proposal = await create_proposal(self.user, ProposalCreate(clientId=self.client_id, title="Proposta com assinatura", contentHtml="<p>Documento de teste</p>"))
        edits = {"layers": [{"id": "visual-text", "type": "text", "page": 0, "x": .15, "y": .55, "width": .5, "height": .1, "text": "Revisao visual persistida"}]}
        updated = await update_proposal(self.user, proposal["id"], ProposalUpdate(expectedVersion=proposal["version"], pdfEdits=edits))
        stored = next(item for item in read_store(self.user["id"])["proposals"] if item["id"] == proposal["id"])
        self.assertEqual(stored["pdfEdits"]["layers"][0]["y"], .55)
        data, _ = build_commercial_pdf(stored, "proposal")
        self.assertIn("Revisao visual persistida", PdfReader(io.BytesIO(data)).pages[0].extract_text())
        with self.assertRaises(HTTPException) as conflict:
            await update_proposal(self.user, proposal["id"], ProposalUpdate(expectedVersion=proposal["version"], pdfEdits=edits))
        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(updated["version"], proposal["version"] + 1)
        invalid_edits = {"layers": [{**edits["layers"][0], "page": 99}]}
        with self.assertRaises(HTTPException) as invalid:
            await update_proposal(self.user, proposal["id"], ProposalUpdate(expectedVersion=updated["version"], pdfEdits=invalid_edits))
        self.assertEqual(invalid.exception.status_code, 422)


    async def test_solo_pipeline_sanitizes_content_and_instantiates_tasks(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Implantacao Norium",
                contentHtml="<h1>Escopo</h1><script>alert('xss')</script><p>Entrega em 30 dias com duas revisoes.</p>",
                scopeSummary="Implantacao completa",
                amount=12_500,
                signers=[
                    SignerInput(
                        name="Cliente Comercial",
                        email="cliente@empresa.local",
                        role="client",
                        order=1,
                    ),
                ],
                deliverables=[
                    {
                        "title": "Configuracao inicial",
                        "description": "Configurar o ambiente contratado.",
                        "createCalendarEvent": False,
                    },
                ],
            ),
        )
        self.assertNotIn("<script", proposal["contentHtml"])
        self.assertIn("Entrega em 30 dias", proposal["contentHtml"])

        updated = await update_proposal(
            self.user,
            proposal["id"],
            ProposalUpdate(expectedVersion=1, title="Implantacao Norium revisada"),
        )
        self.assertEqual(updated["version"], 2)
        self.assertEqual(len(updated["revisions"]), 1)

        approved = await submit_proposal(self.user, proposal["id"], "Fluxo Solo")
        self.assertEqual(approved["status"], "approved")

        contract, converted = await create_contract(self.user, proposal["id"], None)
        self.assertEqual(converted["status"], "contracted")
        self.assertEqual(contract["proposalId"], proposal["id"])
        self.assertEqual(contract["client"]["id"], self.client_id)

        contract = await update_contract(
            self.user,
            contract["id"],
            ContractUpdate(expectedVersion=1, title="Contrato de Implantacao Norium"),
        )
        contract = await send_for_signature(self.user, contract["id"])
        self.assertEqual(contract["status"], "awaiting_signatures")

        signer = contract["signers"][0]
        contract = await sign_contract(
            self.user["id"],
            contract["id"],
            signer["id"],
            SignatureRequest(
                name="Cliente Comercial",
                email="cliente@empresa.local",
                consent=True,
            ),
            ip="127.0.0.1",
            user_agent="Norium Test",
            actor_id=self.user["id"],
        )
        self.assertEqual(contract["status"], "signed")
        self.assertNotIn("cliente@empresa.local", contract["auditTrail"][0]["emailHash"])

        instantiated = await instantiate_obligations(
            self.user,
            contract["id"],
            InstantiateObligationsRequest(
                projectId="default",
                projectName="Contrato",
                createCalendarEvents=False,
            ),
        )
        self.assertEqual(instantiated["contract"]["status"], "active")
        self.assertEqual(len(instantiated["tasks"]), 1)

    async def test_commercial_list_is_compact_and_details_do_not_repeat_revision_logos(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Proposta leve",
                contentHtml="<p>Conteudo completo carregado apenas no editor.</p>",
            ),
        )
        large_logo = "data:image/png;base64," + ("A" * 400_000)
        store = read_store(self.user["id"])
        stored = next(item for item in store["proposals"] if item["id"] == proposal["id"])
        stored["branding"]["logoUrl"] = large_logo
        stored["revisions"] = [
            {
                "id": "revision_legacy",
                "version": 1,
                "title": stored["title"],
                "contentHtml": stored["contentHtml"],
                "branding": {**stored["branding"]},
                "savedBy": "Teste",
                "savedById": self.user["id"],
                "savedAt": stored["updatedAt"],
            }
        ]
        await write_store(self.user["id"], store)

        full_size = len(json.dumps(store, ensure_ascii=False))
        commercial = await list_commercial_data(self.user)
        list_size = len(json.dumps(commercial, ensure_ascii=False))
        listed = commercial["proposals"][0]

        self.assertEqual(listed["documentType"], "proposal")
        self.assertEqual(listed["primaryColor"], stored["branding"]["primaryColor"])
        for heavy_field in ("contentHtml", "revisions", "branding", "signers", "deliverables"):
            self.assertNotIn(heavy_field, listed)
        self.assertLess(list_size, full_size // 5)

        detail = document_for_response(stored)
        self.assertEqual(detail["branding"]["logoUrl"], large_logo)
        self.assertNotIn("logoUrl", detail["revisions"][0]["branding"])

        updated = await update_proposal(
            self.user,
            proposal["id"],
            ProposalUpdate(expectedVersion=1, title="Proposta leve revisada"),
        )
        self.assertTrue(updated["revisions"])
        self.assertTrue(all("logoUrl" not in item["branding"] for item in updated["revisions"]))

    async def test_contract_draft_can_be_deleted_and_formal_contract_is_cancelled(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Contrato com ciclo de vida",
                contentHtml="<p>Escopo comercial aprovado.</p>",
            ),
        )
        approved = await submit_proposal(self.user, proposal["id"], "Fluxo Solo")
        draft, _ = await create_contract(self.user, approved["id"], None)

        removed, restored = await delete_contract(self.user, draft["id"])
        self.assertEqual(removed["status"], "draft")
        self.assertEqual(restored["status"], "approved")
        self.assertIsNone(restored["contractId"])

        recreated, _ = await create_contract(self.user, approved["id"], None)
        cancelled = await cancel_contract(self.user, recreated["id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["auditTrail"][0]["action"], "contract_cancelled")
        with self.assertRaisesRegex(Exception, "Somente minutas"):
            await delete_contract(self.user, cancelled["id"])

    async def test_nora_requires_confirmation_and_then_cancels_contract(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Contrato cancelado pela Nora",
                contentHtml="<p>Escopo aprovado.</p>",
            ),
        )
        approved = await submit_proposal(self.user, proposal["id"], "Fluxo Solo")
        contract, _ = await create_contract(self.user, approved["id"], None)

        preview = await handle_commercial_agent(self.user, f"Cancele o contrato {contract['title']}")
        self.assertEqual(preview["status"], "precisa_confirmacao")

        executed = await handle_commercial_agent(
            self.user,
            f"Cancelar definitivamente o contrato {contract['title']}",
        )
        self.assertEqual(executed["status"], "cancelado")
        self.assertEqual(executed["contract"]["status"], "cancelled")

    async def test_enterprise_requires_explicit_approval(self) -> None:
        enterprise_user = {**self.user, "plan": "enterprise"}
        proposal = await create_proposal(
            enterprise_user,
            ProposalCreate(
                clientId=self.client_id,
                title="Projeto Enterprise",
                contentHtml="<p>Escopo empresarial com prazo, aceite e revisoes.</p>",
            ),
        )
        submitted = await submit_proposal(enterprise_user, proposal["id"], "")
        self.assertEqual(submitted["status"], "in_review")

        approved = await decide_proposal(
            enterprise_user,
            proposal["id"],
            approved=True,
            note="Aprovado pelo gestor",
        )
        self.assertEqual(approved["status"], "approved")
        self.assertEqual(approved["approval"]["decisionNote"], "Aprovado pelo gestor")

    async def test_public_signature_link_opens_and_registers_audited_signature(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Proposta com assinatura publica",
                contentHtml="<h1>Escopo</h1><p>Documento pronto para assinatura.</p>",
                signers=[
                    SignerInput(
                        name="Cliente Comercial",
                        email="cliente@empresa.local",
                        role="client",
                        order=1,
                    ),
                ],
            ),
        )
        await submit_proposal(self.user, proposal["id"], "")
        contract, _ = await create_contract(self.user, proposal["id"], None)
        contract = await send_for_signature(self.user, contract["id"])

        links = signature_links(self.user["id"], contract, "http://127.0.0.1:5173")
        self.assertEqual(len(links), 1)
        token = links[0]["url"].rsplit("/", 1)[-1]
        invitation = public_signature_data(token)
        self.assertEqual(invitation["contract"]["id"], contract["id"])
        self.assertEqual(invitation["signer"]["email"], "cliente@empresa.local")

        signed = await sign_contract_public(
            token,
            SignatureRequest(
                name="Cliente Comercial",
                email="cliente@empresa.local",
                consent=True,
            ),
            ip="127.0.0.1",
            user_agent="Norium Public Signature Test",
        )
        self.assertEqual(signed["status"], "signed")
        self.assertEqual(signed["signers"][0]["status"], "signed")
        self.assertEqual(signed["auditTrail"][0]["action"], "contract_signed")
        self.assertEqual(signed["auditTrail"][0]["ip"], "127.0.0.1")
        self.assertNotIn("cliente@empresa.local", signed["auditTrail"][0]["emailHash"])

    async def test_nora_simple_command_starts_commercial_session(self) -> None:
        result = await handle_commercial_agent(self.user, "quero criar uma proposta")
        self.assertEqual(result["status"], "precisa_dados")
        self.assertTrue(str(result.get("session_id") or "").startswith("commercial_"))
        self.assertIn("cliente", result["response"].lower())

    async def test_nora_corrects_stale_year_regenerates_pdf_and_saves_it_to_library(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Proposta de marketing",
                contentHtml="<h1>Proposta 2024</h1><p>Campanha planejada para 2024.</p>",
            ),
        )

        result = await handle_commercial_agent(self.user, "Estamos em 2026; corrija o ano na proposta.")

        self.assertEqual(result["status"], "editada")
        self.assertNotIn("2024", result["proposal"]["contentHtml"])
        self.assertIn("2026", result["proposal"]["contentHtml"])
        self.assertEqual(result["proposal"]["id"], proposal["id"])
        self.assertTrue(result["files"][0]["inLibrary"])
        self.assertIn(result["files"][0]["id"], [item["id"] for item in list_library_files(self.user["id"])])

    async def test_nora_lists_the_real_document_catalog_as_markdown_tables(self) -> None:
        for question in ("Quais modelos de documento você sabe fazer?", "Que documentos você pode gerar?"):
            with self.subTest(question=question):
                result = await handle_commercial_agent(self.user, question)
                self.assertEqual(result["status"], "consulta")
                self.assertIn("## Comercial", result["response"])
                self.assertIn("| Tipo | Modelos disponíveis |", result["response"])
                self.assertIn("Currículo", result["response"])
                self.assertIn("Roteiro de apresentação executiva", result["response"])
                self.assertNotIn("Google Slides", result["response"])

    async def test_nora_requests_only_blocking_data_for_a_presentation(self) -> None:
        result = await handle_commercial_agent(self.user, "quero uma apresentação")

        self.assertEqual(result["status"], "precisa_dados")
        self.assertEqual(result["template"]["id"], "standard_custom_apresentacao_executiva")
        self.assertIn("tema", result["response"].lower())
        self.assertIn("pdf", result["response"].lower())
        self.assertIn("powerpoint", result["response"].lower())

    def test_nora_understands_a_typo_in_a_document_creation_request(self) -> None:
        self.assertTrue(is_document_creation_request("querer uma proposta de desenvolvimento de software"))

    def test_nora_preserves_written_monetary_multipliers(self) -> None:
        cases = {
            "proposta no valor de 5 mil reais": 5_000,
            "orçamento de R$ 5,5 mil": 5_500,
            "contrato de 2 milhões": 2_000_000,
            "projeto por R$ 12.800,00": 12_800,
            "projeto por R$ 5.000": 5_000,
            "proposta para 2026 por 5 mil": 5_000,
            "serviço de 8k": 8_000,
        }
        for message, expected in cases.items():
            with self.subTest(message=message):
                self.assertEqual(_extract_amount(message), expected)

    async def test_nora_sends_full_written_amount_to_document_creation(self) -> None:
        document = {"id": "proposal-value", "title": "Proposta de site", "amount": 5_000}
        artifact = {"id": "file-value", "mimeType": "application/pdf", "inLibrary": True}
        with patch(
            "app.modules.commercial.nora_agent.create_smart_document",
            new=AsyncMock(return_value=(document, artifact)),
        ) as create_document:
            result = await handle_commercial_agent(
                self.user,
                "Crie uma proposta comercial de site para Cliente Comercial no valor de 5 mil reais.",
            )

        self.assertEqual(result["status"], "criada")
        self.assertEqual(create_document.await_args.args[1].amount, 5_000)

    def test_pdf_replaces_unsupported_hyphens_without_breaking_portuguese_accents(self) -> None:
        pdf_bytes, _ = build_commercial_pdf(
            {
                "title": "Informações de contato",
                "contentHtml": "<h2>Informações de contato</h2><p>E‑mail: criação@exemplo.com</p>",
                "metadata": {"documentType": "proposal"},
                "branding": {},
            },
            "proposal",
        )
        extracted = "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf_bytes)).pages)
        self.assertIn("E-mail", extracted)
        self.assertIn("criação@exemplo.com", extracted)
        self.assertNotIn("■", extracted)

    async def test_consecutive_nora_suggestions_are_idempotent(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Proposta com revisoes",
                contentHtml="<h2>Escopo</h2><p>Entrega inicial.</p><p>Suporte basico.</p>",
            ),
        )
        store = read_store(self.user["id"])
        stored = next(item for item in store["proposals"] if item["id"] == proposal["id"])
        stored["suggestions"] = [
            {
                "id": "suggestion_one",
                "original": "Entrega inicial.",
                "replacement": "Entrega inicial com critérios de aceite.",
                "reason": "Tornar o aceite verificável.",
                "severity": "info",
                "status": "pending",
            },
            {
                "id": "suggestion_two",
                "original": "Suporte basico.",
                "replacement": "Suporte básico durante o período definido.",
                "reason": "Delimitar o suporte.",
                "severity": "warning",
                "status": "pending",
            },
        ]
        await write_store(self.user["id"], store)

        first = await decide_suggestion(self.user, proposal["id"], "suggestion_one", "accepted")
        second = await decide_suggestion(self.user, proposal["id"], "suggestion_two", "accepted")
        repeated = await decide_suggestion(self.user, proposal["id"], "suggestion_one", "accepted")

        self.assertIn("critérios de aceite", first["contentHtml"])
        self.assertIn("Suporte básico", second["contentHtml"])
        self.assertEqual(repeated["version"], second["version"])

    def test_nora_replacement_preserves_rich_text_block_structure(self) -> None:
        content = (
            "<h2>Escopo</h2>"
            "<p>Primeira parte do escopo.</p>"
            "<p>Segunda parte do escopo.</p>"
            "<h2>Entregaveis</h2>"
        )

        updated, applied = replace_visible_text(
            content,
            "Primeira parte do escopo. Segunda parte do escopo.",
            "Escopo detalhado, com atividades e criterios de aceite.",
        )

        self.assertTrue(applied)
        self.assertIn(
            "<p>Escopo detalhado, com atividades e criterios de aceite.</p><p></p>",
            updated,
        )
        self.assertEqual(updated.count("<h2>"), 2)
        self.assertIn("<h2>Entregaveis</h2>", updated)

    def test_nora_replacement_keeps_heading_and_body_styles_separate(self) -> None:
        content = (
            "<h2>Escopo</h2>"
            "<p>Desenvolvimento do portal do cliente.</p>"
            "<h2>Entregaveis</h2>"
        )

        updated, applied = replace_visible_text(
            content,
            "Escopo Desenvolvimento do portal do cliente.",
            "Escopo Desenvolvimento do portal do cliente com validacao em etapas e criterios de aceite.",
        )

        self.assertTrue(applied)
        self.assertIn("<h2>Escopo</h2>", updated)
        self.assertIn(
            "<p>Desenvolvimento do portal do cliente com validacao em etapas e criterios de aceite.</p>",
            updated,
        )
        self.assertIn("<h2>Entregaveis</h2>", updated)

    def test_standard_templates_cover_supported_categories(self) -> None:
        templates = standard_templates()
        for category in ("desenvolvimento", "marketing", "consultoria", "manutencao", "design", "recorrente"):
            self.assertTrue(any(item["id"] == f"standard_proposal_{category}" for item in templates))
            self.assertTrue(any(item["id"] == f"standard_contract_{category}" for item in templates))

    def test_complete_document_library_covers_all_requested_segments_and_types(self) -> None:
        templates = standard_templates()
        types = {str(item["documentType"]) for item in templates}
        segmented = [item for item in templates if item.get("category") == "Propostas por segmento"]

        self.assertGreaterEqual(len(templates), 150)
        self.assertEqual(len(segmented), 45)
        self.assertTrue({"proposal", "contract", "resume", "hr", "report", "policy", "academic", "personal"}.issubset(types))
        self.assertTrue(any(item["id"] == "standard_resume_foto_clean" and item.get("layout") == "resume-photo" for item in templates))
        for template in templates:
            content = str(template.get("contentHtml") or "")
            self.assertIn("data:image/png;base64,", content, template["id"])
            self.assertIn("fict", content.casefold(), template["id"])
            self.assertIn("{{NORA_CONTENT}}", str(template.get("generationContentHtml") or ""), template["id"])

        resume = next(item for item in templates if item["id"] == "standard_resume_foto_clean")
        proposal = next(item for item in templates if item["id"] == "standard_proposal_consultoria")
        self.assertNotEqual(
            re.search(r'data:image/png;base64,([^\"]+)', resume["contentHtml"]).group(1),
            re.search(r'data:image/png;base64,([^\"]+)', proposal["contentHtml"]).group(1),
        )
        pdf_bytes, _ = build_commercial_pdf(
            {
                "title": resume["name"],
                "contentHtml": resume["contentHtml"],
                "metadata": {"documentType": "resume"},
                "branding": {},
            },
            "proposal",
        )
        self.assertIn(b"/Subtype /Image", pdf_bytes)

    def test_all_standard_examples_are_substantial_multipage_documents(self) -> None:
        import io
        from pypdf import PdfReader
        for template in standard_templates():
            with self.subTest(template=template["id"]):
                content = template["contentHtml"]
                words = re.sub(r"<[^>]+>", " ", content).split()
                self.assertGreaterEqual(len(words), 850)
                self.assertNotIn("{{NORA_CONTENT}}", content)
                self.assertGreaterEqual(content.count("<h2>"), 7)
                pdf, _ = build_commercial_pdf({"title": template["name"], "contentHtml": content, "metadata": {"documentType": template["documentType"]}}, "contract" if template["documentType"] == "contract" else "proposal")
                reader = PdfReader(io.BytesIO(pdf))
                self.assertGreaterEqual(len(reader.pages), 3)
                for page in reader.pages:
                    self.assertGreater(len(page.extract_text().strip()), 70)

    async def test_template_detail_loads_full_example_without_bloating_catalog(self) -> None:
        from app.modules.commercial.service import get_template, list_commercial_data
        data = await list_commercial_data(self.user)
        summary = next(item for item in data["templates"] if item["id"] == "standard_resume_foto_clean")
        self.assertEqual(summary["contentHtml"], "")
        self.assertTrue(summary["contentDeferred"])
        detail = await get_template(self.user, summary["id"])
        self.assertFalse(detail["contentDeferred"])
        self.assertIn("Projeto selecionado 2", detail["contentHtml"])
        self.assertIn("data:image/png;base64,", detail["contentHtml"])
        with self.assertRaises(HTTPException) as caught:
            await get_template(self.user, "template_from_another_workspace")
        self.assertEqual(caught.exception.status_code, 404)

    async def test_smart_document_uses_minimal_brief_and_returns_editable_chat_pdf(self) -> None:
        payload = SmartDocumentRequest(
            templateId="standard_resume_foto_clean",
            brief="Ana Lima, analista de dados com experiência em Python e SQL.",
            primaryColor="#4C1D95",
            secondaryColor="#8B5CF6",
        )
        with patch(
            "app.modules.commercial.service._nora.perguntar_nora",
            new=AsyncMock(side_effect=RuntimeError("provider indisponivel no teste")),
        ):
            document, artifact = await create_smart_document(self.user, payload)

        self.assertEqual(document["metadata"]["documentType"], "resume")
        self.assertEqual(document["metadata"]["templateLayout"], "resume-photo")
        self.assertEqual(document["branding"]["primaryColor"], "#4C1D95")
        self.assertIn("Ana Lima", document["contentHtml"])
        self.assertEqual(artifact["mimeType"], "application/pdf")
        self.assertEqual(artifact["editTarget"]["entityId"], document["id"])
        self.assertEqual(artifact["editTarget"]["tab"], "Documentos")

    def test_structured_nora_briefing_is_rendered_as_readable_document(self) -> None:
        payload = ProposalBriefRequest(
            clientId=self.client_id,
            title="Reforma da Presença Digital",
            objective="Aumentar a taxa de conversão em 25% e modernizar a interface.",
            scopeNotes="Novas telas de checkout e reformulação do painel do usuário.",
            team="Designer, desenvolvedor front-end e líder técnico.",
            deadline="45 dias úteis.",
            deliverablesNotes="Protótipo; código-fonte; documentação.",
            exclusions="Conteúdo e mídia paga.",
            amount=15_000,
            currency="BRL",
        )
        response = """
        {
          "title": "Reforma da Presença Digital do Cliente",
          "scopeSummary": "Modernizar a experiência digital para apoiar o aumento da conversão e facilitar a jornada do usuário.",
          "expandedScope": {
            "objetivos": [
              {"title": "Aumentar a taxa de conversão", "description": "Melhorar a experiência de checkout com base no briefing aprovado."}
            ],
            "escopoInicial": [
              {"title": "Reformular o painel", "description": "Atualizar a experiência do usuário e validar o resultado com o cliente."}
            ]
          },
          "teamPlan": {
            "equipe": [
              {"nome": "Designer UI/UX", "função": "Prototipagem", "responsabilidades": ["Criar protótipos", "Validar a navegação"]}
            ]
          },
          "timeline": {
            "prazo": "45 dias úteis",
            "sprints": [
              {"nome": "Design", "duração": "15 dias", "tarefas": ["Criar protótipos", "Validar interfaces"]}
            ]
          },
          "deliverables": [
            {"title": "Protótipo navegável", "description": "Protótipo para validação do fluxo.", "responsible": "Designer UI/UX"}
          ],
          "exclusions": {"itens": ["Criação de conteúdo", "Mídia paga"]},
          "notes": "Validar critérios de aceite antes do início.",
          "noraComment": "Detalhei o briefing sem alterar as premissas informadas."
        }
        """
        client = {"id": self.client_id, "name": "Cliente Comercial"}
        draft = _parse_briefing_response(response, payload, client)
        document = _proposal_html_from_briefing(draft, client, payload)

        for value in (
            draft["scopeSummary"],
            draft["expandedScope"],
            draft["teamPlan"],
            draft["timeline"],
            draft["exclusions"],
            document,
        ):
            self.assertNotIn("{'", value)
            self.assertNotIn("['", value)
        self.assertIn("Objetivos", draft["expandedScope"])
        self.assertIn("Responsabilidades: Criar protótipos; Validar a navegação", draft["teamPlan"])
        self.assertIn("Duração: 15 dias", draft["timeline"])
        self.assertIn("Protótipo navegável", document)

    def test_serialized_structures_from_nora_are_decoded_before_rendering(self) -> None:
        payload = ProposalBriefRequest(
            clientId=self.client_id,
            objective="Modernizar a presenca digital e aumentar a conversao.",
            scopeNotes="Redesenhar o checkout e o painel do usuario.",
            team="Designer, desenvolvedor e lider tecnico.",
            deadline="45 dias uteis.",
            deliverablesNotes="Prototipo navegavel.",
            exclusions="Conteudo e midia paga.",
        )
        response = """
        {
          "title": "Modernizacao da plataforma",
          "scopeSummary": "A iniciativa moderniza a experiencia digital para apoiar a conversao. O trabalho organiza objetivos, validacoes e resultados esperados.",
          "expandedScope": "[{'title': 'Redesenho do checkout', 'description': 'Atualizar a jornada e validar a experiencia com o cliente.'}, {'title': 'Painel do usuario', 'description': 'Reorganizar as informacoes conforme o briefing aprovado.'}]",
          "teamPlan": "[{'nome': 'Designer', 'funcao': 'Prototipagem', 'responsabilidades': ['Mapear fluxos', 'Validar interfaces']}, {'nome': 'Desenvolvedor', 'funcao': 'Implementacao'}]",
          "timeline": "{'prazo': '45 dias uteis', 'etapas': [{'nome': 'Planejamento', 'duracao': '15 dias'}, {'nome': 'Execucao', 'duracao': '30 dias'}]}",
          "deliverables": [{"title": "Prototipo navegavel", "description": "Material navegavel para validar os fluxos, os limites do escopo e os criterios de aceite.", "responsible": "Designer"}],
          "exclusions": "{'itens': ['Conteudo', 'Midia paga']}",
          "notes": "Validar os criterios antes do inicio.",
          "noraComment": "Detalhei o briefing usando somente as informacoes fornecidas."
        }
        """
        client = {"id": self.client_id, "name": "Cliente Comercial"}
        draft = _parse_briefing_response(response, payload, client)
        document = _proposal_html_from_briefing(draft, client, payload)

        for value in (draft["expandedScope"], draft["teamPlan"], draft["timeline"], draft["exclusions"], document):
            self.assertNotIn("{'", value)
            self.assertNotIn("['", value)
        self.assertIn("Redesenho do checkout", draft["expandedScope"])
        self.assertIn("Responsabilidades: Mapear fluxos; Validar interfaces", draft["teamPlan"])
        self.assertIn("Prazo: 45 dias uteis", draft["timeline"])

    def test_detail_guard_expands_short_sections_without_inventing_facts(self) -> None:
        payload = ProposalBriefRequest(
            clientId=self.client_id,
            objective="Aumentar a conversao do portal.",
            scopeNotes="Redesenhar o checkout.",
            team="Designer e desenvolvedor.",
            deadline="30 dias.",
            deliverablesNotes="Prototipo.",
            exclusions="Midia paga.",
        )
        draft = {
            "title": "Proposta",
            "scopeSummary": payload.objective,
            "expandedScope": payload.scopeNotes,
            "teamPlan": payload.team,
            "timeline": payload.deadline,
            "deliverables": [
                {
                    "title": "Prototipo",
                    "description": "",
                    "responsibleId": "",
                    "responsibleName": "",
                    "dueDate": None,
                    "createCalendarEvent": True,
                }
            ],
            "exclusions": payload.exclusions,
            "notes": "",
            "noraComment": "",
        }

        detailed = _ensure_briefing_detail(draft, payload)

        self.assertGreaterEqual(_briefing_sentence_count(detailed["scopeSummary"]), 2)
        self.assertIn("Controle de mudanças", detailed["expandedScope"])
        self.assertIn("Responsabilidades", detailed["teamPlan"])
        self.assertIn("Acompanhamento", detailed["timeline"])
        self.assertIn("mudança de escopo", detailed["exclusions"])
        self.assertGreaterEqual(len(detailed["deliverables"][0]["description"]), 60)

    def test_copied_briefing_is_flagged_for_expansion(self) -> None:
        payload = ProposalBriefRequest(
            clientId=self.client_id,
            objective="Aumentar a taxa de conversão em 25% e modernizar a interface.",
            scopeNotes="Novas telas de checkout e reformulação do painel do usuário.",
        )
        draft = {
            "scopeSummary": payload.objective,
            "expandedScope": payload.scopeNotes,
            "teamPlan": "",
            "timeline": "",
        }
        self.assertTrue(_draft_requires_expansion(draft, payload))

    async def test_document_center_imports_and_processes_pdf_in_private_queue(self) -> None:
        writer = PdfWriter()
        writer.add_blank_page(width=200, height=300)
        writer.add_blank_page(width=200, height=300)
        buffer = io.BytesIO()
        writer.write(buffer)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

        document = await import_document(
            self.user["id"],
            self.user,
            DocumentImportRequest(
                fileName="contrato-teste.pdf",
                mimeType="application/pdf",
                dataBase64=encoded,
                category="received",
                direction="received",
                confidential=True,
            ),
        )
        self.assertNotIn("storagePath", document)
        self.assertEqual(document["category"], "received")
        self.assertTrue(document["securityReviewRequired"])

        favorite = await update_imported_document(
            self.user["id"],
            self.user,
            document["id"],
            ImportedDocumentUpdate(favorite=True),
        )
        self.assertTrue(favorite["favorite"])
        capabilities = await pdf_capabilities()
        self.assertIn("split", {item["id"] for item in capabilities["operations"]})
        self.assertIn("edit_pdf", {item["id"] for item in capabilities["operations"]})

        job = await create_processing_job(
            self.user["id"],
            self.user,
            PdfProcessRequest(operation="split", documentIds=[document["id"]]),
        )
        await run_processing_job(self.user["id"], job["id"])
        store = read_store(self.user["id"])
        completed = next(item for item in store["processingJobs"] if item["id"] == job["id"])
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(len(completed["outputDocumentIds"]), 2)

        edit_job = await create_processing_job(
            self.user["id"],
            self.user,
            PdfProcessRequest(
                operation="edit_pdf",
                documentIds=[document["id"]],
                options={"text": "Revisado no Norium", "pages": "1", "xPercent": 15, "yPercent": 20, "fontSize": 14, "color": "#173f7a"},
            ),
        )
        await run_processing_job(self.user["id"], edit_job["id"])
        store = read_store(self.user["id"])
        edited_job = next(item for item in store["processingJobs"] if item["id"] == edit_job["id"])
        edited_document = next(item for item in store["uploadedDocuments"] if item["id"] == edited_job["outputDocumentIds"][0])
        self.assertEqual("completed", edited_job["status"])
        self.assertIn("Revisado no Norium", PdfReader(edited_document["storagePath"]).pages[0].extract_text())

        visual_job = await create_processing_job(
            self.user["id"], self.user,
            PdfProcessRequest(operation="edit_pdf", documentIds=[document["id"]], options={"editor": {
                "layers": [{"id":"text","type":"text","page":1,"x":.1,"y":.4,"width":.6,"height":.1,"text":"Editor visual em outra pagina"}],
                "pages": [{"source":1,"rotation":90}]
            }}),
        )
        await run_processing_job(self.user["id"], visual_job["id"])
        store = read_store(self.user["id"])
        completed_visual = next(item for item in store["processingJobs"] if item["id"] == visual_job["id"])
        self.assertEqual(completed_visual["status"], "completed")
        visual_result = next(item for item in store["uploadedDocuments"] if item["id"] == completed_visual["outputDocumentIds"][0])
        result_reader = PdfReader(visual_result["storagePath"])
        self.assertEqual(len(result_reader.pages), 1)
        self.assertIn("Editor visual em outra pagina", result_reader.pages[0].extract_text())

        protected_job = await create_processing_job(
            self.user["id"],
            self.user,
            PdfProcessRequest(
                operation="add_password",
                documentIds=[document["id"]],
                options={"password": "senha-segura"},
            ),
        )
        self.assertNotIn("password", protected_job["options"])
        self.assertTrue(protected_job["requiresTransientSecret"])

        other_store = read_store(f"other-{self.user['id']}")
        self.assertFalse(other_store["uploadedDocuments"])

    async def test_proposal_status_duplication_and_template_crud_are_auditable(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Proposta com ciclo comercial",
                contentHtml="<p>Escopo</p>",
            ),
        )
        approved = await submit_proposal(self.user, proposal["id"], "Fluxo Solo")
        sent = await change_proposal_status(
            self.user,
            approved["id"],
            ProposalStatusChange(status="sent", note="Enviada ao cliente"),
        )
        viewed = await change_proposal_status(
            self.user,
            sent["id"],
            ProposalStatusChange(status="viewed"),
        )
        self.assertEqual(viewed["status"], "viewed")
        self.assertEqual(viewed["events"][0]["action"], "proposal_status_changed")

        duplicate = await duplicate_proposal(
            self.user,
            proposal["id"],
            DocumentDuplicateRequest(title="Proposta duplicada"),
        )
        self.assertEqual(duplicate["status"], "draft")
        self.assertNotEqual(duplicate["id"], proposal["id"])

        template = await create_template(
            self.user,
            TemplateCreate(
                name="Modelo de termo",
                description="Termo reutilizavel",
                contentHtml="<h1>{{CLIENT_NAME}}</h1><p>{{DATE}}</p>",
                documentType="term",
                variables=["CLIENT_NAME", "DATE"],
            ),
        )
        self.assertEqual(template["contentHtml"], "<h1>{{CLIENT_NAME}}</h1><p>{{DATE}}</p>")
        updated = await update_template(
            self.user,
            template["id"],
            TemplateUpdate(active=False),
        )
        self.assertFalse(updated["active"])
        copied = await duplicate_template(
            self.user,
            template["id"],
            DocumentDuplicateRequest(),
        )
        self.assertNotEqual(copied["id"], template["id"])
        removed = await delete_template(self.user, template["id"])
        self.assertEqual(removed["id"], template["id"])


if __name__ == "__main__":
    unittest.main()
