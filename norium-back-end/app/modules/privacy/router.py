from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import secrets
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import Field

from app.core.security import hash_password, verify_password
from app.core.request_context import normalize_workspace_id
from app.core.tenant import get_data_root, read_json_file, safe_tenant_id, write_json_file
from app.modules.auth import router as auth
from app.shared.schemas import StrictModel


router = APIRouter(prefix="/api/auth/privacy", tags=["Privacidade"])
logger = logging.getLogger(__name__)
PROTECTED_TERMS = ("password", "senha", "secret", "token", "credential", "api_key", "apikey")


class DeleteAccountPayload(StrictModel):
    currentPassword: str = Field(min_length=1, max_length=180)
    confirmation: str = Field(min_length=1, max_length=80)


def _redact(value: Any) -> Any:
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        str(key): "[REMOVIDO DA EXPORTACAO]" if any(term in str(key).casefold() for term in PROTECTED_TERMS) else _redact(item)
        for key, item in value.items()
    }


def _user_directory(user_id: str) -> Path:
    root = get_data_root().resolve()
    target = (root / f"user_{safe_tenant_id(user_id)}").resolve()
    if target.parent != root or not target.name.startswith("user_"):
        raise RuntimeError("invalid user data path")
    return target


def _chat_upload_directory(user_id: str) -> Path:
    root = get_data_root().resolve()
    uploads = (root / "uploads").resolve()
    target = (uploads / safe_tenant_id(user_id)).resolve()
    if target.parent != uploads or uploads.parent != root:
        raise RuntimeError("invalid upload data path")
    return target


def _build_export(user: dict[str, Any]) -> bytes:
    user_id = str(user["id"])
    directory = _user_directory(user_id)
    stream = io.BytesIO()
    manifest: list[dict[str, Any]] = []
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        account = json.dumps(_redact(auth.sanitize_user(user)), ensure_ascii=False, indent=2).encode("utf-8")
        archive.writestr("conta.json", account)
        manifest.append({"path": "conta.json", "sha256": hashlib.sha256(account).hexdigest(), "bytes": len(account)})
        if directory.exists():
            for path in sorted(item for item in directory.rglob("*") if item.is_file()):
                relative = path.relative_to(directory)
                data = path.read_bytes()
                if path.suffix.casefold() == ".json":
                    try:
                        data = json.dumps(_redact(json.loads(data.decode("utf-8"))), ensure_ascii=False, indent=2).encode("utf-8")
                    except (UnicodeError, json.JSONDecodeError) as exc:
                        raise RuntimeError(f"invalid JSON in export: {relative.as_posix()}") from exc
                name = f"dados/{relative.as_posix()}"
                archive.writestr(name, data)
                manifest.append({"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
        manifest_bytes = json.dumps({"generatedAt": datetime.now(timezone.utc).isoformat(), "files": manifest}, ensure_ascii=False, indent=2).encode("utf-8")
        archive.writestr("manifesto.json", manifest_bytes)
    return stream.getvalue()


def _purge_personal_files(user_id: str) -> None:
    for directory in (_user_directory(user_id), _chat_upload_directory(user_id)):
        if directory.exists():
            shutil.rmtree(directory)


def _parse_due(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _purge_due_workspace_directories(now: datetime | None = None) -> int:
    current = now or datetime.now(timezone.utc)
    root = get_data_root().resolve()
    purged = 0
    for store_path in sorted(root.glob("user_*/plataforma_db.json")):
        account_directory = store_path.parent.resolve()
        if account_directory.parent != root or not account_directory.name.startswith("user_"):
            continue
        store = read_json_file(store_path, {})
        if not isinstance(store, dict) or not isinstance(store.get("workspaces"), list):
            continue
        changed = False
        for workspace in store["workspaces"]:
            if not isinstance(workspace, dict) or workspace.get("active", True):
                continue
            due = _parse_due(workspace.get("deletionDueAt"))
            if due is None or due > current or workspace.get("purgedAt"):
                continue
            workspace_id = str(workspace.get("id") or "")
            normalized = normalize_workspace_id(workspace_id)
            if not normalized or normalized != workspace_id or workspace_id == "primary":
                continue
            target = (account_directory / f"workspace_{workspace_id}").resolve()
            if target.parent != account_directory or not target.name.startswith("workspace_"):
                continue
            if target.exists():
                shutil.rmtree(target)
            workspace["name"] = "Workspace excluido"
            for key in ("legalName", "document", "domain", "logoUrl", "emailSignature", "reportFooter"):
                workspace[key] = ""
            workspace["purgedAt"] = current.isoformat()
            changed = True
            purged += 1
        if changed:
            write_json_file(store_path, store)
    return purged


async def run_data_lifecycle_maintenance() -> dict[str, int]:
    accounts = 0
    async with auth.auth_lock:
        store = await auth.read_user_store()
        pending_ids = [
            str(item.get("id") or "")
            for item in store.get("users", [])
            if item.get("status") == "inativo" and item.get("deletionStatus") == "purging"
        ]
    for user_id in pending_ids:
        try:
            await asyncio.to_thread(_purge_personal_files, user_id)
        except OSError:
            logger.exception("Personal data purge failed for a pending tombstone")
            continue
        async with auth.auth_lock:
            store = await auth.read_user_store()
            target = auth.find_user(store, user_id)
            if target and target.get("deletionStatus") == "purging":
                deleted_at = str(target.get("deletionRequestedAt") or datetime.now(timezone.utc).isoformat())
                _anonymize(store, target, deleted_at)
                await auth.write_user_store(store)
                accounts += 1
    workspaces = await asyncio.to_thread(_purge_due_workspace_directories)
    return {"accounts": accounts, "workspaces": workspaces}


async def data_lifecycle_worker() -> None:
    interval = max(300, int(os.getenv("PRIVACY_MAINTENANCE_INTERVAL_SECONDS", "3600")))
    while True:
        try:
            await run_data_lifecycle_maintenance()
        except Exception:
            logger.exception("Data lifecycle maintenance failed")
        await asyncio.sleep(interval)


def _anonymize(store: dict[str, Any], target: dict[str, Any], deleted_at: str) -> None:
    user_id = str(target["id"])
    pseudonym = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:20]
    target.clear()
    target.update({
        "id": user_id,
        "nome": "Conta excluida",
        "email": f"deleted-{pseudonym}@invalid.norium",
        "passwordHash": hash_password(secrets.token_urlsafe(32)),
        "role": "member",
        "plan": "free",
        "status": "inativo",
        "systemAdmin": False,
        "systemAdminRole": None,
        "sessionVersion": 1,
        "teamOwnerId": None,
        "createdBy": None,
        "permissions": {},
        "requiresPlanSelection": False,
        "deletedAt": deleted_at,
        "dataPurgedAt": deleted_at,
    })
    store["teams"] = [item for item in store.get("teams", []) if str(item.get("ownerUserId") or "") != user_id]
    for entry in store.get("adminAudit", []):
        if str(entry.get("actorId") or "") == user_id:
            entry["actorName"] = "Conta excluida"
        if str(entry.get("targetId") or "") == user_id:
            entry["targetName"] = "Conta excluida"


@router.get("/export")
async def export_personal_data(user: dict[str, Any] = Depends(auth.current_user)) -> Response:
    try:
        content = await asyncio.to_thread(_build_export, user)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail="Nao foi possivel preparar a exportacao completa.") from exc
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="norium-dados-pessoais.zip"', "Cache-Control": "no-store"},
    )


