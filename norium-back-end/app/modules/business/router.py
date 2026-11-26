from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import Field, field_validator

from app.core.identity import require_user_id
from app.modules.auth.router import assert_route_permissions, can_manage_team, current_user
from app.modules.clients.access import find_accessible_client
from app.shared.schemas import StrictModel
from .store import mutate, require_room, snapshot

router = APIRouter(prefix="/api/business", tags=["Negócios"])


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def business_audit(user: dict, action: str, entity_type: str, identifier: str, metadata: dict | None = None):
    from app.modules.operations.schemas import AuditCreate
    from app.modules.operations.service import record_audit
    await record_audit(user, AuditCreate(action=action, source="business", entityType=entity_type,
                                       entityId=identifier, status="info", metadata=metadata or {}))


def catalog_user(user: dict = Depends(current_user)) -> dict:
    assert_route_permissions(user, "/api/comercial")
    return user


def clients_user(user: dict = Depends(current_user)) -> dict:
    assert_route_permissions(user, "/api/clientes")
    return user


class CatalogItem(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    type: Literal["product", "service"] = "service"
    unit: str = Field(default="un", min_length=1, max_length=24)
    priceCents: int = Field(ge=0, le=100_000_000_000, strict=True)
    maxDiscountBasisPoints: int = Field(default=0, ge=0, le=10_000, strict=True)
    noraCanOffer: bool = False
    category: str = Field(default="", max_length=80)
    sku: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=4000)
    active: bool = True
    durationMinutes: int | None = Field(default=None, ge=5, le=1440)

    @field_validator("name", "unit", "category", "sku", "description")
    @classmethod
    def clean(cls, value: str) -> str:
        return value.strip()

    @field_validator("name")
    @classmethod
    def meaningful_name(cls, value: str) -> str:
        if len(value) < 2:
            raise ValueError("Informe um nome com pelo menos dois caracteres.")
        return value

    @field_validator("unit")
    @classmethod
    def meaningful_unit(cls, value: str) -> str:
        if not value:
            raise ValueError("Informe a unidade do item.")
        return value


class CatalogSave(CatalogItem):
    expectedVersion: int | None = Field(default=None, ge=1)


def public_item(item: dict, *, history: bool = False) -> dict:
    return copy.deepcopy({key: value for key, value in item.items() if not key.startswith("_") and (history or key != "priceHistory")})


@router.get("/catalog")
async def catalog_list(response: Response, query: str = Query(default="", max_length=160),
                       kind: Literal["all", "product", "service"] = "all",
                       active: bool | None = None, offset: int = Query(0, ge=0),
                       limit: int = Query(50, ge=1, le=100), user: dict = Depends(catalog_user)):
    response.headers["Cache-Control"] = "no-store"
    data = await asyncio.to_thread(snapshot, user, "catalog")
    items = [item for item in data["items"] if not item.get("archivedAt")
             and (active is None or item.get("active") is active)
             and (kind == "all" or item.get("type") == kind)
             and (not query or query.casefold() in " ".join(str(item.get(key) or "") for key in ("name", "sku", "category")).casefold())]
    return {"items": [public_item(item) for item in items[offset:offset+limit]],
            "total": len(items), "offset": offset, "limit": limit,
            "nextOffset": offset+limit if offset+limit < len(items) else None}


@router.post("/catalog", status_code=201)
async def catalog_create(payload: CatalogItem, user: dict = Depends(catalog_user)):
    item = {**payload.model_dump(), "id": "catalog_" + uuid.uuid4().hex,
            "version": 1, "createdAt": now(), "createdBy": require_user_id(user),
            "updatedAt": now(), "updatedBy": require_user_id(user), "priceHistory": []}
    def insert(data):
        require_room(data["items"])
        if payload.sku and any(row.get("sku", "").casefold() == payload.sku.casefold() for row in data["items"] if not row.get("archivedAt")):
            raise HTTPException(409, "Já existe um item com este código/SKU.")
        data["items"].insert(0, item)
        return public_item(item)
    return {"item": await asyncio.to_thread(mutate, user, "catalog", insert)}


@router.get("/catalog/{item_id}")
async def catalog_detail(item_id: str, user: dict = Depends(catalog_user)):
    data = await asyncio.to_thread(snapshot, user, "catalog")
    item = next((row for row in data["items"] if row["id"] == item_id and not row.get("archivedAt")), None)
    if item is None:
        raise HTTPException(404, "Item não encontrado.")
    return {"item": public_item(item, history=True)}


