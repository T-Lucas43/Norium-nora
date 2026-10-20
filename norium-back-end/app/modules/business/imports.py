"""User-reviewed CSV/XLSX/vCard imports with row-level application receipts."""
from __future__ import annotations

import asyncio
import base64
import binascii
import csv
import hashlib
import io
import json
import quopri
import re
import time
import unicodedata
import zipfile
from decimal import Decimal, InvalidOperation
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import Field, ValidationError

from app.modules.auth.router import assert_route_permissions, current_user
from app.shared.schemas import StrictModel
from . import jobs
from .store import mutate, require_room, snapshot

router = APIRouter(prefix="/api/business/imports", tags=["Importação"])
MAX_ROWS = 5000
FIELDS = {
    "clients": {"name": ["nome", "razao social", "nome razao", "name", "fn"],
        "company": ["empresa", "razao", "company", "org"], "document": ["cpf", "cnpj", "cpf cnpj", "documento", "document"],
        "phone": ["telefone", "celular", "whatsapp", "phone", "tel"], "email": ["email", "e mail"],
        "city": ["cidade", "city"], "state": ["uf", "estado", "state"],
        "notes": ["observacoes", "observacao", "notas", "notes", "note"], "segment": ["segmento", "segment"]},
    "catalog": {"name": ["nome", "item", "produto", "servico", "name"], "sku": ["codigo", "sku", "referencia"],
        "type": ["tipo", "type"], "unit": ["unidade", "unit"], "price": ["preco", "valor", "price"],
        "discount": ["desconto maximo", "desconto max", "desconto"], "category": ["categoria", "category"],
        "description": ["descricao", "description"], "duration": ["duracao", "duracao minutos", "minutos"]},
}


def fold(value) -> str:
    return " ".join("".join(char for char in unicodedata.normalize("NFKD", str(value).casefold()) if not unicodedata.combining(char)).replace("_", " ").replace("-", " ").replace("/", " ").split())


def decode_file(payload: dict) -> bytes:
    try:
        content = base64.b64decode(payload["dataBase64"], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("invalid_file_encoding") from exc
    if not content or len(content) > 8_000_000:
        raise ValueError("invalid_file_size")
    return content


def validate_sheet_xml(content: bytes):
    """Bound actual coordinates as well as ZIP size; ignore declared dimensions."""
    from defusedxml.ElementTree import iterparse
    from defusedxml.common import DefusedXmlException
    from xml.etree.ElementTree import ParseError
    try:
        for _, element in iterparse(io.BytesIO(content), events=("end",)):
            kind = element.tag.rsplit("}", 1)[-1]
            if kind == "row":
                index = element.get("r", "")
                if not index.isdigit() or len(index) > 6 or not 1 <= int(index) <= MAX_ROWS+1:
                    raise ValueError("spreadsheet_row_limit")
            elif kind == "c":
                coordinate = element.get("r", "")
                match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]{0,5})", coordinate)
                if not match or int(match[2]) > MAX_ROWS+1:
                    raise ValueError("spreadsheet_cell_limit")
                column = 0
                for char in match[1]:
                    column = column*26+ord(char)-ord("A")+1
                if column > 60:
                    raise ValueError("too_many_columns")
            element.clear()
    except (ParseError, DefusedXmlException) as exc:
        raise ValueError("invalid_spreadsheet_xml") from exc