@router.delete("/account")
async def delete_own_account(
    payload: DeleteAccountPayload,
    user: dict[str, Any] = Depends(auth.current_user),
) -> dict[str, Any]:
    if payload.confirmation.strip().upper() != "EXCLUIR MINHA CONTA":
        raise HTTPException(status_code=422, detail='Digite "EXCLUIR MINHA CONTA" para confirmar.')
    async with auth.auth_lock:
        store = await auth.read_user_store()
        target = auth.find_user(store, str(user["id"]))
        if not target or not verify_password(payload.currentPassword, str(target.get("passwordHash") or "")):
            raise HTTPException(status_code=401, detail="Senha atual invalida.")
        if auth.is_system_owner(target):
            raise HTTPException(status_code=409, detail="Transfira a titularidade administrativa antes de excluir esta conta.")
        active_members = [
            item for item in store.get("users", [])
            if str(item.get("teamOwnerId") or "") == str(target["id"]) and item.get("status") == "ativo"
        ]
        if active_members:
            raise HTTPException(status_code=409, detail="Remova ou transfira os membros ativos antes de excluir a conta proprietaria.")
        deleted_at = datetime.now(timezone.utc).isoformat()
        target["status"] = "inativo"
        target["sessionVersion"] = int(target.get("sessionVersion") or 0) + 1
        target["deletionStatus"] = "purging"
        target["deletionRequestedAt"] = deleted_at
        await auth.write_user_store(store)

    maintenance = await run_data_lifecycle_maintenance()
    if maintenance["accounts"] != 1:
        raise HTTPException(status_code=503, detail="A conta foi bloqueada, mas a eliminacao fisica segue pendente de nova tentativa automatica.")
    return {"deleted": True, "deletedAt": deleted_at}
