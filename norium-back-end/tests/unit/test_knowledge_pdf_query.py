"""Tarefa 3: consulta autorizada a PDFs com evidência por página.

PDF autorizado retorna trechos com página; documento de outro tenant dá 404;
PDF sem texto pesquisável dá erro claro sem resultado fabricado. A busca geral
(`query_knowledge`, usada no fluxo natural da Nora) passa a incluir a página
para PDFs. Tudo com dados sintéticos.
"""

from __future__ import annotations

import base64
import os
import shutil
import tempfile
import unittest
from io import BytesIO

from fastapi import HTTPException


TEST_DATA_DIR = tempfile.mkdtemp(prefix="norium_pdf_query_")
os.environ["NORIUM_DATA_DIR"] = TEST_DATA_DIR

from app.modules.platform.router import upload_knowledge_pdf  # noqa: E402
from app.modules.platform.schemas import KnowledgePdfPayload  # noqa: E402
from app.modules.platform.service import query_knowledge, query_knowledge_pdf  # noqa: E402


def make_pdf(pages: list[str]) -> bytes:
    from reportlab.pdfgen import canvas

    buffer = BytesIO()
    doc = canvas.Canvas(buffer)
    for text in pages:
        if text:
            doc.drawString(72, 720, text)
        doc.showPage()
    doc.save()
    return buffer.getvalue()


def data_url(pdf: bytes) -> str:
    return "data:application/pdf;base64," + base64.b64encode(pdf).decode("ascii")


def user_for(test_name: str) -> dict:
    return {"id": f"pdf-user-{test_name}", "nome": "Teste PDF", "email": "pdf@norium.local"}


class KnowledgePdfQueryTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)

    async def upload(self, user: dict, pages: list[str], title: str = "Contrato sintetico") -> dict:
        response = await upload_knowledge_pdf(
            KnowledgePdfPayload(
                fileName="contrato-sintetico.pdf",
                dataUrl=data_url(make_pdf(pages)),
                title=title,
            ),
            user,
        )
        return response["item"]

    async def test_specific_field_returns_page_evidence(self) -> None:
        user = user_for(self._testMethodName)
        item = await self.upload(
            user,
            [
                "Condicao de pagamento: 30 dias apos o faturamento.",
                "Clausula de rescisao: aviso previo de 30 dias com multa.",
            ],
        )
        result = await query_knowledge_pdf(user, item["id"], "rescisao aviso previo", limit=5)
        self.assertTrue(result["grounded"])
        self.assertEqual(item["id"], result["documentId"])
        self.assertEqual(1, len(result["excerpts"]))
        self.assertEqual(2, result["excerpts"][0]["page"])
        self.assertIn("rescisao", result["excerpts"][0]["excerpt"])
        self.assertIn("p. 2", result["answer"])

    async def test_absent_term_is_not_invented(self) -> None:
        user = user_for(self._testMethodName)
        item = await self.upload(user, ["Valor total e cronograma de entrega."])
        result = await query_knowledge_pdf(user, item["id"], "clausula inexistente de garantia", limit=5)
        self.assertFalse(result["grounded"])
        self.assertEqual([], result["excerpts"])

    async def test_common_word_alone_does_not_ground(self) -> None:
        # Reprodução P2: "prazo de rescisão" em PDF com só "prazo de entrega".
        user = user_for(self._testMethodName)
        item = await self.upload(user, ["Prazo de entrega: 30 dias apos o faturamento."])
        result = await query_knowledge_pdf(user, item["id"], "prazo de rescisão", limit=5)
        self.assertFalse(result["grounded"])
        self.assertEqual([], result["excerpts"])
        self.assertEqual([], result["conflicts"])

    async def test_same_field_divergence_is_flagged(self) -> None:
        user = user_for(self._testMethodName)
        item = await self.upload(
            user,
            [
                "Prazo de entrega: 30 dias apos o faturamento.",
                "Prazo de entrega: 45 dias apos o faturamento.",
            ],
        )
        result = await query_knowledge_pdf(user, item["id"], "prazo de entrega", limit=5)
        self.assertTrue(result["grounded"])
        self.assertEqual(2, len(result["excerpts"]))
        self.assertEqual(1, len(result["conflicts"]))
        self.assertEqual("prazo de entrega", result["conflicts"][0]["field"])
        self.assertEqual({"30 dias", "45 dias"}, set(result["conflicts"][0]["values"]))
        self.assertIn("30 dias", result["answer"])
        self.assertIn("45 dias", result["answer"])

    async def test_different_fields_do_not_conflict(self) -> None:
        # Números de campos diferentes não geram conflito; a comparação é
        # declarada inconclusiva na resposta.
        user = user_for(self._testMethodName)
        item = await self.upload(
            user,
            [
                "Prazo de entrega: 30 dias apos o faturamento.",
                "Prazo de garantia: 60 dias apos o recebimento.",
            ],
        )
        result = await query_knowledge_pdf(user, item["id"], "prazo", limit=5)
        self.assertTrue(result["grounded"])
        self.assertEqual(2, len(result["excerpts"]))
        self.assertEqual([], result["conflicts"])
        self.assertIn("sem divergencia comparavel", result["answer"])

    async def test_same_page_divergence_is_flagged(self) -> None:
        user = user_for(self._testMethodName)
        item = await self.upload(user, ["Prazo: 30 dias. Prazo: 60 dias."])
        result = await query_knowledge_pdf(user, item["id"], "prazo", limit=5)
        self.assertTrue(result["grounded"])
        self.assertEqual(1, len(result["conflicts"]))
        self.assertEqual("prazo", result["conflicts"][0]["field"])
        self.assertEqual(
            [1, 1], [hit["page"] for hit in result["conflicts"][0]["occurrences"]]
        )

    async def test_later_window_in_page_is_found(self) -> None:
        # A primeira ocorrência de "prazo" está longe de "aviso previo", mas
        # há janela válida adiante na mesma página.
        filler = "palavra de preenchimento " * 30
        user = user_for(self._testMethodName)
        item = await self.upload(
            user, ["Prazo isolado no comeco. " + filler + "Aviso previo com prazo combinado."]
        )
        result = await query_knowledge_pdf(user, item["id"], "prazo aviso previo", limit=5)
        self.assertTrue(result["grounded"])
        self.assertEqual(1, len(result["excerpts"]))

    async def test_single_page_values_have_no_conflict(self) -> None:
        user = user_for(self._testMethodName)
        item = await self.upload(user, ["Prazo de entrega: 30 dias apos o faturamento."])
        result = await query_knowledge_pdf(user, item["id"], "prazo de entrega", limit=5)
        self.assertTrue(result["grounded"])
        self.assertEqual([], result["conflicts"])
        self.assertIn("30 dias", result["excerpts"][0]["values"])

    async def test_other_tenant_cannot_query(self) -> None:
        owner = user_for(f"{self._testMethodName}-owner")
        intruder = user_for(f"{self._testMethodName}-intruder")
        item = await self.upload(owner, ["Dado interno do contrato sintetico."])
        with self.assertRaises(HTTPException) as ctx:
            await query_knowledge_pdf(intruder, item["id"], "contrato", limit=5)
        self.assertEqual(404, ctx.exception.status_code)

    async def test_unknown_or_non_pdf_document_is_404(self) -> None:
        user = user_for(self._testMethodName)
        with self.assertRaises(HTTPException) as ctx:
            await query_knowledge_pdf(user, "knowledge_inexistente", "contrato", limit=5)
        self.assertEqual(404, ctx.exception.status_code)

    async def test_pdf_without_text_has_clear_error(self) -> None:
        user = user_for(self._testMethodName)
        with self.assertRaises(HTTPException) as ctx:
            await self.upload(user, [""], title="PDF digitalizado")
        self.assertEqual(422, ctx.exception.status_code)
        self.assertIn("pesquisavel", str(ctx.exception.detail))

    async def test_general_knowledge_search_includes_pdf_page(self) -> None:
        user = user_for(self._testMethodName)
        item = await self.upload(
            user,
            ["Escopo do projeto sintetico.", "Garantia estendida de 12 meses com suporte."],
        )
        result = await query_knowledge(user, "garantia estendida suporte", 5)
        self.assertTrue(result["grounded"])
        pdf_citations = [entry for entry in result["citations"] if entry["id"] == item["id"]]
        self.assertEqual(1, len(pdf_citations))
        self.assertEqual(2, pdf_citations[0].get("page"))
        self.assertIn("Garantia", pdf_citations[0]["excerpt"])


if __name__ == "__main__":
    unittest.main()
