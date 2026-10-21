"""Bounded manual metadata batches. No message sending adapter is imported."""
from __future__ import annotations

import asyncio
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import Field, StrictBool, StrictInt

from app.core.identity import require_user_id
from app.modules.auth.router import assert_route_permissions, current_user
from app.modules.business import router as business
from app.modules.business.whatsapp_contacts import aliases_for, canonical, contact_alias_index, identity
from app.modules.whatsapp_team import access, context, repository, service
from app.shared.schemas import StrictModel
from .bulk_store import atomic_document

router = APIRouter(tags=["WhatsApp — seleção"])
Identifier = Annotated[str, Field(min_length=1, max_length=180, pattern=r"^[^\x00-\x1f\x7f]+$")]


class Selection(StrictModel):
    ids: list[Identifier] = Field(min_length=1, max_length=200)
    inboxId: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class Batch(Selection):
    acao: Literal["etiquetar", "atribuir", "resolver", "arquivar", "lida"]
    parametros: dict


class TagChange(StrictModel):
    tagId: str = Field(min_length=1, max_length=100)
    apply: StrictBool


class Tags(StrictModel):
    changes: list[TagChange] = Field(min_length=1, max_length=20)


class Assignment(StrictModel):
    versions: dict[str, StrictInt]
    assigneeUserId: str | None = Field(default=None, max_length=180)


class LocalMetadata(StrictModel):
    valor: StrictBool = True


async def resolve_selection(user: dict, payload: Selection, *, contacts=False):
    ids = list(dict.fromkeys(payload.ids))
    grant = value = None
    if payload.inboxId:
        grant, value, _ = await context.authorized(user, payload.inboxId)
        owner = grant.owner
    else:
        from app.modules.chat.router import assert_channel_permission
        assert_channel_permission(user, "whatsapp")
        assert_route_permissions(user, "/api/chat")
        owner = user
    database = await business.owned_conversations(owner, [])
    index = await contact_alias_index(owner) if contacts else {}
    if any(identifier not in database and (not contacts or identity(identifier) not in index) for identifier in ids):
        raise HTTPException(404, "Uma conversa ou contato está indisponível. Atualize a seleção.")
    if grant is not None:
        grant, value, _ = await context.authorized(user, payload.inboxId)
        for identifier in ids:
            access.assert_conversation(grant, value, identifier)
    return ids, owner, grant, value, index


@router.post("/api/chat/conversas/lote/etiquetas")
async def selection_labels(payload: Selection, user: dict = Depends(current_user)):
    ids, owner, grant, _, index = await resolve_selection(user, payload, contacts=True)
    binding = await business.conversation_binding_key(owner)
    definitions, links = await asyncio.gather(asyncio.to_thread(business.snapshot, owner, "tags"),
                                              asyncio.to_thread(business.snapshot, owner, "tag_links"))
    groups = {canonical(aliases_for(index, identifier)): aliases_for(index, identifier) for identifier in ids}
    by_tag = {}
    for link in links["items"]:
        if link.get("conversationOwnerId") == require_user_id(owner) and link.get("bindingKey") == binding:
            by_tag.setdefault(link.get("tagId"), set()).add(identity(link.get("conversationId")))
    rows = []
    for tag in definitions["items"]:
        if not business.active_tag(tag) or tag.get("scope") not in {"contact", "conversation"}:
            continue
        linked = by_tag.get(tag["id"], set())
        count = sum(bool(aliases & linked) for aliases in groups.values())
        rows.append({**business.tag_summary(user, tag), "selectedCount": count})
    if grant is not None:
        fresh, latest, _ = await context.authorized(user, payload.inboxId)
        for identifier in ids:
            access.assert_conversation(fresh, latest, identifier)
    return {"items": rows, "totalContacts": len(groups)}


def assignment_batch(grant, ids, parameters, action):
    if set(parameters.versions) != set(ids) or any(version < 0 for version in parameters.versions.values()):
        raise HTTPException(422, "Informe a versão de cada atendimento selecionado.")
    changes = {"status": "resolved"} if action == "resolver" else {"assigneeUserId": parameters.assigneeUserId}
    def operation(value):
        # Check the whole selection before changing even the in-memory copy.
        for identifier in ids:
            access.assert_conversation(grant, value, identifier)
        return [service.apply_assignment(value, grant, identifier,
                expected_version=parameters.versions[identifier], changes=changes) for identifier in ids]
    return repository.mutate(grant.scope, operation)