@router.put("/catalog/{item_id}")
async def catalog_update(item_id: str, payload: CatalogSave, user: dict = Depends(catalog_user)):
    def update(data):
        item = next((row for row in data["items"] if row["id"] == item_id and not row.get("archivedAt")), None)
        if item is None:
            raise HTTPException(404, "Item não encontrado.")
        if payload.expectedVersion is None or payload.expectedVersion != item["version"]:
            raise HTTPException(409, "O item foi atualizado. Recarregue antes de salvar.")
        if payload.sku and any(row["id"] != item_id and row.get("sku", "").casefold() == payload.sku.casefold() for row in data["items"] if not row.get("archivedAt")):
            raise HTTPException(409, "Já existe um item com este código/SKU.")
        if item["priceCents"] != payload.priceCents:
            item["priceHistory"].append({"priceCents": item["priceCents"], "until": now(), "changedBy": require_user_id(user)})
        item.update(payload.model_dump(exclude={"expectedVersion"}))
        item.update(version=item["version"]+1, updatedAt=now(), updatedBy=require_user_id(user))
        return public_item(item)
    return {"item": await asyncio.to_thread(mutate, user, "catalog", update)}


@router.get("/catalog/{item_id}/history")
async def catalog_price_history(item_id: str, offset: int = Query(0, ge=0),
                                limit: int = Query(25, ge=1, le=100), user: dict = Depends(catalog_user)):
    data = await asyncio.to_thread(snapshot, user, "catalog")
    item = next((row for row in data["items"] if row["id"] == item_id and not row.get("archivedAt")), None)
    if item is None:
        raise HTTPException(404, "Item não encontrado.")
    history = list(reversed(item.get("priceHistory", [])))
    return {"items": [{"priceCents": row["priceCents"], "until": row["until"]} for row in history[offset:offset+limit]],
            "total": len(history), "nextOffset": offset+limit if offset+limit < len(history) else None}


class TagSave(StrictModel):
    name: str = Field(min_length=2, max_length=60)
    color: str = Field(default="#3b82f6", pattern=r"^#[0-9a-fA-F]{6}$")
    scope: Literal["client", "contact", "conversation", "opportunity"] = "client"


def active_tag(item: dict) -> bool:
    return item.get("active", True) and not item.get("archivedAt")


def tag_route(kind: str) -> str:
    return "/api/chat" if kind in {"contact", "conversation"} else "/api/clientes"


def tag_summary(user: dict, item: dict) -> dict:
    return {**item, "version": item.get("version", 1), "active": active_tag(item),
            "canManage": item.get("createdBy") == require_user_id(user) or can_manage_team(user)}


@router.get("/tags")
async def tags(scope: Literal["client", "contact", "conversation", "opportunity"] | None = None,
               includeArchived: bool = False, user: dict = Depends(current_user)):
    def allowed(kind):
        try:
            assert_route_permissions(user, tag_route(kind))
            return True
        except HTTPException:
            return False
    if scope and not allowed(scope):
        raise HTTPException(403, "Seu acesso não permite consultar estas etiquetas.")
    data = await asyncio.to_thread(snapshot, user, "tags")
    return {"items": [tag_summary(user, item) for item in data["items"]
                      if (scope is None or item["scope"] == scope) and allowed(item["scope"])
                      and (includeArchived or active_tag(item))]}


@router.post("/tags", status_code=201)
async def create_tag(payload: TagSave, user: dict = Depends(current_user)):
    assert_route_permissions(user, tag_route(payload.scope))
    name = payload.name.strip()
    if len(name) < 2:
        raise HTTPException(422, "Informe um nome para a etiqueta.")
    def insert(data):
        current = next((row for row in data["items"] if row["name"].casefold() == name.casefold() and row["scope"] == payload.scope and active_tag(row)), None)
        if current:
            return tag_summary(user, current)
        require_room(data["items"], 500)
        item = {**payload.model_dump(), "name": name, "id": "tag_" + uuid.uuid4().hex,
                "createdBy": require_user_id(user), "createdAt": now(), "active": True, "version": 1}
        data["items"].append(item)
        return tag_summary(user, item)
    return {"item": await asyncio.to_thread(mutate, user, "tags", insert)}


class TagUpdate(StrictModel):
    name: str = Field(min_length=2, max_length=60)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    active: bool = True
    expectedVersion: int = Field(ge=1)


