from __future__ import annotations

import base64
import json
import mimetypes
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from app.core.tenant import get_data_root, get_user_db_path, public_api_url, read_json_file, write_json_file

BASE_DIR = Path(__file__).resolve().parents[2]
FINANCE_PATH = BASE_DIR / "financeiro_db.json"
FINANCE_UPLOAD_DIR = get_data_root() / "finance_uploads"
FINANCE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ENTRY_TYPES = {"entrada", "saida"}
STATUS = {"pendente", "pago", "cancelado"}
FREQUENCIES = {"unico", "semanal", "mensal", "anual"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_workspace(user_id: str = "lucas123") -> dict[str, Any]:
    db = _read_db()
    if user_id not in db:
        db[user_id] = {
            "lancamentos": [],
            "programados": [],
            "boletos": [],
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        _write_db(db)
    return db[user_id]


def list_finance(user_id: str = "lucas123") -> dict[str, Any]:
    workspace = load_workspace(user_id)
    lancamentos = [normalize_lancamento(item) for item in workspace.get("lancamentos", [])]
    programados = [normalize_programado(item) for item in workspace.get("programados", [])]
    boletos = [normalize_boleto(item) for item in workspace.get("boletos", [])]
    return {
        "lancamentos": sorted(lancamentos, key=lambda item: item.get("dueDate") or item.get("createdAt") or "", reverse=True),
        "programados": sorted(programados, key=lambda item: item.get("nextDueDate") or ""),
        "boletos": sorted(boletos, key=lambda item: item.get("dueDate") or ""),
        "resumo": build_summary(lancamentos, programados, boletos),
        "lembretes": build_reminders(lancamentos, programados),
        "updatedAt": workspace.get("updatedAt"),
    }


def create_lancamento(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    db = _read_db()
    workspace = load_workspace(user_id)
    lancamento = normalize_lancamento(
        {
            "id": f"fin_{uuid.uuid4().hex}",
            "title": payload.get("title"),
            "description": payload.get("description", ""),
            "type": payload.get("type", "saida"),
            "amount": payload.get("amount", 0),
            "category": payload.get("category", "geral"),
            "method": payload.get("method", ""),
            "status": payload.get("status", "pendente"),
            "dueDate": payload.get("dueDate"),
            "paidAt": payload.get("paidAt"),
            "attachments": payload.get("attachments", []),
            "source": payload.get("source", "manual"),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
    )
    workspace.setdefault("lancamentos", []).append(lancamento)
    workspace["updatedAt"] = now_iso()
    db[user_id] = workspace
    _write_db(db)
    return lancamento


def update_lancamento(user_id: str, lancamento_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    db = _read_db()
    workspace = load_workspace(user_id)
    items = workspace.setdefault("lancamentos", [])
    for index, item in enumerate(items):
        if item.get("id") != lancamento_id:
            continue
        changed = dict(item)
        for key in ("title", "description", "type", "amount", "category", "method", "status", "dueDate", "paidAt"):
            if key in updates:
                changed[key] = updates[key]
        if changed.get("status") == "pago" and not changed.get("paidAt"):
            changed["paidAt"] = _local_today().date().isoformat()
        changed["updatedAt"] = now_iso()
        items[index] = normalize_lancamento(changed)
        workspace["updatedAt"] = now_iso()
        db[user_id] = workspace
        _write_db(db)
        return items[index]
    return None


def delete_lancamento(user_id: str, lancamento_id: str) -> bool:
    db = _read_db()
    workspace = load_workspace(user_id)
    items = workspace.setdefault("lancamentos", [])
    before = len(items)
    workspace["lancamentos"] = [item for item in items if item.get("id") != lancamento_id]
    if len(workspace["lancamentos"]) == before:
        return False
    workspace["updatedAt"] = now_iso()
    db[user_id] = workspace
    _write_db(db)
    return True


def restore_lancamento(user_id: str, snapshot: dict[str, Any]) -> dict[str, Any] | None:
    """Restaura um lançamento com o mesmo identificador e anexos do snapshot."""
    lancamento_id = str(snapshot.get("id") or "").strip()
    if not lancamento_id:
        return None
    db = _read_db()
    workspace = load_workspace(user_id)
    db = _read_db()
    items = workspace.setdefault("lancamentos", [])
    restored = normalize_lancamento({**snapshot, "id": lancamento_id, "updatedAt": now_iso()})
    for index, current in enumerate(items):
        if str(current.get("id")) == lancamento_id:
            items[index] = restored
            break
    else:
        items.append(restored)
    workspace["updatedAt"] = now_iso()
    db[user_id] = workspace
    _write_db(db)
    return restored


def create_programado(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    db = _read_db()
    workspace = load_workspace(user_id)
    programado = normalize_programado(
        {
            "id": f"fix_{uuid.uuid4().hex}",
            "title": payload.get("title"),
            "description": payload.get("description", ""),
            "type": payload.get("type", "saida"),
            "amount": payload.get("amount", 0),
            "category": payload.get("category", "fixo"),
            "frequency": payload.get("frequency", "mensal"),
            "nextDueDate": payload.get("nextDueDate"),
            "remindDaysBefore": payload.get("remindDaysBefore", 3),
            "active": bool(payload.get("active", True)),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
    )
    workspace.setdefault("programados", []).append(programado)
    workspace["updatedAt"] = now_iso()
    db[user_id] = workspace
    _write_db(db)
    return programado


def update_programado(user_id: str, programado_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    db = _read_db()
    workspace = load_workspace(user_id)
    items = workspace.setdefault("programados", [])
    for index, item in enumerate(items):
        if item.get("id") != programado_id:
            continue
        changed = dict(item)
        for key in ("title", "description", "type", "amount", "category", "frequency", "nextDueDate", "remindDaysBefore", "active"):
            if key in updates:
                changed[key] = updates[key]
        changed["updatedAt"] = now_iso()
        items[index] = normalize_programado(changed)
        workspace["updatedAt"] = now_iso()
        db[user_id] = workspace
        _write_db(db)
        return items[index]
    return None


def delete_programado(user_id: str, programado_id: str) -> bool:
    db = _read_db()
    workspace = load_workspace(user_id)
    items = workspace.setdefault("programados", [])
    before = len(items)
    workspace["programados"] = [item for item in items if item.get("id") != programado_id]
    if len(workspace["programados"]) == before:
        return False
    workspace["updatedAt"] = now_iso()
    db[user_id] = workspace
    _write_db(db)
    return True


def save_boletos(user_id: str, boletos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    db = _read_db()
    workspace = load_workspace(user_id)
    normalized = [normalize_boleto(item) for item in boletos]
    existing = {item.get("id"): item for item in workspace.get("boletos", []) if item.get("id")}
    for boleto in normalized:
        existing[boleto["id"]] = boleto
    workspace["boletos"] = list(existing.values())
    workspace["updatedAt"] = now_iso()
    db[user_id] = workspace
    _write_db(db)
    return normalized


def add_attachment(user_id: str, lancamento_id: str, *, file_name: str, mime_type: str, data_url: str) -> dict[str, Any] | None:
    db = _read_db()
    workspace = load_workspace(user_id)
    target = next((item for item in workspace.setdefault("lancamentos", []) if item.get("id") == lancamento_id), None)
    if not target:
        return None
    file_bytes, detected_mime = decode_data_url(data_url, mime_type)
    safe_name = safe_upload_name(file_name, detected_mime)
    file_path = FINANCE_UPLOAD_DIR / safe_name
    file_path.write_bytes(file_bytes)
    attachment = {
        "id": f"fin_att_{uuid.uuid4().hex}",
        "name": Path(file_name).name or safe_name,
        "mimeType": detected_mime,
        "size": len(file_bytes),
        "url": public_api_url(f"/api/financeiro/anexos/{quote(safe_name)}"),
        "storedName": safe_name,
        "createdAt": now_iso(),
    }

    for item in workspace.setdefault("lancamentos", []):
        if item.get("id") != lancamento_id:
            continue
        item.setdefault("attachments", []).append(attachment)
        item["updatedAt"] = now_iso()
        workspace["updatedAt"] = now_iso()
        db[user_id] = workspace
        _write_db(db)
        return attachment
    return None


def remove_attachment(user_id: str, lancamento_id: str, attachment_id: str) -> dict[str, Any] | None:
    db = _read_db()
    workspace = load_workspace(user_id)
    removed: dict[str, Any] | None = None

    for item in workspace.setdefault("lancamentos", []):
        if item.get("id") != lancamento_id:
            continue
        attachments = list(item.get("attachments", []))
        next_attachments = []
        for attachment in attachments:
            if str(attachment.get("id")) == attachment_id:
                removed = dict(attachment)
            else:
                next_attachments.append(attachment)
        if not removed:
            return None

        item["attachments"] = next_attachments
        item["updatedAt"] = now_iso()
        workspace["updatedAt"] = now_iso()
        db[user_id] = workspace
        _write_db(db)

        stored_name = Path(str(removed.get("storedName") or "")).name
        if stored_name and not _attachment_file_still_used(workspace, stored_name):
            path = FINANCE_UPLOAD_DIR / stored_name
            if path.exists() and path.is_file():
                path.unlink(missing_ok=True)
        return removed

    return None


def attachment_path(user_id: str, file_name: str) -> Path | None:
    safe_name = Path(file_name).name
    workspace = load_workspace(user_id)
    authorized = any(
        Path(str(attachment.get("storedName") or "")).name == safe_name
        for lancamento in workspace.get("lancamentos", [])
        for attachment in lancamento.get("attachments", [])
        if isinstance(attachment, dict)
    )
    if not authorized:
        return None
    path = FINANCE_UPLOAD_DIR / safe_name
    if not path.exists() or not path.is_file():
        return None
    return path


def _attachment_file_still_used(workspace: dict[str, Any], stored_name: str) -> bool:
    for lancamento in workspace.get("lancamentos", []):
        for attachment in lancamento.get("attachments", []):
            if Path(str(attachment.get("storedName") or "")).name == stored_name:
                return True
    return False


def build_summary(lancamentos: list[dict[str, Any]], programados: list[dict[str, Any]], boletos: list[dict[str, Any]]) -> dict[str, Any]:
    paid = [item for item in lancamentos if item.get("status") == "pago"]
    pending = [item for item in lancamentos if item.get("status") == "pendente"]
    entradas = sum(float(item.get("amount") or 0) for item in paid if item.get("type") == "entrada")
    saidas = sum(float(item.get("amount") or 0) for item in paid if item.get("type") == "saida")
    pendente = sum(float(item.get("amount") or 0) for item in pending if item.get("type") == "saida")
    today = _local_today().date()
    vencidos = [
        item for item in pending
        if _parse_date(item.get("dueDate")) and _parse_date(item.get("dueDate")) < today
    ]
    proximos = [
        item for item in programados
        if item.get("active") and _parse_date(item.get("nextDueDate"))
    ]
    return {
        "entradas": round(entradas, 2),
        "saidas": round(saidas, 2),
        "saldo": round(entradas - saidas, 2),
        "pendente": round(pendente, 2),
        "vencidos": len(vencidos),
        "programadosAtivos": len(proximos),
        "boletosEncontrados": len(boletos),
    }


def build_reminders(lancamentos: list[dict[str, Any]], programados: list[dict[str, Any]]) -> list[dict[str, Any]]:
    today = _local_today().date()
    reminders: list[dict[str, Any]] = []
    for item in lancamentos:
        due = _parse_date(item.get("dueDate"))
        if item.get("status") != "pendente" or not due:
            continue
        days = (due - today).days
        if days <= 7:
            reminders.append({
                "id": f"rem_{item.get('id')}",
                "kind": "lancamento",
                "title": item.get("title"),
                "amount": item.get("amount"),
                "dueDate": item.get("dueDate"),
                "daysUntil": days,
            })
    for item in programados:
        due = _parse_date(item.get("nextDueDate"))
        if not item.get("active") or not due:
            continue
        days = (due - today).days
        remind_days = int(item.get("remindDaysBefore") or 0)
        if days <= remind_days:
            reminders.append({
                "id": f"rem_{item.get('id')}",
                "kind": "programado",
                "title": item.get("title"),
                "amount": item.get("amount"),
                "dueDate": item.get("nextDueDate"),
                "daysUntil": days,
            })
    return sorted(reminders, key=lambda item: item["daysUntil"])[:20]


def normalize_lancamento(item: dict[str, Any]) -> dict[str, Any]:
    item_type = str(item.get("type") or "saida").lower()
    status = str(item.get("status") or "pendente").lower()
    return {
        **item,
        "id": str(item.get("id") or f"fin_{uuid.uuid4().hex}"),
        "title": str(item.get("title") or "Lancamento")[:160],
        "description": str(item.get("description") or "")[:2000],
        "type": item_type if item_type in ENTRY_TYPES else "saida",
        "amount": round(float(item.get("amount") or 0), 2),
        "category": str(item.get("category") or "geral")[:80],
        "method": str(item.get("method") or "")[:80],
        "status": status if status in STATUS else "pendente",
        "dueDate": _date_or_none(item.get("dueDate")),
        "paidAt": _date_or_none(item.get("paidAt")),
        "attachments": list(item.get("attachments", [])),
        "source": str(item.get("source") or "manual")[:80],
        "createdAt": item.get("createdAt") or now_iso(),
        "updatedAt": item.get("updatedAt") or now_iso(),
    }


def normalize_programado(item: dict[str, Any]) -> dict[str, Any]:
    item_type = str(item.get("type") or "saida").lower()
    frequency = str(item.get("frequency") or "mensal").lower()
    return {
        **item,
        "id": str(item.get("id") or f"fix_{uuid.uuid4().hex}"),
        "title": str(item.get("title") or "Gasto programado")[:160],
        "description": str(item.get("description") or "")[:2000],
        "type": item_type if item_type in ENTRY_TYPES else "saida",
        "amount": round(float(item.get("amount") or 0), 2),
        "category": str(item.get("category") or "fixo")[:80],
        "frequency": frequency if frequency in FREQUENCIES else "mensal",
        "nextDueDate": _date_or_none(item.get("nextDueDate")),
        "remindDaysBefore": max(0, min(int(item.get("remindDaysBefore") or 0), 60)),
        "active": bool(item.get("active", True)),
        "createdAt": item.get("createdAt") or now_iso(),
        "updatedAt": item.get("updatedAt") or now_iso(),
    }


def normalize_boleto(item: dict[str, Any]) -> dict[str, Any]:
    identifier = str(item.get("id") or item.get("linhaDigitavel") or item.get("barcode") or item.get("url") or uuid.uuid4().hex)
    return {
        "id": identifier[:160],
        "title": str(item.get("title") or item.get("beneficiary") or "Boleto")[:160],
        "beneficiary": str(item.get("beneficiary") or item.get("cedente") or "")[:160],
        "amount": round(_money_value(item.get("amount") or item.get("valor") or 0), 2),
        "dueDate": _date_or_none(item.get("dueDate") or item.get("vencimento")),
        "status": str(item.get("status") or "pendente")[:80],
        "barcode": str(item.get("barcode") or item.get("linhaDigitavel") or "")[:220],
        "linhaDigitavel": str(item.get("linhaDigitavel") or item.get("linha_digitavel") or item.get("barcode") or "")[:260],
        "url": str(item.get("url") or item.get("link") or item.get("boleto") or "")[:1000],
        "source": str(item.get("source") or "api")[:80],
        "createdAt": item.get("createdAt") or now_iso(),
    }


def decode_data_url(data_url: str, fallback_mime: str) -> tuple[bytes, str]:
    match = re.match(r"^data:([^,]*),(.*)$", data_url, flags=re.DOTALL)
    if not match or "base64" not in match.group(1).lower():
        raise ValueError("Anexo invalido. Envie data URL base64.")
    metadata = [part for part in match.group(1).split(";") if part and part.lower() != "base64"]
    mime_type = next((part for part in metadata if "/" in part), fallback_mime or "application/octet-stream")
    file_bytes = base64.b64decode(match.group(2), validate=True)
    if not file_bytes:
        raise ValueError("Anexo vazio.")
    if len(file_bytes) > 15 * 1024 * 1024:
        raise ValueError("Anexo acima do limite de 15 MB.")
    return file_bytes, mime_type


def safe_upload_name(file_name: str, mime_type: str) -> str:
    suffix = Path(file_name).suffix.lower().lstrip(".")
    if not suffix:
        suffix = (mimetypes.guess_extension(mime_type) or ".bin").lstrip(".")
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(file_name).stem or "comprovante").strip("._") or "comprovante"
    return f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}_{stem[:48]}.{suffix[:12]}"


def _date_or_none(value: Any) -> str | None:
    parsed = _parse_date(value)
    return parsed.isoformat() if parsed else None


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    text = str(value).strip()
    try:
        return datetime.fromisoformat(text[:10]).date()
    except ValueError:
        pass
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text[:10], fmt).date()
        except ValueError:
            continue
    return None


def _money_value(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("R$", "").replace(" ", "")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return 0.0


def _local_today() -> datetime:
    return datetime.now(timezone(timedelta(hours=-3)))


def _read_db() -> dict[str, Any]:
    db: dict[str, Any] = {}
    legacy_payload = read_json_file(FINANCE_PATH, {})
    if isinstance(legacy_payload, dict):
        db.update({str(key): value for key, value in legacy_payload.items() if isinstance(value, dict)})

    data_root = get_data_root()
    for user_dir in data_root.glob("user_*"):
        if not user_dir.is_dir():
            continue
        user_id = user_dir.name.removeprefix("user_")
        payload = read_json_file(user_dir / "financeiro_db.json", {})
        if isinstance(payload, dict):
            if "lancamentos" in payload or "programados" in payload:
                db[user_id] = payload
            elif isinstance(payload.get(user_id), dict):
                db[user_id] = payload[user_id]
    return db


def _write_db(payload: dict[str, Any]) -> None:
    for user_id, workspace in payload.items():
        if isinstance(workspace, dict):
            write_json_file(get_user_db_path(str(user_id), "financeiro"), workspace)
