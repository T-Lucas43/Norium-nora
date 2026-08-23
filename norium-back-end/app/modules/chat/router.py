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
import shutil
import subprocess
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
from app.services.wapi_connect import WapiConnectService, ConsentRequiredError
from app.services.wapi_messaging import WapiMessagingService, MessagingUnavailable
from app.services.wapi_client import WapiError, WapiClient
from app.services import wapi_binding as wb
from app.services import wapi_webhook

router = APIRouter()
logger = logging.getLogger(__name__)
webhook_debug_logger = logging.getLogger(f"{__name__}.wapi_webhook_debug")

# Backend de WhatsApp totalmente via W-API (conexão, mensagens, webhooks,
# conversas/contatos/grupos). O serviço legado foi removido.
wapi_connect = WapiConnectService()
wapi_messaging = WapiMessagingService()
wapi_client = WapiClient()


def _messaging_http_error(exc: Exception, default_detail: str) -> HTTPException:
    if isinstance(exc, MessagingUnavailable):
        return HTTPException(status_code=409, detail="WhatsApp nao esta conectado nesta conta.")
    # A W-API responde 403 "Acesso negado" para recursos fora do plano contratado
    # (ex.: reacoes e figurinhas no LITE). Sinaliza de forma clara em vez de 502.
    if isinstance(exc, WapiError) and (exc.status == 403 or "acesso negado" in str(exc.message or "").lower()):
        return HTTPException(status_code=501, detail="Recurso indisponivel no plano atual da W-API.")
    return HTTPException(status_code=502, detail=default_detail)

status_conexoes: Dict[str, Dict[str, Dict[str, Any]]] = {}
WAPI_WEBHOOK_SECRET = os.getenv("WAPI_WEBHOOK_SECRET", "").strip()
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
# Diagnóstico temporário: quando ligado, loga um retrato REDIGIDO de cada webhook
# (estrutura + campos de status; sem texto de mensagem e com telefones mascarados)
# para mapear os campos reais da W-API (status/visto e mensagens fromMe). Desligar
# após capturar (env WHATSAPP_WEBHOOK_DEBUG).
WHATSAPP_WEBHOOK_DEBUG = os.getenv("WHATSAPP_WEBHOOK_DEBUG", "").strip().lower() in {"1", "true", "yes"}
if WHATSAPP_WEBHOOK_DEBUG:
    # Um logger dedicado permite emitir o diagnóstico em INFO mesmo quando o
    # logger geral da aplicação permanece em WARNING.
    webhook_debug_logger.setLevel(logging.INFO)
BRAZIL_TZ = ZoneInfo("America/Sao_Paulo")


def _mask_id(value: Any) -> str | None:
    """Remove o identificador local e preserva apenas o tipo de JID."""
    s = str(value or "").strip()
    if not s:
        return None
    _, sep, suffix = s.partition("@")
    return "***" + (f"@{suffix}" if sep else "")


