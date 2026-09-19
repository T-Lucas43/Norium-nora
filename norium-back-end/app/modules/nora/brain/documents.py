"""Bounded local extraction, calculation and private artifact generation."""
from __future__ import annotations

import csv
import hashlib
import io
import zipfile
from decimal import Decimal, InvalidOperation
from html import escape
from typing import Literal
from xml.etree import ElementTree

from pydantic import Field
from pydantic import field_validator, model_validator

from .contracts import BrainError, Outcome, Strict
from .policy import Tool


class ReadFile(Strict):
    id: str = Field(min_length=1, max_length=80)
    start: int = Field(default=0, ge=0, le=100_000)


def checked_file(user, file_id):
    from app.services.nora_files import owned_file
    record, path = owned_file(user["id"], file_id)
    if path.stat().st_size > 24 * 1024 * 1024:
        raise BrainError("file_size_limit", 413)
    return record, path


async def prepare_read(user, args, job):
    record, path = checked_file(user, args.id)
    return {"id": args.id, "start": args.start, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "effects": []}


def safe_zip(path):
    archive = zipfile.ZipFile(path)
    if len(archive.infolist()) > 5000 or sum(item.file_size for item in archive.infolist()) > 64 * 1024 * 1024:
        archive.close()
        raise BrainError("archive_expansion_limit", 413)
    return archive


