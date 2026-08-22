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
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import Field

from app.shared.schemas import StrictModel

load_dotenv()

from app.routers.auth_router import current_user, effective_permissions, find_user, read_user_store
from app.core.tenant import get_data_root, public_api_url, read_user_db, write_user_db
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

router = APIRouter()
logger = logging.getLogger(__name__)

whatsapp_service = WhatsAppService()

status_conexoes: Dict[str, Dict[str, Dict[str, Any]]] = {}
WHATSAPP_WEBHOOK_SECRET = os.getenv("WHATSAPP_WEBHOOK_SECRET", "").strip()
WHATSAPP_WEBHOOK_HMAC_SECRET = os.getenv("WHATSAPP_WEBHOOK_HMAC_SECRET", "").strip()
WHATSAPP_MEDIA_HOSTS = {
    item.strip().lower()
    for item in os.getenv("WHATSAPP_MEDIA_HOSTS", "").split(",")
    if item.strip()
}
profile_photo_attempt_cache: Dict[str, int] = {}
whatsapp_webhook_event_cache: Dict[str, float] = {}
WHATSAPP_CATALOG_CACHE_TTL_SECONDS = max(60, int(os.getenv("WHATSAPP_CATALOG_CACHE_TTL_SECONDS", "300")))
WHATSAPP_CATALOG_SCHEMA_VERSION = 2
WHATSAPP_HISTORY_CACHE_TTL_SECONDS = max(30, int(os.getenv("WHATSAPP_HISTORY_CACHE_TTL_SECONDS", "120")))
WHATSAPP_HISTORY_SCHEMA_VERSION = 2
WHATSAPP_RECENT_CONVERSATION_LIMIT = max(10, min(100, int(os.getenv("WHATSAPP_RECENT_CONVERSATION_LIMIT", "50"))))
WHATSAPP_RECENT_DAYS = max(1, min(90, int(os.getenv("WHATSAPP_RECENT_DAYS", "30"))))
BRAZIL_TZ = ZoneInfo("America/Sao_Paulo")
UPLOAD_DIR = get_data_root() / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD_BYTES = 14 * 1024 * 1024


class InicializarLoginPayload(StrictModel):
    user_id: str | None = Field(default=None, min_length=1)
    canal: Literal["whatsapp"]


class EnviarMensagemPayload(StrictModel):
    user_id: str | None = Field(default=None, min_length=1)
    conversa_id: str = Field(min_length=1)
    canal: Literal["whatsapp"] = "whatsapp"
    texto: str = Field(min_length=1)


class EnviarArquivoPayload(StrictModel):
    user_id: str | None = Field(default=None, min_length=1)
    conversa_id: str = Field(min_length=1)
    canal: Literal["whatsapp"] = "whatsapp"
    nome_arquivo: str = Field(min_length=1)
    mime_type: str = Field(min_length=1)
    data_url: str = Field(min_length=16)
    legenda: str | None = None
    como_figurinha: bool = False


class ReagirMensagemPayload(StrictModel):
    conversa_id: str = Field(min_length=1)
    mensagem_id: str = Field(min_length=1)
    emoji: str = Field(min_length=0, max_length=16)


class ModificarChatPayload(StrictModel):
    user_id: str | None = Field(default=None, min_length=1)
    conversa_id: str = Field(min_length=1)
    acao: Literal["lida", "fixada", "silenciada", "arquivada"]
    valor: bool


class FavoritarChatPayload(StrictModel):
    conversa_id: str = Field(min_length=1)
    valor: bool


class ApagarMensagemPayload(StrictModel):
    user_id: str | None = Field(default=None, min_length=1)
    conversa_id: str = Field(min_length=1)
    mensagem_id: str = Field(min_length=1)
    para_todos: bool = False


class CriarGrupoPayload(StrictModel):
    nome: str = Field(min_length=1, max_length=100)
    participantes: list[str] = Field(min_length=1, max_length=256)


class EncaminharMensagensPayload(StrictModel):
    destino_id: str = Field(min_length=1)
    mensagens_ids: list[str] = Field(min_length=1, max_length=100)


def tenant_id(user: dict[str, Any]) -> str:
    resolved = str(user.get("id") or "").strip()
    if not resolved:
        raise HTTPException(status_code=401, detail="Identidade autenticada invalida.")
    return resolved


def connection_status(user_id: str) -> Dict[str, Dict[str, Any]]:
    return status_conexoes.setdefault(
        user_id,
        {
            "whatsapp": {"conectado": False, "qrcode": None},
        },
    )


async def load_whatsapp_catalog_cache(user_id: str) -> Dict[str, Any]:
    payload = await asyncio.to_thread(read_user_db, user_id, "whatsapp_catalog_cache", {})
    return payload if isinstance(payload, dict) else {}


async def save_whatsapp_catalog_cache(user_id: str, payload: Dict[str, Any]) -> None:
    await asyncio.to_thread(write_user_db, user_id, "whatsapp_catalog_cache", payload)


def catalog_cache_is_fresh(cache: Dict[str, Any], key: str = "catalogSyncedAt") -> bool:
    if cache.get("schemaVersion") != WHATSAPP_CATALOG_SCHEMA_VERSION:
        return False
    try:
        cached_at = float(cache.get(key) or 0)
    except (TypeError, ValueError):
        return False
    return cached_at > 0 and time.time() - cached_at < WHATSAPP_CATALOG_CACHE_TTL_SECONDS


def sorted_conversations(db: Dict[str, Any]) -> list[Dict[str, Any]]:
    cutoff = int(time.time()) - WHATSAPP_RECENT_DAYS * 24 * 60 * 60
    items = [
        item for item in db.values()
        if int(item.get("timestampUltimaMsg") or 0) >= cutoff
    ]
    items.sort(
        key=lambda item: (bool(item.get("fixada")), int(item.get("timestampUltimaMsg") or 0)),
        reverse=True,
    )
    return items[:WHATSAPP_RECENT_CONVERSATION_LIMIT]


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


