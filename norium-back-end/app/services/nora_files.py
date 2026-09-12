"""Arquivos privados e geracoes deterministicas usadas pelo chat da Nora."""

from __future__ import annotations

import base64
import binascii
import io
import mimetypes
import re
import uuid
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.core.tenant import get_user_db_path, read_user_db, write_user_db
from app.modules.commercial.document_files import process_native_documents
from app.services.finance_store import list_finance
from app.services.task_store import list_tasks


DB_NAME = "nora_files"
MAX_FILE_BYTES = 24 * 1024 * 1024
MAX_FILES = 600
FILE_ID_PATTERN = re.compile(r"^nora_file_[a-f0-9]{32}$")

ALLOWED_MIME_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "text/plain",
    "text/csv",
    "application/json",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/zip",
    "audio/mpeg",
    "audio/wav",
    "audio/webm",
    "audio/ogg",
    "video/mp4",
    "video/webm",
    "video/quicktime",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _workspace_root(user_id: str) -> Path:
    db_path = Path(get_user_db_path(user_id, DB_NAME)).resolve()
    root = (db_path.parent / "nora_files").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_filename(value: str, mime_type: str) -> str:
    raw = Path(value or "arquivo").name.strip().replace("\x00", "")
    raw = re.sub(r"[^a-zA-Z0-9À-ÿ._() -]+", "_", raw)[:180].strip(" .") or "arquivo"
    if "." not in raw:
        raw += mimetypes.guess_extension(mime_type) or ""
    return raw


def _decode_base64(value: str) -> bytes:
    encoded = value.split(",", 1)[-1].strip()
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=400, detail="Arquivo inválido. Envie conteúdo base64 válido.") from exc
    if not content:
        raise HTTPException(status_code=400, detail="O arquivo está vazio.")
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="Cada arquivo pode ter no máximo 24 MB.")
    return content


def _validate_content(content: bytes, mime_type: str) -> None:
    if mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail="Formato não aceito pela Nora.")
    signatures = {
        "application/pdf": content.startswith(b"%PDF-"),
        "image/png": content.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": content.startswith(b"\xff\xd8\xff"),
        "image/webp": len(content) > 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP",
    }
    if mime_type in signatures and not signatures[mime_type]:
        raise HTTPException(status_code=400, detail="O conteúdo do arquivo não corresponde ao formato informado.")
    if "officedocument" in mime_type and not content.startswith(b"PK"):
        raise HTTPException(status_code=400, detail="O documento Office está corrompido ou usa um formato incompatível.")
    if mime_type in {"application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"} and not content.startswith(b"\xd0\xcf\x11\xe0"):
        raise HTTPException(status_code=400, detail="O documento Office está corrompido ou usa um formato incompatível.")
    if mime_type == "application/zip" and not content.startswith(b"PK"):
        raise HTTPException(status_code=400, detail="O arquivo ZIP está corrompido.")


def _artifact(record: dict[str, Any]) -> dict[str, Any]:
    file_id = str(record["id"])
    content_url = f"/api/nora/files/{file_id}/content"
    artifact = {
        "id": file_id,
        "name": str(record.get("name") or "arquivo"),
        "mimeType": str(record.get("mimeType") or "application/octet-stream"),
        "size": int(record.get("size") or 0),
        "previewUrl": content_url,
        "downloadUrl": f"{content_url}?download=true",
        "source": str(record.get("source") or "nora"),
        "createdAt": record.get("createdAt"),
        "inLibrary": bool(record.get("inLibrary", False)),
    }
    metadata = record.get("metadata")
    if isinstance(metadata, dict):
        artifact["metadata"] = metadata
        if isinstance(metadata.get("editTarget"), dict):
            artifact["editTarget"] = metadata["editTarget"]
    return artifact