async def read_file(user, prepared, job):
    record, path = checked_file(user, prepared["id"])
    if hashlib.sha256(path.read_bytes()).hexdigest() != prepared["sha256"]:
        return Outcome("rejected", {}, {"reason": "file_version_changed"})
    start, suffix = prepared["start"], path.suffix.lower()
    if suffix == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(path)
        total = len(reader.pages)
        units = [{"page": i + 1, "text": (reader.pages[i].extract_text() or "")[:6000]} for i in range(start, min(start + 1, total))]
        end = start + len(units)
        warning = "PDF: extração de texto; imagens e tabelas visuais não foram verificadas."
    elif suffix in {".xlsx", ".docx"}:
        with safe_zip(path):
            pass
        if suffix == ".xlsx":
            from openpyxl import load_workbook
            workbook = load_workbook(path, read_only=True, data_only=False)
            try:
                sheet = workbook.worksheets[0]
                total = sheet.max_row or 0
                if total > 100_000:
                    raise BrainError("spreadsheet_row_limit", 413)
                units = [{"row": i, "cells": [str(v) if v is not None else None for v in values[:20]]}
                         for i, values in enumerate(sheet.iter_rows(min_row=start + 1, max_row=min(start + 20, total), max_col=20, values_only=True), start + 1)] if start < total else []
                warning = "Primeira aba; até 20 colunas. Fórmulas são texto, não valores recalculados."
            finally:
                workbook.close()
        else:
            with safe_zip(path) as archive:
                content = archive.read("word/document.xml")
            tree = ElementTree.fromstring(content)
            paragraphs = ["".join(node.itertext()) for node in tree.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p")]
            total = len(paragraphs)
            units = [{"paragraph": i + 1, "text": paragraphs[i][:2000]} for i in range(start, min(start + 10, total))]
            warning = "Texto do corpo; imagens, cabeçalhos e notas exigem leitura específica."
        end = start + len(units)
    elif suffix in {".txt", ".md", ".csv", ".json"}:
        content = path.read_text(encoding="utf-8-sig")
        total, end = len(content), min(start + 6000, len(content))
        units = [{"offset": start, "text": content[start:end]}]
        warning = "Recorte textual; totais exigem cálculo sobre o arquivo completo."
    else:
        raise BrainError("file_format_requires_specialized_reader", 422)
    data = {"source": prepared["id"], "sha256": prepared["sha256"], "units": units,
            "nextCursor": end if end < total else None, "totalUnits": total, "coverage": warning}
    return Outcome("succeeded", data, {"source": prepared["id"], "sha256": prepared["sha256"], "start": start, "end": end, "total": total})


class Calculation(Strict):
    values: list[str] = Field(min_length=1, max_length=1000)
    operation: Literal["sum", "multiply"] = "sum"


async def prepare_calculation(user, args, job):
    return {**args.model_dump(), "effects": []}


async def calculate(user, prepared, job):
    try:
        numbers = [Decimal(value.replace(",", ".")) for value in prepared["values"]]
        if any(not value.is_finite() or abs(value) > Decimal("1e18") for value in numbers):
            raise ValueError()
        result = sum(numbers) if prepared["operation"] == "sum" else Decimal(1)
        if prepared["operation"] == "multiply":
            for number in numbers:
                result *= number
                if abs(result) > Decimal("1e30"):
                    raise ValueError()
    except (InvalidOperation, ValueError):
        raise BrainError("invalid_calculation", 422) from None
    return Outcome("succeeded", {"result": str(result)}, {"operation": prepared["operation"], "values": prepared["values"], "result": str(result)})


class Document(Strict):
    title: str = Field(min_length=1, max_length=160)
    paragraphs: list[str] = Field(min_length=1, max_length=60)
    format: Literal["docx", "pdf", "md"] = "docx"
    sources: list[str] = Field(default_factory=list, max_length=8)


async def prepare_document(user, args, job):
    if sum(len(p) for p in args.paragraphs) > 24000:
        raise BrainError("document_size_limit", 413)
    read_sources = {s.get("result", {}).get("evidence", {}).get("source") for s in job["steps"] if s["status"] == "succeeded" and s["tool"] == "files_read"}
    if any(source not in read_sources for source in args.sources):
        raise BrainError("document_source_not_read")
    return {**args.model_dump(), "effects": ["private_file"]}


def docx_bytes(title, paragraphs):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        body = "".join('<w:p><w:r>' + ('<w:rPr><w:b/><w:sz w:val="36"/></w:rPr>' if i == 0 else '') + '<w:t xml:space="preserve">' + escape(text) + '</w:t></w:r></w:p>' for i, text in enumerate([title, *paragraphs]))
        archive.writestr("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:bottom="1134" w:left="1134" w:right="1134"/></w:sectPr></w:body></w:document>')
    return stream.getvalue()


async def generate_document(user, prepared, job):
    from app.services.nora_files import save_bytes, owned_file
    title, paragraphs, format_name = prepared["title"], prepared["paragraphs"], prepared["format"]
    if format_name == "docx":
        content = docx_bytes(title, paragraphs)
        mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            parsed = ElementTree.fromstring(archive.read("word/document.xml"))
            if title not in "".join(parsed.itertext()):
                raise BrainError("document_verification_failed")
    elif format_name == "pdf":
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
        from reportlab.lib.pagesizes import A4
        from pypdf import PdfReader
        stream = io.BytesIO()
        styles = getSampleStyleSheet()
        story = [Paragraph(escape(title), styles["Title"]), Spacer(1, 16)]
        for paragraph in paragraphs:
            story.extend([Paragraph(escape(paragraph).replace("\n", "<br/>"), styles["BodyText"]), Spacer(1, 10)])
        SimpleDocTemplate(stream, pagesize=A4, title=title).build(story)
        content = stream.getvalue()
        if not PdfReader(io.BytesIO(content)).pages:
            raise BrainError("document_verification_failed")
        mime = "application/pdf"
    else:
        content = ("# " + title + "\n\n" + "\n\n".join(paragraphs)).encode()
        mime = "text/plain"
    artifact = save_bytes(user["id"], content, "documento-nora." + format_name, mime, source="nora_brain",
                          metadata={"operationId": job["operationId"], "sources": prepared["sources"], "verification": "structure_and_saved_bytes", "visualReview": "pending"})
    _, saved = owned_file(user["id"], artifact["id"])
    digest = hashlib.sha256(content).hexdigest()
    if hashlib.sha256(saved.read_bytes()).hexdigest() != digest:
        raise BrainError("document_verification_failed")
    return Outcome("succeeded", {"file": artifact, "visualReview": "pending"}, {"artifact": artifact["id"], "sha256": digest, "structuralVerification": True, "visualReview": "pending"})


class SpreadsheetFormula(Strict):
    cell: str = Field(pattern=r"^[A-T](?:[2-9]|[1-9][0-9]{1,2}|[1-4][0-9]{3}|500[01])$")
    operation: Literal["sum", "multiply"]
    sourceCells: list[str] = Field(min_length=1, max_length=1000)

    @field_validator("sourceCells")
    @classmethod
    def source_cells(cls, values):
        import re
        pattern = re.compile(r"^[A-T](?:[2-9]|[1-9][0-9]{1,2}|[1-4][0-9]{3}|500[01])$")
        if len(set(values)) != len(values) or any(not pattern.fullmatch(value) for value in values):
            raise ValueError("Invalid or duplicate source cell")
        return values

    @model_validator(mode="after")
    def no_cycle(self):
        if self.cell in self.sourceCells:
            raise ValueError("Formula cannot reference itself")
        return self


class Spreadsheet(Strict):
    title: str = Field(min_length=1, max_length=160)
    columns: list[str] = Field(min_length=1, max_length=20)
    rows: list[list[str | int | float | None]] = Field(default_factory=list, max_length=5000)
    formulas: list[SpreadsheetFormula] = Field(default_factory=list, max_length=100)
    sources: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def bounded_cells(self):
        if any(len(row) > len(self.columns) for row in self.rows):
            raise ValueError("A row has more cells than columns")
        return self


async def prepare_spreadsheet(user, args, job):
    if len(args.rows) * len(args.columns) > 100_000:
        raise BrainError("spreadsheet_cell_limit", 413)
    read_sources = {s.get("result", {}).get("evidence", {}).get("source") for s in job["steps"]
                    if s["status"] == "succeeded" and s["tool"] == "files_read"}
    if any(source not in read_sources for source in args.sources):
        raise BrainError("document_source_not_read")
    return {**args.model_dump(), "effects": ["private_file"]}


def decimal_cell(sheet, reference):
    value = sheet[reference].value
    if isinstance(value, bool) or value is None:
        raise BrainError("spreadsheet_formula_source_invalid", 422)
    try:
        parsed = Decimal(str(value).replace(",", "."))
    except InvalidOperation:
        raise BrainError("spreadsheet_formula_source_invalid", 422) from None
    if not parsed.is_finite():
        raise BrainError("spreadsheet_formula_source_invalid", 422)
    return parsed


async def generate_spreadsheet(user, prepared, job):
    from openpyxl import Workbook, load_workbook
    from app.services.nora_files import save_bytes, owned_file
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Dados"
    sheet.append(prepared["columns"])
    for row in prepared["rows"]:
        safe = [("'" + value) if isinstance(value, str) and value.startswith(("=", "+", "-", "@")) else value
                for value in row]
        sheet.append(safe)
    checks = []
    for spec in prepared["formulas"]:
        values = [decimal_cell(sheet, reference) for reference in spec["sourceCells"]]
        result = sum(values) if spec["operation"] == "sum" else Decimal(1)
        if spec["operation"] == "multiply":
            for value in values:
                result *= value
        function = "SUM" if spec["operation"] == "sum" else "PRODUCT"
        formula = f"={function}({','.join(spec['sourceCells'])})"
        sheet[spec["cell"]] = formula
        checks.append({"cell": spec["cell"], "formula": formula, "calculated": str(result)})
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    workbook.calculation.fullCalcOnLoad = True
    stream = io.BytesIO()
    workbook.save(stream)
    workbook.close()
    content = stream.getvalue()
    verified = load_workbook(io.BytesIO(content), read_only=False, data_only=False)
    try:
        restored = verified["Dados"]
        if [restored.cell(1, index + 1).value for index in range(len(prepared["columns"]))] != prepared["columns"]:
            raise BrainError("document_verification_failed")
        if any(restored[item["cell"]].value != item["formula"] for item in checks):
            raise BrainError("document_verification_failed")
    finally:
        verified.close()
    artifact = save_bytes(user["id"], content, "planilha-nora.xlsx",
                          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                          source="nora_brain", metadata={"operationId": job["operationId"],
                          "sources": prepared["sources"], "verification": "reopened_structure_formulas"})
    _, saved = owned_file(user["id"], artifact["id"])
    digest = hashlib.sha256(content).hexdigest()
    if hashlib.sha256(saved.read_bytes()).hexdigest() != digest:
        raise BrainError("document_verification_failed")
    return Outcome("succeeded", {"file": artifact, "formulaChecks": checks}, {
        "artifact": artifact["id"], "sha256": digest, "reopened": True, "formulaChecks": checks,
    })


async def reconcile_generated_file(user, prepared, job):
    from app.core.tenant import read_user_db
    from app.services.nora_files import owned_file
    payload = read_user_db(user["id"], "nora_files", {"files": []})
    record = next((item for item in payload.get("files", []) if isinstance(item, dict)
                   and isinstance(item.get("metadata"), dict)
                   and item["metadata"].get("operationId") == job["operationId"]), None)
    if record is None:
        return Outcome("rejected", {}, {"confirmedNotApplied": True, "reason": "artifact_receipt_absent"})
    artifact, path = owned_file(user["id"], record["id"])
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return Outcome("succeeded", {"file": artifact}, {
        "artifact": artifact["id"], "sha256": digest, "confirmedApplied": True,
    })


def document_tools():
    return [
        Tool("files_read", "Ler recorte de arquivo privado, preservando página/linha, versão e cobertura.", "nora", "C", ReadFile, prepare_read, read_file),
        Tool("files_calculate", "Somar ou multiplicar valores decimais de forma determinística.", "nora", "C", Calculation, prepare_calculation, calculate),
        Tool("files_generate", "Gerar documento privado DOCX/PDF/Markdown e conferir estrutura. Revisão visual fica explícita como pendente.", "nora", "D", Document, prepare_document, generate_document, reconcile=reconcile_generated_file),
        Tool("files_generate_spreadsheet", "Gerar XLSX privado com fórmulas limitadas, cálculo determinístico e reabertura para verificação.", "nora", "D", Spreadsheet, prepare_spreadsheet, generate_spreadsheet, reconcile=reconcile_generated_file),
    ]