def _debug_token(value: Any) -> str | int | float | bool | None:
    """Mantém somente escalares curtos com formato de enum; redige o restante."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", value):
        return value
    return f"<{type(value).__name__}:redacted>"


def _debug_keys(value: Dict[Any, Any]) -> list[str]:
    """Expõe apenas nomes de campos com formato estrutural seguro."""
    return sorted(
        str(key) if isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", key) else "<redacted-key>"
        for key in value
    )


def _webhook_debug_snapshot(data: Dict[str, Any], kind: str) -> Dict[str, Any]:
    """Retrato seguro do webhook para diagnóstico: nenhum texto de mensagem, telefones mascarados."""
    sender = data.get("sender") if isinstance(data.get("sender"), dict) else {}
    chat = data.get("chat") if isinstance(data.get("chat"), dict) else {}
    content = data.get("msgContent") if isinstance(data.get("msgContent"), dict) else None
    return {
        "classifiedAs": kind,
        "event": _debug_token(data.get("event") or data.get("type")),
        "topKeys": _debug_keys(data),
        "fromMe": data.get("fromMe") if isinstance(data.get("fromMe"), bool) else None,
        "isGroup": data.get("isGroup") if isinstance(data.get("isGroup"), bool) else None,
        "chatIdMasked": _mask_id(data.get("chatId") or data.get("phone") or chat.get("id")),
        "senderIdMasked": _mask_id(sender.get("id") or data.get("senderId")),
        "senderLidMasked": _mask_id(sender.get("senderLid") or sender.get("lid")),
        "hasPushName": bool(sender.get("pushName") or data.get("pushName")),
        "msgContentKeys": _debug_keys(content) if content else None,
        # Campos candidatos a status/visto, limitados a escalares tipo enum.
        "status": _debug_token(data.get("status")),
        "ack": _debug_token(data.get("ack")),
        "state": _debug_token(data.get("state")),
    }
UPLOAD_DIR = get_data_root() / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD_BYTES = 14 * 1024 * 1024


class InicializarLoginPayload(StrictModel):
    user_id: str | None = Field(default=None, min_length=1)
    canal: Literal["whatsapp"]


class ConsentimentoPayload(StrictModel):
    aceito: bool
    versao: str | None = Field(default=None, min_length=1, max_length=32)


class EnviarMensagemPayload(StrictModel):
    user_id: str | None = Field(default=None, min_length=1)
    conversa_id: str = Field(min_length=1)
    canal: Literal["whatsapp"] = "whatsapp"
    texto: str = Field(min_length=1)
    responder_a: str | None = Field(default=None, min_length=1, max_length=128)


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


def wapi_creds(user_id: str) -> tuple[str, str] | None:
    """Credenciais (instanceId, token) da instancia vinculada, ou None."""
    binding = wb.get_binding(user_id)
    return (binding.instance_id, binding.token) if binding.exists else None


def transcode_audio_to_ogg(audio_bytes: bytes) -> bytes | None:
    """Converte áudio (ex.: webm/opus do navegador) para ogg/opus via ffmpeg.

    A W-API rejeita webm; ogg/opus é o formato de voz do WhatsApp. Retorna None
    se o ffmpeg não existir ou a conversão falhar (o chamador envia o original).
    """
    if not audio_bytes or not shutil.which("ffmpeg"):
        return None
    try:
        proc = subprocess.run(  # nosec B603 B607
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                "-vn", "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1",
                "-f", "ogg", "pipe:1",
            ],
            input=audio_bytes,
            capture_output=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        logger.warning("Falha ao executar ffmpeg para transcodificar audio.")
        return None
    if proc.returncode != 0 or not proc.stdout:
        logger.warning("ffmpeg retornou rc=%s ao transcodificar audio.", proc.returncode)
        return None
    return proc.stdout


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
    base = urlparse(wapi_client.config.base_url)
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


def _whatsapp_connection_shape(result: dict[str, Any]) -> dict[str, Any]:
    """Normaliza o estado do WapiConnectService para o formato do frontend."""
    status = result.get("status")
    return {
        "conectado": status == "conectado",
        "qrcode": None if status == "conectado" else result.get("qrcode"),
        "status": status,
        "state": result.get("state"),
        "detail": result.get("detail"),
        "numero": result.get("numero"),
        "conectadoEm": result.get("conectadoEm"),
        "consentRequired": bool(result.get("consentRequired")),
    }


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
        resultado = await wapi_connect.status(resolved_user_id)
        user_status["whatsapp"] = _whatsapp_connection_shape(resultado)
    except Exception:
        user_status["whatsapp"] = {
            "conectado": False,
            "qrcode": None,
            "status": "indisponivel",
            "disponivel": False,
        }
        logger.exception("Falha ao sincronizar status WhatsApp.")
    return user_status


@router.get("/api/chat/consentimento")
async def obter_consentimento(user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    return wapi_connect.consent_terms(resolved_user_id)


@router.post("/api/chat/consentimento")
async def registrar_consentimento(
    payload: ConsentimentoPayload,
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    if not payload.aceito:
        raise HTTPException(
            status_code=400,
            detail="E necessario aceitar as orientacoes de uso responsavel antes de continuar.",
        )
    terms = wapi_connect.consent_terms(resolved_user_id)
    if payload.versao and payload.versao != terms.get("termVersion"):
        raise HTTPException(
            status_code=409,
            detail="A versao dos termos mudou. Recarregue a pagina e aceite novamente.",
        )
    return wapi_connect.accept_consent(resolved_user_id, origin="chat_whatsapp")


@router.post("/api/chat/inicializar-login")
async def inicializar_login(payload: InicializarLoginPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, payload.canal)
    user_status = connection_status(resolved_user_id)
    try:
        resultado = await wapi_connect.start(resolved_user_id)
    except ConsentRequiredError as exc:
        # Bloqueia a geração do QR sem aceite, inclusive por chamada direta.
        raise HTTPException(
            status_code=403,
            detail={"code": "consent_required", "message": str(exc)},
        ) from exc
    status = resultado.get("status")
    user_status["whatsapp"]["conectado"] = status == "conectado"
    if status in {"conectado", "aguardando_qrcode", "iniciando"}:
        return {"status": status, "qrcode": None if status == "conectado" else resultado.get("qrcode")}
    raise HTTPException(status_code=503, detail="API do WhatsApp ainda nao esta disponivel.")


@router.post("/api/chat/desconectar")
async def desconectar_whatsapp(user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    # Desconexão LOCAL: remove o WhatsApp apenas do Norium, SEM chamar o
    # /instance/disconnect da W-API — esse endpoint desloga a conta inteira e
    # derruba o celular e os demais aparelhos. Aqui limpamos só o vínculo e o
    # cache locais; os outros dispositivos do usuário permanecem conectados.
    wb.clear_binding(resolved_user_id)
    await save_conversations({}, resolved_user_id)
    await save_whatsapp_catalog_cache(resolved_user_id, {})
    status_conexoes.pop(resolved_user_id, None)
    return {"status": "desconectado"}


@router.post("/api/whatsapp/webhook")
async def webhook_whatsapp(
    data: Dict[str, Any] = Body(...),
    # Headers do contrato legado mantidos (opcionais, ignorados) para preservar
    # o contrato publico congelado durante a migracao para a W-API.
    x_whatsapp_webhook_secret: str | None = Header(default=None),
    x_norium_timestamp: str | None = Header(default=None),
    x_norium_signature: str | None = Header(default=None),
    x_norium_event_id: str | None = Header(default=None),
    request: Request = None,
):
    # 1) Autenticacao: segredo compartilhado via query (?secret=) ou header.
    #    A URL registrada na W-API leva o segredo, entao chega em toda chamada.
    supplied_secret = ""
    if request is not None:
        supplied_secret = str(
            request.query_params.get("secret") or request.headers.get("x-wapi-webhook-secret") or ""
        )
    if not WAPI_WEBHOOK_SECRET:
        if os.getenv("ENVIRONMENT", "development").strip().lower() == "production":
            raise HTTPException(status_code=503, detail="Webhook WhatsApp indisponivel ate a configuracao segura.")
    elif not secrets.compare_digest(supplied_secret, WAPI_WEBHOOK_SECRET):
        raise HTTPException(status_code=403, detail="Webhook WhatsApp nao autorizado.")

    # 2) Dono resolvido pela instancia (mapa seguro). Nunca confia em userId do payload.
    instance_id = str(data.get("instanceId") or data.get("instanceID") or "").strip()
    owner_user_id = wb.owner_of_instance(instance_id) if instance_id else None
    if not owner_user_id:
        # Nao revela a existencia de instancias de terceiros.
        raise HTTPException(status_code=404, detail="Evento nao reconhecido.")

    # 3) Deduplicacao por (tipo de evento + id). Recebido e status compartilham o
    #    messageId, entao a chave inclui o tipo para nao descartar o status.
    kind = wapi_webhook.classify_event(data)
    if WHATSAPP_WEBHOOK_DEBUG:
        try:
            webhook_debug_logger.info("WAPI_WEBHOOK_DEBUG %r", _webhook_debug_snapshot(data, kind))
        except Exception:  # diagnóstico nunca pode quebrar o webhook
            webhook_debug_logger.info("WAPI_WEBHOOK_DEBUG <falha ao serializar>")
    now = time.time()
    for expired in [eid for eid, expires_at in whatsapp_webhook_event_cache.items() if expires_at <= now]:
        whatsapp_webhook_event_cache.pop(expired, None)
    raw_id = wapi_webhook.event_id(data)
    if raw_id:
        dedup_id = f"{kind}:{raw_id}"
        if dedup_id in whatsapp_webhook_event_cache:
            return {"status": "duplicate"}
        whatsapp_webhook_event_cache[dedup_id] = now + 600

    # 4) Dispatch por tipo de evento.
    try:
        if kind == wapi_webhook.EVENT_RECEIVED:
            return await _wapi_handle_received(owner_user_id, data)
        if kind == wapi_webhook.EVENT_STATUS:
            return await _wapi_handle_status(owner_user_id, data)
        if kind in (wapi_webhook.EVENT_CONNECTED, wapi_webhook.EVENT_DISCONNECTED):
            return _wapi_handle_connection(owner_user_id, kind)
        return {"status": "ignored", "event": kind}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Falha ao processar webhook W-API.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao processar webhook.")


async def _wapi_apply_reaction(user_id: str, msg: Dict[str, Any]) -> Dict[str, Any]:
    """Reação recebida: atualiza a mensagem alvo em vez de criar uma mensagem."""
    target_id = str(msg.get("reactionTargetId") or "")
    if not target_id:
        return {"status": "ignored", "event": "reaction"}
    emoji = msg.get("texto") or ""
    db = await load_conversations(user_id)
    conversation = db.get(msg["chatId"])
    candidates = [conversation] if isinstance(conversation, dict) else list(db.values())
    for conv in candidates:
        if not isinstance(conv, dict):
            continue
        for stored in conv.get("mensagens") or []:
            if str(stored.get("id") or "") != target_id:
                continue
            # Preserva a reação do próprio usuário (fromMe); substitui a do contato.
            reactions = [r for r in (stored.get("reacoes") or []) if isinstance(r, dict) and r.get("fromMe")]
            if emoji:
                reactions.append({"emoji": emoji, "count": 1, "fromMe": False, "senders": []})
            stored["reacoes"] = reactions
            await save_conversations(db, user_id)
            return {"status": "success", "event": "reaction"}
    return {"status": "ignored", "event": "reaction"}


async def _wapi_handle_received(user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    msg = wapi_webhook.adapt_incoming(data)
    if not msg:
        return {"status": "ignored"}
    if msg.get("tipo") == "reaction":
        return await _wapi_apply_reaction(user_id, msg)
    phone = msg["chatId"]
    _, current_ts = current_clock()
    timestamp = msg["timestamp"] or current_ts
    hora = format_whatsapp_time(timestamp)
    message_id = msg["messageId"] or f"msg_{timestamp}_{uuid.uuid4().hex[:8]}"
    is_from_me = msg["fromMe"]

    db = await load_conversations(user_id)
    # Numa conversa nova aberta por uma msg fromMe (você enviou primeiro, inclusive
    # pelo celular), o "sender" é você — não use isso como nome do contato.
    contato_inicial = phone if is_from_me else (msg["chatName"] or phone)
    conversa = db.get(phone) or new_conversation(
        phone, contato=contato_inicial, channel="whatsapp", is_group=msg["isGroup"]
    )
    mensagens = conversa.setdefault("mensagens", [])
    if any(str(item.get("id") or "") == message_id for item in mensagens):
        return {"status": "duplicate"}

    # Em grupos, nome/foto vêm dos metadados do próprio grupo e são seguros mesmo
    # quando a mensagem é fromMe. Em chats diretos, o remetente de uma fromMe é o
    # usuário — nunca deve substituir a identidade do contato.
    if msg["isGroup"]:
        nome_atual = conversa.get("contato")
        if not nome_atual or nome_atual == phone:
            grupo = await fetch_group_metadata(user_id, phone)
            conversa["contato"] = (grupo or {}).get("nome") or nome_atual or phone
            group_photo = (grupo or {}).get("photoUrl")
            if group_photo:
                conversa["photoUrl"] = group_photo
                conversa.setdefault("metadados", {})["photoUrl"] = group_photo
    elif not is_from_me:
        if msg["chatName"]:
            conversa["contato"] = melhor_nome_contato(conversa.get("contato"), msg["chatName"], phone)
        if msg.get("photoUrl"):
            conversa["photoUrl"] = msg["photoUrl"]
            conversa.setdefault("metadados", {})["photoUrl"] = msg["photoUrl"]
        elif not conversa.get("photoUrl") and should_try_profile_picture(user_id, phone):
            # O webhook não traz foto; busca via profile-picture (uma vez, com cache).
            foto = await fetch_profile_picture(user_id, phone)
            if foto:
                conversa["photoUrl"] = foto
                conversa.setdefault("metadados", {})["photoUrl"] = foto
    conversa["canal"] = "whatsapp"
    conversa["channel"] = "whatsapp"
    conversa["esGrupo"] = msg["isGroup"]
    conversa["ultimoTexto"] = msg["texto"]
    conversa["horario"] = hora
    conversa["timestampUltimaMsg"] = timestamp
    conversa["ultimaMensagemMinha"] = is_from_me
    conversa["ultimoRemetenteNome"] = msg["senderName"] if msg["isGroup"] and not is_from_me else None
    if is_from_me:
        conversa["lida"] = True
    else:
        conversa["lida"] = False
        conversa["naoLidasCount"] = int(conversa.get("naoLidasCount") or 0) + 1

    mensagens.append(
        normalize_message(
            {
                "id": message_id,
                "remetente": "usuario" if is_from_me else "contato",
                "remetenteNome": msg["senderName"] if msg["isGroup"] and not is_from_me else None,
                "remetenteId": msg.get("senderId"),
                "texto": msg["texto"],
                "tipo": msg["tipo"],
                "midiaMeta": msg.get("midiaMeta"),
                "arquivoUrl": whatsapp_media_url(message_id, phone) if msg.get("midiaMeta") else None,
                "arquivoMime": (msg.get("midiaMeta") or {}).get("mimetype"),
                "horario": hora,
                "timestamp": timestamp,
                "status": msg.get("status") if is_from_me else None,
                "canal": "whatsapp",
                "channel": "whatsapp",
            },
            "whatsapp",
        )
    )
    conversa["mensagens"] = conversa["mensagens"][-250:]
    db[phone] = normalize_conversation(phone, conversa)
    await save_conversations(db, user_id)
    await record_event(
        source="whatsapp",
        title="Nova mensagem no WhatsApp" if not is_from_me else "Mensagem enviada no WhatsApp",
        description=f"{msg['chatName']}: {msg['texto'] or '[sem texto]'}",
        metadata={
            "conversaId": phone,
            "messageId": message_id,
            "channel": "whatsapp",
            "isGroup": msg["isGroup"],
            "fromMe": is_from_me,
            "userId": user_id,
        },
    )
    return {"status": "success"}


async def _wapi_handle_status(user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    message_id, status = wapi_webhook.extract_status_update(data)
    if not message_id or not status:
        return {"status": "ignored"}
    db = await load_conversations(user_id)
    changed = False
    for conversation in db.values():
        if not isinstance(conversation, dict):
            continue
        for stored_message in conversation.get("mensagens") or []:
            if str(stored_message.get("id") or "") == message_id:
                stored_message["status"] = status
                changed = True
                break
        if changed:
            break
    if changed:
        await save_conversations(db, user_id)
    return {"status": "success" if changed else "ignored"}


def _wapi_handle_connection(user_id: str, kind: str) -> Dict[str, Any]:
    binding = wb.get_binding(user_id)
    if binding.exists:
        if kind == wapi_webhook.EVENT_CONNECTED:
            previous_state = binding.state
            binding.state = "connected"
            if previous_state != "connected" or binding.connected_at is None:
                binding.connected_at = time.time()
        else:
            binding.state = "disconnected"
            binding.connected_at = None
        wb.save_binding(user_id, binding)
    return {"status": "success", "event": kind}


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
    # Remove também conversas de Status já persistidas por versões anteriores.
    status_conversation_ids = [
        conversation_id
        for conversation_id in db
        if wapi_webhook.is_status_broadcast({"chatId": conversation_id})
    ]
    if status_conversation_ids:
        for conversation_id in status_conversation_ids:
            db.pop(conversation_id, None)
        await save_conversations(db, resolved_user_id)
    catalog_cache = await load_whatsapp_catalog_cache(resolved_user_id)
    whatsapp_status = await wapi_connect.status(resolved_user_id)
    if whatsapp_status.get("status") != "conectado":
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

    creds = wapi_creds(resolved_user_id)

    async def _remote_catalog(kind: str) -> list[Dict[str, Any]] | None:
        # Lista remota paginada (fetch-chats/contacts vem em páginas de ~10).
        # [] em sucesso vazio; None quando indisponivel (sem instancia, erro, ou
        # "Acesso negado" no LITE). Nunca apaga o cache.
        if not creds:
            return None
        instance_id, token = creds
        fetch = wapi_client.fetch_chats if kind == "chats" else wapi_client.fetch_contacts
        combined: list[Dict[str, Any]] = []
        for page in range(1, 6):  # até 5 páginas
            try:
                data = await fetch(instance_id, token, page=page)
            except WapiError:
                return combined if page > 1 else None
            if isinstance(data, list):
                combined.extend(data)
                break
            if not isinstance(data, dict):
                break
            items = next((data[k] for k in (kind, "items", "data") if isinstance(data.get(k), list)), None)
            if not items:
                break
            combined.extend(items)
            total_pages = data.get("totalPages")
            if not isinstance(total_pages, int) or page >= total_pages:
                break
        return combined

    try:
        res_chats, res_contacts = await asyncio.gather(_remote_catalog("chats"), _remote_catalog("contacts"))

        contacts = parse_whatsapp_collection(res_contacts) if res_contacts is not None else []
        chats = parse_whatsapp_collection(res_chats) if res_chats is not None else []
        remote_catalog_loaded = res_chats is not None
        remote_contacts_loaded = res_contacts is not None

        # O catalogo remoto e paginado/limitado. A ausencia de um chat nesse
        # lote nao significa exclusao no WhatsApp e nunca deve apagar o cache
        # duravel do usuario; exclusoes so acontecem pela rota explicita.

        nomes, fotos, metadata = build_contact_indexes(contacts)

        missing_photo_count = 0
        group_metadata_count = 0
        for chat in chats[:500]:
            if wapi_webhook.is_status_broadcast(chat):
                continue
            phone = chat.get("phone") or chat.get("id") or chat.get("jid")
            if not phone:
                continue

            phone = str(phone)
            # W-API fetch-chats traz "lastMessageTime" (sem mensagens). Usa como
            # timestamp da conversa para não ser filtrada pelo corte de recência.
            last_ts = chat.get("lastMessageTime") or chat.get("timestamp") or 0
            try:
                last_ts = int(last_ts)
                if last_ts > 1_000_000_000_000:  # milissegundos → segundos
                    last_ts //= 1000
            except (TypeError, ValueError):
                last_ts = 0
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
                if last_ts:
                    db[phone]["timestampUltimaMsg"] = last_ts
                    db[phone]["horario"] = format_whatsapp_time(last_ts)
                db[phone] = normalize_conversation(phone, db[phone])
                changed = True
            else:
                conversa = db[phone]
                # Não rebaixa um nome real já existente (ex.: pushName de webhook)
                # para o id cru quando o catálogo não resolveu o nome (@lid).
                conversa["contato"] = melhor_nome_contato(conversa.get("contato"), str(nome_final), phone)
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
                if last_ts:
                    conversa["timestampUltimaMsg"] = max(int(conversa.get("timestampUltimaMsg") or 0), last_ts)
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
    # A W-API nao expoe endpoint de historico de mensagens: o historico e
    # construido pelo store alimentado pelos webhooks. Servimos o que ja temos,
    # paginado por ``before``/``limit``.
    conversation = db.get(conversa_id) or new_conversation(conversa_id, channel="whatsapp")
    todas = sorted(
        (m for m in (conversation.get("mensagens") or []) if isinstance(m, dict)),
        key=lambda m: int(m.get("timestamp") or 0),
    )
    if before:
        todas = [m for m in todas if int(m.get("timestamp") or 0) < int(before)]
    page = todas[-limit:]
    return {
        "items": page,
        "cursor": min((int(m.get("timestamp") or 0) for m in page), default=None),
        "hasMore": len(todas) > len(page),
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
    creds = wapi_creds(resolved_user_id)
    details = None
    # Grupos: metadados via W-API. Contatos: sem endpoint de detalhe disponivel
    # no plano atual; degrada para o cache local (foto vem do catalogo/webhook).
    if creds and is_group_chat(conversa_id, conversation):
        try:
            details = await wapi_client.group_metadata(creds[0], creds[1], conversa_id)
        except WapiError:
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

    # A W-API baixa midia por metadados (mediaKey/directPath/type/mimetype) que
    # chegam no webhook de recebimento e ficam salvos em ``midiaMeta`` da mensagem.
    creds = wapi_creds(resolved_user_id)
    media_meta: Dict[str, Any] | None = None
    if resolved_conversation_id:
        db = await load_conversations(resolved_user_id)
        conversation = db.get(resolved_conversation_id) or {}
        for item in conversation.get("mensagens") or []:
            if str(item.get("id") or "") == message_id and isinstance(item.get("midiaMeta"), dict):
                media_meta = item["midiaMeta"]
                break
    if not creds or not media_meta:
        raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.")
    try:
        payload = await wapi_client.download_media(
            creds[0], creds[1],
            media_key=str(media_meta.get("mediaKey") or ""),
            direct_path=str(media_meta.get("directPath") or ""),
            media_type=str(media_meta.get("type") or ""),
            mimetype=str(media_meta.get("mimetype") or ""),
        )
    except WapiError as exc:
        raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.") from exc
    inline = link = None
    if isinstance(payload, dict):
        inline = payload.get("data") or payload.get("base64") or payload.get("media")
        link = payload.get("fileLink") or payload.get("url") or payload.get("link")
    fallback_mime = str(media_meta.get("mimetype") or "application/octet-stream")
    if isinstance(inline, str) and inline:
        # base64 / data URI
        file_bytes, mime_type = decode_data_url(inline, fallback_mime)
    elif isinstance(link, str) and link.startswith("https://"):
        # A W-API entrega a midia decriptada por uma URL temporaria (fileLink).
        async with httpx.AsyncClient(follow_redirects=True) as media_client:
            res_link = await media_client.get(link, timeout=60.0)
        if res_link.status_code != 200:
            raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.")
        file_bytes = res_link.content
        mime_type = res_link.headers.get("Content-Type", fallback_mime)
    else:
        raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.")
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
    try:
        result = await wapi_messaging.create_group(tenant_id(user), payload.nome, payload.participantes)
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "A API do WhatsApp nao conseguiu criar o grupo.") from exc
    return {"status": "criado", "group": result}


@router.post("/api/chat/encaminhar")
async def encaminhar_mensagens(payload: EncaminharMensagensPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    # A W-API nao expoe um endpoint de encaminhamento na documentacao oficial.
    # Em vez de simular sucesso, declara a indisponibilidade de forma explicita.
    raise HTTPException(
        status_code=501,
        detail="Encaminhamento de mensagens nao e suportado pela integracao W-API.",
    )


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
            creds = wapi_creds(resolved_user_id)
            raw_contacts: Any = None
            if creds:
                try:
                    raw_contacts = await wapi_client.fetch_contacts(*creds)
                except WapiError:
                    raw_contacts = None
            if isinstance(raw_contacts, dict):
                raw_contacts = raw_contacts.get("contacts") or raw_contacts.get("items") or raw_contacts.get("data")
            contatos = parse_whatsapp_collection(raw_contacts) if isinstance(raw_contacts, list) else []
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
            if (c.get("name") or c.get("phone") or c.get("id"))
            and not wapi_webhook.is_status_broadcast(c)
        ]
        return contatos_whatsapp
    except Exception:
        return []


@router.post("/api/chat/enviar")
async def enviar_mensagem(payload: EnviarMensagemPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, payload.canal)

    # Citação (responder): monta a prévia a partir da mensagem alvo no store.
    citada = None
    if payload.responder_a:
        db_quote = await load_conversations(resolved_user_id)
        conversa_quote = db_quote.get(payload.conversa_id)
        if isinstance(conversa_quote, dict):
            alvo = next(
                (m for m in conversa_quote.get("mensagens") or [] if str(m.get("id") or "") == payload.responder_a),
                None,
            )
            if alvo:
                citada = {
                    "id": payload.responder_a,
                    "content": alvo.get("texto") or "",
                    "senderName": alvo.get("remetenteNome")
                    or (None if alvo.get("remetente") == "usuario" else conversa_quote.get("contato")),
                }

    try:
        result = await wapi_messaging.send_text(
            resolved_user_id, payload.conversa_id, payload.texto, quoted_message_id=payload.responder_a or ""
        )
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "A API do WhatsApp recusou o envio.") from exc
    if not result.get("sent"):
        raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o envio.")

    await append_outgoing_message(
        payload.conversa_id,
        payload.texto,
        channel="whatsapp",
        status="enviado",
        message_id=str(result.get("messageId") or "") or None,
        citada=citada,
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

    if payload.como_figurinha and media_kind != "image":
        raise HTTPException(status_code=415, detail="Figurinhas devem ser enviadas a partir de uma imagem.")

    media_data = payload.data_url
    if payload.como_figurinha:
        kind, tipo, texto = "sticker", "sticker", "[Figurinha]"
    elif media_kind == "audio":
        kind, tipo, texto = "audio", "audio", "[Audio]"
        # A W-API rejeita webm (formato de gravacao do navegador). Transcodifica
        # para ogg/opus (formato de voz do WhatsApp). Fallback: envia o original.
        ogg = await asyncio.to_thread(transcode_audio_to_ogg, file_bytes)
        if ogg:
            media_data = "data:audio/ogg;base64," + base64.b64encode(ogg).decode()
    elif media_kind == "image":
        kind, tipo, texto = "image", "midia", (legenda or "[Imagem]")
    elif media_kind == "video":
        kind, tipo, texto = "video", "midia", (legenda or "[Video]")
    else:
        kind, tipo, texto = "document", "documento", (legenda or "[Documento]")

    try:
        # A W-API aceita mídia como data URI (base64), verificado ao vivo.
        result = await wapi_messaging.send_media(
            resolved_user_id,
            payload.conversa_id,
            kind,
            media_data,
            caption=(legenda or ""),
            file_name=safe_file_name,
            extension=extension,
            timeout=110.0,
        )
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "A API do WhatsApp recusou o envio do arquivo.") from exc
    if not result.get("sent"):
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
    try:
        await wapi_messaging.react(resolved_user_id, payload.conversa_id, payload.mensagem_id, payload.emoji)
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "O WhatsApp recusou a reacao.") from exc

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
    try:
        await wapi_messaging.delete(resolved_user_id, payload.conversa_id, payload.mensagem_id, payload.para_todos)
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "O WhatsApp recusou a exclusao da mensagem.") from exc
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
    # A W-API nao expoe exclusao de conversa; a remocao e local (store do usuario).
    sucesso = await delete_conversation(conversa_id, resolved_user_id)
    if sucesso:
        return {"status": "sucesso", "user_id": resolved_user_id}
    raise HTTPException(status_code=404, detail="Conversa nao encontrada.")


@router.patch("/api/chat/modificar")
async def modificar_chat(payload: ModificarChatPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    # "Marcar como lida": envia o recibo de leitura (✓✓) da última mensagem
    # recebida ao WhatsApp e limpa o não-lido localmente.
    if payload.acao == "lida" and payload.valor is True:
        try:
            db_read = await load_conversations(resolved_user_id)
            conv_read = db_read.get(payload.conversa_id)
            if isinstance(conv_read, dict):
                ultima = next(
                    (m for m in reversed(conv_read.get("mensagens") or [])
                     if m.get("remetente") == "contato" and m.get("id")),
                    None,
                )
                if ultima:
                    await wapi_messaging.mark_read(resolved_user_id, payload.conversa_id, str(ultima["id"]))
        except (MessagingUnavailable, WapiError):
            pass  # marca localmente mesmo se a W-API recusar/estiver indisponível
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


# Um id "cru" é o próprio jid do chat (ex.: "2194...@lid", "5511...@c.us") ou um
# número com formato de telefone. Com a migração do WhatsApp para @lid, os
# chats chegam com id @lid enquanto os nomes do fetch-contacts vêm por número,
# então o nome resolvido frequentemente cai para o id. Estas funções evitam que
# um nome real (ex.: pushName de um webhook) seja rebaixado de volta para o id.
_JID_LIKE = re.compile(r"^[0-9]+@[^@]+$")
_PHONE_LIKE = re.compile(r"^\+?[0-9][0-9\s().-]{6,}$")


def _is_id_like(value: str | None, phone: str) -> bool:
    v = (value or "").strip()
    return (not v) or v == phone or bool(_JID_LIKE.fullmatch(v)) or bool(_PHONE_LIKE.fullmatch(v))


def melhor_nome_contato(atual: str | None, novo: str | None, phone: str) -> str:
    """Escolhe o melhor nome de exibição, sem rebaixar um nome real para o id.

    Promove ``novo`` só quando é um nome de verdade; caso contrário mantém um
    ``atual`` já bom; e só cai para o id (``phone``) quando não há nenhum nome.
    """
    atual = (atual or "").strip()
    novo = (novo or "").strip()
    if novo and not _is_id_like(novo, phone):
        return novo
    if atual and not _is_id_like(atual, phone):
        return atual
    return atual or novo or phone


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
        # Chaves alternativas: com @lid os chats chegam por lid, mas o contato
        # costuma vir indexado pelo número. Indexa também por qualquer lid/jid
        # do contato para a busca por telefone do chat casar (ponte @lid → nome).
        alt_keys = {jid}
        for alt in (contato.get("lid"), contato.get("senderLid"), contato.get("jid"), contato.get("id")):
            if alt:
                alt_keys.add(str(alt))
        nome = contato.get("name") or contato.get("verifiedName") or contato.get("pushname")
        if nome:
            for key in alt_keys:
                nomes[key] = str(nome)
        photo = extract_photo_url(contato)
        if photo:
            for key in alt_keys:
                fotos[key] = photo
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
    creds = wapi_creds(user_id)
    if not creds:
        return None
    query_phone = normalize_profile_phone(phone)
    try:
        data = await wapi_client.contact_profile_picture(creds[0], creds[1], query_phone)
        if isinstance(data, dict):
            return data.get("profilePictureUrl") or data.get("photoUrl") or data.get("link") or data.get("value")
    except WapiError:
        logger.warning("Falha ao buscar foto de perfil W-API.")
    return None


async def fetch_group_metadata(user_id: str, phone: str) -> Dict[str, Any] | None:
    creds = wapi_creds(user_id)
    if not creds:
        return None
    group_id = phone.strip()
    try:
        data = await wapi_client.group_metadata(creds[0], creds[1], group_id)
        if not isinstance(data, dict) or data.get("error"):
            return None
        # O subject/participantes vêm aninhados em "group".
        g = data.get("group") if isinstance(data.get("group"), dict) else data
        return {
            "nome": g.get("subject") or g.get("name"),
            "descricaoGrupo": g.get("description") or g.get("desc") or "",
            "participantes": g.get("participants") or [],
            "criadoPor": g.get("owner") or g.get("creator") or g.get("subjectOwner"),
            "criadoEm": g.get("creation") or g.get("createdAt"),
            "photoUrl": extract_photo_url(g),
        }
    except WapiError:
        logger.warning("Falha ao buscar metadados de grupo W-API.")
    return None