def save_bytes(
    user_id: str,
    content: bytes,
    filename: str,
    mime_type: str,
    *,
    source: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not content or len(content) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="O arquivo deve ter entre 1 byte e 24 MB.")
    _validate_content(content, mime_type)
    file_id = f"nora_file_{uuid.uuid4().hex}"
    safe_name = _safe_filename(filename, mime_type)
    suffix = Path(safe_name).suffix[:12] or (mimetypes.guess_extension(mime_type) or ".bin")
    root = _workspace_root(user_id)
    path = (root / f"{file_id}{suffix}").resolve()
    if path.parent != root:
        raise HTTPException(status_code=400, detail="Destino de arquivo inválido.")
    path.write_bytes(content)
    record = {
        "id": file_id,
        "name": safe_name,
        "mimeType": mime_type,
        "size": len(content),
        "storageName": path.name,
        "source": source,
        "createdAt": _now_iso(),
        "inLibrary": False,
    }
    if metadata:
        record["metadata"] = metadata
    store = read_user_db(user_id, DB_NAME, {"files": []})
    items = [item for item in store.get("files", []) if isinstance(item, dict)]
    write_user_db(user_id, DB_NAME, {"files": [record, *items][:MAX_FILES]})
    return _artifact(record)


def list_library_files(user_id: str) -> list[dict[str, Any]]:
    store = read_user_db(user_id, DB_NAME, {"files": []})
    records = [
        item for item in store.get("files", [])
        if isinstance(item, dict) and bool(item.get("inLibrary", False))
    ]
    records.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
    return [_artifact(record) for record in records]


def set_library_status(user_id: str, file_id: str, in_library: bool) -> dict[str, Any]:
    # Validate ownership and the backing file before persisting the marker.
    owned_file(user_id, file_id)
    store = read_user_db(user_id, DB_NAME, {"files": []})
    records = [item for item in store.get("files", []) if isinstance(item, dict)]
    updated: dict[str, Any] | None = None
    for record in records:
        if record.get("id") == file_id:
            record["inLibrary"] = bool(in_library)
            updated = record
            break
    if updated is None:
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    write_user_db(user_id, DB_NAME, {"files": records[:MAX_FILES]})
    return _artifact(updated)


def save_upload(user_id: str, file_name: str, mime_type: str, data_base64: str) -> dict[str, Any]:
    content = _decode_base64(data_base64)
    _validate_content(content, mime_type)
    return save_bytes(user_id, content, file_name, mime_type, source="upload")


def owned_file(user_id: str, file_id: str) -> tuple[dict[str, Any], Path]:
    if not FILE_ID_PATTERN.fullmatch(file_id):
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    store = read_user_db(user_id, DB_NAME, {"files": []})
    record = next((item for item in store.get("files", []) if item.get("id") == file_id), None)
    if not isinstance(record, dict):
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    root = _workspace_root(user_id)
    path = (root / Path(str(record.get("storageName") or "")).name).resolve()
    if path.parent != root or not path.is_file():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    return record, path


def artifacts_for_ids(user_id: str, file_ids: list[str]) -> list[dict[str, Any]]:
    return [_artifact(owned_file(user_id, file_id)[0]) for file_id in file_ids]


def process_files(user_id: str, file_ids: list[str], operation: str, options: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    records_and_paths = [owned_file(user_id, file_id) for file_id in file_ids]
    paths = [item[1] for item in records_and_paths]
    outputs = process_native_documents(operation, paths, options or {})
    return [save_bytes(user_id, content, name, mime_type, source=f"pdf:{operation}") for content, name, mime_type in outputs]


def _money(value: Any) -> str:
    return f"R$ {float(value or 0):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _report_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("NoriumTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=24, leading=29, textColor=colors.HexColor("#EAF2FF")),
        "eyebrow": ParagraphStyle("NoriumEyebrow", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=colors.HexColor("#21C7E8"), spaceAfter=3),
        "section": ParagraphStyle("NoriumSection", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=colors.HexColor("#1266F1"), spaceBefore=9, spaceAfter=7),
        "body": ParagraphStyle("NoriumBody", parent=base["BodyText"], fontName="Helvetica", fontSize=9, leading=13, textColor=colors.HexColor("#CBD5E1")),
        "cell": ParagraphStyle("NoriumCell", parent=base["BodyText"], fontName="Helvetica", fontSize=8, leading=10, textColor=colors.HexColor("#0F172A")),
        "cellStrong": ParagraphStyle("NoriumCellStrong", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=colors.HexColor("#0F172A")),
    }


def _p(value: Any, style: ParagraphStyle) -> Paragraph:
    return Paragraph(escape(str(value or "—")), style)