def whatsapp_media_cache_paths(user_id: str, message_id: str) -> tuple[Path, Path]:
    digest = hashlib.sha256(message_id.encode("utf-8")).hexdigest()
    cache_dir = user_upload_dir(user_id) / "whatsapp_media"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{digest}.bin", cache_dir / f"{digest}.mime"


def read_whatsapp_media_cache(user_id: str, message_id: str) -> tuple[bytes, str] | None:
    data_path, mime_path = whatsapp_media_cache_paths(user_id, message_id)
    if not data_path.is_file() or not mime_path.is_file():
        return None
    try:
        file_bytes = data_path.read_bytes()
        mime_type = mime_path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not file_bytes or len(file_bytes) > MAX_UPLOAD_BYTES or not mime_type:
        return None
    return file_bytes, mime_type


def write_whatsapp_media_cache(user_id: str, message_id: str, file_bytes: bytes, mime_type: str) -> None:
    data_path, mime_path = whatsapp_media_cache_paths(user_id, message_id)
    suffix = uuid.uuid4().hex[:10]
    temp_data = data_path.with_name(f"{data_path.name}.{suffix}.tmp")
    temp_mime = mime_path.with_name(f"{mime_path.name}.{suffix}.tmp")
    temp_data.write_bytes(file_bytes)
    temp_mime.write_text(mime_type, encoding="utf-8")
    temp_data.replace(data_path)
    temp_mime.replace(mime_path)


@router.get("/api/chat/foto-perfil")
async def obter_foto_perfil(
    phone: str = Query(..., description="ID ou numero do contato/grupo"),
    user: dict[str, Any] = Depends(current_user),
):
    assert_channel_permission(user, "whatsapp")
    return {"photoUrl": await fetch_profile_picture(tenant_id(user), phone)}


@router.get("/api/chat/media-proxy")
async def media_proxy(
    url: str = Query(..., description="URL original da midia do WhatsApp"),
    user: dict[str, Any] = Depends(current_user),
):
    assert_channel_permission(user, "whatsapp")
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


@router.get("/api/chat/uploads/{file_name}")
async def obter_upload_local(file_name: str, user: dict[str, Any] = Depends(current_user)):
    safe_name = Path(file_name).name
    file_path = user_upload_dir(tenant_id(user)) / safe_name
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Arquivo local nao encontrado.")
    return FileResponse(file_path)


