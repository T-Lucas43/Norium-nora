from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, Response
from pydantic import Field

from app.modules.auth.router import current_user, assert_route_permissions
from app.modules.clients import files
from app.modules.clients.repository import list_clients as load_clients
from app.modules.clients.repository import save_clients
from app.modules.operations.schemas import AuditCreate
from app.modules.operations.service import record_audit
from app.infrastructure.persistence import postgres_store
from app.shared.schemas import StrictModel


router = APIRouter(prefix="/api/clientes", tags=["Clientes"])
_lock = asyncio.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def client_summary(item: dict) -> dict:
    return {**{key: value for key, value in item.items() if key != "attachments"}, "attachmentCount": len(item.get("attachments", []))}


class ClientCreate(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    company: str = Field(default="", max_length=160)
    document: str = Field(default="", max_length=40)
    email: str = Field(default="", max_length=220)
    phone: str = Field(default="", max_length=40)
    segment: str = Field(default="", max_length=100)
    status: Literal["lead", "active", "inactive"] = "lead"
    stage: Literal["new", "contacted", "proposal", "won", "lost"] = "new"
    ownerId: str = Field(default="", max_length=120)
    ownerName: str = Field(default="", max_length=160)
    nextActionAt: str | None = None
    tags: list[str] = Field(default_factory=list, max_length=20)
    notes: str = Field(default="", max_length=2000)


class ClientUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    company: str | None = Field(default=None, max_length=160)
    document: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=220)
    phone: str | None = Field(default=None, max_length=40)
    segment: str | None = Field(default=None, max_length=100)
    status: Literal["lead", "active", "inactive"] | None = None
    stage: Literal["new", "contacted", "proposal", "won", "lost"] | None = None
    ownerId: str | None = Field(default=None, max_length=120)
    ownerName: str | None = Field(default=None, max_length=160)
    nextActionAt: str | None = None
    tags: list[str] | None = Field(default=None, max_length=20)
    notes: str | None = Field(default=None, max_length=2000)


class ClientFileUpload(StrictModel):
    fileName: str = Field(min_length=1, max_length=220)
    dataBase64: str = Field(min_length=4, max_length=21_000_000)


def client_or_404(items: list[dict], client_id: str) -> dict:
    item = next((item for item in items if item.get("id") == client_id), None)
    if not item:
        raise HTTPException(404, "Cliente não encontrado.")
    return item


def attachment_summary(client_id: str, item: dict) -> dict:
    return {**item, "url": f"/api/clientes/{client_id}/files/{item['id']}"}


@router.get("/{client_id}/files")
async def list_client_files(client_id: str, user: dict = Depends(current_user)) -> dict:
    item = client_or_404(await asyncio.to_thread(load_clients, tenant_id(user)), client_id)
    return {"items": [attachment_summary(client_id, file) for file in item.get("attachments", [])]}


@router.post("/{client_id}/files")
async def upload_client_file(client_id: str, payload: ClientFileUpload, user: dict = Depends(current_user)) -> dict:
    user_id = tenant_id(user)
    client_or_404(await asyncio.to_thread(load_clients, user_id), client_id)
    name, mime, data = await asyncio.to_thread(files.decoded_file, payload.fileName, payload.dataBase64)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        client = client_or_404(items, client_id)
        if len(client.get("attachments", [])) >= 100:
            raise HTTPException(422, "Esta ficha atingiu o limite de 100 documentos.")
        file_id = await asyncio.to_thread(files.write_file, user_id, client_id, data)
        attachment = {"id": file_id, "fileName": name, "mimeType": mime, "size": len(data), "createdAt": now_iso()}
        client["attachments"] = [attachment, *client.get("attachments", [])]
        client["updatedAt"] = now_iso()
        await save_clients(user_id, items)
    await record_audit(user, AuditCreate(action="client_document_uploaded", source="clients", description=f'Documento "{name}" anexado ao cliente.', status="success", entityType="client", entityId=client_id))
    return {"item": attachment_summary(client_id, attachment)}


