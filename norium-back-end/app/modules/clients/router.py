from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field

from app.modules.auth.router import current_user
from app.modules.clients.repository import list_clients as load_clients
from app.modules.clients.repository import save_clients
from app.modules.operations.schemas import AuditCreate
from app.modules.operations.service import record_audit
from app.shared.schemas import StrictModel


router = APIRouter(prefix="/api/clientes", tags=["Clientes"])
_lock = asyncio.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


class ClientCreate(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    company: str = Field(default="", max_length=160)
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
    return {"items": items, "total": len(items)}


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
    return {"item": item}


@router.patch("/{client_id}")
async def update_client(client_id: str, payload: ClientUpdate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    user_id = tenant_id(user)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        updated = None
        for index, current in enumerate(items):
            if str(current.get("id")) != client_id:
                continue
            updated = {**current, **payload.model_dump(exclude_none=True), "updatedAt": now_iso()}
            items[index] = updated
            break
        if updated is None:
            raise HTTPException(status_code=404, detail="Cliente nao encontrado.")
        await save_clients(user_id, items)
    await record_audit(user, AuditCreate(action="client_updated", source="clients", description=f'Cliente "{updated["name"]}" atualizado.', status="info", entityType="client", entityId=client_id))
    return {"item": updated}


@router.delete("/{client_id}")
async def delete_client(client_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    user_id = tenant_id(user)
    async with _lock:
        items = await asyncio.to_thread(load_clients, user_id)
        remaining = [item for item in items if str(item.get("id")) != client_id]
        if len(remaining) == len(items):
            raise HTTPException(status_code=404, detail="Cliente nao encontrado.")
        await save_clients(user_id, remaining)
    await record_audit(user, AuditCreate(action="client_deleted", source="clients", description="Cliente removido do CRM.", status="warning", entityType="client", entityId=client_id))
    return {"ok": True}