@router.post("/api/chat/conversas/lote")
async def batch(payload: Batch, user: dict = Depends(current_user)):
    from pydantic import ValidationError
    model = Tags if payload.acao == "etiquetar" else Assignment if payload.acao in {"atribuir", "resolver"} else LocalMetadata
    try:
        parameters = model.model_validate(payload.parametros)
    except ValidationError:
        raise HTTPException(422, "Parâmetros inválidos para a ação selecionada.") from None
    if payload.acao == "etiquetar" and len({row.tagId for row in parameters.changes}) != len(parameters.changes):
        raise HTTPException(422, "Cada etiqueta deve aparecer uma única vez no lote.")
    ids, owner, grant, before, index = await resolve_selection(user, payload, contacts=payload.acao == "etiquetar")
    owner_id = require_user_id(owner)
    # Resolve the binding before any write; no credential is accepted in payloads.
    binding = await business.conversation_binding_key(owner)
    if payload.acao == "etiquetar":
        from app.modules.business.whatsapp_tag_batch import change
        result = await asyncio.to_thread(change, owner, binding, require_user_id(user),
                    [aliases_for(index, identifier) for identifier in ids], [row.model_dump() for row in parameters.changes],
                    grant=grant, ids=ids)
    elif payload.acao in {"atribuir", "resolver"}:
        if grant is None:
            raise HTTPException(422, "Atribuição e resolução estão disponíveis na caixa de equipe.")
        rows = await asyncio.to_thread(assignment_batch, grant, ids, parameters, payload.acao)
        result = {"updated": len(rows)}
    else:
        from app.services.conversation_store import _json_file_for_user, whatsapp_conversation_mutation_lock
        def operation(database, _):
            if any(identifier not in database for identifier in ids):
                raise HTTPException(404, "Uma conversa não está mais disponível.")
            for identifier in ids:
                row = database[identifier]
                row["arquivada" if payload.acao == "arquivar" else "lida"] = parameters.valor
                if payload.acao == "lida" and parameters.valor:
                    row["naoLidasCount"] = 0
            return {"updated": len(ids), "localOnly": True}
        async with whatsapp_conversation_mutation_lock(owner_id):
            result = await asyncio.to_thread(atomic_document, _json_file_for_user(owner_id), {}, operation, grant=grant, ids=ids)
    await announce(user, owner_id, payload.inboxId, ids, before, payload.acao)
    return {**result, "ok": True}


async def announce(user, owner_id, inbox_id, ids, before, action):
    """A failed notification cannot turn a committed batch into a failed action."""
    import logging
    try:
        from .realtime import publish_change
        await publish_change(owner_id, "labels" if action == "etiquetar" else "conversations")
        if inbox_id:
            grant, value, _ = await context.authorized(user, inbox_id)
            # Emit a single content-free invalidation to the union of readers.
            from app.modules.inbox.router import manager
            recipients = set()
            for identifier in ids:
                previous = (before or {}).get("assignments", {}).get(identifier, {}).get("assigneeUserId")
                for member in grant.roster:
                    actor = access.Access(member, grant.owner, grant.scope, grant.roster)
                    try:
                        access.assert_conversation(actor, value, identifier)
                    except HTTPException:
                        if actor.actor_id == previous:
                            recipients.add(actor.actor_id)
                    else:
                        recipients.add(actor.actor_id)
            await asyncio.wait_for(asyncio.gather(*(manager.broadcast(recipient, {
                "type": "WHATSAPP_CONVERSATION_UPDATED", "ownerId": recipient, "inboxId": inbox_id,
                "area": "labels" if action == "etiquetar" else "attendance"}) for recipient in recipients), return_exceptions=True), 2)
    except Exception:
        logging.getLogger(__name__).warning("Lote salvo; a atualização ao vivo será retomada pela leitura periódica.")


@router.get("/api/chat/caixas/{inbox_id}/tagged-conversations")
async def tagged(inbox_id: str, response: Response, tagIds: str = Query(max_length=2000),
                 offset: int = Query(0, ge=0, le=50000), limit: int = Query(200, ge=1, le=200), user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id)
    # Reuse the registry/alias projection, then apply current ACL before counts
    # or pagination. The larger internal limit never reaches the HTTP response.
    candidates = await business.tagged_conversations(tagIds=tagIds, offset=0, limit=50000, user=grant.owner)
    fresh, value, _ = await context.authorized(user, inbox_id)
    identifiers = []
    for identifier in candidates["ids"]:
        try:
            access.assert_conversation(fresh, value, identifier)
        except HTTPException:
            continue
        identifiers.append(identifier)
    response.headers["Cache-Control"] = "no-store"
    return {"ids": identifiers[offset:offset + limit], "total": len(identifiers),
            "nextOffset": offset + limit if offset + limit < len(identifiers) else None}