def parse_file(payload: dict) -> tuple[list[str], list[dict]]:
    content = decode_file(payload)
    extension = payload["fileName"].rsplit(".", 1)[-1].casefold()
    if extension == "xlsx":
        from openpyxl import load_workbook
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > 300 or sum(entry.file_size for entry in entries) > 30_000_000:
                raise ValueError("spreadsheet_expansion_limit")
            for entry in entries:
                if entry.filename.lower().endswith("vbaproject.bin"):
                    raise ValueError("macro_not_allowed")
                if entry.filename.endswith(".xml"):
                    xml = archive.read(entry)
                    if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
                        raise ValueError("xml_entities_not_allowed")
                    if entry.filename.startswith("xl/worksheets/"):
                        validate_sheet_xml(xml)
        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True, keep_links=False)
        try:
            workbook.active.reset_dimensions()
            iterator = workbook.active.iter_rows(values_only=True)
            headers = [str(value or "").strip() for value in next(iterator, ())]
            if len(headers) > 60 or len(headers) != len(set(headers)):
                raise ValueError("invalid_columns")
            rows = []
            for values in iterator:
                if not any(value is not None for value in values):
                    continue
                rows.append({header: str(value) if value is not None else "" for header, value in zip(headers, values)})
                if len(rows) > MAX_ROWS:
                    raise ValueError("too_many_rows")
            return headers, rows
        finally:
            workbook.close()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("cp1252")
    if extension in {"vcf", "vcard"}:
        rows, current = [], None
        unfolded = re.sub(r"\r?\n[ \t]", "", text)
        for line in unfolded.splitlines():
            if line.strip().upper() == "BEGIN:VCARD":
                current = {}
            elif line.strip().upper() == "END:VCARD":
                if current is not None:
                    rows.append(current)
                current = None
                if len(rows) > MAX_ROWS:
                    raise ValueError("too_many_rows")
            elif current is not None and ":" in line:
                header, value = line.split(":", 1)
                key = header.split(";", 1)[0].upper()
                if key in {"FN", "ORG", "TEL", "EMAIL", "NOTE"} and key not in current:
                    if "QUOTED-PRINTABLE" in header.upper():
                        value = quopri.decodestring(value.encode()).decode("utf-8", errors="replace")
                    current[key] = value.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";")
        return ["FN", "ORG", "TEL", "EMAIL", "NOTE"], rows
    if extension != "csv":
        raise ValueError("unsupported_file_type")
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    headers = reader.fieldnames or []
    if len(headers) > 60 or len(headers) != len(set(headers)):
        raise ValueError("invalid_columns")
    rows = []
    for row in reader:
        if None in row:
            raise ValueError("invalid_csv_columns")
        rows.append({key: value or "" for key, value in row.items()})
        if len(rows) > MAX_ROWS:
            raise ValueError("too_many_rows")
    return headers, rows


def money_cents(value: str) -> int:
    cleaned = value.strip().replace("R$", "").replace("%", "").replace(" ", "")
    if "," in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(?:\.\d{3})+", cleaned):
        cleaned = cleaned.replace(".", "")
    try:
        decimal = Decimal(cleaned or "0")
        if not decimal.is_finite() or decimal < 0 or decimal.as_tuple().exponent < -2:
            raise ValueError("Preço deve ter até duas casas decimais.")
        return int(decimal * 100)
    except InvalidOperation as exc:
        raise ValueError("Preço inválido.") from exc