@router.put("/tags/{tag_id}")
async def update_tag(tag_id: str, payload: TagUpdate, user: dict = Depends(current_user)):
    if len(payload.name.strip()) < 2:
        raise HTTPException(422, "Informe um nome com pelo menos dois caracteres.")
    def update(data):
        item = next((row for row in data["items"] if row["id"] == tag_id), None)
        if item is None:
            raise HTTPException(404, "Etiqueta não encontrada.")
        assert_route_permissions(user, tag_route(item["scope"]))
        if not tag_summary(user, item)["canManage"]:
            raise HTTPException(403, "Somente quem criou a etiqueta ou um gestor pode alterá-la.")
        if item.get("version", 1) != payload.expectedVersion:
            raise HTTPException(409, "A etiqueta mudou. Recarregue antes de salvar.")
        if payload.active and any(row["id"] != tag_id and row["scope"] == item["scope"] and active_tag(row)
                                  and row["name"].casefold() == payload.name.strip().casefold() for row in data["items"]):
            raise HTTPException(409, "Já existe uma etiqueta ativa com este nome.")
        item.update(name=payload.name.strip(), color=payload.color, active=payload.active,
                    archivedAt=None if payload.active else now(), version=payload.expectedVersion+1,
                    updatedAt=now(), updatedBy=require_user_id(user))
        return tag_summary(user, item)
    item = await asyncio.to_thread(mutate, user, "tags", update)
    await business_audit(user, "business_tag_updated", "tag", tag_id, {"active": item["active"], "version": item["version"]})
    return {"item": item}


class ClientTagChange(StrictModel):
    clientIds: list[str] = Field(min_length=1, max_length=100)
    tagId: str = Field(min_length=1, max_length=100)
    apply: bool = True


@router.post("/tags/clients")
async def tag_clients(payload: ClientTagChange, user: dict = Depends(clients_user)):
    # Every client is checked before any write. Names never grant access.
    clients = []
    for identifier in dict.fromkeys(payload.clientIds):
        owner, _, _, client = await find_accessible_client(user, identifier, "edit")
        clients.append({"clientId": client["id"], "clientOwnerId": owner})
    tag_data = await asyncio.to_thread(snapshot, user, "tags")
    if not any(item["id"] == payload.tagId and item["scope"] == "client" and active_tag(item) for item in tag_data["items"]):
        raise HTTPException(404, "Etiqueta de cliente não encontrada.")
    def change(data):
        for client in clients:
            matches = lambda row: row.get("tagId") == payload.tagId and row.get("clientId") == client["clientId"] and row.get("clientOwnerId") == client["clientOwnerId"]
            if payload.apply and not any(matches(row) for row in data["items"]):
                require_room(data["items"], 50_000)
                data["items"].append({**client, "tagId": payload.tagId, "createdBy": require_user_id(user), "createdAt": now()})
            elif not payload.apply:
                data["items"] = [row for row in data["items"] if not matches(row)]
        return {"updated": len(clients)}
    return await asyncio.to_thread(mutate, user, "tag_links", change)


@router.get("/tags/client/{client_id}")
async def client_tags(client_id: str, user: dict = Depends(clients_user)):
    owner, _, _, client = await find_accessible_client(user, client_id)
    tag_data, links = await asyncio.gather(asyncio.to_thread(snapshot, user, "tags"), asyncio.to_thread(snapshot, user, "tag_links"))
    identifiers = {row["tagId"] for row in links["items"] if row.get("clientId") == client["id"] and row.get("clientOwnerId") == owner}
    return {"items": [tag_summary(user, row) for row in tag_data["items"] if row["id"] in identifiers and active_tag(row)]}


class ConversationTagChange(StrictModel):
    conversationIds: list[Annotated[str, Field(min_length=1, max_length=180)]] = Field(min_length=1, max_length=100)
    tagId: str = Field(min_length=1, max_length=100)
    apply: bool = True


class ContactTagChange(StrictModel):
    contactIds: list[Annotated[str, Field(min_length=1, max_length=180)]] = Field(min_length=1, max_length=100)
    tagId: str = Field(min_length=1, max_length=100)
    apply: bool = Field(default=True, strict=True)


class ContactLabelsQuery(StrictModel):
    contactIds: list[Annotated[str, Field(min_length=1, max_length=180)]] = Field(min_length=1, max_length=100)


