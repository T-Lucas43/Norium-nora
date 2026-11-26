"""Manual sends use the existing integration, after scoped team authorization."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from app.shared.schemas import StrictModel
from app.modules.auth.router import current_user
from app.modules.chat import router as chat
from . import context
from .bridge import manual_actor

router = APIRouter(prefix="/api/chat/caixas/{inbox_id}", tags=["WhatsApp da equipe"])


@router.post("/enviar")
async def send_text(inbox_id: str, payload: chat.EnviarMensagemPayload, user: dict = Depends(current_user)):
    if payload.user_id is not None:
        raise HTTPException(422, "A identidade de envio é resolvida pelo servidor.")
    grant, _, _ = await context.authorized(user, inbox_id, payload.conversa_id)
    if payload.responder_a:
        await context.message(user, inbox_id, payload.conversa_id, payload.responder_a)
    token = manual_actor.set(grant.actor_id)
    try:
        # No provider credential, personal-store tenant override or new sender.
        return await chat.enviar_mensagem(payload, user=grant.owner)
    finally:
        manual_actor.reset(token)


@router.post("/enviar-arquivo")
async def send_media(inbox_id: str, payload: chat.EnviarArquivoPayload, user: dict = Depends(current_user)):
    if payload.user_id is not None:
        raise HTTPException(422, "A identidade de envio é resolvida pelo servidor.")
    grant, _, _ = await context.authorized(user, inbox_id, payload.conversa_id)
    if payload.responder_a:
        await context.message(user, inbox_id, payload.conversa_id, payload.responder_a)
    token = manual_actor.set(grant.actor_id)
    try:
        result = await chat.enviar_arquivo(payload, user=grant.owner)
        # The owner's local upload path must not be exposed as a member URL.
        return {**result, "arquivoUrl": None}
    finally:
        manual_actor.reset(token)


@router.post("/reagir")
async def react(inbox_id: str, payload: chat.ReagirMensagemPayload, user: dict = Depends(current_user)):
    grant, _, _ = await context.message(user, inbox_id, payload.conversa_id, payload.mensagem_id)
    return await chat.reagir_mensagem(payload, user=grant.owner)


@router.patch("/editar-mensagem")
async def edit(inbox_id: str, payload: chat.EditarMensagemPayload, user: dict = Depends(current_user)):
    grant, _, _ = await context.message(user, inbox_id, payload.conversa_id, payload.mensagem_id)
    return await chat.editar_mensagem(payload, user=grant.owner)


@router.post("/apagar-mensagem")
async def delete_message(inbox_id: str, payload: chat.ApagarMensagemPayload, user: dict = Depends(current_user)):
    if payload.user_id is not None:
        raise HTTPException(422, "A identidade é resolvida pelo servidor.")
    grant, _, _ = await context.message(user, inbox_id, payload.conversa_id, payload.mensagem_id)
    return await chat.apagar_mensagem(payload, user=grant.owner)


@router.patch("/modificar")
async def modify(inbox_id: str, payload: chat.ModificarChatPayload, user: dict = Depends(current_user)):
    if payload.user_id is not None:
        raise HTTPException(422, "A identidade é resolvida pelo servidor.")
    grant, _, _ = await context.authorized(user, inbox_id, payload.conversa_id)
    return await chat.modificar_chat(payload, user=grant.owner)


@router.patch("/favoritar")
async def favorite(inbox_id: str, payload: chat.FavoritarChatPayload, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id, payload.conversa_id)
    return await chat.favoritar_chat(payload, user=grant.owner)


@router.delete("/conversas/{conversation_id}")
async def delete_conversation(inbox_id: str, conversation_id: str, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id, conversation_id)
    if not grant.manager:
        raise HTTPException(403, "Somente gestores podem excluir uma conversa da caixa.")
    await chat.excluir_conversa(conversation_id, user_id=None, user=grant.owner)
    return {"status": "sucesso"}


class ForwardPayload(StrictModel):
    origem_id: str = Field(min_length=1, max_length=180)
    destino_id: str = Field(min_length=1, max_length=180)
    mensagens_ids: list[str] = Field(min_length=1, max_length=100)


@router.post("/encaminhar")
async def forward(inbox_id: str, payload: ForwardPayload, user: dict = Depends(current_user)):
    # Resolve *all* exact source IDs and destination before the first side effect.
    sources = []
    for message_id in dict.fromkeys(payload.mensagens_ids):
        _, _, row = await context.message(user, inbox_id, payload.origem_id, message_id)
        sources.append((payload.origem_id, row))
    grant, _, _ = await context.authorized(user, inbox_id, payload.destino_id)
    await context.authorized(user, inbox_id, payload.origem_id)
    token = manual_actor.set(grant.actor_id)
    try:
        result = await chat._forward_authorized_sources(chat.EncaminharMensagensPayload(
            destino_id=payload.destino_id, mensagens_ids=payload.mensagens_ids), grant.owner, sources)
        from .bridge import outgoing
        await outgoing(chat, grant.owner, payload.destino_id)
        return result
    finally:
        manual_actor.reset(token)


@router.post("/sincronizacao")
async def synchronize(inbox_id: str, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id)
    if not grant.manager:
        raise HTTPException(403, "Peça a um gestor para sincronizar o catálogo da instância.")
    return await chat.iniciar_sincronizacao_whatsapp(user=grant.owner)


@router.post("/grupos")
async def create_group(inbox_id: str, payload: chat.CriarGrupoPayload, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id)
    if not grant.manager:
        raise HTTPException(403, "Somente gestores podem criar grupos na instância compartilhada.")
    result = await chat.criar_grupo(payload, user=grant.owner)
    group = result.get("group")
    if isinstance(group, dict):
        result = {**result, "group": {**group, "photoUrl": None, "mensagens": [],
                   "metadados": {**(group.get("metadados") or {}), "photoUrl": None,
                                 "participantes": [{**row, "photoUrl": None} for row in (group.get("metadados") or {}).get("participantes", [])]}}}
    return result