def valid_document(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if not digits:
        if not value.strip():
            return ""
        raise ValueError("CPF ou CNPJ deve conter os dígitos do documento.")
    from app.core.ai_guardrails import _valid_cpf
    if len(digits) == 11 and _valid_cpf(digits):
        return digits
    if len(digits) == 14 and len(set(digits)) > 1:
        body = digits[:12]
        for weights in ([5,4,3,2,9,8,7,6,5,4,3,2], [6,5,4,3,2,9,8,7,6,5,4,3,2]):
            rest = sum(int(number) * weight for number, weight in zip(body, weights)) % 11
            body += str(0 if rest < 2 else 11-rest)
        if body == digits:
            return digits
    raise ValueError("CPF ou CNPJ inválido; confira os dígitos.")


def normalize(row, target):
    if target == "clients":
        from app.modules.clients.router import ClientCreate
        result = {key: str(value).strip() for key, value in row.items()}
        result["document"] = valid_document(result.get("document", ""))
        phone = re.sub(r"\D", "", result.get("phone", ""))
        if result.get("phone") and not phone:
            raise ValueError("Confira os dígitos do telefone.")
        if phone:
            if len(phone) in {10, 11}:
                phone = "55" + phone
            if len(phone) not in {12, 13} or not phone.startswith("55"):
                raise ValueError("Telefone precisa conter DDD e número válido.")
        result["phone"] = phone
        result["email"] = result.get("email", "").casefold()
        if result["email"] and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", result["email"]):
            raise ValueError("E-mail inválido.")
        result["state"] = result.get("state", "").upper()
        if result["state"] and result["state"] not in {"AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"}:
            raise ValueError("UF deve ser a sigla de um estado brasileiro.")
        if result.get("name", "").startswith(("=", "@")):
            raise ValueError("O nome contém uma fórmula; substitua por texto.")
        return ClientCreate.model_validate(result).model_dump()
    from .router import CatalogItem
    kind = fold(row.get("type", "servico"))
    if kind not in {"servico", "service", "produto", "product", ""}:
        raise ValueError("Tipo deve ser Produto ou Serviço.")
    if not row.get("price", "").strip():
        raise ValueError("Informe o preço do item ou ajuste a coluna Preço.")
    duration = None
    if row.get("duration"):
        number = Decimal(row["duration"])
        if not number.is_finite() or number != number.to_integral_value():
            raise ValueError("A duração deve ser um número inteiro de minutos.")
        duration = int(number)
    return CatalogItem.model_validate({"name": row.get("name", ""), "sku": row.get("sku", ""),
        "type": "product" if kind in {"produto", "product"} else "service", "unit": row.get("unit") or "un",
        "priceCents": money_cents(row.get("price", "")), "maxDiscountBasisPoints": money_cents(row.get("discount", "")),
        "category": row.get("category", ""), "description": row.get("description", ""),
        "durationMinutes": duration}).model_dump()


def build_preview(payload):
    try:
        headers, source = parse_file(payload)
    except (zipfile.BadZipFile, UnicodeError, KeyError, EOFError) as exc:
        raise ValueError("invalid_import_file") from exc
    target = payload["target"]
    mapping = {}
    for field, aliases in FIELDS[target].items():
        match = payload.get("mapping", {}).get(field)
        if match and match not in headers:
            raise ValueError("invalid_mapping")
        mapping[field] = match if field in payload.get("mapping", {}) else next((header for header in headers if fold(header) in aliases), "")
    if not headers or any(not header or len(header) > 120 for header in headers):
        raise ValueError("invalid_header")
    rows = []
    for index, original in enumerate(source):
        row = {field: original.get(header, "") for field, header in mapping.items() if header}
        try:
            value = normalize(row, target)
            warning = "Sem documento, telefone ou e-mail: duplicados só serão reconhecidos ao reimportar este mesmo registro." if target == "clients" and not any(value.get(field) for field in ("document", "phone", "email")) else ""
            rows.append({"index": index, "line": index+2, "data": value, "error": "", "warning": warning})
        except (ValueError, ValidationError, InvalidOperation) as exc:
            message = "Confira os campos obrigatórios, os tamanhos e os valores." if isinstance(exc, ValidationError) else str(exc)
            rows.append({"index": index, "line": index+2, "data": row, "error": message, "warning": ""})
    if not rows:
        raise ValueError("empty_file")
    digest = hashlib.sha256(json.dumps({"target": target, "rows": rows}, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
    return {"id": "preview_" + digest, "target": target, "columns": headers, "mapping": mapping,
            "rows": rows, "digest": digest, "expiresAt": time.time()+86400,
            "total": len(rows), "valid": sum(not row["error"] for row in rows)}


async def process_job(job):
    user = await jobs.live_user(job)
    if job["kind"].startswith("import.preview."):
        preview = await asyncio.to_thread(build_preview, job["payload"])
        await jobs.live_user(job)
        def persist(_current):
            def save(data):
                data["items"] = [item for item in data["items"] if item.get("expiresAt", 0) > time.time() and item["id"] != preview["id"]]
                require_room(data["items"], 10)
                data["items"].append(preview)
            mutate(user, "import_previews", save)
            return 100, {"previewId": preview["id"], "total": preview["total"], "valid": preview["valid"]}, True
        await asyncio.to_thread(jobs.apply_chunk, job, persist)
        return
    from .import_apply import apply_import
    await apply_import(job)


class ImportPreview(StrictModel):
    fileName: str = Field(min_length=3, max_length=200)
    dataBase64: str = Field(min_length=4, max_length=10_666_668)
    target: Literal["clients", "catalog"] = "clients"
    mapping: dict[str, str] = Field(default_factory=dict, max_length=20)


@router.post("/preview", status_code=202)
async def prepare_import(payload: ImportPreview, user: dict = Depends(current_user)):
    assert_route_permissions(user, "/api/clientes" if payload.target == "clients" else "/api/comercial")
    if os_worker_disabled():
        raise HTTPException(503, "O processamento de importações está pausado no servidor.")
    if any(field not in FIELDS[payload.target] for field in payload.mapping):
        raise HTTPException(422, "Mapeamento de coluna desconhecido.")
    body = payload.model_dump()
    key = hashlib.sha256(json.dumps([int(time.time()//86400), body], sort_keys=True, ensure_ascii=True).encode()).hexdigest()
    result = await asyncio.to_thread(jobs.enqueue, user, "import.preview." + payload.target, body, key)
    jobs.wake()
    return {"job": result}


def os_worker_disabled():
    import os
    return os.getenv("NORIUM_BUSINESS_WORKER_ENABLED", "1") != "1"


@router.get("/jobs")
async def recent_imports(target: Literal["clients", "catalog"], response: Response, user: dict = Depends(current_user)):
    assert_route_permissions(user, "/api/clientes" if target == "clients" else "/api/comercial")
    response.headers["Cache-Control"] = "no-store"
    return {"jobs": await asyncio.to_thread(jobs.recent, user, target)}


@router.get("/jobs/{job_id}")
async def import_status(job_id: str, response: Response, user: dict = Depends(current_user)):
    response.headers["Cache-Control"] = "no-store"
    job = await asyncio.to_thread(jobs.read, user, job_id)
    assert_route_permissions(user, "/api/clientes" if job["kind"].endswith(".clients") else "/api/comercial")
    return {"job": job}


@router.post("/jobs/{job_id}/retry")
async def retry_import(job_id: str, user: dict = Depends(current_user)):
    job = await asyncio.to_thread(jobs.read, user, job_id)
    assert_route_permissions(user, "/api/clientes" if job["kind"].endswith(".clients") else "/api/comercial")
    await asyncio.to_thread(jobs.retry, user, job_id)
    jobs.wake()
    return {"job": await asyncio.to_thread(jobs.read, user, job_id)}


@router.get("/previews/{preview_id}")
async def import_preview(preview_id: str, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100), user: dict = Depends(current_user)):
    data = await asyncio.to_thread(snapshot, user, "import_previews")
    preview = next((item for item in data["items"] if item["id"] == preview_id and item["expiresAt"] > time.time()), None)
    if not preview:
        raise HTTPException(404, "Prévia não encontrada ou expirada. Importe o arquivo novamente.")
    assert_route_permissions(user, "/api/clientes" if preview["target"] == "clients" else "/api/comercial")
    return {**{key: value for key, value in preview.items() if key != "rows"}, "rows": preview["rows"][offset:offset+limit],
            "nextOffset": offset+limit if offset+limit < len(preview["rows"]) else None}


class ImportCommit(StrictModel):
    expectedDigest: str = Field(pattern=r"^[a-f0-9]{64}$")
    skipInvalid: bool = False


@router.post("/previews/{preview_id}/commit", status_code=202)
async def commit_import(preview_id: str, payload: ImportCommit, user: dict = Depends(current_user)):
    if os_worker_disabled():
        raise HTTPException(503, "O processamento de importações está pausado no servidor.")
    data = await asyncio.to_thread(snapshot, user, "import_previews")
    preview = next((item for item in data["items"] if item["id"] == preview_id and item["expiresAt"] > time.time()), None)
    if not preview or preview["digest"] != payload.expectedDigest:
        raise HTTPException(409, "A prévia mudou ou expirou. Recarregue antes de confirmar.")
    assert_route_permissions(user, "/api/clientes" if preview["target"] == "clients" else "/api/comercial")
    if preview["valid"] != preview["total"] and not payload.skipInvalid:
        raise HTTPException(409, "Revise os registros inválidos ou confirme explicitamente a importação apenas dos válidos.")
    rows = [row for row in preview["rows"] if not row["error"]]
    if not rows:
        raise HTTPException(422, "Não há registros válidos para importar.")
    result = await asyncio.to_thread(jobs.enqueue, user, "import." + preview["target"],
        {"rows": rows, "sourceDigest": preview["digest"], "skipped": preview["total"]-preview["valid"]}, preview["id"])
    jobs.wake()
    return {"job": result}