@router.post("/whatsapp/contact-labels")
async def contact_label_projection(payload: ContactLabelsQuery, user: dict = Depends(current_user)):
    """One bounded projection for visible rows, scoped to workspace AND binding."""
    from .whatsapp_contacts import aliases_for, contact_alias_index, identity
    from app.modules.chat.router import assert_channel_permission
    assert_channel_permission(user, "whatsapp")
    assert_route_permissions(user, "/api/chat")
    binding = await conversation_binding_key(user)
    actor = require_user_id(user)
    conversations = await owned_conversations(user, [])
    aliases = await contact_alias_index(user)
    definitions, links = await asyncio.gather(asyncio.to_thread(snapshot, user, "tags"),
                                              asyncio.to_thread(snapshot, user, "tag_links"))
    tags = {item["id"]: tag_summary(user, item) for item in definitions["items"]
            if active_tag(item) and item["scope"] in {"contact", "conversation"}}
    by_contact: dict[str, set[str]] = {}
    for row in links["items"]:
        if row.get("conversationOwnerId") == actor and row.get("bindingKey") == binding and row.get("tagId") in tags:
            by_contact.setdefault(identity(row.get("conversationId")), set()).add(row["tagId"])
    items = []
    for identifier in dict.fromkeys(payload.contactIds):
        # An arbitrary identifier never authorizes reading another account.
        known = identifier in conversations or identity(identifier) in aliases
        identifiers = set().union(*(by_contact.get(alias, set()) for alias in aliases_for(aliases, identifier))) if known else set()
        items.append({"id": identifier, "tags": sorted((tags[tag] for tag in identifiers), key=lambda tag: tag["name"].casefold())})
    return {"items": items}


async def owned_conversations(user: dict, identifiers: list[str]):
    from app.services.conversation_store import load_conversations
    assert_route_permissions(user, "/api/chat")
    conversations = await load_conversations(require_user_id(user))
    if any(identifier not in conversations for identifier in identifiers):
        raise HTTPException(404, "Conversa não encontrada neste espaço de trabalho.")
    return conversations


async def conversation_binding_key(user: dict) -> str:
    from app.services.wapi_binding import get_owned_binding
    binding = await asyncio.to_thread(get_owned_binding, require_user_id(user))
    if not binding.exists:
        raise HTTPException(409, "Confira o vínculo do WhatsApp antes de alterar as etiquetas dos contatos.")
    return hashlib.sha256(json.dumps([require_user_id(user), binding.instance_id, binding.created_at]).encode()).hexdigest()


@router.post("/tags/conversations")
async def tag_conversations(payload: ConversationTagChange, user: dict = Depends(current_user)):
    from .whatsapp_contacts import aliases_for, contact_alias_index, identity
    identifiers = list(dict.fromkeys(payload.conversationIds))
    conversations = await owned_conversations(user, [])
    index = await contact_alias_index(user)
    if any(identifier not in conversations and identity(identifier) not in index for identifier in identifiers):
        raise HTTPException(404, "Contato ou conversa não encontrado neste espaço de trabalho.")
    return await change_whatsapp_tags(user, payload.tagId, payload.apply, [aliases_for(index, identifier) for identifier in identifiers])


async def change_whatsapp_tags(user: dict, tag_id: str, apply: bool, groups: list[frozenset[str]]):
    from .whatsapp_tag_batch import change
    binding_key = await conversation_binding_key(user)
    actor = require_user_id(user)
    result = await asyncio.to_thread(change, user, binding_key, actor, groups, [{"tagId": tag_id, "apply": apply}])
    await business_audit(user, "business_whatsapp_tags_changed", "tag", tag_id, {"count": result["updated"], "apply": apply})
    from app.modules.chat.realtime import publish_change
    await publish_change(actor, "labels")
    return result


@router.post("/tags/contacts")
async def tag_contacts(payload: ContactTagChange, user: dict = Depends(current_user)):
    from .whatsapp_contacts import contact_alias_index, identity
    assert_route_permissions(user, "/api/chat")
    await conversation_binding_key(user)
    index = await contact_alias_index(user)
    identifiers = {identity(value) for value in payload.contactIds}
    if not identifiers or any(identifier not in index for identifier in identifiers):
        raise HTTPException(404, "Contato não encontrado no catálogo local deste espaço de trabalho.")
    return await change_whatsapp_tags(user, payload.tagId, payload.apply, [index[identifier] for identifier in identifiers])