@router.get("/api/chat/status-canais")
async def obter_status_canais(
    user_id: str | None = Query(default=None, deprecated=True),
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    user_status = connection_status(resolved_user_id)
    user_status["whatsapp"] = {"conectado": False, "qrcode": None}
    try:
        resultado = await whatsapp_service.consultar_instancia(resolved_user_id)
        user_status["whatsapp"] = {
            "conectado": resultado["status"] == "conectado",
            "qrcode": None if resultado["status"] == "conectado" else resultado.get("qrcode"),
            "status": resultado.get("status"),
            "state": resultado.get("state"),
            "detail": resultado.get("detail"),
            "numero": resultado.get("numero"),
            "conectadoEm": resultado.get("conectadoEm"),
        }
    except Exception:
        user_status["whatsapp"] = {
            "conectado": False,
            "qrcode": None,
            "status": "indisponivel",
            "disponivel": False,
        }
        logger.exception("Falha ao sincronizar status WhatsApp.")
    return user_status


@router.post("/api/chat/inicializar-login")
async def inicializar_login(payload: InicializarLoginPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, payload.canal)
    user_status = connection_status(resolved_user_id)
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


@router.post("/api/chat/desconectar")
async def desconectar_whatsapp(user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    if not await whatsapp_service.desconectar_instancia(resolved_user_id):
        raise HTTPException(status_code=502, detail="Nao foi possivel desconectar a sessao do WhatsApp.")
    await save_conversations({}, resolved_user_id)
    await save_whatsapp_catalog_cache(resolved_user_id, {})
    status_conexoes.pop(resolved_user_id, None)
    return {"status": "desconectado"}


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
        event_id = x_norium_event_id or str(data.get("eventId") or "")
        if event_id:
            if event_id in whatsapp_webhook_event_cache:
                return {"status": "duplicate"}
            whatsapp_webhook_event_cache[event_id] = now + 600

    try:
        webhook_user_id = str(data.get("userId") or "").strip()
        webhook_session_id = str(data.get("sessionId") or "").strip()
        event_name = str(data.get("event") or "").strip()
        payload = data.get("data")
        if not webhook_user_id or not webhook_session_id or not isinstance(payload, dict):
            raise HTTPException(status_code=403, detail="Webhook sem contexto privado de sessao.")
        expected_session_id = whatsapp_service.session_id_for(webhook_user_id)
        if not secrets.compare_digest(webhook_session_id, expected_session_id):
            raise HTTPException(status_code=403, detail="Webhook tentou acessar uma sessao de outro usuario.")
        if event_name in {"ack", "reaction"}:
            event_message = payload.get("message") if event_name == "reaction" else payload
            if not isinstance(event_message, dict):
                return {"status": "ignored", "event": event_name}
            message_id = str(event_message.get("id") or "")
            chat_id = str(event_message.get("chatId") or "")
            if not message_id:
                return {"status": "ignored", "event": event_name}
            db = await load_conversations(webhook_user_id)
            candidates = [db.get(chat_id)] if chat_id and db.get(chat_id) else list(db.values())
            changed = False
            for conversation in candidates:
                if not isinstance(conversation, dict):
                    continue
                for stored_message in conversation.get("mensagens") or []:
                    if str(stored_message.get("id") or "") != message_id:
                        continue
                    if event_name == "ack":
                        stored_message["status"] = event_message.get("status") or stored_message.get("status")
                    else:
                        stored_message["reacoes"] = event_message.get("reactions") or []
                    changed = True
                    break
                if changed:
                    break
            if changed:
                await save_conversations(db, webhook_user_id)
            return {"status": "success" if changed else "ignored", "event": event_name}
        if event_name not in {"message", "any-message"}:
            return {"status": "ignored", "event": event_name}
        data = payload
        phone = data.get("chatId") or data.get("phone") or data.get("from")
        if not phone:
            return {"status": "ignored"}
        phone = str(phone)
        is_group = is_group_chat(phone, data)
        sender_name = str(data.get("senderName") or data.get("pushName") or data.get("name") or phone)
        chat_name = str(data.get("chatName") or data.get("name") or sender_name)
        is_from_me = bool(data.get("fromMe", False))
        hora_formatada, current_ts = current_clock()
        try:
            message_timestamp = int(data.get("timestamp") or current_ts)
        except (TypeError, ValueError):
            message_timestamp = current_ts
        hora_formatada = format_whatsapp_time(message_timestamp)

        message_id = str(data.get("zaid") or data.get("messageId") or data.get("id") or f"msg_{message_timestamp}")

        user_store = await read_user_store()
        webhook_user = find_user(user_store, webhook_user_id)
        if not webhook_user or webhook_user.get("status") != "ativo":
            return {"status": "ignored", "detail": "Usuario de destino inexistente ou inativo."}
        message_payload = extract_message_payload(data, message_id, phone)
        db = await load_conversations(webhook_user_id)
        conversa = db.get(phone) or new_conversation(
            phone,
            contato=chat_name,
            channel="whatsapp",
            is_group=is_group,
            photo_url=extract_photo_url(data),
        )

        mensagens_existentes = conversa.setdefault("mensagens", [])
        if any(str(item.get("id") or "") == message_id for item in mensagens_existentes):
            return {"status": "duplicate"}

        conversa["contato"] = chat_name
        conversa["canal"] = "whatsapp"
        conversa["channel"] = "whatsapp"
        conversa["esGrupo"] = is_group
        conversa["ultimoTexto"] = message_payload["texto"]
        conversa["horario"] = hora_formatada
        conversa["timestampUltimaMsg"] = message_timestamp
        conversa["ultimaMensagemMinha"] = is_from_me
        conversa["statusUltimaMensagem"] = data.get("status") if is_from_me else None
        conversa["ultimoRemetenteNome"] = sender_name if is_group and not is_from_me else None

        if is_from_me:
            conversa["lida"] = True
        else:
            conversa["lida"] = False
            conversa["naoLidasCount"] = int(conversa.get("naoLidasCount") or 0) + 1

        photo_url = extract_photo_url(data) or conversa.get("metadados", {}).get("photoUrl")
        if photo_url:
            conversa.setdefault("metadados", {})["photoUrl"] = photo_url
            conversa["photoUrl"] = photo_url

        mensagens_existentes.append(
            normalize_message(
                {
                    "id": message_id,
                    "remetente": "usuario" if is_from_me else "contato",
                    "remetenteNome": sender_name if is_group and not is_from_me else None,
                    "remetenteId": data.get("senderId"),
                    "texto": message_payload["texto"],
                    "tipo": message_payload["tipo"],
                    "arquivoUrl": message_payload.get("arquivoUrl"),
                    "arquivoMime": message_payload.get("arquivoMime"),
                    "nomeArquivo": message_payload.get("nomeArquivo"),
                    "duracaoAudio": message_payload.get("duracaoAudio"),
                    "horario": hora_formatada,
                    "timestamp": message_timestamp,
                    "status": data.get("status") if is_from_me else None,
                    "reacoes": data.get("reactions") or [],
                    "citada": data.get("quoted"),
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


@router.get("/api/chat/conversas")
async def obter_conversas(
    user_id: str | None = Query(default=None, deprecated=True),
    since: int | None = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=250),
    refresh: bool = Query(default=False),
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    db = await load_conversations(resolved_user_id)
    catalog_cache = await load_whatsapp_catalog_cache(resolved_user_id)
    whatsapp_status = await whatsapp_service.consultar_instancia(resolved_user_id)
    if whatsapp_status["status"] != "conectado":
        if since is None and db and catalog_cache.get("authenticatedAt"):
            return sorted_conversations(db)
        return {"items": [], "cursor": since or 0, "hasMore": False} if since is not None else []

    if since is not None:
        # O webhook/evento em tempo real ja atualiza o cache. Um delta nunca
        # abre uma varredura completa no navegador do WhatsApp: isso evitava
        # que simples cliques em contatos derrubassem a sessao.
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

    if db and not refresh and catalog_cache_is_fresh(catalog_cache):
        return sorted_conversations(db)

    changed = False
    contacts: list[Dict[str, Any]] = []
    chats: list[Dict[str, Any]] = []
    remote_catalog_loaded = False
    remote_contacts_loaded = False

    try:
        res_chats, res_contacts = await asyncio.gather(
            whatsapp_service.get(resolved_user_id, "/chats", timeout=25.0),
            whatsapp_service.get(resolved_user_id, "/contacts", timeout=25.0),
            return_exceptions=True,
        )

        contacts = parse_whatsapp_collection(res_contacts) if not isinstance(res_contacts, Exception) else []
        chats = parse_whatsapp_collection(res_chats) if not isinstance(res_chats, Exception) else []
        remote_catalog_loaded = not isinstance(res_chats, Exception)
        remote_contacts_loaded = not isinstance(res_contacts, Exception)

        # O catalogo remoto e paginado/limitado. A ausencia de um chat nesse
        # lote nao significa exclusao no WhatsApp e nunca deve apagar o cache
        # duravel do usuario; exclusoes so acontecem pela rota explicita.

        nomes, fotos, metadata = build_contact_indexes(contacts)

        missing_photo_count = 0
        group_metadata_count = 0
        for chat in chats[:500]:
            phone = chat.get("phone") or chat.get("id") or chat.get("jid")
            if not phone:
                continue

            phone = str(phone)
            is_group = is_group_chat(phone, chat)
            nome_final = nomes.get(phone) or chat.get("name") or chat.get("pushname") or phone
            meta_extra = metadata.get(phone, {"participantes": [], "descricaoGrupo": ""})
            existing_photo = db.get(phone, {}).get("metadados", {}).get("photoUrl")
            pic_url = fotos.get(phone) or extract_photo_url(chat) or existing_photo

            if not pic_url and missing_photo_count < 45 and should_try_profile_picture(resolved_user_id, phone):
                missing_photo_count += 1
                pic_url = await fetch_profile_picture(resolved_user_id, phone)

            existing_participants = db.get(phone, {}).get("metadados", {}).get("participantes") or []
            if is_group and (not meta_extra["participantes"] and not existing_participants) and group_metadata_count < 12:
                group_metadata_count += 1
                group_metadata = await fetch_group_metadata(resolved_user_id, phone)
                if group_metadata:
                    meta_extra["participantes"] = group_metadata.get("participantes", [])
                    meta_extra["descricaoGrupo"] = group_metadata.get("descricaoGrupo", "")
                    meta_extra["criadoPor"] = group_metadata.get("criadoPor")
                    meta_extra["criadoEm"] = group_metadata.get("criadoEm")
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
                db[phone]["metadados"].update(
                    {
                        "verifiedName": meta_extra.get("verifiedName"),
                        "bioRecado": meta_extra.get("bioRecado"),
                        "isBusiness": bool(meta_extra.get("isBusiness")),
                        "isMyContact": bool(meta_extra.get("isMyContact")),
                        "isBlocked": bool(meta_extra.get("isBlocked")),
                        "criadoPor": meta_extra.get("criadoPor"),
                        "criadoEm": meta_extra.get("criadoEm"),
                    }
                )
                db[phone] = normalize_conversation(phone, db[phone])
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
                for metadata_key in (
                    "verifiedName", "bioRecado", "isBusiness", "isMyContact", "isBlocked", "criadoPor", "criadoEm"
                ):
                    if metadata_key in meta_extra and meta_extra.get(metadata_key) is not None:
                        conversa["metadados"][metadata_key] = meta_extra[metadata_key]
                db[phone] = normalize_conversation(phone, conversa)
                changed = True

            if sync_catalog_messages(db[phone], chat):
                db[phone] = normalize_conversation(phone, db[phone])
                changed = True
    except Exception:
        logger.exception("Falha ao sincronizar catalogo WhatsApp.")

    if changed:
        await save_conversations(db, resolved_user_id)

    if remote_catalog_loaded:
        await save_whatsapp_catalog_cache(
            resolved_user_id,
            {
                **catalog_cache,
                "schemaVersion": WHATSAPP_CATALOG_SCHEMA_VERSION,
                "authenticatedAt": catalog_cache.get("authenticatedAt") or time.time(),
                "catalogSyncedAt": time.time(),
                "contactsSyncedAt": time.time() if remote_contacts_loaded else catalog_cache.get("contactsSyncedAt"),
                "contacts": contacts if remote_contacts_loaded else catalog_cache.get("contacts", []),
            },
        )

    return sorted_conversations(db)


@router.get("/api/chat/conversas/{conversa_id}/mensagens")
async def obter_historico_conversa(
    conversa_id: str,
    before: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    db = await load_conversations(resolved_user_id)
    conversation = db.get(conversa_id)
    history_synced_at = (conversation or {}).get("metadados", {}).get("historicoSincronizadoEm")
    history_schema = (conversation or {}).get("metadados", {}).get("historicoSchema")
    try:
        history_cache_fresh = bool(history_synced_at) and time.time() - float(history_synced_at) < WHATSAPP_HISTORY_CACHE_TTL_SECONDS
    except (TypeError, ValueError):
        history_cache_fresh = False
    if (
        before is None
        and conversation
        and conversation.get("mensagens")
        and history_cache_fresh
        and history_schema == WHATSAPP_HISTORY_SCHEMA_VERSION
    ):
        cached_messages = list(conversation.get("mensagens") or [])[-limit:]
        cached_messages.sort(key=lambda item: int(item.get("timestamp") or 0))
        return {
            "items": cached_messages,
            "cursor": conversation.get("metadados", {}).get("historicoCursor")
            or min((int(item.get("timestamp") or 0) for item in cached_messages), default=None),
            "hasMore": bool(conversation.get("metadados", {}).get("historicoTemMais")),
        }
    query = f"?limit={limit}"
    if before:
        query += f"&before={before}"
    payload = await whatsapp_service.get(
        resolved_user_id,
        f"/chats/{quote(conversa_id, safe='')}/messages{query}",
        timeout=25.0,
    )
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        raise HTTPException(status_code=502, detail="Falha ao carregar o historico real do WhatsApp.")
    conversation = db.get(conversa_id) or new_conversation(conversa_id, channel="whatsapp")
    sync_catalog_messages(conversation, {"id": conversa_id, "messages": payload["items"]})
    conversation.setdefault("metadados", {})["historicoSincronizadoEm"] = time.time()
    conversation["metadados"]["historicoSchema"] = WHATSAPP_HISTORY_SCHEMA_VERSION
    conversation["metadados"]["historicoCursor"] = payload.get("cursor")
    conversation["metadados"]["historicoTemMais"] = bool(payload.get("hasMore"))
    db[conversa_id] = normalize_conversation(conversa_id, conversation)
    await save_conversations(db, resolved_user_id)
    requested_ids = {
        str(item.get("id") or "")
        for item in payload["items"]
        if isinstance(item, dict)
    }
    messages = [
        item for item in db[conversa_id].get("mensagens", [])
        if str(item.get("id") or "") in requested_ids
    ]
    messages.sort(key=lambda item: int(item.get("timestamp") or 0))
    return {
        "items": messages,
        "cursor": payload.get("cursor"),
        "hasMore": bool(payload.get("hasMore")),
    }


@router.get("/api/chat/conversas/{conversa_id}/detalhes")
async def obter_detalhes_conversa(
    conversa_id: str,
    user: dict[str, Any] = Depends(current_user),
):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    db = await load_conversations(resolved_user_id)
    conversation = db.get(conversa_id) or new_conversation(
        conversa_id,
        channel="whatsapp",
        is_group=is_group_chat(conversa_id),
    )
    endpoint = "/groups/" if is_group_chat(conversa_id, conversation) else "/contacts/"
    try:
        details = await whatsapp_service.get(
            resolved_user_id,
            f"{endpoint}{quote(conversa_id, safe='')}",
            timeout=25.0,
        )
    except Exception:
        logger.exception("Falha ao carregar detalhes do WhatsApp.")
        details = None

    metadata = conversation.setdefault("metadados", {})
    if isinstance(details, dict) and not details.get("error"):
        name = details.get("subject") or details.get("name") or details.get("formattedName")
        if name:
            conversation["contato"] = str(name)
        photo_url = extract_photo_url(details)
        if not photo_url:
            photo_url = await fetch_profile_picture(resolved_user_id, conversa_id)
        if photo_url:
            metadata["photoUrl"] = photo_url
            conversation["photoUrl"] = photo_url
        metadata.update(
            {
                "numeroCompleto": details.get("phone") or details.get("id") or conversa_id,
                "bioRecado": details.get("bio") or details.get("status") or metadata.get("bioRecado"),
                "verifiedName": details.get("verifiedName") or metadata.get("verifiedName"),
                "isBusiness": bool(details.get("isBusiness", metadata.get("isBusiness", False))),
                "isMyContact": bool(details.get("isMyContact", metadata.get("isMyContact", False))),
                "isBlocked": bool(details.get("isBlocked", metadata.get("isBlocked", False))),
                "descricaoGrupo": details.get("description") or metadata.get("descricaoGrupo") or "",
                "participantes": details.get("participants") or metadata.get("participantes") or [],
                "criadoPor": details.get("owner") or metadata.get("criadoPor"),
                "criadoEm": details.get("createdAt") or metadata.get("criadoEm"),
            }
        )
        conversation["metadados"] = metadata
        db[conversa_id] = normalize_conversation(conversa_id, conversation)
        await save_conversations(db, resolved_user_id)
        return db[conversa_id]

    return normalize_conversation(conversa_id, conversation)


@router.get("/api/chat/midia/{message_id}")
async def obter_midia_whatsapp(
    message_id: str,
    conversa_id: str | None = Query(default=None, max_length=120),
    user: dict[str, Any] = Depends(current_user),
):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    cached = await asyncio.to_thread(read_whatsapp_media_cache, resolved_user_id, message_id)
    if cached:
        file_bytes, mime_type = cached
        return Response(
            content=file_bytes,
            media_type=mime_type,
            headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"},
        )

    resolved_conversation_id = conversa_id
    if not resolved_conversation_id:
        db = await load_conversations(resolved_user_id)
        for candidate_id, conversation in db.items():
            if any(str(item.get("id") or "") == message_id for item in conversation.get("mensagens") or []):
                resolved_conversation_id = candidate_id
                break

    endpoint = f"/messages/{quote(message_id, safe='')}/media"
    if resolved_conversation_id:
        endpoint += f"?chatId={quote(resolved_conversation_id, safe='')}"
    payload = await whatsapp_service.get(
        resolved_user_id,
        endpoint,
        timeout=65.0,
    )
    data_url = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data_url, str):
        raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.")
    file_bytes, mime_type = decode_data_url(data_url, "application/octet-stream")
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Midia acima do limite permitido.")
    if mime_type.split(";", 1)[0].lower() in {"text/html", "image/svg+xml"}:
        raise HTTPException(status_code=415, detail="Tipo de midia nao permitido.")
    await asyncio.to_thread(write_whatsapp_media_cache, resolved_user_id, message_id, file_bytes, mime_type)
    return Response(
        content=file_bytes,
        media_type=mime_type,
        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )


@router.post("/api/chat/grupos")
async def criar_grupo(payload: CriarGrupoPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    result = await whatsapp_service.post(
        tenant_id(user),
        "/groups",
        {"name": payload.nome, "participants": payload.participantes},
        timeout=50.0,
    )
    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail="A API do WhatsApp nao conseguiu criar o grupo.")
    return {"status": "criado", "group": result}


@router.post("/api/chat/encaminhar")
async def encaminhar_mensagens(payload: EncaminharMensagensPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    result = await whatsapp_service.post(
        tenant_id(user),
        "/messages/forward",
        {"to": payload.destino_id, "messageIds": payload.mensagens_ids},
        timeout=50.0,
    )
    if not isinstance(result, dict) or result.get("forwarded") is not True:
        raise HTTPException(status_code=502, detail="A API do WhatsApp nao conseguiu encaminhar as mensagens.")
    return {"status": "encaminhado"}


@router.get("/api/chat/contatos-disponiveis")
async def obter_contatos_disponiveis(
    user_id: str | None = Query(default=None, deprecated=True),
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    catalog_cache = await load_whatsapp_catalog_cache(resolved_user_id)

    try:
        cached_contacts = catalog_cache.get("contacts")
        if catalog_cache_is_fresh(catalog_cache, "contactsSyncedAt") and isinstance(cached_contacts, list):
            contatos = [item for item in cached_contacts if isinstance(item, dict)]
        else:
            contatos = parse_whatsapp_collection(await whatsapp_service.get(resolved_user_id, "/contacts", timeout=25.0))
            await save_whatsapp_catalog_cache(
                resolved_user_id,
                {**catalog_cache, "contactsSyncedAt": time.time(), "contacts": contatos},
            )
        contatos_whatsapp = [
            {
                "id": c.get("id") or c.get("phone") or c.get("jid"),
                "phone": c.get("phone") or c.get("id") or c.get("jid"),
                "name": c.get("name") or c.get("verifiedName") or c.get("pushname"),
                "pushname": c.get("pushname"),
                "photoUrl": extract_photo_url(c),
                "verifiedName": c.get("verifiedName"),
                "bio": c.get("bio") or c.get("status"),
                "isBusiness": bool(c.get("isBusiness")),
                "isMyContact": bool(c.get("isMyContact")),
                "isBlocked": bool(c.get("isBlocked")),
                "channel": "whatsapp",
                "canal": "whatsapp",
            }
            for c in contatos
            if c.get("name") or c.get("phone") or c.get("id")
        ]
        return contatos_whatsapp
    except Exception:
        return []


@router.post("/api/chat/enviar")
async def enviar_mensagem(payload: EnviarMensagemPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, payload.canal)
    result = await whatsapp_service.enviar_mensagem_texto(resolved_user_id, payload.conversa_id, payload.texto)
    if not result or result.get("sent") is not True:
        raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o envio.")

    await append_outgoing_message(
        payload.conversa_id,
        payload.texto,
        channel="whatsapp",
        status="enviado",
        message_id=str(result.get("messageId") or "") or None,
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

    if payload.como_figurinha:
        if media_kind != "image":
            raise HTTPException(status_code=415, detail="Figurinhas devem ser enviadas a partir de uma imagem.")
        result = await whatsapp_service.enviar_figurinha(resolved_user_id, payload.conversa_id, payload.data_url)
        tipo = "sticker"
        texto = "[Figurinha]"
    elif media_kind == "audio":
        result = await whatsapp_service.enviar_audio(resolved_user_id, payload.conversa_id, payload.data_url)
        tipo = "audio"
        texto = "[Audio]"
    elif media_kind == "image":
        result = await whatsapp_service.enviar_imagem(resolved_user_id, payload.conversa_id, payload.data_url, legenda)
        tipo = "midia"
        texto = legenda or "[Imagem]"
    elif media_kind == "video":
        result = await whatsapp_service.enviar_video(resolved_user_id, payload.conversa_id, payload.data_url, legenda)
        tipo = "midia"
        texto = legenda or "[Video]"
    else:
        result = await whatsapp_service.enviar_documento(
            resolved_user_id,
            payload.conversa_id,
            payload.data_url,
            safe_file_name,
            extension,
        )
        tipo = "documento"
        texto = legenda or "[Documento]"

    if not result or result.get("sent") is not True:
        raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o envio do arquivo.")

    hora, timestamp = current_clock()
    await append_message(
        payload.conversa_id,
        {
            "id": str(result.get("messageId") or "") or f"file_out_{timestamp}_{uuid.uuid4().hex[:8]}",
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


@router.post("/api/chat/reagir")
async def reagir_mensagem(payload: ReagirMensagemPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    result = await whatsapp_service.post(
        resolved_user_id,
        f"/messages/{quote(payload.mensagem_id, safe='')}/reactions",
        {"emoji": payload.emoji},
        timeout=35.0,
    )
    if not isinstance(result, dict) or result.get("reacted") is not True:
        raise HTTPException(status_code=502, detail="O WhatsApp recusou a reacao.")

    db = await load_conversations(resolved_user_id)
    conversation = db.get(payload.conversa_id)
    if isinstance(conversation, dict):
        for message in conversation.get("mensagens") or []:
            if str(message.get("id") or "") != payload.mensagem_id:
                continue
            reactions = [item for item in (message.get("reacoes") or []) if isinstance(item, dict)]
            reactions = [item for item in reactions if not item.get("fromMe")]
            if payload.emoji:
                reactions.append({"emoji": payload.emoji, "count": 1, "fromMe": True, "senders": []})
            message["reacoes"] = reactions
            await save_conversations(db, resolved_user_id)
            break
    return {"status": "reagido", "emoji": payload.emoji}


@router.post("/api/chat/apagar-mensagem")
async def apagar_mensagem(payload: ApagarMensagemPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    result = await whatsapp_service.delete(
        resolved_user_id,
        f"/messages/{quote(payload.mensagem_id, safe='')}",
        {"chatId": payload.conversa_id, "onlyLocal": not payload.para_todos},
        timeout=35.0,
    )
    if not isinstance(result, dict) or result.get("deleted") is not True:
        raise HTTPException(status_code=502, detail="O WhatsApp recusou a exclusao da mensagem.")
    sucesso = await delete_message(payload.conversa_id, payload.mensagem_id, resolved_user_id)
    if sucesso:
        return {"status": "sucesso"}
    raise HTTPException(status_code=404, detail="Mensagem ou conversa nao encontrada.")


@router.delete("/api/chat/conversas/{conversa_id}")
async def excluir_conversa(
    conversa_id: str,
    user_id: str | None = Query(default=None, deprecated=True),
    user: dict[str, Any] = Depends(current_user),
):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    result = await whatsapp_service.delete(
        resolved_user_id,
        f"/chats/{quote(conversa_id, safe='')}",
        timeout=35.0,
    )
    if not isinstance(result, dict) or result.get("deleted") is not True:
        raise HTTPException(status_code=502, detail="O WhatsApp recusou a exclusao da conversa.")
    sucesso = await delete_conversation(conversa_id, resolved_user_id)
    if sucesso:
        return {"status": "sucesso", "user_id": resolved_user_id}
    raise HTTPException(status_code=404, detail="Conversa nao encontrada.")


@router.patch("/api/chat/modificar")
async def modificar_chat(payload: ModificarChatPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    if payload.acao == "lida" and payload.valor is True:
        await whatsapp_service.post(
            resolved_user_id,
            f"/chats/{quote(payload.conversa_id, safe='')}/read",
            {},
            timeout=20.0,
        )
    sucesso = await modify_conversation(payload.conversa_id, payload.acao, payload.valor, resolved_user_id)
    return {"status": "sucesso" if sucesso else "not_found"}


@router.patch("/api/chat/favoritar")
async def favoritar_chat(payload: FavoritarChatPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    sucesso = await modify_conversation(payload.conversa_id, "favorita", payload.valor, tenant_id(user))
    return {"status": "sucesso" if sucesso else "not_found"}


def current_clock() -> tuple[str, int]:
    agora = datetime.now(BRAZIL_TZ)
    return agora.strftime("%H:%M"), int(agora.timestamp())


def format_whatsapp_time(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, tz=BRAZIL_TZ).strftime("%H:%M")


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

    normalized_mime = mime_type.split(";", 1)[0].strip().lower()
    if normalized_mime.startswith("image/"):
        allowed_image_types = {"image/png", "image/jpeg", "image/gif", "image/webp"}
        if normalized_mime not in allowed_image_types:
            raise HTTPException(status_code=415, detail="Use imagens PNG, JPEG, GIF ou WebP.")
        valid_signature = (
            (normalized_mime == "image/png" and file_bytes.startswith(b"\x89PNG\r\n\x1a\n"))
            or (normalized_mime == "image/jpeg" and file_bytes.startswith(b"\xff\xd8\xff"))
            or (normalized_mime == "image/gif" and file_bytes.startswith((b"GIF87a", b"GIF89a")))
            or (
                normalized_mime == "image/webp"
                and file_bytes.startswith(b"RIFF")
                and file_bytes[8:12] == b"WEBP"
            )
        )
        if not valid_signature:
            raise HTTPException(status_code=415, detail="Conteudo da imagem nao corresponde ao formato declarado.")

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


def parse_whatsapp_collection(payload: Any) -> list[Dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("data", "contacts", "chats", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def normalize_whatsapp_timestamp(value: Any) -> int:
    try:
        timestamp = int(float(value or 0))
    except (TypeError, ValueError):
        return 0
    return timestamp // 1000 if timestamp > 10_000_000_000 else timestamp


def sync_catalog_messages(conversation: Dict[str, Any], chat: Dict[str, Any]) -> bool:
    changed = False
    existing_messages = conversation.setdefault("mensagens", [])
    existing_ids = {str(item.get("id") or "") for item in existing_messages if isinstance(item, dict)}
    raw_messages = chat.get("messages") if isinstance(chat.get("messages"), list) else []
    type_map = {
        "audio": "audio",
        "ptt": "audio",
        "image": "midia",
        "video": "midia",
        "document": "documento",
        "sticker": "sticker",
    }
    labels = {
        "audio": "[Audio]",
        "ptt": "[Audio]",
        "image": "[Imagem]",
        "video": "[Video]",
        "document": "[Documento]",
        "sticker": "[Figurinha]",
    }
    for raw_message in sorted(
        (item for item in raw_messages if isinstance(item, dict)),
        key=lambda item: normalize_whatsapp_timestamp(item.get("timestamp")),
    ):
        timestamp = normalize_whatsapp_timestamp(raw_message.get("timestamp"))
        message_id = str(raw_message.get("id") or "").strip()
        if not message_id or not timestamp:
            continue
        existing_message = next(
            (
                item for item in existing_messages
                if isinstance(item, dict) and str(item.get("id") or "") == message_id
            ),
            None,
        )
        if message_id in existing_ids:
            existing_messages[:] = [
                existing for existing in existing_messages
                if str(existing.get("id") or "") != message_id
            ]
            existing_ids.discard(message_id)
            changed = True
        raw_type = str(raw_message.get("type") or "chat").lower()
        content = str(raw_message.get("content") or labels.get(raw_type) or "")
        chat_id = str(chat.get("id") or chat.get("phone") or chat.get("jid") or "") or None
        existing_media_url = str((existing_message or {}).get("arquivoUrl") or "")
        preserved_local_media_url = (
            existing_media_url
            if "/api/chat/uploads/" in existing_media_url
            else None
        )
        existing_messages.append(
            normalize_message(
                {
                    "id": message_id,
                    "remetente": "usuario" if raw_message.get("fromMe") else "contato",
                    "remetenteNome": raw_message.get("senderName"),
                    "remetenteId": raw_message.get("senderId"),
                    "texto": content,
                    "tipo": type_map.get(raw_type, "texto"),
                    "arquivoUrl": preserved_local_media_url or (whatsapp_media_url(message_id, chat_id) if raw_type in type_map and raw_type != "chat" else None),
                    "arquivoMime": raw_message.get("mimetype") or (existing_message or {}).get("arquivoMime"),
                    "nomeArquivo": raw_message.get("filename") or (existing_message or {}).get("nomeArquivo") or default_file_name(type_map.get(raw_type, "texto"), raw_message.get("mimetype")),
                    "duracaoAudio": raw_message.get("duration") or (existing_message or {}).get("duracaoAudio"),
                    "horario": format_whatsapp_time(timestamp),
                    "timestamp": timestamp,
                    "status": raw_message.get("status") if raw_message.get("fromMe") else None,
                    "reacoes": raw_message.get("reactions") or [],
                    "citada": raw_message.get("quoted"),
                    "canal": "whatsapp",
                    "channel": "whatsapp",
                },
                "whatsapp",
            )
        )
        existing_ids.add(message_id)
        changed = True

    existing_messages.sort(key=lambda item: int(item.get("timestamp") or 0))
    conversation["mensagens"] = existing_messages[-250:]
    latest_timestamp = normalize_whatsapp_timestamp(chat.get("timestamp"))
    latest_text = str(chat.get("lastMessage") or "")
    if conversation["mensagens"]:
        latest_message = conversation["mensagens"][-1]
        latest_timestamp = max(latest_timestamp, int(latest_message.get("timestamp") or 0))
        latest_text = str(latest_message.get("texto") or latest_text)
    if latest_timestamp and latest_timestamp != int(conversation.get("timestampUltimaMsg") or 0):
        conversation["timestampUltimaMsg"] = latest_timestamp
        conversation["horario"] = format_whatsapp_time(latest_timestamp)
        changed = True
    if latest_text and latest_text != conversation.get("ultimoTexto"):
        conversation["ultimoTexto"] = latest_text
        changed = True
    if conversation["mensagens"]:
        latest_message = conversation["mensagens"][-1]
        latest_is_mine = latest_message.get("remetente") == "usuario"
        latest_status = latest_message.get("status") if latest_is_mine else None
        latest_sender = latest_message.get("remetenteNome") if not latest_is_mine else None
        if conversation.get("ultimaMensagemMinha") != latest_is_mine:
            conversation["ultimaMensagemMinha"] = latest_is_mine
            changed = True
        if conversation.get("statusUltimaMensagem") != latest_status:
            conversation["statusUltimaMensagem"] = latest_status
            changed = True
        if conversation.get("ultimoRemetenteNome") != latest_sender:
            conversation["ultimoRemetenteNome"] = latest_sender
            changed = True
    if not latest_timestamp and not conversation["mensagens"] and conversation.get("ultimoTexto") in {"Sincronizado", "[Mensagem]", "Mensagem"}:
        conversation["ultimoTexto"] = ""
        conversation["horario"] = ""
        conversation["timestampUltimaMsg"] = 0
        changed = True
    unread_count = max(0, int(chat.get("unreadCount") or 0))
    if unread_count != int(conversation.get("naoLidasCount") or 0):
        conversation["naoLidasCount"] = unread_count
        conversation["lida"] = unread_count == 0
        changed = True
    return changed


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
            "verifiedName": contato.get("verifiedName"),
            "bioRecado": contato.get("bio") or contato.get("status"),
            "isBusiness": bool(contato.get("isBusiness")),
            "isMyContact": bool(contato.get("isMyContact")),
            "isBlocked": bool(contato.get("isBlocked")),
        }

    return nomes, fotos, metadata


def extract_message_payload(
    data: Dict[str, Any],
    message_id: str | None = None,
    conversa_id: str | None = None,
) -> Dict[str, Any]:
    raw_type = str(data.get("type") or "").lower()
    flat_media_types = {
        "audio": ("audio", "[Audio]"),
        "ptt": ("audio", "[Audio]"),
        "sticker": ("sticker", "[Figurinha]"),
        "image": ("midia", "[Imagem]"),
        "video": ("midia", "[Video]"),
        "document": ("documento", "[Documento]"),
    }
    if raw_type in flat_media_types:
        tipo, label = flat_media_types[raw_type]
        return {
            "texto": str(data.get("caption") or label),
            "tipo": tipo,
            "arquivoUrl": whatsapp_media_url(message_id, conversa_id) if message_id else None,
            "arquivoMime": data.get("mimetype"),
            "duracaoAudio": data.get("duration"),
            "nomeArquivo": data.get("filename") or default_file_name(tipo, data.get("mimetype")),
        }

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


def whatsapp_media_url(message_id: str, conversa_id: str | None = None) -> str:
    path = f"/api/chat/midia/{quote(message_id, safe='')}"
    if conversa_id:
        path += f"?conversa_id={quote(conversa_id, safe='')}"
    return public_api_url(path)


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


def should_try_profile_picture(user_id: str, phone: str) -> bool:
    now = int(datetime.now().timestamp())
    cache_key = f"{user_id}:{phone}"
    last_try = profile_photo_attempt_cache.get(cache_key, 0)
    if now - last_try < 900:
        return False
    profile_photo_attempt_cache[cache_key] = now
    return True


async def fetch_profile_picture(user_id: str, phone: str) -> str | None:
    query_phone = normalize_profile_phone(phone)
    try:
        data = await whatsapp_service.get(
            user_id,
            f"/contacts/{quote(query_phone, safe='')}/profile-picture",
            timeout=8.0,
        )
        if isinstance(data, dict):
            return data.get("profilePictureUrl") or data.get("photoUrl") or data.get("link") or data.get("value")
    except Exception:
        logger.exception("Falha ao buscar foto de perfil WhatsApp.")
    return None


async def fetch_group_metadata(user_id: str, phone: str) -> Dict[str, Any] | None:
    group_id = phone.strip()
    try:
        data = await whatsapp_service.get(
            user_id,
            f"/groups/{quote(group_id, safe='')}",
            timeout=8.0,
        )
        if not isinstance(data, dict) or data.get("error"):
            return None
        return {
            "nome": data.get("subject") or data.get("name"),
            "descricaoGrupo": data.get("description") or "",
            "participantes": data.get("participants") or [],
            "criadoPor": data.get("owner"),
            "criadoEm": data.get("createdAt"),
            "photoUrl": extract_photo_url(data),
        }
    except Exception:
        logger.exception("Falha ao buscar metadados de grupo WhatsApp.")
    return None
