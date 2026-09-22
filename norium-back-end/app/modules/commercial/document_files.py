from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import os
import re
import tempfile
import unicodedata
import uuid
from datetime import datetime, timezone
from difflib import unified_diff
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from app.core.tenant import get_user_db_path
from app.infrastructure.persistence import files as persistent_files
from app.infrastructure.persistence import postgres_store
from app.modules.commercial.repository import STORE_LOCK, read_store, write_store
from app.modules.commercial.schemas import DocumentImportRequest, ImportedDocumentUpdate, PdfProcessRequest
from app.modules.commercial.stirling_pdf import StirlingPdfClient, StirlingPdfError
from app.modules.commercial.pdf_editor import PdfEdits, apply_pdf_edits


NATIVE_PDF_OPERATIONS = {
    "merge",
    "split",
    "reorder",
    "delete_pages",
    "rotate",
    "compress",
    "images_to_pdf",
    "watermark",
    "edit_pdf",
    "page_numbers",
    "add_password",
    "remove_password",
    "extract_text",
    "remove_metadata",
    "sanitize",
    "compare",
}
OPERATION_LABELS = {
    "merge": "Combinar PDFs",
    "split": "Separar paginas",
    "reorder": "Reorganizar paginas",
    "delete_pages": "Excluir paginas",
    "rotate": "Girar paginas",
    "compress": "Comprimir PDF",
    "images_to_pdf": "Converter imagens em PDF",
    "watermark": "Aplicar marca d'agua",
    "edit_pdf": "Editar PDF",
    "page_numbers": "Numerar paginas",
    "add_password": "Adicionar senha",
    "remove_password": "Remover senha autorizada",
    "ocr": "Aplicar OCR",
    "extract_text": "Extrair texto",
    "remove_metadata": "Remover metadados",
    "sanitize": "Sanitizar PDF",
    "compare": "Comparar documentos",
}
OPERATION_OPTION_KEYS: dict[str, set[str]] = {
    "split": {"pages"},
    "reorder": {"pages"},
    "delete_pages": {"pages"},
    "rotate": {"pages", "degrees"},
    "compress": {"level"},
    "watermark": {"text", "opacity", "fontSize", "rotation"},
    "edit_pdf": {"text", "pages", "xPercent", "yPercent", "fontSize", "color", "editor"},
    "add_password": {"password"},
    "remove_password": {"password"},
    "ocr": {"languages", "deskew", "clean"},
}