@router.get("/tags/conversation/{conversation_id}")
async def conversation_tags(conversation_id: str, user: dict = Depends(current_user)):
    from .whatsapp_contacts import aliases_for, contact_alias_index, identity
    conversations = await owned_conversations(user, [])
    binding_key = await conversation_binding_key(user)
    index = await contact_alias_index(user)
    if conversation_id not in conversations and identity(conversation_id) not in index:
        raise HTTPException(404, "Contato ou conversa não encontrado neste espaço de trabalho.")
    aliases = aliases_for(index, conversation_id)
    tag_data, links = await asyncio.gather(asyncio.to_thread(snapshot, user, "tags"), asyncio.to_thread(snapshot, user, "tag_links"))
    identifiers = {row["tagId"] for row in links["items"] if row.get("conversationOwnerId") == require_user_id(user) and identity(row.get("conversationId")) in aliases and row.get("bindingKey") == binding_key}
    return {"items": [tag_summary(user, row) for row in tag_data["items"] if row["id"] in identifiers and active_tag(row)]}


@router.get("/tagged-conversations")
async def tagged_conversations(tagIds: str = Query(max_length=2000), offset: int = Query(0, ge=0),
                               limit: int = Query(200, ge=1, le=200), user: dict = Depends(current_user)):
    from .whatsapp_contacts import aliases_for, canonical, contact_alias_index, identity
    conversations = await owned_conversations(user, [])
    identifiers = {item for item in tagIds.split(",") if item}
    if not identifiers or len(identifiers) > 20:
        raise HTTPException(422, "Selecione de uma a 20 etiquetas.")
    binding_key = await conversation_binding_key(user)
    index = await contact_alias_index(user)
    definitions, links = await asyncio.gather(asyncio.to_thread(snapshot, user, "tags"), asyncio.to_thread(snapshot, user, "tag_links"))
    allowed = {item["id"] for item in definitions["items"] if active_tag(item) and item["scope"] in {"contact", "conversation"}}
    linked = {}
    for row in links["items"]:
        if row.get("conversationOwnerId") == require_user_id(user) and row.get("bindingKey") == binding_key and row.get("tagId") in identifiers & allowed:
            linked.setdefault(canonical(aliases_for(index, identity(row.get("conversationId")))), set()).add(row["tagId"])
    matching = [identifier for identifier in conversations if identifiers.issubset(linked.get(canonical(aliases_for(index, identifier)), set()))]
    matching.sort(key=lambda identifier: (bool(conversations[identifier].get("fixada")),
                                         str(conversations[identifier].get("timestampUltimaMsg") or "").zfill(20)), reverse=True)
    return {"ids": matching[offset:offset+limit], "total": len(matching),
            "nextOffset": offset+limit if offset+limit < len(matching) else None}


@router.get("/tagged-contacts")
async def tagged_contacts(response: Response, tagIds: str = Query(max_length=2000), offset: int = Query(0, ge=0),
                          limit: int = Query(200, ge=1, le=200), user: dict = Depends(current_user)):
    from .whatsapp_contacts import canonical, contact_alias_index, identity
    assert_route_permissions(user, "/api/chat")
    response.headers["Cache-Control"] = "no-store"
    identifiers = {item for item in tagIds.split(",") if item}
    if not identifiers or len(identifiers) > 20:
        raise HTTPException(422, "Selecione de uma a 20 etiquetas.")
    binding_key = await conversation_binding_key(user)
    index = await contact_alias_index(user)
    definitions, links = await asyncio.gather(asyncio.to_thread(snapshot, user, "tags"), asyncio.to_thread(snapshot, user, "tag_links"))
    allowed = {row["id"] for row in definitions["items"] if active_tag(row) and row["scope"] in {"contact", "conversation"}}
    linked: dict[str, set[str]] = {}
    groups: dict[str, frozenset[str]] = {}
    for row in links["items"]:
        alias = identity(row.get("conversationId"))
        if row.get("conversationOwnerId") != require_user_id(user) or row.get("bindingKey") != binding_key or alias not in index or row.get("tagId") not in identifiers & allowed:
            continue
        group = index[alias]
        primary = canonical(group)
        groups[primary] = group
        linked.setdefault(primary, set()).add(row["tagId"])
    matching = sorted(primary for primary, labels in linked.items() if identifiers.issubset(labels))
    page = matching[offset:offset+limit]
    return {"ids": sorted({alias for primary in page for alias in groups[primary]}), "total": len(matching),
            "nextOffset": offset+limit if offset+limit < len(matching) else None}


