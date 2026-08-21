"""Dominio de chat extraido do entrypoint para separar canais e midias."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import mimetypes
import logging
import os
import re
import secrets
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Literal
from urllib.parse import quote, urlparse

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import Field

from app.shared.schemas import StrictModel

load_dotenv()

from app.routers.auth_router import current_user, effective_permissions, find_user, read_user_store
from app.core.tenant import get_data_root, public_api_url
from app.routers.inbox_router import record_event
from app.services.conversation_store import (
    append_message,
    append_outgoing_message,
    delete_conversation,
    delete_message,
    load_conversations,
    modify_conversation,
    new_conversation,
    normalize_conversation,
    normalize_message,
    save_conversations,
)
from app.services.whatsapp import WhatsAppService
from app.services.telegram import TelegramConfigError, TelegramService

router = APIRouter()
logger = logging.getLogger(__name__)

whatsapp_service = WhatsAppService()
telegram_service = TelegramService()

status_conexoes: Dict[str, Dict[str, Dict[str, Any]]] = {}
TELEGRAM_OWNER_EMAIL = os.getenv("TELEGRAM_OWNER_EMAIL", "").strip().lower()
TELEGRAM_OWNER_USER_ID = os.getenv("TELEGRAM_OWNER_USER_ID", "").strip()
TELEGRAM_ALLOWED_USER_IDS = {
    item.strip()
    for item in os.getenv("TELEGRAM_ALLOWED_USER_IDS", "").split(",")
    if item.strip()
}
TELEGRAM_ALLOWED_CHAT_IDS = {
    item.strip()
    for item in os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", "").split(",")
    if item.strip()
}
WHATSAPP_OWNER_USER_ID = os.getenv("WHATSAPP_OWNER_USER_ID", "").strip()
WHATSAPP_WEBHOOK_SECRET = os.getenv("WHATSAPP_WEBHOOK_SECRET", "").strip()
WHATSAPP_WEBHOOK_HMAC_SECRET = os.getenv("WHATSAPP_WEBHOOK_HMAC_SECRET", "").strip()
WHATSAPP_MEDIA_HOSTS = {
    item.strip().lower()
    for item in os.getenv("WHATSAPP_MEDIA_HOSTS", "").split(",")
    if item.strip()
}
profile_photo_attempt_cache: Dict[str, int] = {}
whatsapp_webhook_event_cache: Dict[str, float] = {}
UPLOAD_DIR = get_data_root() / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD_BYTES = 14 * 1024 * 1024


class InicializarLoginPayload(StrictModel):
    user_id: str = Field(min_length=1)
    canal: Literal["whatsapp", "telegram"]


class EnviarMensagemPayload(StrictModel):
    user_id: str = Field(min_length=1)
    conversa_id: str = Field(min_length=1)
    canal: Literal["whatsapp", "telegram"] = "whatsapp"
    texto: str = Field(min_length=1)


class EnviarArquivoPayload(StrictModel):
    user_id: str = Field(min_length=1)
    conversa_id: str = Field(min_length=1)
    canal: Literal["whatsapp", "telegram"] = "whatsapp"
    nome_arquivo: str = Field(min_length=1)
    mime_type: str = Field(min_length=1)
    data_url: str = Field(min_length=16)
    legenda: str | None = None


class ModificarChatPayload(StrictModel):
    user_id: str = Field(min_length=1)
    conversa_id: str = Field(min_length=1)
    acao: Literal["lida", "fixada", "silenciada", "arquivada"]
    valor: bool


class ApagarMensagemPayload(StrictModel):
    user_id: str = Field(min_length=1)
    conversa_id: str = Field(min_length=1)
    mensagem_id: str = Field(min_length=1)


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def connection_status(user_id: str) -> Dict[str, Dict[str, Any]]:
    return status_conexoes.setdefault(
        user_id,
        {
            "whatsapp": {"conectado": False, "qrcode": None},
            "telegram": {"conectado": False, "qrcode": None, "disponivel": False},
        },
    )


def assert_whatsapp_owner(user: dict[str, Any]) -> None:
    if tenant_id(user) != WHATSAPP_OWNER_USER_ID:
        raise HTTPException(status_code=403, detail="WhatsApp vinculado a outra conta do Norium.")


def assert_channel_permission(user: dict[str, Any], channel: str) -> None:
    permissions = effective_permissions(user)
    if not permissions.get("chat"):
        raise HTTPException(status_code=403, detail="Acesso ao chat indisponivel.")
    if channel == "whatsapp" and not permissions.get("integracao_whatsapp"):
        raise HTTPException(status_code=403, detail="Integracao WhatsApp indisponivel para este usuario.")


def user_upload_dir(user_id: str) -> Path:
    path = UPLOAD_DIR / re.sub(r"[^a-zA-Z0-9._-]", "_", user_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def is_telegram_owner_user(user: dict[str, Any]) -> bool:
    user_id = str(user.get("id") or "")
    email = str(user.get("email") or "").strip().lower()
    return user_id == TELEGRAM_OWNER_USER_ID or email == TELEGRAM_OWNER_EMAIL


def is_telegram_owner_id(user_id: str) -> bool:
    return str(user_id) == TELEGRAM_OWNER_USER_ID


def telegram_unavailable_status() -> dict[str, Any]:
    return {
        "conectado": False,
        "qrcode": None,
        "disponivel": False,
        "restrito": True,
        "detail": "Telegram liberado somente para a conta principal do Norium.",
    }


def assert_telegram_owner(user: dict[str, Any]) -> None:
    if not is_telegram_owner_user(user):
        raise HTTPException(status_code=403, detail="Telegram liberado somente para a conta principal do Norium.")


def is_allowed_telegram_sender(chat: Dict[str, Any], sender: Dict[str, Any]) -> bool:
    if not TELEGRAM_ALLOWED_USER_IDS and not TELEGRAM_ALLOWED_CHAT_IDS:
        return True

    sender_id = str(sender.get("id") or "")
    chat_id = str(chat.get("id") or "")
    return (
        (sender_id and sender_id in TELEGRAM_ALLOWED_USER_IDS)
        or (chat_id and chat_id in TELEGRAM_ALLOWED_CHAT_IDS)
    )


@router.get("/api/chat/foto-perfil")
async def obter_foto_perfil(
    phone: str = Query(..., description="ID ou numero do contato/grupo"),
    user: dict[str, Any] = Depends(current_user),
):
    if tenant_id(user) != WHATSAPP_OWNER_USER_ID:
        raise HTTPException(status_code=403, detail="Midia do WhatsApp nao pertence a este usuario.")
    return {"photoUrl": await fetch_profile_picture(phone)}


@router.get("/api/chat/media-proxy")
async def media_proxy(
    url: str = Query(..., description="URL original do arquivo recebida pelo WhatsApp"),
    user: dict[str, Any] = Depends(current_user),
):
    if tenant_id(user) != WHATSAPP_OWNER_USER_ID:
        raise HTTPException(status_code=403, detail="Midia do WhatsApp nao pertence a este usuario.")
    parsed = urlparse(url)
    base = urlparse(whatsapp_service.base_url)
    allowed_hosts = {base.hostname or "", *WHATSAPP_MEDIA_HOSTS}
    if parsed.scheme != "https" or not parsed.hostname or parsed.hostname.lower() not in allowed_hosts:
        raise HTTPException(status_code=400, detail="Origem de midia nao autorizada.")
    try:
        async with httpx.AsyncClient(follow_redirects=False) as client:
            res_media = await client.get(url, timeout=25.0)
            if res_media.status_code != 200:
                raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.")
            if len(res_media.content) > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="Midia acima do limite permitido.")
            content_type = res_media.headers.get("Content-Type", "application/octet-stream")
            if content_type.split(";", 1)[0].lower() in {"text/html", "image/svg+xml"}:
                raise HTTPException(status_code=415, detail="Tipo de midia nao permitido.")
            return Response(
                content=res_media.content,
                media_type=content_type,
                headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"},
            )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Falha no proxy de midia.")
        raise HTTPException(status_code=500, detail="Falha temporaria no proxy de midia.") from exc


@router.get("/api/chat/telegram-file")
async def telegram_file_proxy(
    file_id: str = Query(..., description="file_id retornado pelo Telegram"),
    filename: str = Query(default="arquivo"),
    user: dict[str, Any] = Depends(current_user),
):
    assert_telegram_owner(user)
    try:
        content, mime_type = await telegram_service.download_file(file_id)
        safe_name = Path(filename).name or "arquivo"
        return Response(
            content=content,
            media_type=mime_type,
            headers={"Content-Disposition": f'inline; filename="{safe_name}"'},
        )
    except TelegramConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao baixar arquivo do Telegram.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao baixar arquivo do Telegram.") from exc


@router.get("/api/chat/uploads/{file_name}")
async def obter_upload_local(file_name: str, user: dict[str, Any] = Depends(current_user)):
    safe_name = Path(file_name).name
    file_path = user_upload_dir(tenant_id(user)) / safe_name
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Arquivo local nao encontrado.")
    return FileResponse(file_path)


@router.get("/api/chat/status-canais")
async def obter_status_canais(user_id: str, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    user_status = connection_status(resolved_user_id)
    try:
        if resolved_user_id != WHATSAPP_OWNER_USER_ID:
            user_status["whatsapp"] = {"conectado": False, "qrcode": None, "disponivel": False, "restrito": True}
        else:
            resultado = await whatsapp_service.inicializar_instancia(resolved_user_id)
            user_status["whatsapp"]["conectado"] = resultado["status"] == "conectado"
            user_status["whatsapp"]["qrcode"] = None if resultado["status"] == "conectado" else resultado.get("qrcode")
    except Exception:
        logger.exception("Falha ao sincronizar status WhatsApp.")
    if is_telegram_owner_user(user):
        user_status["telegram"] = await telegram_service.status(resolved_user_id)
    else:
        user_status["telegram"] = telegram_unavailable_status()
    return user_status


@router.post("/api/chat/inicializar-login")
async def inicializar_login(payload: InicializarLoginPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, payload.canal)
    user_status = connection_status(resolved_user_id)
    if payload.canal == "telegram":
        assert_telegram_owner(user)
        try:
            resultado = await telegram_service.configure_webhook(resolved_user_id)
            user_status["telegram"] = await telegram_service.status(resolved_user_id)
            return {
                "qrcode": None,
                "canal": "telegram",
                **resultado,
                **{key: value for key, value in user_status["telegram"].items() if key not in {"qrcode"}},
            }
        except TelegramConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    if resolved_user_id != WHATSAPP_OWNER_USER_ID:
        raise HTTPException(status_code=403, detail="WhatsApp vinculado a outra conta do Norium.")
    resultado = await whatsapp_service.inicializar_instancia(resolved_user_id)
    if resultado["status"] == "conectado":
        user_status["whatsapp"]["conectado"] = True
        return {"status": "conectado", "qrcode": None}
    if resultado["status"] == "aguardando_qrcode":
        user_status["whatsapp"]["conectado"] = False
        return {"status": "aguardando_qrcode", "qrcode": resultado["qrcode"]}
    if resultado["status"] == "iniciando":
        user_status["whatsapp"]["conectado"] = False
        return {"status": "iniciando", "qrcode": None}
    raise HTTPException(status_code=503, detail="API do WhatsApp ainda nao esta disponivel.")


@router.post("/api/whatsapp/webhook")
async def webhook_whatsapp(
    data: Dict[str, Any] = Body(...),
    x_whatsapp_webhook_secret: str | None = Header(default=None),
    x_norium_timestamp: str | None = Header(default=None),
    x_norium_signature: str | None = Header(default=None),
    x_norium_event_id: str | None = Header(default=None),
    request: Request = None,
):
    supplied_secret = x_whatsapp_webhook_secret or ""
    if not WHATSAPP_WEBHOOK_SECRET and os.getenv("ENVIRONMENT", "development").strip().lower() == "production":
        raise HTTPException(status_code=503, detail="Webhook WhatsApp indisponivel ate a configuracao segura.")
    if WHATSAPP_WEBHOOK_SECRET and not secrets.compare_digest(supplied_secret, WHATSAPP_WEBHOOK_SECRET):
        raise HTTPException(status_code=403, detail="Webhook WhatsApp nao autorizado.")
    if WHATSAPP_WEBHOOK_HMAC_SECRET:
        if request is None:
            raise HTTPException(status_code=403, detail="Assinatura do webhook ausente ou invalida.")
        try:
            timestamp = int(x_norium_timestamp or "")
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Assinatura do webhook ausente ou invalida.") from exc
        if abs(int(time.time()) - timestamp) > 300:
            raise HTTPException(status_code=403, detail="Assinatura do webhook expirada.")
        raw_body = await request.body()
        expected_signature = "sha256=" + hmac.new(
            WHATSAPP_WEBHOOK_HMAC_SECRET.encode("utf-8"),
            f"{timestamp}.".encode("utf-8") + raw_body,
            hashlib.sha256,
        ).hexdigest()
        if not x_norium_signature or not secrets.compare_digest(x_norium_signature, expected_signature):
            raise HTTPException(status_code=403, detail="Assinatura do webhook invalida.")

        now = time.time()
        expired_ids = [event_id for event_id, expires_at in whatsapp_webhook_event_cache.items() if expires_at <= now]
        for event_id in expired_ids:
            whatsapp_webhook_event_cache.pop(event_id, None)
        if x_norium_event_id:
            if x_norium_event_id in whatsapp_webhook_event_cache:
                return {"status": "duplicate"}
            whatsapp_webhook_event_cache[x_norium_event_id] = now + 600
    phone = data.get("phone") or data.get("chatId") or data.get("from")
    if not phone:
        return {"status": "ignored"}

    try:
        phone = str(phone)
        is_group = is_group_chat(phone, data)
        sender_name = str(data.get("senderName") or data.get("pushName") or data.get("name") or phone)
        chat_name = str(data.get("chatName") or data.get("name") or sender_name)
        is_from_me = bool(data.get("fromMe", False))
        hora_formatada, current_ts = current_clock()

        message_id = str(data.get("zaid") or data.get("messageId") or data.get("id") or f"msg_{current_ts}")

        requested_user_id = str(data.get("userId") or data.get("user_id") or "").strip()
        if requested_user_id and requested_user_id != WHATSAPP_OWNER_USER_ID:
            raise HTTPException(status_code=403, detail="Webhook tentou atribuir dados a outro usuario.")
        webhook_user_id = WHATSAPP_OWNER_USER_ID
        user_store = await read_user_store()
        webhook_user = find_user(user_store, webhook_user_id)
        if not webhook_user or webhook_user.get("status") != "ativo":
            return {"status": "ignored", "detail": "Usuario de destino inexistente ou inativo."}
        message_payload = extract_message_payload(data)
        db = await load_conversations(webhook_user_id)
        conversa = db.get(phone) or new_conversation(
            phone,
            contato=chat_name,
            channel="whatsapp",
            is_group=is_group,
            photo_url=extract_photo_url(data),
        )

        conversa["contato"] = chat_name
        conversa["canal"] = "whatsapp"
        conversa["channel"] = "whatsapp"
        conversa["esGrupo"] = is_group
        conversa["ultimoTexto"] = message_payload["texto"]
        conversa["horario"] = hora_formatada
        conversa["timestampUltimaMsg"] = current_ts

        if is_from_me:
            conversa["lida"] = True
        else:
            conversa["lida"] = False
            conversa["naoLidasCount"] = int(conversa.get("naoLidasCount") or 0) + 1

        photo_url = extract_photo_url(data) or conversa.get("metadados", {}).get("photoUrl")
        if photo_url:
            conversa.setdefault("metadados", {})["photoUrl"] = photo_url
            conversa["photoUrl"] = photo_url

        conversa.setdefault("mensagens", []).append(
            normalize_message(
                {
                    "id": message_id,
                    "remetente": "usuario" if is_from_me else "contato",
                    "remetenteNome": sender_name if is_group and not is_from_me else None,
                    "texto": message_payload["texto"],
                    "tipo": message_payload["tipo"],
                    "arquivoUrl": message_payload.get("arquivoUrl"),
                    "arquivoMime": message_payload.get("arquivoMime"),
                    "nomeArquivo": message_payload.get("nomeArquivo"),
                    "duracaoAudio": message_payload.get("duracaoAudio"),
                    "horario": hora_formatada,
                    "timestamp": current_ts,
                    "status": "enviado" if is_from_me else None,
                    "canal": "whatsapp",
                    "channel": "whatsapp",
                },
                "whatsapp",
            )
        )

        conversa["mensagens"] = conversa["mensagens"][-250:]
        db[phone] = normalize_conversation(phone, conversa)
        await save_conversations(db, webhook_user_id)
        await record_event(
            source="whatsapp",
            title="Nova mensagem no WhatsApp" if not is_from_me else "Mensagem enviada no WhatsApp",
            description=f"{chat_name}: {message_payload['texto'] or '[sem texto]'}",
            metadata={
                "conversaId": phone,
                "messageId": message_id,
                "channel": "whatsapp",
                "isGroup": is_group,
                "fromMe": is_from_me,
                "userId": webhook_user_id,
            },
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Falha ao processar webhook WhatsApp.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao processar webhook WhatsApp.")
    return {"status": "success"}


@router.post("/api/telegram/webhook/{user_id}")
async def webhook_telegram(
    user_id: str,
    data: Dict[str, Any] = Body(...),
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
):
    if not is_telegram_owner_id(user_id):
        raise HTTPException(status_code=403, detail="Webhook Telegram restrito a conta principal.")

    expected_secret = telegram_service.webhook_secret
    if not expected_secret and os.getenv("ENVIRONMENT", "development").strip().lower() == "production":
        raise HTTPException(status_code=503, detail="Webhook Telegram sem segredo configurado.")
    if expected_secret and x_telegram_bot_api_secret_token != expected_secret:
        raise HTTPException(status_code=403, detail="Webhook Telegram nao autorizado.")

    try:
        processed = await process_telegram_update(data, user_id)
        return {"status": "success", "processed": processed}
    except Exception:
        logger.exception("Falha ao processar webhook Telegram.")
        return {"status": "ignored", "detail": "Atualizacao nao processada."}


@router.get("/api/chat/conversas")
async def obter_conversas(
    user_id: str,
    since: int | None = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=250),
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    db = await load_conversations(resolved_user_id)

    if since is not None:
        changed_items = [
            normalize_conversation(conversation_id, conversation)
            for conversation_id, conversation in db.items()
            if int(conversation.get("timestampUltimaMsg") or 0) > since
            or any(
                int(message.get("timestamp") or 0) > since
                for message in conversation.get("mensagens", [])
            )
        ]
        changed_items.sort(
            key=lambda item: int(item.get("timestampUltimaMsg") or 0),
            reverse=True,
        )
        cursor = max(
            [since, *[int(item.get("timestampUltimaMsg") or 0) for item in changed_items]],
        )
        return {
            "items": changed_items[:limit],
            "cursor": cursor,
            "hasMore": len(changed_items) > limit,
        }

    changed = False

    if resolved_user_id != WHATSAPP_OWNER_USER_ID:
        lista_local = list(db.values())
        lista_local.sort(
            key=lambda item: (bool(item.get("fixada")), int(item.get("timestampUltimaMsg") or 0)),
            reverse=True,
        )
        return lista_local

    try:
        async with httpx.AsyncClient() as client:
            res_chats, res_contacts = await asyncio.gather(
                client.get(f"{whatsapp_service.base_url}/chats", headers=whatsapp_service.headers, timeout=10.0),
                client.get(f"{whatsapp_service.base_url}/contacts", headers=whatsapp_service.headers, timeout=10.0),
                return_exceptions=True,
            )

            contacts = parse_whatsapp_collection(res_contacts) if isinstance(res_contacts, httpx.Response) else []
            chats = parse_whatsapp_collection(res_chats) if isinstance(res_chats, httpx.Response) else []

            nomes, fotos, metadata = build_contact_indexes(contacts)

            missing_photo_count = 0
            group_metadata_count = 0
            for chat in chats[:45]:
                phone = chat.get("phone") or chat.get("id") or chat.get("jid")
                if not phone:
                    continue

                phone = str(phone)
                is_group = is_group_chat(phone, chat)
                nome_final = nomes.get(phone) or chat.get("name") or chat.get("pushname") or phone
                meta_extra = metadata.get(phone, {"participantes": [], "descricaoGrupo": ""})
                existing_photo = db.get(phone, {}).get("metadados", {}).get("photoUrl")
                pic_url = fotos.get(phone) or extract_photo_url(chat) or existing_photo

                if not pic_url and missing_photo_count < 45 and should_try_profile_picture(phone):
                    missing_photo_count += 1
                    pic_url = await fetch_profile_picture(phone, client=client)

                existing_participants = db.get(phone, {}).get("metadados", {}).get("participantes") or []
                if is_group and (not meta_extra["participantes"] and not existing_participants) and group_metadata_count < 12:
                    group_metadata_count += 1
                    group_metadata = await fetch_group_metadata(phone, client=client)
                    if group_metadata:
                        meta_extra["participantes"] = group_metadata.get("participantes", [])
                        meta_extra["descricaoGrupo"] = group_metadata.get("descricaoGrupo", "")
                        nome_final = group_metadata.get("nome") or nome_final
                        pic_url = pic_url or group_metadata.get("photoUrl")

                if phone not in db:
                    db[phone] = new_conversation(
                        phone,
                        contato=str(nome_final),
                        channel="whatsapp",
                        is_group=is_group,
                        photo_url=pic_url,
                        participantes=meta_extra["participantes"],
                        descricao_grupo=meta_extra["descricaoGrupo"],
                    )
                    changed = True
                else:
                    conversa = db[phone]
                    conversa["contato"] = str(nome_final)
                    conversa["canal"] = "whatsapp"
                    conversa["channel"] = "whatsapp"
                    conversa["esGrupo"] = is_group
                    conversa.setdefault("metadados", {})
                    if pic_url:
                        conversa["metadados"]["photoUrl"] = pic_url
                        conversa["photoUrl"] = pic_url
                    if meta_extra["participantes"]:
                        conversa["metadados"]["participantes"] = meta_extra["participantes"]
                    if meta_extra["descricaoGrupo"]:
                        conversa["metadados"]["descricaoGrupo"] = meta_extra["descricaoGrupo"]
                    db[phone] = normalize_conversation(phone, conversa)
                    changed = True
    except Exception:
        logger.exception("Falha ao sincronizar catalogo WhatsApp.")

    if changed:
        await save_conversations(db, resolved_user_id)

    if is_telegram_owner_user(user):
        try:
            telegram_count = await sync_telegram_updates(resolved_user_id)
            if telegram_count:
                db = await load_conversations(resolved_user_id)
        except Exception:
            logger.exception("Falha ao sincronizar Telegram.")

    lista_ordenada = list(db.values())
    lista_ordenada.sort(
        key=lambda item: (bool(item.get("fixada")), int(item.get("timestampUltimaMsg") or 0)),
        reverse=True,
    )
    return lista_ordenada


@router.get("/api/chat/contatos-disponiveis")
async def obter_contatos_disponiveis(user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    contatos_telegram: list[Dict[str, Any]] = []
    if is_telegram_owner_user(user):
        try:
            db = await load_conversations(resolved_user_id)
            contatos_telegram = [
                {
                    "id": conversa.get("id"),
                    "phone": conversa.get("id"),
                    "name": conversa.get("contato"),
                    "pushname": conversa.get("contato"),
                    "photoUrl": conversa.get("photoUrl") or conversa.get("metadados", {}).get("photoUrl"),
                    "channel": "telegram",
                    "canal": "telegram",
                }
                for conversa in db.values()
                if conversa.get("canal") == "telegram"
            ]
        except Exception:
            contatos_telegram = []

    if resolved_user_id != WHATSAPP_OWNER_USER_ID:
        return contatos_telegram

    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{whatsapp_service.base_url}/contacts", headers=whatsapp_service.headers, timeout=10.0)
            contatos = parse_whatsapp_collection(res)
            contatos_whatsapp = [
                {
                    "id": c.get("id") or c.get("phone") or c.get("jid"),
                    "phone": c.get("phone") or c.get("id") or c.get("jid"),
                    "name": c.get("name") or c.get("verifiedName") or c.get("pushname"),
                    "pushname": c.get("pushname"),
                    "photoUrl": extract_photo_url(c),
                    "channel": "whatsapp",
                    "canal": "whatsapp",
                }
                for c in contatos
                if c.get("name") or c.get("phone") or c.get("id")
            ]
            return [*contatos_telegram, *contatos_whatsapp]
    except Exception:
        return contatos_telegram


@router.post("/api/chat/enviar")
async def enviar_mensagem(payload: EnviarMensagemPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, payload.canal)
    if payload.canal == "telegram":
        assert_telegram_owner(user)
        try:
            await telegram_service.send_text(payload.conversa_id, payload.texto)
        except TelegramConfigError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Telegram recusou o envio.")
            raise HTTPException(status_code=502, detail="Falha temporaria no envio pelo Telegram.") from exc

        await append_outgoing_message(
            payload.conversa_id,
            payload.texto,
            channel="telegram",
            status="enviado",
            user_id=resolved_user_id,
        )
        await record_event(
            source="telegram",
            title="Mensagem enviada no Telegram",
            description=payload.texto,
            metadata={
                "conversaId": payload.conversa_id,
                "channel": "telegram",
                "direction": "outgoing",
                "userId": resolved_user_id,
            },
        )
        return {"status": "enviado_real", "canal": "telegram"}

    assert_whatsapp_owner(user)
    sucesso = await whatsapp_service.enviar_mensagem_texto(payload.conversa_id, payload.texto)
    if not sucesso:
        raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o envio.")

    await append_outgoing_message(
        payload.conversa_id,
        payload.texto,
        channel="whatsapp",
        status="enviado",
        user_id=resolved_user_id,
    )
    await record_event(
        source="whatsapp",
        title="Mensagem enviada no WhatsApp",
        description=payload.texto,
        metadata={
            "conversaId": payload.conversa_id,
            "channel": "whatsapp",
            "direction": "outgoing",
            "userId": resolved_user_id,
        },
    )
    return {"status": "enviado_real", "canal": "whatsapp"}


@router.post("/api/chat/enviar-arquivo")
async def enviar_arquivo(payload: EnviarArquivoPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, payload.canal)
    file_bytes, mime_type = decode_data_url(payload.data_url, payload.mime_type)
    local_url, safe_file_name = save_upload_file(resolved_user_id, payload.nome_arquivo, mime_type, file_bytes)
    media_kind = classify_media(mime_type, safe_file_name)
    extension = file_extension(safe_file_name, mime_type)
    legenda = (payload.legenda or "").strip() or None

    if payload.canal == "telegram":
        assert_telegram_owner(user)
        try:
            await telegram_service.send_file(
                payload.conversa_id,
                file_bytes=file_bytes,
                file_name=safe_file_name,
                mime_type=mime_type,
                media_kind=media_kind,
                caption=legenda,
            )
        except TelegramConfigError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Telegram recusou o envio do arquivo.")
            raise HTTPException(status_code=502, detail="Falha temporaria no envio do arquivo pelo Telegram.") from exc

        if media_kind == "audio":
            tipo = "audio"
            texto = legenda or "[Audio]"
        elif media_kind == "image":
            tipo = "midia"
            texto = legenda or "[Imagem]"
        elif media_kind == "video":
            tipo = "midia"
            texto = legenda or "[Video]"
        else:
            tipo = "documento"
            texto = legenda or "[Documento]"

        hora, timestamp = current_clock()
        await append_message(
            payload.conversa_id,
            {
                "id": f"tg_file_out_{timestamp}_{uuid.uuid4().hex[:8]}",
                "remetente": "usuario",
                "texto": texto,
                "tipo": tipo,
                "arquivoUrl": local_url,
                "arquivoMime": mime_type,
                "nomeArquivo": safe_file_name,
                "horario": hora,
                "timestamp": timestamp,
                "status": "enviado",
                "canal": "telegram",
                "channel": "telegram",
            },
            channel="telegram",
            user_id=resolved_user_id,
        )
        await record_event(
            source="telegram",
            title="Arquivo enviado no Telegram",
            description=f"{safe_file_name} ({mime_type})",
            metadata={
                "conversaId": payload.conversa_id,
                "channel": "telegram",
                "tipo": tipo,
                "arquivoUrl": local_url,
                "userId": resolved_user_id,
            },
        )
        return {
            "status": "enviado_real",
            "canal": "telegram",
            "tipo": tipo,
            "arquivoUrl": local_url,
            "nomeArquivo": safe_file_name,
        }

    assert_whatsapp_owner(user)
    if media_kind == "audio":
        sucesso = await whatsapp_service.enviar_audio(payload.conversa_id, payload.data_url)
        tipo = "audio"
        texto = "[Audio]"
    elif media_kind == "image":
        sucesso = await whatsapp_service.enviar_imagem(payload.conversa_id, payload.data_url, legenda)
        tipo = "midia"
        texto = legenda or "[Imagem]"
    elif media_kind == "video":
        sucesso = await whatsapp_service.enviar_video(payload.conversa_id, payload.data_url, legenda)
        tipo = "midia"
        texto = legenda or "[Video]"
    else:
        sucesso = await whatsapp_service.enviar_documento(payload.conversa_id, payload.data_url, safe_file_name, extension)
        tipo = "documento"
        texto = legenda or "[Documento]"

    if not sucesso:
        raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o envio do arquivo.")

    hora, timestamp = current_clock()
    await append_message(
        payload.conversa_id,
        {
            "id": f"file_out_{timestamp}_{uuid.uuid4().hex[:8]}",
            "remetente": "usuario",
            "texto": texto,
            "tipo": tipo,
            "arquivoUrl": local_url,
            "arquivoMime": mime_type,
            "nomeArquivo": safe_file_name,
            "horario": hora,
            "timestamp": timestamp,
            "status": "enviado",
            "canal": "whatsapp",
            "channel": "whatsapp",
        },
        channel="whatsapp",
        user_id=resolved_user_id,
    )
    await record_event(
        source="whatsapp",
        title="Arquivo enviado no WhatsApp",
        description=f"{safe_file_name} ({mime_type})",
        metadata={
            "conversaId": payload.conversa_id,
            "channel": "whatsapp",
            "tipo": tipo,
            "arquivoUrl": local_url,
            "userId": resolved_user_id,
        },
    )

    return {
        "status": "enviado_real",
        "canal": "whatsapp",
        "tipo": tipo,
        "arquivoUrl": local_url,
        "nomeArquivo": safe_file_name,
    }


@router.post("/api/chat/apagar-mensagem")
async def apagar_mensagem(payload: ApagarMensagemPayload, user: dict[str, Any] = Depends(current_user)):
    sucesso = await delete_message(payload.conversa_id, payload.mensagem_id, tenant_id(user))
    if sucesso:
        return {"status": "sucesso"}
    raise HTTPException(status_code=404, detail="Mensagem ou conversa nao encontrada.")


@router.delete("/api/chat/conversas/{conversa_id}")
async def excluir_conversa(conversa_id: str, user_id: str, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    sucesso = await delete_conversation(conversa_id, resolved_user_id)
    if sucesso:
        return {"status": "sucesso", "user_id": resolved_user_id}
    raise HTTPException(status_code=404, detail="Conversa nao encontrada.")


@router.patch("/api/chat/modificar")
async def modificar_chat(payload: ModificarChatPayload, user: dict[str, Any] = Depends(current_user)):
    sucesso = await modify_conversation(payload.conversa_id, payload.acao, payload.valor, tenant_id(user))
    return {"status": "sucesso" if sucesso else "not_found"}


async def sync_telegram_updates(user_id: str) -> int:
    if not is_telegram_owner_id(user_id):
        return 0
    updates = await telegram_service.get_updates(user_id, limit=30)
    processed = 0
    for update in updates:
        if await process_telegram_update(update, user_id):
            processed += 1
    return processed


async def process_telegram_update(update: Dict[str, Any], user_id: str) -> bool:
    if not is_telegram_owner_id(user_id):
        return False

    message = (
        update.get("message")
        or update.get("edited_message")
        or update.get("channel_post")
        or update.get("edited_channel_post")
    )
    if not isinstance(message, dict):
        return False

    chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
    if not chat.get("id"):
        return False

    conversa_id = str(chat["id"])
    message_id = str(message.get("message_id") or update.get("update_id") or uuid.uuid4().hex)
    normalized_message_id = f"tg_{conversa_id}_{message_id}"
    sender = message.get("from") if isinstance(message.get("from"), dict) else {}
    if not is_allowed_telegram_sender(chat, sender):
        logger.info("Update Telegram ignorado pela allowlist.")
        return False

    sender_name = telegram_sender_name(sender) or telegram_chat_name(chat) or conversa_id
    chat_name = telegram_chat_name(chat) or sender_name
    is_group = str(chat.get("type") or "").lower() in {"group", "supergroup", "channel"}
    timestamp = int(message.get("date") or datetime.now().timestamp())
    hora_formatada = datetime.fromtimestamp(timestamp).strftime("%H:%M")
    message_payload = telegram_message_payload(message)

    db = await load_conversations(user_id)
    conversa = db.get(conversa_id) or new_conversation(
        conversa_id,
        contato=chat_name,
        channel="telegram",
        is_group=is_group,
    )

    mensagens = conversa.get("mensagens") or []
    if any(str(item.get("id")) == normalized_message_id for item in mensagens):
        return False

    conversa["contato"] = chat_name
    conversa["canal"] = "telegram"
    conversa["channel"] = "telegram"
    conversa["esGrupo"] = is_group
    conversa["ultimoTexto"] = message_payload["texto"]
    conversa["horario"] = hora_formatada
    conversa["timestampUltimaMsg"] = timestamp
    conversa["lida"] = False
    conversa["naoLidasCount"] = int(conversa.get("naoLidasCount") or 0) + 1
    conversa.setdefault("metadados", {})
    conversa["metadados"]["username"] = chat.get("username") or sender.get("username")
    conversa["metadados"]["numeroCompleto"] = conversa_id

    conversa.setdefault("mensagens", []).append(
        normalize_message(
            {
                "id": normalized_message_id,
                "remetente": "contato",
                "remetenteNome": sender_name if is_group else None,
                "texto": message_payload["texto"],
                "tipo": message_payload["tipo"],
                "arquivoUrl": message_payload.get("arquivoUrl"),
                "arquivoMime": message_payload.get("arquivoMime"),
                "nomeArquivo": message_payload.get("nomeArquivo"),
                "duracaoAudio": message_payload.get("duracaoAudio"),
                "horario": hora_formatada,
                "timestamp": timestamp,
                "canal": "telegram",
                "channel": "telegram",
            },
            "telegram",
        )
    )

    conversa["mensagens"] = conversa["mensagens"][-250:]
    db[conversa_id] = normalize_conversation(conversa_id, conversa)
    await save_conversations(db, user_id)
    await record_event(
        source="telegram",
        title="Nova mensagem no Telegram",
        description=f"{chat_name}: {message_payload['texto'] or '[sem texto]'}",
        metadata={
            "conversaId": conversa_id,
            "messageId": normalized_message_id,
            "channel": "telegram",
            "isGroup": is_group,
            "userId": user_id,
            "sender": sender_name,
        },
    )
    return True


def telegram_chat_name(chat: Dict[str, Any]) -> str:
    title = chat.get("title")
    if title:
        return str(title)
    full_name = " ".join(str(chat.get(key) or "").strip() for key in ("first_name", "last_name")).strip()
    if full_name:
        return full_name
    username = chat.get("username")
    return f"@{username}" if username else ""


def telegram_sender_name(sender: Dict[str, Any]) -> str:
    full_name = " ".join(str(sender.get(key) or "").strip() for key in ("first_name", "last_name")).strip()
    if full_name:
        return full_name
    username = sender.get("username")
    return f"@{username}" if username else ""


def telegram_message_payload(message: Dict[str, Any]) -> Dict[str, Any]:
    text = message.get("text") or message.get("caption")
    if text:
        return {"texto": str(text), "tipo": "texto"}

    media_specs = [
        ("voice", "audio", "[Audio]", "voice.ogg"),
        ("audio", "audio", "[Audio]", "audio.mp3"),
        ("photo", "midia", "[Imagem]", "imagem.jpg"),
        ("video", "midia", "[Video]", "video.mp4"),
        ("sticker", "sticker", "[Figurinha]", "sticker.webp"),
        ("document", "documento", "[Documento]", "documento"),
    ]

    for key, tipo, label, default_name in media_specs:
        value = message.get(key)
        if not value:
            continue
        payload = value[-1] if key == "photo" and isinstance(value, list) and value else value
        if not isinstance(payload, dict):
            continue
        file_id = payload.get("file_id")
        file_name = payload.get("file_name") or default_name
        mime_type = payload.get("mime_type") or guess_telegram_mime(file_name, tipo)
        return {
            "texto": str(message.get("caption") or label),
            "tipo": tipo,
            "arquivoUrl": telegram_file_url(file_id, file_name) if file_id else None,
            "arquivoMime": mime_type,
            "nomeArquivo": file_name,
            "duracaoAudio": payload.get("duration"),
        }

    return {"texto": "", "tipo": "texto"}


def telegram_file_url(file_id: Any, file_name: Any) -> str:
    return public_api_url(
        f"/api/chat/telegram-file?file_id={quote(str(file_id), safe='')}&filename={quote(str(file_name or 'arquivo'), safe='')}"
    )


def guess_telegram_mime(file_name: str, tipo: str) -> str:
    guessed = mimetypes.guess_type(file_name)[0]
    if guessed:
        return guessed
    if tipo == "audio":
        return "audio/ogg"
    if tipo == "midia":
        return "image/jpeg"
    if tipo == "sticker":
        return "image/webp"
    return "application/octet-stream"


def current_clock() -> tuple[str, int]:
    agora = datetime.now()
    return agora.strftime("%H:%M"), int(agora.timestamp())


def decode_data_url(data_url: str, fallback_mime: str) -> tuple[bytes, str]:
    match = re.match(r"^data:([^,]*),(.*)$", data_url, flags=re.DOTALL)
    if not match:
        raise HTTPException(status_code=400, detail="Arquivo invalido. Envie um data URL base64.")

    metadata = match.group(1) or ""
    metadata_parts = [part.strip() for part in metadata.split(";") if part.strip()]
    lower_metadata_parts = {part.lower() for part in metadata_parts}
    if "base64" not in lower_metadata_parts:
        raise HTTPException(status_code=400, detail="Arquivo invalido. Envie um data URL base64.")

    declared_mime = next((part for part in metadata_parts if part.lower() != "base64" and "/" in part), None)
    mime_type = (declared_mime or fallback_mime or "application/octet-stream").strip()
    try:
        file_bytes = base64.b64decode(match.group(2), validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Base64 do arquivo invalido.") from exc

    if not file_bytes:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Arquivo acima do limite de 14 MB.")

    return file_bytes, mime_type


def file_extension(file_name: str, mime_type: str) -> str:
    suffix = Path(file_name).suffix.lower().lstrip(".")
    if suffix:
        return re.sub(r"[^a-z0-9]", "", suffix)[:12] or "bin"

    guessed = mimetypes.guess_extension(mime_type.split(";")[0].strip()) or ".bin"
    return guessed.lower().lstrip(".")[:12] or "bin"


def safe_upload_name(original_name: str, mime_type: str) -> str:
    extension = file_extension(original_name, mime_type)
    stem = Path(original_name).stem or "arquivo"
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", stem).strip("._") or "arquivo"
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    return f"{timestamp}_{uuid.uuid4().hex[:8]}_{stem[:48]}.{extension}"


def save_upload_file(user_id: str, original_name: str, mime_type: str, file_bytes: bytes) -> tuple[str, str]:
    safe_name = safe_upload_name(original_name, mime_type)
    file_path = user_upload_dir(user_id) / safe_name
    file_path.write_bytes(file_bytes)
    return public_api_url(f"/api/chat/uploads/{quote(safe_name)}"), safe_name


def classify_media(mime_type: str, file_name: str) -> str:
    normalized = mime_type.lower()
    if normalized.startswith("audio/"):
        return "audio"
    if normalized.startswith("image/"):
        return "image"
    if normalized.startswith("video/"):
        return "video"

    suffix = Path(file_name).suffix.lower()
    if suffix in {".ogg", ".opus", ".mp3", ".m4a", ".wav", ".webm"}:
        return "audio"
    if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
        return "image"
    if suffix in {".mp4", ".mov", ".avi", ".mkv", ".webm"}:
        return "video"
    return "document"


def is_group_chat(phone: str, data: Dict[str, Any] | None = None) -> bool:
    lowered = phone.lower()
    explicit = bool(data.get("isGroup", False)) if data else False
    return explicit or "@g.us" in lowered or lowered.endswith("-group")


def parse_whatsapp_collection(response: httpx.Response) -> list[Dict[str, Any]]:
    if response.status_code != 200:
        return []
    payload = response.json()
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("data", "contacts", "chats", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def build_contact_indexes(contacts: list[Dict[str, Any]]) -> tuple[Dict[str, str], Dict[str, str], Dict[str, Dict[str, Any]]]:
    nomes: Dict[str, str] = {}
    fotos: Dict[str, str] = {}
    metadata: Dict[str, Dict[str, Any]] = {}

    for contato in contacts:
        jid = contato.get("phone") or contato.get("id") or contato.get("jid")
        if not jid:
            continue
        jid = str(jid)
        nome = contato.get("name") or contato.get("verifiedName") or contato.get("pushname")
        if nome:
            nomes[jid] = str(nome)
        photo = extract_photo_url(contato)
        if photo:
            fotos[jid] = photo
        metadata[jid] = {
            "participantes": contato.get("participants") or contato.get("participantes") or [],
            "descricaoGrupo": contato.get("description") or contato.get("descricao") or "",
        }

    return nomes, fotos, metadata


def extract_message_payload(data: Dict[str, Any]) -> Dict[str, Any]:
    text_data = data.get("text")
    if isinstance(text_data, dict):
        text = text_data.get("message") or text_data.get("body") or text_data.get("text") or ""
    elif isinstance(text_data, str):
        text = text_data
    else:
        text = data.get("message") or data.get("body") or ""

    if text:
        return {"texto": str(text), "tipo": "texto"}

    media_specs = [
        ("audio", "audioUrl", "audio", "[Audio]"),
        ("sticker", "stickerUrl", "sticker", "[Figurinha]"),
        ("image", "imageUrl", "midia", "[Imagem]"),
        ("video", "videoUrl", "midia", "[Video]"),
        ("document", "documentUrl", "documento", "[Documento]"),
    ]

    for key, url_key, tipo, label in media_specs:
        payload = data.get(key)
        if not isinstance(payload, dict):
            continue
        raw_url = payload.get(url_key) or payload.get("url")
        mime = payload.get("mimeType") or payload.get("mimetype")
        caption = payload.get("caption") or payload.get("message")
        return {
            "texto": str(caption or label),
            "tipo": tipo,
            "arquivoUrl": proxied_media_url(raw_url),
            "arquivoMime": mime,
            "duracaoAudio": payload.get("seconds") or payload.get("duration"),
            "nomeArquivo": payload.get("fileName") or payload.get("filename") or default_file_name(tipo, mime),
        }

    return {"texto": "", "tipo": "texto"}


def proxied_media_url(raw_url: Any) -> str | None:
    if not isinstance(raw_url, str) or not raw_url:
        return None
    return public_api_url(f"/api/chat/media-proxy?url={quote(raw_url, safe='')}")


def default_file_name(tipo: str, mime: Any) -> str | None:
    if tipo == "documento":
        return "Documento"
    if tipo == "midia" and isinstance(mime, str) and mime.startswith("video/"):
        return "Video"
    if tipo == "midia":
        return "Imagem"
    return None


def extract_photo_url(data: Dict[str, Any]) -> str | None:
    candidates = [
        data.get("photoUrl"),
        data.get("profilePictureUrl"),
        data.get("link"),
        data.get("senderPhoto"),
        data.get("chatPhoto"),
        data.get("picture"),
        data.get("avatar"),
    ]

    contact = data.get("contact")
    if isinstance(contact, dict):
        candidates.extend([contact.get("photoUrl"), contact.get("profilePictureUrl"), contact.get("avatar")])

    for value in candidates:
        if isinstance(value, str) and value.startswith(("http://", "https://", "data:image")):
            return value
    return None


def normalize_profile_phone(phone: str) -> str:
    query_phone = phone.strip()
    if query_phone.endswith("-group"):
        return query_phone
    if "@" in query_phone:
        return query_phone
    return f"{query_phone}@c.us"


def should_try_profile_picture(phone: str) -> bool:
    now = int(datetime.now().timestamp())
    last_try = profile_photo_attempt_cache.get(phone, 0)
    if now - last_try < 900:
        return False
    profile_photo_attempt_cache[phone] = now
    return True


async def fetch_profile_picture(phone: str, client: httpx.AsyncClient | None = None) -> str | None:
    query_phone = normalize_profile_phone(phone)
    owns_client = client is None
    active_client = client or httpx.AsyncClient()
    try:
        url_foto = f"{whatsapp_service.base_url}/contacts/{quote(query_phone, safe='')}/profile-picture"
        response = await active_client.get(url_foto, headers=whatsapp_service.headers, timeout=6.0)
        if response.status_code == 200:
            data = response.json()
            return data.get("profilePictureUrl") or data.get("photoUrl") or data.get("link") or data.get("value")
    except Exception:
        logger.exception("Falha ao buscar foto de perfil WhatsApp.")
    finally:
        if owns_client:
            await active_client.aclose()
    return None


async def fetch_group_metadata(phone: str, client: httpx.AsyncClient | None = None) -> Dict[str, Any] | None:
    owns_client = client is None
    active_client = client or httpx.AsyncClient()
    group_id = phone.strip()
    try:
        response = await active_client.get(
            f"{whatsapp_service.base_url}/groups/{quote(group_id, safe='')}",
            headers=whatsapp_service.headers,
            timeout=8.0,
        )
        if response.status_code != 200:
            return None
        data = response.json()
        if not isinstance(data, dict) or data.get("error"):
            return None
        return {
            "nome": data.get("subject") or data.get("name"),
            "descricaoGrupo": data.get("description") or "",
            "participantes": data.get("participants") or [],
            "criadoPor": data.get("owner"),
            "photoUrl": extract_photo_url(data),
        }
    except Exception:
        logger.exception("Falha ao buscar metadados de grupo WhatsApp.")
    finally:
        if owns_client:
            await active_client.aclose()
    return None