def _report_pdf(title: str, subtitle: str, sections: list[tuple[str, list[list[Any]], list[int]]]) -> bytes:
    output = io.BytesIO()
    pdf = SimpleDocTemplate(output, pagesize=A4, rightMargin=15 * mm, leftMargin=15 * mm, topMargin=16 * mm, bottomMargin=16 * mm, title=title, author="Norium")
    styles = _report_styles()
    story: list[Any] = [
        Table([[ _p("NORIUM  •  NORA", styles["eyebrow"]) ]], colWidths=[180 * mm], style=TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#08111F")), ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#173152")), ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)])),
        Spacer(1, 7 * mm),
        Paragraph(escape(title), styles["title"]),
        Paragraph(escape(subtitle), styles["body"]),
        Spacer(1, 5 * mm),
    ]
    for section_title, rows, widths in sections:
        story.append(Paragraph(escape(section_title), styles["section"]))
        prepared = [[_p(value, styles["cellStrong"] if row_index == 0 else styles["cell"]) for value in row] for row_index, row in enumerate(rows)]
        table = Table(prepared, colWidths=[width * mm for width in widths], repeatRows=1, hAlign="LEFT")
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DCEBFF")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#0F172A")),
            ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#F8FAFC")),
            ("GRID", (0, 0), (-1, -1), 0.45, colors.HexColor("#C7D5E8")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.extend([table, Spacer(1, 4 * mm)])
    pdf.build(story, onFirstPage=_report_page, onLaterPages=_report_page)
    return output.getvalue()


def _report_page(canvas: Any, document: Any) -> None:
    canvas.saveState()
    canvas.setFillColor(colors.HexColor("#050A12"))
    canvas.rect(0, 0, A4[0], A4[1], fill=1, stroke=0)
    canvas.setFillColor(colors.HexColor("#64748B"))
    canvas.setFont("Helvetica", 7)
    canvas.drawRightString(A4[0] - 15 * mm, 8 * mm, f"Gerado pela Nora • página {document.page}")
    canvas.restoreState()


def generate_finance_report(user_id: str) -> dict[str, Any]:
    data = list_finance(user_id)
    summary = data.get("resumo") if isinstance(data.get("resumo"), dict) else {}
    summary_rows = [["Indicador", "Valor"], ["Entradas", _money(summary.get("entradas"))], ["Saídas", _money(summary.get("saidas"))], ["Saldo", _money(summary.get("saldo"))]]
    entries = data.get("lancamentos", [])[:80]
    entry_rows = [["Lançamento", "Tipo", "Valor", "Status", "Vencimento"]] + [[item.get("title"), item.get("type"), _money(item.get("amount")), item.get("status"), item.get("dueDate") or "—"] for item in entries]
    if not entries:
        entry_rows.append(["Nenhum lançamento registrado", "—", "—", "—", "—"])
    content = _report_pdf("Relatório financeiro", f"Posição consolidada em {datetime.now().strftime('%d/%m/%Y %H:%M')}", [("Resumo", summary_rows, [90, 90]), ("Lançamentos", entry_rows, [58, 25, 32, 28, 37])])
    return save_bytes(user_id, content, "relatorio-financeiro.pdf", "application/pdf", source="report:finance")


def generate_operations_report(user_id: str) -> dict[str, Any]:
    data = list_tasks(user_id, status="todas")
    stats = data.get("stats") if isinstance(data.get("stats"), dict) else {}
    stats_rows = [["Indicador", "Total"]] + [[label, stats.get(key, 0)] for label, key in (("Ativas", "ativas"), ("Pendentes", "pendentes"), ("Em andamento", "andamento"), ("Em revisão", "revisao"), ("Concluídas", "concluidas"), ("Vencidas", "vencidas"))]
    tasks = data.get("tasks", [])[:80]
    task_rows = [["Tarefa", "Status", "Prioridade", "Responsável", "Vencimento"]] + [[item.get("title"), item.get("status"), item.get("priority"), item.get("assigneeName") or item.get("responsibleName") or "—", item.get("dueDate") or "—"] for item in tasks]
    if not tasks:
        task_rows.append(["Nenhuma tarefa registrada", "—", "—", "—", "—"])
    content = _report_pdf("Relatório operacional", f"Atividades e capacidade em {datetime.now().strftime('%d/%m/%Y %H:%M')}", [("Visão geral", stats_rows, [90, 90]), ("Tarefas", task_rows, [62, 27, 27, 34, 30])])
    return save_bytes(user_id, content, "relatorio-operacional.pdf", "application/pdf", source="report:operations")


def normalize_command(value: str) -> str:
    from unicodedata import combining, normalize
    return "".join(char for char in normalize("NFKD", value.casefold()) if not combining(char))


def file_operation_for(text: str, file_ids: list[str]) -> tuple[str, dict[str, Any]] | None:
    normalized = normalize_command(text)
    rules = (
        ("merge", ("combinar", "combine", "juntar", "junte", "unir", "una", "mesclar")),
        ("images_to_pdf", ("imagens para pdf", "imagem para pdf", "converter imagem", "fazer pdf das imagens")),
        ("extract_text", ("extrair texto", "extraia o texto", "extraia texto", "pdf para texto", "tirar o texto")),
        ("compress", ("comprimir", "comprima", "reduzir tamanho", "deixar menor")),
        ("page_numbers", ("numerar paginas", "numere as paginas", "numero nas paginas", "numeracao")),
        ("remove_metadata", ("limpar metadados", "remover metadados")),
        ("split", ("separar paginas", "dividir pdf", "extrair pagina")),
        ("rotate", ("girar pdf", "rotacionar", "virar pagina")),
    )
    for operation, signals in rules:
        if any(signal in normalized for signal in signals):
            if not file_ids:
                return operation, {}
            options: dict[str, Any] = {}
            if operation == "rotate":
                options["degrees"] = 90
            return operation, options
    return None


def is_deterministic_file_request(text: str) -> bool:
    normalized = normalize_command(text)
    return bool(
        file_operation_for(text, [])
        or ("relatorio" in normalized and any(term in normalized for term in ("finance", "gasto", "receita", "operacional", "operacao", "tarefas", "equipe")))
    )


def deterministic_file_command(user_id: str, text: str, file_ids: list[str], context: str = "") -> dict[str, Any] | None:
    normalized = normalize_command(text)
    if "relatorio" in normalized and any(term in normalized for term in ("finance", "gasto", "receita")):
        artifact = generate_finance_report(user_id)
        return {"status": "arquivo_pronto", "response": "Relatório financeiro gerado com os dados atuais do Norium. Você pode visualizar ou baixar o PDF abaixo.", "files": [artifact], "tokenUsage": 0}
    if "relatorio" in normalized and any(term in normalized for term in ("operacional", "operacao", "tarefas", "equipe")):
        artifact = generate_operations_report(user_id)
        return {"status": "arquivo_pronto", "response": "Relatório operacional gerado com os dados atuais do Norium. Você pode visualizar ou baixar o PDF abaixo.", "files": [artifact], "tokenUsage": 0}

    operation = file_operation_for(f"{context}\n{text}", file_ids)
    if operation:
        operation_name, options = operation
        if not file_ids:
            label = {
                "merge": "os PDFs",
                "images_to_pdf": "as imagens",
                "extract_text": "o PDF",
                "compress": "o PDF",
                "page_numbers": "o PDF",
                "remove_metadata": "o PDF",
                "split": "o PDF",
                "rotate": "o PDF",
            }[operation_name]
            return {"status": "aguardando_arquivo", "response": f"Envie {label} pelo botão de anexo. Assim que chegar, farei o processamento direto no Norium, sem usar tokens de IA.", "files": [], "tokenUsage": 0}
        try:
            files = process_files(user_id, file_ids, operation_name, options)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"status": "arquivo_pronto", "response": "Processamento concluído dentro do Norium, sem uso de tokens. O resultado está pronto para visualizar ou baixar.", "files": files, "tokenUsage": 0}

    if file_ids:
        artifacts_for_ids(user_id, file_ids)
        return {"status": "arquivo_recebido", "response": "Recebi o arquivo e ele já está salvo com acesso privado. Diga o que deseja fazer: visualizar, extrair texto, comprimir, numerar páginas, combinar PDFs ou converter imagens em PDF.", "files": [], "tokenUsage": 0}
    return None
