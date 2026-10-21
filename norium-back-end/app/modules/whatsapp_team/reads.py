"""Read projections authorize every conversation before exposing content or bytes."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.modules.auth.router import current_user
from app.modules.business.router import ContactLabelsQuery
from app.modules.chat.conversation_projection import list_page
from . import access, context, service

router = APIRouter(prefix="/api/chat/caixas/{inbox_id}", tags=["WhatsApp da equipe"])


@router.get("/referencias/{reference}")
async def referenced_conversation(inbox_id: str, reference: str, user: dict = Depends(current_user)):
    if len(reference) != 64 or any(char not in "0123456789abcdef" for char in reference):
        raise HTTPException(404, "Atendimento indisponível.")
    grant, _, _ = await context.authorized(user, inbox_id)
    chat = context.runtime()
    database = await chat.load_conversations(grant.scope.owner_id)
    catalog = await chat.load_whatsapp_catalog_cache(grant.scope.owner_id)
    for row in list_page(chat, database, catalog, offset=0, limit=50000, search="")["items"]:
        if context.conversation_ref(inbox_id, row["id"]) == reference:
            result = await details(inbox_id, row["id"], user)
            return {**result, "attendanceRef": reference}
    raise HTTPException(404, "Atendimento indisponível.")


@router.post("/contact-labels")
async def labels(inbox_id: str, payload: ContactLabelsQuery, user: dict = Depends(current_user)):
    grant, value, _ = await context.authorized(user, inbox_id)
    chat = context.runtime()
    database = await chat.load_conversations(grant.scope.owner_id)
    catalog = await chat.load_whatsapp_catalog_cache(grant.scope.owner_id)
    known = set(database) | {chat._contact_primary_id(row) for row in catalog.get("chats", []) if isinstance(row, dict)}
    for identifier in payload.contactIds:
        if identifier not in known:
            raise HTTPException(404, "Contato indisponível.")
        access.assert_conversation(grant, value, identifier)
    from app.modules.business.router import contact_label_projection
    result = await contact_label_projection(payload, user=grant.owner)
    fresh, latest, _ = await context.authorized(user, inbox_id)
    for identifier in payload.contactIds:
        access.assert_conversation(fresh, latest, identifier)
    return result


@router.get("/status-canais")
async def connection(inbox_id: str, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id)
    result = await context.runtime().obter_status_canais(user_id=None, live=False, user=grant.owner)
    await context.authorized(user, inbox_id)
    status = result.get("whatsapp", {})
    # QR, administrative URLs and owner's identifiers never enter this surface.
    return {"whatsapp": {key: status[key] for key in ("conectado", "status", "disponivel", "provider", "providerLabel", "plano") if key in status}}


@router.get("/conversas/{conversation_id}/detalhes")
async def details(inbox_id: str, conversation_id: str, user: dict = Depends(current_user)):
    grant, value, _ = await context.authorized(user, inbox_id, conversation_id)
    result = await context.runtime().obter_detalhes_conversa(conversation_id, user=grant.owner)
    await context.authorized(user, inbox_id, conversation_id)
    metadata = {**(result.get("metadados") or {}), "photoUrl": context.resource_url(inbox_id, conversation_id, "foto")}
    metadata["participantes"] = [{**row, "photoUrl": None} for row in metadata.get("participantes", [])]
    return {**result, "mensagens": [], "metadados": metadata, "photoUrl": metadata["photoUrl"],
            "assignee": {**service.default_assignment(conversation_id), **value["assignments"].get(conversation_id, {})}}


@router.get("/contatos-disponiveis")
async def contacts(inbox_id: str, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id)
    # A non-manager can select only conversations they are allowed to read.
    if grant.manager:
        result = await context.runtime().obter_contatos_disponiveis(user_id=None, user=grant.owner)
        await context.authorized(user, inbox_id)
        return [{**row, "photoUrl": None} for row in result]
    page = await conversations(inbox_id, offset=0, limit=100, search="", responsavel="all", estado=None, user=user)
    return [{"id": row["id"], "phone": row["id"], "name": row["contato"], "photoUrl": row.get("photoUrl")}
            for row in page["items"] if not row.get("esGrupo")]


@router.get("/grupos")
async def groups(inbox_id: str, user: dict = Depends(current_user)):
    result = await conversations(inbox_id, offset=0, limit=100, search="", responsavel="all", estado=None, user=user)
    return {"items": [row for row in result["items"] if row.get("esGrupo")]}


@router.get("/grupos/{conversation_id}")
async def group_details(inbox_id: str, conversation_id: str, user: dict = Depends(current_user)):
    return await details(inbox_id, conversation_id, user)


@router.get("/sincronizacao")
async def synchronization(inbox_id: str, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id)
    result = await context.runtime().obter_sincronizacao_whatsapp(user=grant.owner)
    await context.authorized(user, inbox_id)
    return result


@router.get("/conversas")
async def conversations(inbox_id: str, offset: int = Query(0, ge=0, le=50000), limit: int = Query(100, ge=1, le=100),
                        search: str = Query("", max_length=200), responsavel: str = Query("all", pattern="^(all|me|none|nora)$"),
                        estado: str | None = Query(None, pattern="^(open|waiting_customer|resolved)$"), user: dict = Depends(current_user),
                        filtros: str = Query("", max_length=5000)):
    grant, value, _ = await context.authorized(user, inbox_id)
    chat = context.runtime()
    database = await chat.load_conversations(grant.scope.owner_id)
    catalog = await chat.load_whatsapp_catalog_cache(grant.scope.owner_id)
    from app.modules.chat.list_filters import options as filter_options
    filters, allowed_ids = await filter_options(grant.owner, filtros, team=True)
    responsavel = filters.get("responsavel", responsavel)
    estado = filters.get("estado", estado)
    rows = list_page(chat, database, catalog, offset=0, limit=50000, search=search, filters=filters, allowed_ids=allowed_ids)["items"]
    visible = []
    counts = {"me": 0, "none": 0, "nora": 0, "all": 0}
    for row in rows:
        try:
            assignment = access.assert_conversation(grant, value, row["id"], row.get("metadados", {}).get("identityAliases", []))
        except HTTPException:
            continue
        assignment = {**service.default_assignment(row["id"]), **assignment}
        assigned_member = next((item for item in grant.roster if item["id"] == assignment.get("assigneeUserId")), None)
        assignment["name"] = "Você" if assignment.get("assigneeUserId") == grant.actor_id else access.public_member(assigned_member)["name"] if assigned_member else ""
        category = "me" if assignment.get("assigneeUserId") == grant.actor_id else assignment["assigneeKind"]
        counts["all"] += 1
        if category in counts:
            counts[category] += 1
        if (responsavel != "all" and category != responsavel) or (estado and assignment["status"] != estado):
            continue
        photo = context.resource_url(inbox_id, row["id"], "foto")
        visible.append({**row, "photoUrl": photo, "metadados": {**(row.get("metadados") or {}), "photoUrl": photo},
                        "assignee": assignment, "status": assignment["status"], "inboxId": inbox_id,
                        "attendanceRef": context.conversation_ref(inbox_id, row["id"])})
    # Refresh the ACL projection after reads, not only the browser's role.
    fresh, latest, _ = await context.authorized(user, inbox_id)
    if fresh.manager != grant.manager or latest["assignments"] != value["assignments"]:
        raise HTTPException(409, "O atendimento mudou durante a leitura. Atualize a lista.")
    permitted = []
    for row in visible:
        try:
            assignment = access.assert_conversation(fresh, latest, row["id"], row.get("metadados", {}).get("identityAliases", []))
        except HTTPException:
            continue
        if assignment != access.assert_conversation(grant, value, row["id"], row.get("metadados", {}).get("identityAliases", [])):
            raise HTTPException(409, "O atendimento mudou durante a leitura. Atualize a lista.")
        permitted.append(row)
    return {"items": permitted[offset:offset + limit], "total": len(permitted), "counts": counts,
            "nextOffset": offset + limit if offset + limit < len(permitted) else None,
            "cursor": int(value["inbox"].get("revision", 0)), "hasMore": False}


@router.get("/conversas/{conversation_id}/mensagens")
async def messages(inbox_id: str, conversation_id: str, before: int | None = Query(None, ge=1),
                   beforeId: str | None = Query(None, max_length=180), limit: int = Query(50, ge=1, le=100),
                   user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id, conversation_id)
    result = await context.runtime().obter_historico_conversa(conversation_id, before=before, beforeId=beforeId, limit=limit, user=grant.owner)
    await context.authorized(user, inbox_id, conversation_id)
    return {**result, "items": [context.message_projection(row, inbox_id, conversation_id) for row in result.get("items", [])]}


@router.get("/conversas/{conversation_id}/mensagens/{message_id}/{kind}")
async def media(inbox_id: str, conversation_id: str, message_id: str, kind: str, user: dict = Depends(current_user)):
    if kind not in {"midia", "miniatura"}:
        raise HTTPException(404, "Recurso indisponível.")
    grant, _, conversation = await context.authorized(user, inbox_id, conversation_id)
    if not any(row.get("id") == message_id for row in (conversation or {}).get("mensagens", [])):
        from app.modules.chat.private_history import reference
        if await reference(context.runtime(), grant.scope.owner_id, message_id, conversation_id) is None:
            raise HTTPException(404, "Mensagem indisponível.")
        await context.authorized(user, inbox_id, conversation_id)
    chat = context.runtime()
    if kind == "miniatura":
        result = await chat.obter_miniatura_whatsapp(conversation_id, message_id, user=grant.owner)
    else:
        result = await chat.obter_midia_whatsapp(message_id, conversa_id=conversation_id, user=grant.owner)
    await context.authorized(user, inbox_id, conversation_id)
    result.headers["Cache-Control"] = "private, no-store"
    return result


@router.get("/conversas/{conversation_id}/foto")
async def photo(inbox_id: str, conversation_id: str, user: dict = Depends(current_user)):
    grant, _, conversation = await context.authorized(user, inbox_id, conversation_id)
    chat = context.runtime()
    catalog = await chat.load_whatsapp_catalog_cache(grant.scope.owner_id)
    _, photos, _ = chat.build_contact_indexes([*(catalog.get("contacts") or []), *(catalog.get("chats") or [])])
    source = chat._lookup_contact_index(photos, conversation_id) or (conversation or {}).get("photoUrl")
    if not isinstance(source, str) or not source or len(source) > 4096:
        raise HTTPException(404, "Foto indisponível.")
    parsed = urlparse(source)
    opaque = parse_qs(parsed.query).get("media_id", [None])[0] if parsed.path == "/api/chat/media-proxy" and not parsed.netloc else None
    if opaque:
        result = await chat.media_proxy(url=None, media_id=opaque, user=grant.owner)
    elif parsed.scheme in {"http", "https"}:
        chat.remember_remote_media_references(grant.scope.owner_id, {"photoUrl": source})
        result = await chat.media_proxy(url=source, media_id=None, user=grant.owner)
    else:
        raise HTTPException(404, "Foto indisponível.")
    await context.authorized(user, inbox_id, conversation_id)
    result.headers["Cache-Control"] = "private, no-store"
    return result


@router.get("/conversas/{conversation_id}/historico")
@router.get("/conversas/{conversation_id}/notas")
async def history(inbox_id: str, conversation_id: str, request: Request,
                  before: float | None = Query(None, ge=0), beforeId: str | None = Query(None, max_length=64),
                  limit: int = Query(50, ge=1, le=100), user: dict = Depends(current_user)):
    _, value, _ = await context.authorized(user, inbox_id, conversation_id)
    kind = "notes" if request.url.path.endswith("/notas") else "events"
    return service.page(value, conversation_id, kind, before=(before, beforeId or "") if before is not None else None, limit=limit)