def _validated_options(operation: str, options: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    allowed = OPERATION_OPTION_KEYS.get(operation, set())
    unknown = sorted(set(options) - allowed)
    if unknown:
        raise HTTPException(status_code=422, detail=f'Opcoes nao permitidas: {", ".join(unknown)}.')
    normalized: dict[str, Any] = {}
    transient: dict[str, Any] = {}
    for key, value in options.items():
        if key == "editor":
            try:
                normalized[key] = PdfEdits.model_validate(value).model_dump()
            except ValueError as exc:
                raise HTTPException(status_code=422, detail="Dados de edicao invalidos. Verifique os elementos e as imagens.") from exc
        elif key == "password":
            password = str(value)
            if len(password) > 200:
                raise HTTPException(status_code=422, detail="A senha informada e muito longa.")
            transient[key] = password
        elif key in {"text", "languages", "pages", "color"}:
            normalized[key] = str(value)[:500]
        elif key in {"degrees", "fontSize", "rotation", "level"}:
            normalized[key] = int(value)
        elif key in {"opacity", "xPercent", "yPercent"}:
            normalized[key] = float(value)
        elif key in {"deskew", "clean"}:
            normalized[key] = bool(value)
    return normalized, transient


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def max_upload_bytes() -> int:
    configured = int(os.getenv("DOCUMENT_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
    return max(1024 * 1024, min(configured, 100 * 1024 * 1024))


def processing_timeout_seconds() -> int:
    configured = int(os.getenv("DOCUMENT_PROCESS_TIMEOUT_SECONDS", "240"))
    return max(15, min(configured, 900))


def processing_retries() -> int:
    configured = int(os.getenv("DOCUMENT_PROCESS_MAX_RETRIES", "1"))
    return max(0, min(configured, 3))


def _storage_root(tenant_id: str) -> Path:
    database_path = Path(get_user_db_path(tenant_id, "comercial"))
    root = (database_path.parent / "documents").resolve()
    if not (postgres_store.configured() or postgres_store.required()):
        root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_filename(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", Path(value).name)
    ascii_name = normalized.encode("ascii", "ignore").decode("ascii")
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", ascii_name).strip(".-")
    return stem[:180] or "documento"


def _decode_file(payload: DocumentImportRequest) -> bytes:
    encoded = payload.dataBase64.split(",", 1)[-1].strip()
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Arquivo codificado em base64 invalido.") from exc
    if not content:
        raise HTTPException(status_code=422, detail="O arquivo esta vazio.")
    if len(content) > max_upload_bytes():
        raise HTTPException(status_code=413, detail="O arquivo excede o limite configurado.")
    return content


def _validated_extension(payload: DocumentImportRequest, content: bytes) -> str:
    suffix = Path(payload.fileName).suffix.lower()
    rules = {
        "application/pdf": ({".pdf"}, content.startswith(b"%PDF-")),
        "image/png": ({".png"}, content.startswith(b"\x89PNG\r\n\x1a\n")),
        "image/jpeg": ({".jpg", ".jpeg"}, content.startswith(b"\xff\xd8\xff")),
        "image/webp": ({".webp"}, content.startswith(b"RIFF") and content[8:12] == b"WEBP"),
    }
    extensions, valid_magic = rules[payload.mimeType]
    if suffix not in extensions or not valid_magic:
        raise HTTPException(status_code=422, detail="Extensao, tipo MIME e assinatura do arquivo nao correspondem.")
    return suffix


def document_file_summary(document: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in document.items()
        if key not in {"storagePath", "tokenHash"}
    }


def processing_job_summary(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in job.items()
        if key not in {"internalError"}
    }


async def prepare_imported_document(
    tenant_id: str,
    actor: dict[str, Any],
    payload: DocumentImportRequest,
) -> dict[str, Any]:
    content = _decode_file(payload)
    suffix = _validated_extension(payload, content)
    now = now_iso()
    document_id = f"file_{uuid.uuid4().hex}"
    stored_name = f"{document_id}{suffix}"
    destination = (_storage_root(tenant_id) / stored_name).resolve()
    if destination.parent != _storage_root(tenant_id):
        raise HTTPException(status_code=422, detail="Nome de arquivo invalido.")
    await asyncio.to_thread(persistent_files.write, destination, content, content_type=payload.mimeType)
    title = Path(_safe_filename(payload.fileName)).stem.replace("-", " ").strip() or "Documento importado"
    event = {
        "id": f"event_{uuid.uuid4().hex}",
        "action": "document_imported",
        "label": "Documento importado",
        "actorId": str(actor.get("id") or ""),
        "actorName": str(actor.get("nome") or actor.get("email") or "Operador"),
        "timestamp": now,
    }
    item = {
        "id": document_id,
        "documentType": "pdf" if payload.mimeType == "application/pdf" else "image",
        "title": title,
        "originalFileName": _safe_filename(payload.fileName),
        "mimeType": payload.mimeType,
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "storagePath": str(destination),
        "category": payload.category,
        "direction": payload.direction,
        "status": "ready",
        "favorite": False,
        "archived": payload.category == "archived",
        "confidential": payload.confidential,
        "scanStatus": "not_configured",
        "securityReviewRequired": True,
        "events": [event],
        "createdBy": str(actor.get("id") or ""),
        "createdByName": str(actor.get("nome") or actor.get("email") or "Operador"),
        "createdAt": now,
        "updatedAt": now,
    }
    return item


async def import_document(tenant_id: str, actor: dict[str, Any], payload: DocumentImportRequest) -> dict[str, Any]:
    item = await prepare_imported_document(tenant_id, actor, payload)
    async with STORE_LOCK:
        store = await asyncio.to_thread(read_store, tenant_id)
        store["uploadedDocuments"].insert(0, item)
        await write_store(tenant_id, store)
    return document_file_summary(item)


def imported_document_or_404(store: dict[str, Any], document_id: str) -> tuple[int, dict[str, Any]]:
    for index, document in enumerate(store.get("uploadedDocuments", [])):
        if str(document.get("id")) == document_id:
            return index, document
    raise HTTPException(status_code=404, detail="Documento importado nao encontrado.")


def processing_job_or_404(store: dict[str, Any], job_id: str) -> tuple[int, dict[str, Any]]:
    for index, job in enumerate(store.get("processingJobs", [])):
        if str(job.get("id")) == job_id:
            return index, job
    raise HTTPException(status_code=404, detail="Processamento nao encontrado.")


def document_path(tenant_id: str, document: dict[str, Any]) -> Path:
    root = _storage_root(tenant_id)
    path = Path(str(document.get("storagePath") or "")).resolve()
    if path.parent != root or not persistent_files.exists(path):
        raise HTTPException(status_code=404, detail="Arquivo privado indisponivel.")
    return path


def document_bytes(tenant_id: str, document: dict[str, Any]) -> bytes:
    return persistent_files.read(document_path(tenant_id, document))


async def update_imported_document(
    tenant_id: str,
    actor: dict[str, Any],
    document_id: str,
    payload: ImportedDocumentUpdate,
) -> dict[str, Any]:
    async with STORE_LOCK:
        store = await asyncio.to_thread(read_store, tenant_id)
        index, current = imported_document_or_404(store, document_id)
        updates = payload.model_dump(exclude_unset=True)
        if updates.get("category") == "archived":
            updates["archived"] = True
        if updates.get("archived") is True:
            updates["category"] = "archived"
        event = {
            "id": f"event_{uuid.uuid4().hex}",
            "action": "document_updated",
            "label": "Documento atualizado",
            "actorId": str(actor.get("id") or ""),
            "actorName": str(actor.get("nome") or actor.get("email") or "Operador"),
            "timestamp": now_iso(),
        }
        updated = {
            **current,
            **updates,
            "updatedAt": event["timestamp"],
            "events": [event, *current.get("events", [])][:100],
        }
        store["uploadedDocuments"][index] = updated
        await write_store(tenant_id, store)
    return document_file_summary(updated)


async def delete_imported_document(tenant_id: str, document_id: str) -> dict[str, Any]:
    async with STORE_LOCK:
        store = await asyncio.to_thread(read_store, tenant_id)
        index, current = imported_document_or_404(store, document_id)
        if any(
            proposal.get("sourceDocumentId") == document_id
            or any(document_id in {version.get("documentId"), version.get("editedDocumentId")} for version in proposal.get("fileVersions", []))
            for proposal in store.get("proposals", [])
        ):
            raise HTTPException(status_code=409, detail="Este arquivo faz parte do histórico de uma proposta e deve ser preservado.")
        active_job = next(
            (
                job
                for job in store.get("processingJobs", [])
                if document_id in job.get("documentIds", []) and job.get("status") in {"queued", "processing"}
            ),
            None,
        )
        if active_job:
            raise HTTPException(status_code=409, detail="Cancele o processamento ativo antes de excluir o documento.")
        store["uploadedDocuments"].pop(index)
        await write_store(tenant_id, store)
    path = Path(str(current.get("storagePath") or ""))
    try:
        if path.resolve().parent == _storage_root(tenant_id):
            await asyncio.to_thread(persistent_files.delete, path)
    except OSError:
        pass
    return document_file_summary(current)


async def pdf_capabilities() -> dict[str, Any]:
    stirling = await StirlingPdfClient().capabilities()
    native = sorted(NATIVE_PDF_OPERATIONS)
    stirling_operations = [operation for operation in stirling.get("operations", []) if operation not in native]
    operations = [*native, *stirling_operations]
    return {
        "operations": [
            {
                "id": operation,
                "label": OPERATION_LABELS[operation],
                "engine": "native" if operation in NATIVE_PDF_OPERATIONS else "stirling",
            }
            for operation in operations
        ],
        "stirling": stirling,
        "maxUploadBytes": max_upload_bytes(),
        "asynchronous": True,
    }


async def create_processing_job(
    tenant_id: str,
    actor: dict[str, Any],
    payload: PdfProcessRequest,
) -> dict[str, Any]:
    capabilities = await pdf_capabilities()
    allowed = {item["id"] for item in capabilities["operations"]}
    if payload.operation not in allowed:
        raise HTTPException(status_code=409, detail="Esta operacao nao esta disponivel no motor configurado.")
    if payload.operation == "merge" and len(payload.documentIds) < 2:
        raise HTTPException(status_code=422, detail="Selecione ao menos dois documentos para esta operacao.")
    if payload.operation == "compare" and len(payload.documentIds) != 2:
        raise HTTPException(status_code=422, detail="A comparacao exige exatamente dois documentos.")
    if payload.operation not in {"merge", "compare", "images_to_pdf"} and len(payload.documentIds) != 1:
        raise HTTPException(status_code=422, detail="Esta operacao aceita um documento por processamento.")
    persisted_options, transient_options = _validated_options(payload.operation, payload.options)
    async with STORE_LOCK:
        store = await asyncio.to_thread(read_store, tenant_id)
        documents = [imported_document_or_404(store, document_id)[1] for document_id in payload.documentIds]
        if payload.operation != "images_to_pdf" and any(item.get("mimeType") != "application/pdf" for item in documents):
            raise HTTPException(status_code=422, detail="A operacao selecionada aceita somente arquivos PDF.")
        if payload.operation == "images_to_pdf" and any(not str(item.get("mimeType") or "").startswith("image/") for item in documents):
            raise HTTPException(status_code=422, detail="Selecione somente imagens para esta conversao.")
        now = now_iso()
        job = {
            "id": f"job_{uuid.uuid4().hex}",
            "operation": payload.operation,
            "label": OPERATION_LABELS[payload.operation],
            "documentIds": payload.documentIds,
            "options": persisted_options,
            "requiresTransientSecret": bool(transient_options),
            "status": "queued",
            "progress": 0,
            "attempts": 0,
            "maxAttempts": processing_retries() + 1,
            "cancelRequested": False,
            "outputDocumentIds": [],
            "message": "Aguardando processamento.",
            "createdBy": str(actor.get("id") or ""),
            "createdByName": str(actor.get("nome") or actor.get("email") or "Operador"),
            "createdAt": now,
            "updatedAt": now,
        }
        store["processingJobs"].insert(0, job)
        store["processingJobs"] = store["processingJobs"][:200]
        await write_store(tenant_id, store)
    return processing_job_summary(job)


async def cancel_processing_job(tenant_id: str, job_id: str) -> dict[str, Any]:
    async with STORE_LOCK:
        store = await asyncio.to_thread(read_store, tenant_id)
        index, job = processing_job_or_404(store, job_id)
        if job.get("status") in {"completed", "failed", "cancelled"}:
            return processing_job_summary(job)
        updated = {
            **job,
            "cancelRequested": True,
            "status": "cancelled" if job.get("status") == "queued" else job.get("status"),
            "message": "Cancelamento solicitado.",
            "updatedAt": now_iso(),
        }
        store["processingJobs"][index] = updated
        await write_store(tenant_id, store)
    return processing_job_summary(updated)


async def _read_job(tenant_id: str, job_id: str) -> dict[str, Any]:
    store = await asyncio.to_thread(read_store, tenant_id)
    return processing_job_or_404(store, job_id)[1]


async def _write_job(tenant_id: str, job_id: str, **updates: Any) -> dict[str, Any]:
    async with STORE_LOCK:
        store = await asyncio.to_thread(read_store, tenant_id)
        index, current = processing_job_or_404(store, job_id)
        updated = {**current, **updates, "updatedAt": now_iso()}
        store["processingJobs"][index] = updated
        await write_store(tenant_id, store)
    return updated


async def run_processing_job(
    tenant_id: str,
    job_id: str,
    transient_options: dict[str, Any] | None = None,
) -> None:
    job = await _read_job(tenant_id, job_id)
    if job.get("status") != "queued" or job.get("cancelRequested"):
        return
    max_attempts = int(job.get("maxAttempts") or 1)
    last_error = ""
    for attempt in range(1, max_attempts + 1):
        job = await _write_job(
            tenant_id,
            job_id,
            status="processing",
            progress=10,
            attempts=attempt,
            message=f"Processando (tentativa {attempt} de {max_attempts}).",
        )
        if job.get("cancelRequested"):
            await _write_job(tenant_id, job_id, status="cancelled", progress=0, message="Processamento cancelado.")
            return
        try:
            execution_job = {
                **job,
                "options": {
                    **(job.get("options") if isinstance(job.get("options"), dict) else {}),
                    **(transient_options or {}),
                },
            }
            outputs = await asyncio.wait_for(
                _execute_job(tenant_id, execution_job),
                timeout=processing_timeout_seconds(),
            )
            latest = await _read_job(tenant_id, job_id)
            if latest.get("cancelRequested"):
                await _write_job(tenant_id, job_id, status="cancelled", progress=0, message="Processamento cancelado.")
                return
            output_documents = await _persist_outputs(tenant_id, job, outputs)
            await _write_job(
                tenant_id,
                job_id,
                status="completed",
                progress=100,
                outputDocumentIds=[item["id"] for item in output_documents],
                message="Processamento concluido.",
                completedAt=now_iso(),
            )
            return
        except asyncio.TimeoutError:
            last_error = "O processamento excedeu o tempo limite configurado."
        except (HTTPException, StirlingPdfError, ValueError, OSError) as exc:
            last_error = exc.detail if isinstance(exc, HTTPException) else str(exc)
        except Exception:
            last_error = "Falha interna ao processar o documento."
        if attempt < max_attempts:
            await _write_job(tenant_id, job_id, status="queued", progress=0, message="Nova tentativa agendada.")
            await asyncio.sleep(min(attempt, 3))
    await _write_job(
        tenant_id,
        job_id,
        status="failed",
        progress=0,
        message=last_error or "Nao foi possivel processar o documento.",
        failedAt=now_iso(),
    )


async def _execute_job(tenant_id: str, job: dict[str, Any]) -> list[tuple[bytes, str, str]]:
    store = await asyncio.to_thread(read_store, tenant_id)
    documents = [imported_document_or_404(store, document_id)[1] for document_id in job.get("documentIds", [])]
    stored_paths = [document_path(tenant_id, document) for document in documents]
    operation = str(job.get("operation") or "")
    options = job.get("options") if isinstance(job.get("options"), dict) else {}

    with tempfile.TemporaryDirectory(prefix="norium-doc-process-") as directory:
        paths: list[Path] = []
        for index, stored_path in enumerate(stored_paths):
            temporary = Path(directory) / f"{index}{stored_path.suffix}"
            temporary.write_bytes(persistent_files.read(stored_path))
            paths.append(temporary)
        if operation == "ocr":
            content, filename, content_type = await StirlingPdfClient().process(operation, paths, options)
            return [(content, filename, content_type)]
        if operation in {"watermark", "merge", "compress"}:
            stirling = StirlingPdfClient()
            if stirling.configured:
                capabilities = await stirling.capabilities()
                if operation in capabilities.get("operations", []):
                    content, filename, content_type = await stirling.process(operation, paths, options)
                    return [(content, filename, content_type)]
        return await asyncio.to_thread(_process_native, operation, paths, options)


def _reader(path: Path, password: str = "") -> PdfReader:
    reader = PdfReader(str(path))
    if reader.is_encrypted:
        if not password or reader.decrypt(password) == 0:
            raise ValueError("O PDF esta protegido; informe a senha autorizada.")
    return reader


def _pdf_bytes(writer: PdfWriter, *, password: str = "") -> bytes:
    if password:
        writer.encrypt(password)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def _page_numbers(options: dict[str, Any], total: int, key: str = "pages") -> list[int]:
    raw = options.get(key)
    if raw is None:
        return list(range(total))
    if isinstance(raw, str):
        values = [part.strip() for part in raw.split(",") if part.strip()]
    elif isinstance(raw, list):
        values = raw
    else:
        raise ValueError("Lista de paginas invalida.")
    result: list[int] = []
    for value in values:
        page = int(value) - 1
        if page < 0 or page >= total:
            raise ValueError("Uma das paginas informadas nao existe.")
        result.append(page)
    return result


def _overlay_page(width: float, height: float, draw: Any) -> Any:
    buffer = io.BytesIO()
    overlay = canvas.Canvas(buffer, pagesize=(width, height))
    draw(overlay, width, height)
    overlay.save()
    buffer.seek(0)
    return PdfReader(buffer).pages[0]


def _process_native(operation: str, paths: list[Path], options: dict[str, Any]) -> list[tuple[bytes, str, str]]:
    if operation == "edit_pdf" and "editor" in options:
        return [(apply_pdf_edits(paths[0].read_bytes(), options["editor"]), "pdf-editado.pdf", "application/pdf")]
    password = str(options.get("password") or "")
    if operation == "images_to_pdf":
        output = io.BytesIO()
        pdf = canvas.Canvas(output)
        for path in paths:
            image = ImageReader(str(path))
            width, height = image.getSize()
            pdf.setPageSize((width, height))
            pdf.drawImage(image, 0, 0, width=width, height=height, preserveAspectRatio=True)
            pdf.showPage()
        pdf.save()
        return [(output.getvalue(), "imagens-convertidas.pdf", "application/pdf")]

    readers = [_reader(path, password if operation == "remove_password" else "") for path in paths]
    if operation == "merge":
        writer = PdfWriter()
        for reader in readers:
            for page in reader.pages:
                writer.add_page(page)
        return [(_pdf_bytes(writer), "documentos-combinados.pdf", "application/pdf")]
    if operation == "split":
        outputs: list[tuple[bytes, str, str]] = []
        for page_index in _page_numbers(options, len(readers[0].pages)):
            writer = PdfWriter()
            writer.add_page(readers[0].pages[page_index])
            outputs.append((_pdf_bytes(writer), f"pagina-{page_index + 1}.pdf", "application/pdf"))
        return outputs
    if operation == "compare":
        first = "\n".join(page.extract_text() or "" for page in readers[0].pages).splitlines()
        second = "\n".join(page.extract_text() or "" for page in readers[1].pages).splitlines()
        comparison = "\n".join(unified_diff(first, second, fromfile=paths[0].name, tofile=paths[1].name, lineterm=""))
        return [(comparison.encode("utf-8"), "comparacao-documentos.txt", "text/plain")]
    if operation == "extract_text":
        text = "\n\n".join(page.extract_text() or "" for page in readers[0].pages)
        return [(text.encode("utf-8"), "texto-extraido.txt", "text/plain")]

    reader = readers[0]
    writer = PdfWriter()
    if operation == "reorder":
        for page_index in _page_numbers(options, len(reader.pages), "pages"):
            writer.add_page(reader.pages[page_index])
    elif operation == "delete_pages":
        excluded = set(_page_numbers(options, len(reader.pages), "pages"))
        if len(excluded) >= len(reader.pages):
            raise ValueError("O documento deve manter ao menos uma pagina.")
        for index, page in enumerate(reader.pages):
            if index not in excluded:
                writer.add_page(page)
    elif operation == "rotate":
        degrees = int(options.get("degrees") or 90)
        if degrees not in {-270, -180, -90, 90, 180, 270}:
            raise ValueError("A rotacao deve ser um multiplo de 90 graus.")
        selected = set(_page_numbers(options, len(reader.pages)))
        for index, page in enumerate(reader.pages):
            if index in selected:
                page.rotate(degrees)
            writer.add_page(page)
    elif operation == "compress":
        for page in reader.pages:
            page.compress_content_streams()
            writer.add_page(page)
    elif operation in {"remove_metadata", "sanitize"}:
        for page in reader.pages:
            writer.add_page(page)
        writer.add_metadata({"/Producer": "Norium Documentos"})
    elif operation == "add_password":
        if len(password) < 8:
            raise ValueError("A senha deve ter pelo menos oito caracteres.")
        for page in reader.pages:
            writer.add_page(page)
        return [(_pdf_bytes(writer, password=password), "documento-protegido.pdf", "application/pdf")]
    elif operation == "remove_password":
        for page in reader.pages:
            writer.add_page(page)
    elif operation in {"watermark", "page_numbers", "edit_pdf"}:
        text = str(options.get("text") or "CONFIDENCIAL")[:120]
        edit_pages = set(_page_numbers(options, len(reader.pages))) if operation == "edit_pdf" else set()
        for page_index, page in enumerate(reader.pages, start=1):
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            if operation == "watermark":
                def draw_watermark(pdf: canvas.Canvas, page_width: float, page_height: float) -> None:
                    pdf.saveState()
                    pdf.setFillAlpha(max(0.05, min(float(options.get("opacity") or 0.22), 1)))
                    pdf.setFont("Helvetica-Bold", max(10, min(int(options.get("fontSize") or 34), 120)))
                    pdf.translate(page_width / 2, page_height / 2)
                    pdf.rotate(max(-360, min(int(options.get("rotation") or 45), 360)))
                    pdf.drawCentredString(0, 0, text)
                    pdf.restoreState()
                page.merge_page(_overlay_page(width, height, draw_watermark))
            elif operation == "page_numbers":
                def draw_number(pdf: canvas.Canvas, page_width: float, _page_height: float, number: int = page_index) -> None:
                    pdf.setFont("Helvetica", 9)
                    pdf.drawCentredString(page_width / 2, 18, f"Pagina {number} de {len(reader.pages)}")
                page.merge_page(_overlay_page(width, height, draw_number))
            elif not edit_pages or (page_index - 1) in edit_pages:
                color = str(options.get("color") or "#1266F1")
                if not re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
                    raise ValueError("A cor do editor deve usar o formato hexadecimal #RRGGBB.")

                def draw_editor_text(pdf: canvas.Canvas, page_width: float, page_height: float) -> None:
                    pdf.saveState()
                    pdf.setFillColor(HexColor(color))
                    pdf.setFont("Helvetica", max(8, min(int(options.get("fontSize") or 18), 96)))
                    x = page_width * max(0.02, min(float(options.get("xPercent") or 10) / 100, 0.98))
                    y = page_height * (1 - max(0.02, min(float(options.get("yPercent") or 12) / 100, 0.98)))
                    pdf.drawString(x, y, text)
                    pdf.restoreState()

                page.merge_page(_overlay_page(width, height, draw_editor_text))
            writer.add_page(page)
    else:
        raise ValueError("Operacao de PDF nao implementada.")
    return [(_pdf_bytes(writer), f"{operation}-resultado.pdf", "application/pdf")]


def process_native_documents(
    operation: str,
    paths: list[Path],
    options: dict[str, Any] | None = None,
) -> list[tuple[bytes, str, str]]:
    """Ponto público para fluxos internos que processam arquivos sem chamar IA."""
    if operation not in NATIVE_PDF_OPERATIONS:
        raise ValueError("Operação de PDF não suportada pelo processamento local.")
    if not paths:
        raise ValueError("Envie ao menos um arquivo para processar.")
    if operation in {"merge", "compare"} and len(paths) < 2:
        raise ValueError("Esta operação exige pelo menos dois arquivos.")
    if operation not in {"merge", "compare", "images_to_pdf"} and len(paths) != 1:
        raise ValueError("Esta operação aceita um arquivo por vez.")
    return _process_native(operation, paths, options or {})


async def _persist_outputs(
    tenant_id: str,
    job: dict[str, Any],
    outputs: list[tuple[bytes, str, str]],
) -> list[dict[str, Any]]:
    now = now_iso()
    root = _storage_root(tenant_id)
    created: list[dict[str, Any]] = []
    for content, filename, mime_type in outputs:
        document_id = f"file_{uuid.uuid4().hex}"
        suffix = ".txt" if mime_type == "text/plain" else ".pdf"
        destination = (root / f"{document_id}{suffix}").resolve()
        if destination.parent != root:
            raise ValueError("Destino interno invalido.")
        await asyncio.to_thread(persistent_files.write, destination, content, content_type=mime_type)
        item = {
            "id": document_id,
            "documentType": "text" if mime_type == "text/plain" else "pdf",
            "title": Path(filename).stem.replace("-", " ").strip().title(),
            "originalFileName": _safe_filename(filename),
            "mimeType": mime_type,
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "storagePath": str(destination),
            "category": "pdf",
            "direction": "internal",
            "status": "ready",
            "favorite": False,
            "archived": False,
            "confidential": False,
            "scanStatus": "generated",
            "securityReviewRequired": False,
            "sourceDocumentIds": list(job.get("documentIds", [])),
            "processingJobId": job.get("id"),
            "events": [{
                "id": f"event_{uuid.uuid4().hex}",
                "action": "pdf_processing_completed",
                "label": str(job.get("label") or "Processamento concluido"),
                "actorId": str(job.get("createdBy") or ""),
                "actorName": str(job.get("createdByName") or "Operador"),
                "timestamp": now,
            }],
            "createdBy": str(job.get("createdBy") or ""),
            "createdByName": str(job.get("createdByName") or "Operador"),
            "createdAt": now,
            "updatedAt": now,
        }
        created.append(item)
    async with STORE_LOCK:
        store = await asyncio.to_thread(read_store, tenant_id)
        store["uploadedDocuments"] = [*created, *store.get("uploadedDocuments", [])]
        await write_store(tenant_id, store)
    return created