@router.get("/{client_id}/files/{file_id}")
async def download_client_file(client_id: str, file_id: str, user: dict = Depends(current_user)) -> Response:
    user_id = tenant_id(user)
    client = client_or_404(await asyncio.to_thread(load_clients, user_id), client_id)
    attachment = next((item for item in client.get("attachments", []) if item["id"] == file_id), None)
    content = await asyncio.to_thread(files.read_file, user_id, client_id, file_id)
    if not attachment or content is None:
        raise HTTPException(404, "Documento não encontrado.")
    safe_name = str(attachment["fileName"]).replace('"', "")
    headers = {"Content-Disposition": f'attachment; filename="{safe_name}"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
    if not (postgres_store.configured() or postgres_store.required()):
        return FileResponse(files.file_path(user_id, client_id, file_id), media_type=attachment["mimeType"], headers=headers)
    return Response(content, media_type=attachment["mimeType"], headers=headers)


@router.delete("/{client_id}/files/{file_id}")
async def delete_client_file(client_id: str, file_id: str, user: dict = Depends(current_user)) -> dict:
    user_id = tenant_id(user)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        client = client_or_404(items, client_id)
        current = client.get("attachments", [])
        if not any(item["id"] == file_id for item in current):
            raise HTTPException(404, "Documento não encontrado.")
        client["attachments"] = [item for item in current if item["id"] != file_id]
        client["updatedAt"] = now_iso()
        await save_clients(user_id, items)
        await asyncio.to_thread(files.remove_file, user_id, client_id, file_id)
    return {"ok": True}


@router.put("/{client_id}/avatar")
async def upload_client_avatar(client_id: str, payload: ClientFileUpload, user: dict = Depends(current_user)) -> dict:
    user_id = tenant_id(user)
    client_or_404(await asyncio.to_thread(load_clients, user_id), client_id)
    _, mime, data = await asyncio.to_thread(files.decoded_file, payload.fileName, payload.dataBase64)
    if not mime.startswith("image/"):
        raise HTTPException(422, "Escolha uma imagem PNG, JPG ou WebP.")
    image = await asyncio.to_thread(files.profile_image, data)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        client = client_or_404(items, client_id)
        old_id = client.get("avatarId")
        client["avatarId"] = await asyncio.to_thread(files.write_file, user_id, client_id, image)
        client["updatedAt"] = now_iso()
        await save_clients(user_id, items)
        if old_id:
            await asyncio.to_thread(files.remove_file, user_id, client_id, old_id)
    return {"item": client_summary(client)}


@router.get("/{client_id}/avatar")
async def read_client_avatar(client_id: str, user: dict = Depends(current_user)) -> Response:
    user_id = tenant_id(user)
    client = client_or_404(await asyncio.to_thread(load_clients, user_id), client_id)
    if not client.get("avatarId"):
        raise HTTPException(404, "Foto não encontrada.")
    content = await asyncio.to_thread(files.read_file, user_id, client_id, client["avatarId"])
    if content is None:
        raise HTTPException(404, "Foto não encontrada.")
    return Response(content, media_type="image/webp", headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.delete("/{client_id}/avatar")
async def delete_client_avatar(client_id: str, user: dict = Depends(current_user)) -> dict:
    user_id = tenant_id(user)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        client = client_or_404(items, client_id)
        old_id = client.pop("avatarId", None)
        client["updatedAt"] = now_iso()
        await save_clients(user_id, items)
        if old_id:
            await asyncio.to_thread(files.remove_file, user_id, client_id, old_id)
    return {"item": client_summary(client)}


@router.get("/{client_id}/contracts")
async def list_client_contracts(client_id: str, user: dict = Depends(current_user)) -> dict:
    from app.modules.commercial.repository import read_store
    from app.modules.commercial.service import collaboration_tenant_id, commercial_document_summary
    assert_route_permissions(user, "/api/comercial")
    client = client_or_404(await asyncio.to_thread(load_clients, tenant_id(user)), client_id)
    store = await asyncio.to_thread(read_store, collaboration_tenant_id(user))
    linked_ids = set(client.get("contractIds", []))
    result = []
    for contract in store["contracts"]:
        primary = contract.get("client", {}).get("id") == client_id
        result.append({**commercial_document_summary(contract, "contract"), "linked": primary or contract["id"] in linked_ids, "primary": primary})
    return {"items": sorted(result, key=lambda item: item["updatedAt"], reverse=True)}


@router.put("/{client_id}/contracts/{contract_id}")
async def link_client_contract(client_id: str, contract_id: str, user: dict = Depends(current_user)) -> dict:
    available = await list_client_contracts(client_id, user)
    contract = next((item for item in available["items"] if item["id"] == contract_id), None)
    if not contract:
        raise HTTPException(404, "Contrato não encontrado neste espaço de trabalho.")
    user_id = tenant_id(user)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        client = client_or_404(items, client_id)
        client["contractIds"] = list(dict.fromkeys([*client.get("contractIds", []), contract_id]))
        client["updatedAt"] = now_iso()
        await save_clients(user_id, items)
    return {"item": {**contract, "linked": True}}


@router.delete("/{client_id}/contracts/{contract_id}")
async def unlink_client_contract(client_id: str, contract_id: str, user: dict = Depends(current_user)) -> dict:
    available = await list_client_contracts(client_id, user)
    contract = next((item for item in available["items"] if item["id"] == contract_id), None)
    if contract and contract["primary"]:
        raise HTTPException(409, "Este cliente faz parte do contrato original. O vínculo original é preservado.")
    user_id = tenant_id(user)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        client = client_or_404(items, client_id)
        client["contractIds"] = [item for item in client.get("contractIds", []) if item != contract_id]
        client["updatedAt"] = now_iso()
        await save_clients(user_id, items)
    return {"ok": True}


@router.get("")
async def list_clients(
    q: str | None = Query(default=None, max_length=120),
    status: str | None = Query(default=None),
    stage: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    items = await asyncio.to_thread(load_clients, tenant_id(user))
    if q:
        needle = q.casefold().strip()
        items = [
            item for item in items
            if needle in " ".join(str(item.get(key) or "") for key in ("name", "company", "email", "phone", "segment", "tags")).casefold()
        ]
    if status:
        items = [item for item in items if item.get("status") == status]
    if stage:
        items = [item for item in items if item.get("stage") == stage]
    items.sort(key=lambda item: str(item.get("updatedAt") or ""), reverse=True)
    return {"items": [client_summary(item) for item in items], "total": len(items)}


@router.post("")
async def create_client(payload: ClientCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    user_id = tenant_id(user)
    item = {
        "id": f"client_{uuid.uuid4().hex}",
        **payload.model_dump(),
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        items.insert(0, item)
        await save_clients(user_id, items)
    await record_audit(user, AuditCreate(action="client_created", source="clients", description=f'Cliente "{item["name"]}" criado.', status="success", entityType="client", entityId=item["id"]))
    return {"item": client_summary(item)}


@router.patch("/{client_id}")
async def update_client(client_id: str, payload: ClientUpdate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    user_id = tenant_id(user)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        updated = None
        for index, current in enumerate(items):
            if str(current.get("id")) != client_id:
                continue
            changes = {key: value for key, value in payload.model_dump(exclude_unset=True).items() if value is not None or key == "nextActionAt"}
            updated = {**current, **changes, "updatedAt": now_iso()}
            items[index] = updated
            break
        if updated is None:
            raise HTTPException(status_code=404, detail="Cliente nao encontrado.")
        await save_clients(user_id, items)
    await record_audit(user, AuditCreate(action="client_updated", source="clients", description=f'Cliente "{updated["name"]}" atualizado.', status="info", entityType="client", entityId=client_id))
    return {"item": client_summary(updated)}


@router.delete("/{client_id}")
async def delete_client(client_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    user_id = tenant_id(user)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        remaining = [item for item in items if str(item.get("id")) != client_id]
        if len(remaining) == len(items):
            raise HTTPException(status_code=404, detail="Cliente nao encontrado.")
        removed = client_or_404(items, client_id)
        await save_clients(user_id, remaining)
        file_ids = [item["id"] for item in removed.get("attachments", [])]
        if removed.get("avatarId"):
            file_ids.append(removed["avatarId"])
        for file_id in file_ids:
            await asyncio.to_thread(files.remove_file, user_id, client_id, file_id)
    await record_audit(user, AuditCreate(action="client_deleted", source="clients", description="Cliente removido do CRM.", status="warning", entityType="client", entityId=client_id))
    return {"ok": True}