@router.get("/tagged-clients")
async def tagged_clients(tagIds: str = Query(max_length=2000), user: dict = Depends(clients_user)):
    from app.modules.clients.access import list_accessible_clients
    identifiers = {item for item in tagIds.split(",") if item}
    if len(identifiers) > 20:
        raise HTTPException(422, "Use até 20 etiquetas no filtro.")
    accessible = await list_accessible_clients(user)
    links = await asyncio.to_thread(snapshot, user, "tag_links")
    definitions = await asyncio.to_thread(snapshot, user, "tags")
    allowed = {item["id"] for item in definitions["items"] if active_tag(item) and item["scope"] == "client"}
    linked = {}
    for row in links["items"]:
        if row.get("clientId") and row.get("tagId") in identifiers & allowed:
            linked.setdefault((row["clientOwnerId"], row["clientId"]), set()).add(row["tagId"])
    return {"ids": [client["id"] for owner, client in accessible if identifiers.issubset(linked.get((owner, client["id"]), set()))]}


class ClientFilters(StrictModel):
    query: str = Field(default="", max_length=120)
    archive: Literal["exclude", "only", "all"] = "exclude"
    status: Literal["all", "lead", "active", "inactive"] = "all"
    stage: Literal["all", "new", "contacted", "proposal", "won", "lost"] = "all"
    ownerId: str = Field(default="", max_length=160)
    tagIds: list[str] = Field(default_factory=list, max_length=20)


class SavedView(StrictModel):
    name: str = Field(min_length=2, max_length=80)
    scope: Literal["personal", "team"] = "personal"
    filters: ClientFilters


class SavedViewUpdate(SavedView):
    expectedVersion: int = Field(ge=1)


@router.get("/client-views")
async def client_views(user: dict = Depends(clients_user)):
    personal, team = await asyncio.gather(asyncio.to_thread(snapshot, user, "saved_views"),
                                          asyncio.to_thread(snapshot, user, "team_views"))
    return {"items": [{**item, "version": item.get("version", 1),
                       "canDelete": item["createdBy"] == require_user_id(user) or can_manage_team(user),
                       "canEdit": item["createdBy"] == require_user_id(user) or can_manage_team(user)}
                      for item in [*personal["items"], *team["items"]] if item.get("kind") != "whatsapp"], "canShare": can_manage_team(user)}


@router.post("/client-views", status_code=201)
async def save_client_view(payload: SavedView, user: dict = Depends(clients_user)):
    if payload.scope == "team" and not can_manage_team(user):
        raise HTTPException(403, "Somente gestores podem criar uma visão compartilhada.")
    if len(payload.name.strip()) < 2:
        raise HTTPException(422, "Informe um nome com pelo menos dois caracteres.")
    item = {**payload.model_dump(), "name": payload.name.strip(), "id": "view_" + uuid.uuid4().hex,
            "createdBy": require_user_id(user), "createdAt": now(), "version": 1}
    def insert(data):
        require_room(data["items"], 100)
        data["items"].append(item)
        return item
    domain = "saved_views" if payload.scope == "personal" else "team_views"
    return {"item": await asyncio.to_thread(mutate, user, domain, insert)}


@router.delete("/client-views/{scope}/{view_id}")
async def remove_client_view(scope: Literal["personal", "team"], view_id: str,
                             expectedVersion: int = Query(ge=1), user: dict = Depends(clients_user)):
    domain = "saved_views" if scope == "personal" else "team_views"
    def remove(data):
        item = next((row for row in data["items"] if row["id"] == view_id and row.get("kind") != "whatsapp"), None)
        if not item:
            raise HTTPException(404, "Visão não encontrada.")
        if item["createdBy"] != require_user_id(user) and not can_manage_team(user):
            raise HTTPException(403, "Você não pode remover esta visão.")
        if item.get("version", 1) != expectedVersion:
            raise HTTPException(409, "A visão mudou. Recarregue antes de removê-la.")
        data["items"].remove(item)
        return {"ok": True}
    return await asyncio.to_thread(mutate, user, domain, remove)


@router.put("/client-views/{scope}/{view_id}")
async def edit_client_view(scope: Literal["personal", "team"], view_id: str,
                           payload: SavedViewUpdate, user: dict = Depends(clients_user)):
    if payload.scope != scope:
        raise HTTPException(422, "Crie outra visão para alterar seu compartilhamento.")
    if len(payload.name.strip()) < 2:
        raise HTTPException(422, "Informe um nome com pelo menos dois caracteres.")
    def update(data):
        item = next((row for row in data["items"] if row["id"] == view_id and row.get("kind") != "whatsapp"), None)
        if item is None:
            raise HTTPException(404, "Visão não encontrada.")
        if item["createdBy"] != require_user_id(user) and not can_manage_team(user):
            raise HTTPException(403, "Você não pode alterar esta visão.")
        if item.get("version", 1) != payload.expectedVersion:
            raise HTTPException(409, "A visão mudou. Recarregue antes de salvar.")
        item.update(name=payload.name.strip(), filters=payload.filters.model_dump(),
                    updatedAt=now(), updatedBy=require_user_id(user), version=payload.expectedVersion+1)
        return {**item, "canEdit": True, "canDelete": True}
    return {"item": await asyncio.to_thread(mutate, user, "saved_views" if scope == "personal" else "team_views", update)}


