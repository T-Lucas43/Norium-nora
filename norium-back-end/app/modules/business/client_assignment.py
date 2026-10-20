"""Explicit internal reassignment. Responsibility never changes sharing or ownership."""
from __future__ import annotations

import asyncio
import copy
import logging

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import Field, field_validator

from app.modules.clients.access import client_store_ids_for_user, require_client_access
from app.modules.clients.repository import list_clients, save_clients
from app.modules.clients.router import _lock
from app.modules.team.router import visible_team_members
from app.modules.auth.router import assert_route_permissions
from app.shared.schemas import StrictModel
from .router import business_audit, clients_user, now

router = APIRouter(prefix="/api/business/clients", tags=["Negócios"])
logger = logging.getLogger(__name__)


class SelectedClient(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    expectedUpdatedAt: str = Field(min_length=1, max_length=64)


class ClientSelection(StrictModel):
    clients: list[SelectedClient] = Field(min_length=1, max_length=100)

    @field_validator("clients")
    @classmethod
    def distinct_clients(cls, value):
        if len({item.id for item in value}) != len(value):
            raise ValueError("Selecione cada cliente uma única vez.")
        return value


class Assignment(ClientSelection):
    userId: str = Field(default="", max_length=120)


class Archival(ClientSelection):
    archived: bool = Field(strict=True)


async def assignees(user: dict) -> list[dict]:
    eligible = []
    for member in await visible_team_members(user):
        if member.get("status") != "ativo":
            continue
        try:
            assert_route_permissions(member, "/api/clientes")
        except HTTPException:
            continue
        eligible.append(member)
    return eligible


@router.get("/assignees")
async def assignment_options(response: Response, user: dict = Depends(clients_user)):
    response.headers["Cache-Control"] = "no-store"
    return {"items": [{"id": item["id"], "name": str(item.get("nome") or "Membro da equipe")}
                      for item in await assignees(user)]}


@router.post("/assign")
async def assign_clients(payload: Assignment, response: Response, user: dict = Depends(clients_user)):
    response.headers["Cache-Control"] = "no-store"
    member = next((item for item in await assignees(user) if item["id"] == payload.userId), None)
    if payload.userId and member is None:
        raise HTTPException(422, "Escolha uma pessoa ativa da sua equipe com acesso a Clientes.")
    results = {item.id: {"id": item.id, "status": "not_allowed"} for item in payload.clients}
    expected = {item.id: item.expectedUpdatedAt for item in payload.clients}
    seen: set[str] = set()
    # Reuse the client/import writer lock. Each owner's document is saved once;
    # cross-document success is reported per item, never described as atomic.
    async with _lock:
        for store_id in await client_store_ids_for_user(user):
            rows = copy.deepcopy(await asyncio.to_thread(list_clients, store_id))
            changed: list[str] = []
            for row in rows:
                identifier = str(row.get("id") or "")
                if identifier not in expected or identifier in seen:
                    continue
                try:
                    require_client_access(row, user, store_id, "edit")
                except HTTPException:
                    continue
                seen.add(identifier)
                if row.get("updatedAt") != expected[identifier]:
                    results[identifier]["status"] = "conflict"
                    continue
                if member is not None:
                    try:
                        require_client_access(row, member, store_id, "view")
                    except HTTPException:
                        results[identifier]["status"] = "assignee_no_access"
                        continue
                row.update(ownerId=payload.userId, ownerName=str((member or {}).get("nome") or ""), updatedAt=now())
                changed.append(identifier)
            if not changed:
                continue
            try:
                await save_clients(store_id, rows)
            except Exception:
                # A failed commit may have an uncertain result. The client must
                # reload; expectedUpdatedAt prevents silently replaying a write.
                logger.exception("Client assignment persistence failed")
                for identifier in changed:
                    results[identifier]["status"] = "reload_required"
            else:
                for identifier in changed:
                    results[identifier]["status"] = "updated"
    updated_ids = [identifier for identifier, result in results.items() if result["status"] == "updated"]
    if updated_ids:
        await business_audit(user, "business_clients_assigned", "client_batch", "selection",
                             {"clientIds": updated_ids, "assigneeId": payload.userId, "count": len(updated_ids)})
    return {"items": list(results.values()), "updated": len(updated_ids), "total": len(results)}


@router.post("/archive")
async def archive_clients(payload: Archival, response: Response, user: dict = Depends(clients_user)):
    response.headers["Cache-Control"] = "no-store"
    results = {item.id: {"id": item.id, "status": "not_allowed"} for item in payload.clients}
    expected = {item.id: item.expectedUpdatedAt for item in payload.clients}
    seen: set[str] = set()
    async with _lock:
        for store_id in await client_store_ids_for_user(user):
            rows = copy.deepcopy(await asyncio.to_thread(list_clients, store_id))
            changed: list[str] = []
            for row in rows:
                identifier = str(row.get("id") or "")
                if identifier not in expected or identifier in seen:
                    continue
                try:
                    require_client_access(row, user, store_id, "edit")
                except HTTPException:
                    continue
                seen.add(identifier)
                if row.get("updatedAt") != expected[identifier]:
                    results[identifier]["status"] = "conflict"
                    continue
                if bool(row.get("archivedAt")) == payload.archived:
                    results[identifier]["status"] = "unchanged"
                    continue
                stamp = now()
                row.update(archivedAt=stamp if payload.archived else None, updatedAt=stamp)
                changed.append(identifier)
            if not changed:
                continue
            try:
                await save_clients(store_id, rows)
            except Exception:
                logger.exception("Client archival persistence failed")
                for identifier in changed:
                    results[identifier]["status"] = "reload_required"
            else:
                for identifier in changed:
                    results[identifier]["status"] = "updated"
    updated_ids = [identifier for identifier, result in results.items() if result["status"] == "updated"]
    if updated_ids:
        await business_audit(user, "business_clients_archived" if payload.archived else "business_clients_restored",
                             "client_batch", "selection", {"clientIds": updated_ids, "count": len(updated_ids)})
    return {"items": list(results.values()), "updated": len(updated_ids), "total": len(results)}
