"""Tarefa 3: serviço compartilhado de PDF — extração e busca determinística.

Cobre validação (tipo, tamanho, páginas, texto pesquisável) e a busca por
páginas com referência 1-based. Usa apenas PDFs sintéticos gerados em memória.
"""

from __future__ import annotations

import base64
import unittest
from io import BytesIO

from fastapi import HTTPException

from app.modules.platform import pdf_text
from app.modules.platform.pdf_text import (
    decode_pdf_data_url,
    detect_value_conflicts,
    extract_nearby_values,
    extract_pdf_pages,
    extract_pdf_pages_async,
    find_accent_insensitive,
    page_excerpt,
    search_pdf_pages,
)


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


class ExtractPdfPagesTests(unittest.TestCase):
    def test_extracts_pages_in_order(self) -> None:
        pdf = make_pdf(["Primeira pagina: valor total", "Segunda pagina: clausula de rescisao"])
        pages = extract_pdf_pages(pdf)
        self.assertEqual(2, len(pages))
        self.assertIn("valor total", pages[0])
        self.assertIn("rescisao", pages[1])

    def test_rejects_non_pdf_bytes(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            extract_pdf_pages(b"not a pdf at all, just text")
        self.assertEqual(422, ctx.exception.status_code)

    def test_rejects_pdf_without_searchable_text(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            extract_pdf_pages(make_pdf([""]))
        self.assertEqual(422, ctx.exception.status_code)
        self.assertIn("pesquisavel", str(ctx.exception.detail))

    def test_rejects_oversized_pdf(self) -> None:
        pdf = make_pdf(["conteudo sintetico"])
        original = pdf_text.PDF_MAX_BYTES
        pdf_text.PDF_MAX_BYTES = len(pdf) - 1
        try:
            with self.assertRaises(HTTPException) as ctx:
                extract_pdf_pages(pdf)
        finally:
            pdf_text.PDF_MAX_BYTES = original
        self.assertEqual(413, ctx.exception.status_code)

    def test_rejects_too_many_pages(self) -> None:
        pdf = make_pdf(["pagina um", "pagina dois"])
        original = pdf_text.PDF_MAX_PAGES
        pdf_text.PDF_MAX_PAGES = 1
        try:
            with self.assertRaises(HTTPException) as ctx:
                extract_pdf_pages(pdf)
        finally:
            pdf_text.PDF_MAX_PAGES = original
        self.assertEqual(413, ctx.exception.status_code)

    def test_missing_reader_is_unavailable(self) -> None:
        original = pdf_text.PdfReader
        pdf_text.PdfReader = None
        try:
            with self.assertRaises(HTTPException) as ctx:
                extract_pdf_pages(b"%PDF-1.4 fake")
        finally:
            pdf_text.PdfReader = original
        self.assertEqual(503, ctx.exception.status_code)

    def test_rejects_extracted_text_over_total_cap(self) -> None:
        pdf = make_pdf(["conteudo sintetico para o teto de caracteres"])
        original = pdf_text.PDF_MAX_TOTAL_CHARS
        pdf_text.PDF_MAX_TOTAL_CHARS = 10
        try:
            with self.assertRaises(HTTPException) as ctx:
                extract_pdf_pages(pdf)
        finally:
            pdf_text.PDF_MAX_TOTAL_CHARS = original
        self.assertEqual(413, ctx.exception.status_code)
        self.assertIn("2.000.000", str(ctx.exception.detail))


class ExtractPdfPagesAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_wrapper_matches_sync_result(self) -> None:
        pdf = make_pdf(["Primeira pagina assincrona", "Segunda pagina assincrona"])
        self.assertEqual(extract_pdf_pages(pdf), await extract_pdf_pages_async(pdf))

    async def test_async_wrapper_propagates_limits(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await extract_pdf_pages_async(b"not a pdf at all, just text")
        self.assertEqual(422, ctx.exception.status_code)


class DecodeDataUrlTests(unittest.TestCase):
    def test_decodes_with_and_without_prefix(self) -> None:
        raw = make_pdf(["ola"])
        encoded = base64.b64encode(raw).decode("ascii")
        self.assertEqual(raw, decode_pdf_data_url(f"data:application/pdf;base64,{encoded}"))
        self.assertEqual(raw, decode_pdf_data_url(encoded))

    def test_rejects_corrupted_payload(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            decode_pdf_data_url("data:application/pdf;base64,!!!nao-base64!!!")
        self.assertEqual(422, ctx.exception.status_code)


class SearchPdfPagesTests(unittest.TestCase):
    def test_returns_one_based_page_with_evidence(self) -> None:
        pages = [
            "Proposta comercial: valor total de R$ 10.000.",
            "Clausula de rescisao: aviso previo de 30 dias.",
            "Cronograma de entrega em tres etapas mensais.",
        ]
        hits = search_pdf_pages(pages, "rescisao aviso previo", limit=5)
        self.assertEqual(1, len(hits))
        self.assertEqual(2, hits[0]["page"])
        self.assertIn("rescisao", hits[0]["excerpt"])

    def test_orders_hits_by_page(self) -> None:
        pages = ["entrega com prazo de pagamento", "pagamento do prazo de entrega"]
        hits = search_pdf_pages(pages, "pagamento prazo entrega", limit=5)
        self.assertEqual([1, 2], [hit["page"] for hit in hits])

    def test_single_common_word_does_not_ground(self) -> None:
        # Reprodução P2: "prazo de rescisão" em PDF com só "prazo de entrega".
        hits = search_pdf_pages(
            ["Prazo de entrega: 30 dias apos o faturamento."], "prazo de rescisão", limit=5
        )
        self.assertEqual([], hits)

    def test_terms_far_apart_do_not_ground(self) -> None:
        filler = "palavra de preenchimento " * 60
        pages = [f"rescisao no inicio. {filler} aviso previo no fim."]
        hits = search_pdf_pages(pages, "rescisao aviso previo", limit=5)
        self.assertEqual([], hits)

    def test_accents_match_both_directions(self) -> None:
        hits = search_pdf_pages(["Clausula de rescisão: aviso prévio."], "rescisao aviso previo")
        self.assertEqual(1, len(hits))
        self.assertIn("rescisão", hits[0]["excerpt"])
        hits = search_pdf_pages(["Clausula de rescisao: aviso previo."], "rescisão aviso prévio")
        self.assertEqual(1, len(hits))
        self.assertIn("rescisao", hits[0]["excerpt"])

    def test_no_match_is_empty_not_invented(self) -> None:
        hits = search_pdf_pages(["valor e prazo"], "clausula inexistente de garantia", limit=5)
        self.assertEqual([], hits)

    def test_empty_query_is_empty(self) -> None:
        self.assertEqual([], search_pdf_pages(["algum texto"], "", limit=5))

    def test_excerpt_keeps_term_on_long_pages(self) -> None:
        filler = "palavra de preenchimento " * 200
        pages = [f"{filler} clausula especial de garantia estendida {filler}"]
        excerpt, _center = page_excerpt(pages[0], {"clausula", "garantia"})
        self.assertIn("clausula", excerpt)
        self.assertLessEqual(len(excerpt), 420)

    def test_excerpt_contains_accented_match(self) -> None:
        filler = "texto de preenchimento " * 200
        pages = [f"{filler} cláusula especial de rescisão contratual {filler}"]
        excerpt, _center = page_excerpt(pages[0], {"clausula", "rescisao"})
        self.assertIn("cláusula", excerpt)
        self.assertIn("rescisão", excerpt)


class FindAccentInsensitiveTests(unittest.TestCase):
    def test_maps_to_original_indices(self) -> None:
        self.assertEqual((9, 17), find_accent_insensitive("Prazo de rescisão aqui", "rescisão"))
        self.assertEqual((9, 17), find_accent_insensitive("Prazo de rescisão aqui", "RESCISAO"))
        self.assertIsNone(find_accent_insensitive("Prazo de entrega", "rescisão"))
        self.assertIsNone(find_accent_insensitive("texto", ""))


class NearbyValuesTests(unittest.TestCase):
    def test_extracts_numbers_dates_and_money(self) -> None:
        values = extract_nearby_values("Prazo de 30 dias, valor R$ 12.500,00, início em 30/12/2026.", 10)
        self.assertIn("30 dias", values)
        self.assertTrue(any("12.500" in value for value in values))
        self.assertIn("30/12/2026", values)

    def test_empty_when_no_values(self) -> None:
        self.assertEqual([], extract_nearby_values("Clausula sem numeros por aqui.", 5))


class LaterWindowTests(unittest.TestCase):
    def test_later_occurrence_forms_valid_window(self) -> None:
        filler = "palavra de preenchimento " * 30
        pages = ["Prazo isolado no comeco. " + filler + "Aviso previo com prazo combinado."]
        hits = search_pdf_pages(pages, "prazo aviso previo", limit=5)
        self.assertEqual(1, len(hits))
        self.assertIn("Aviso previo", hits[0]["excerpt"])


class DetectConflictsTests(unittest.TestCase):
    def test_same_field_divergence(self) -> None:
        conflicts = detect_value_conflicts(
            ["Prazo de entrega: 30 dias.", "Prazo de entrega: 45 dias."], "prazo de entrega"
        )
        self.assertEqual(1, len(conflicts))
        self.assertEqual("prazo de entrega", conflicts[0]["field"])
        self.assertEqual({"30 dias", "45 dias"}, set(conflicts[0]["values"]))

    def test_different_fields_do_not_conflict(self) -> None:
        conflicts = detect_value_conflicts(
            ["Prazo de entrega: 30 dias.", "Prazo de garantia: 60 dias."], "prazo"
        )
        self.assertEqual([], conflicts)

    def test_same_page_divergence(self) -> None:
        conflicts = detect_value_conflicts(["Prazo: 30 dias. Prazo: 60 dias."], "prazo")
        self.assertEqual(1, len(conflicts))
        self.assertEqual("prazo", conflicts[0]["field"])
        self.assertEqual([1, 1], [hit["page"] for hit in conflicts[0]["occurrences"]])

    def test_unlabeled_values_do_not_cross_pages(self) -> None:
        conflicts = detect_value_conflicts(["Em 30 dias.", "Em 60 dias."], "dias")
        self.assertEqual([], conflicts)


if __name__ == "__main__":
    unittest.main()