class ClientRelation(StrictModel):
    resourceType: Literal["proposal", "contract"]
    resourceId: str = Field(min_length=1, max_length=180)


async def visible_commercial_refs(user: dict, minimum: str = "view") -> list[dict]:
    from app.modules.commercial.service import document_store_ids_for_user, read_store, require_document_access
    assert_route_permissions(user, "/api/comercial")
    result = []
    for owner in await document_store_ids_for_user(user):
        store = await asyncio.to_thread(read_store, owner)
        for kind, collection in (("proposal", "proposals"), ("contract", "contracts")):
            for document in store.get(collection, []):
                try:
                    role = require_document_access(document, user, minimum)
                except HTTPException as exc:
                    if exc.status_code in {403, 404}:
                        continue
                    raise
                client = document.get("client") if isinstance(document.get("client"), dict) else {}
                result.append({"type": kind, "id": document["id"], "owner": owner,
                               "title": document.get("title") or "Documento", "status": document.get("status") or "draft",
                               "primaryClientId": str(document.get("clientId") or client.get("id") or ""),
                               "canEdit": role in {"owner", "edit"},
                               "updatedAt": str(document.get("updatedAt") or "")})
    return result


async def relation_document(user: dict, kind: str, identifier: str, minimum="view"):
    from app.modules.commercial.service import find_accessible_document
    assert_route_permissions(user, "/api/comercial")
    return await find_accessible_document(user, kind, identifier, minimum)


@router.post("/clients/{client_id}/relations", status_code=201)
async def link_document(client_id: str, payload: ClientRelation, user: dict = Depends(clients_user)):
    client_owner, _, _, client = await find_accessible_client(user, client_id, "edit")
    document_owner, _, _, document = await relation_document(user, payload.resourceType, payload.resourceId, "edit")
    def link(data):
        previous = [row for row in data["items"] if row["resourceType"] == payload.resourceType
                    and row["resourceId"] == payload.resourceId and row["resourceOwnerId"] == document_owner]
        related = [row for row in previous if not row.get("removedAt")]
        document_client = document.get("client") if isinstance(document.get("client"), dict) else {}
        primary = str(document.get("clientId") or document_client.get("id") or "")
        if primary and primary != client_id:
            raise HTTPException(409, "O cliente do documento é diferente. Revise o documento antes de vinculá-lo.")
        if related:
            current = related[0]
            if current["clientId"] != client_id or current["clientOwnerId"] != client_owner:
                raise HTTPException(409, "Este documento já possui vínculo com outro cliente.")
            return current
        require_room(data["items"], 50_000)
        item = {**payload.model_dump(), "resourceOwnerId": document_owner, "clientId": client["id"],
                "clientOwnerId": client_owner, "createdBy": require_user_id(user), "createdAt": now(),
                "version": max((row.get("version", 1) for row in previous), default=0)+1}
        data["items"].append(item)
        return item
    item = await asyncio.to_thread(mutate, user, "client_relations", link)
    await business_audit(user, "client_document_linked", "client", client_id,
                         {"resourceType": payload.resourceType, "resourceId": payload.resourceId})
    return {"item": item}


@router.get("/clients/{client_id}/relations")
async def linked_documents(client_id: str, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                            user: dict = Depends(clients_user)):
    client_owner, _, _, client = await find_accessible_client(user, client_id)
    data = await asyncio.to_thread(snapshot, user, "client_relations")
    documents = await visible_commercial_refs(user)
    explicit = {(row["resourceType"], row["resourceOwnerId"], row["resourceId"]): row
                for row in data["items"] if row["clientId"] == client_id and row["clientOwnerId"] == client_owner and not row.get("removedAt")}
    result = []
    for document in documents:
        relation = explicit.get((document["type"], document["owner"], document["id"]))
        primary = document["primaryClientId"] == client_id
        legacy = document["type"] == "contract" and document["id"] in client.get("contractIds", [])
        if not primary and not legacy and (not relation or document["primaryClientId"]):
            continue
        result.append({"type": document["type"], "id": document["id"], "title": document["title"],
                       "status": document["status"], "origin": "primary" if primary else "legacy" if legacy else "explicit",
                       "canUnlink": bool(relation) and not primary and not legacy and document["canEdit"],
                       "version": relation.get("version", 1) if relation else None})
    return {"items": result[offset:offset+limit], "total": len(result),
            "nextOffset": offset+limit if offset+limit < len(result) else None}


@router.get("/clients/{client_id}/relation-options")
async def relation_options(client_id: str, kind: Literal["proposal", "contract"], query: str = Query("", max_length=160),
                            offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=50), user: dict = Depends(clients_user)):
    client_owner, _, _, _ = await find_accessible_client(user, client_id, "edit")
    data = await asyncio.to_thread(snapshot, user, "client_relations")
    bound = {(row["resourceType"], row["resourceOwnerId"], row["resourceId"]): (row["clientOwnerId"], row["clientId"])
             for row in data["items"] if not row.get("removedAt")}
    result = []
    for document in await visible_commercial_refs(user, "edit"):
        if document["type"] != kind or (document["primaryClientId"] and document["primaryClientId"] != client_id):
            continue
        linked = bound.get((kind, document["owner"], document["id"]))
        if linked and linked != (client_owner, client_id):
            continue
        if not query or query.casefold() in document["title"].casefold():
            result.append({"type": kind, "id": document["id"], "title": document["title"], "status": document["status"],
                           "linked": bool(linked) or document["primaryClientId"] == client_id})
    return {"items": result[offset:offset+limit], "total": len(result),
            "nextOffset": offset+limit if offset+limit < len(result) else None}


@router.delete("/clients/{client_id}/relations/{kind}/{document_id}")
async def unlink_document(client_id: str, kind: Literal["proposal", "contract"], document_id: str,
                           expectedVersion: int = Query(ge=1), user: dict = Depends(clients_user)):
    client_owner, _, _, _ = await find_accessible_client(user, client_id, "edit")
    document_owner, _, _, document = await relation_document(user, kind, document_id, "edit")
    primary = document.get("client") if isinstance(document.get("client"), dict) else {}
    if str(document.get("clientId") or primary.get("id") or "") == client_id:
        raise HTTPException(409, "Altere o cliente no documento para mudar seu vínculo principal.")
    def remove(data):
        relation = next((row for row in data["items"] if row["clientId"] == client_id and row["clientOwnerId"] == client_owner
                         and row["resourceType"] == kind and row["resourceId"] == document_id and row["resourceOwnerId"] == document_owner and not row.get("removedAt")), None)
        if relation is None:
            raise HTTPException(404, "Vínculo não encontrado.")
        if relation.get("version", 1) != expectedVersion:
            raise HTTPException(409, "O vínculo mudou. Recarregue antes de desvincular.")
        relation.update(removedAt=now(), updatedAt=now(), updatedBy=require_user_id(user), version=expectedVersion+1)
        return {"unlinked": True}
    result = await asyncio.to_thread(mutate, user, "client_relations", remove)
    await business_audit(user, "client_document_unlinked", "client", client_id,
                         {"resourceType": kind, "resourceId": document_id})
    return result


@router.get("/documents/{kind}/{document_id}/client")
async def document_client(kind: Literal["proposal", "contract"], document_id: str, user: dict = Depends(current_user)):
    owner, _, _, document = await relation_document(user, kind, document_id)
    try:
        assert_route_permissions(user, "/api/clientes")
    except HTTPException as exc:
        if exc.status_code == 403:
            return {"client": None}
        raise
    original = document.get("client") if isinstance(document.get("client"), dict) else {}
    identifier = str(document.get("clientId") or original.get("id") or "")
    expected_owner = None
    if not identifier:
        data = await asyncio.to_thread(snapshot, user, "client_relations")
        relation = next((row for row in data["items"] if row["resourceType"] == kind and row["resourceId"] == document_id
                         and row["resourceOwnerId"] == owner and not row.get("removedAt")), None)
        if relation:
            identifier, expected_owner = relation["clientId"], relation["clientOwnerId"]
    if not identifier:
        return {"client": None}
    try:
        client_owner, _, _, client = await find_accessible_client(user, identifier)
    except HTTPException as exc:
        if exc.status_code in {403, 404}:
            return {"client": None}
        raise
    if expected_owner is not None and client_owner != expected_owner:
        return {"client": None}
    return {"client": {"id": client["id"], "name": client["name"]}}
