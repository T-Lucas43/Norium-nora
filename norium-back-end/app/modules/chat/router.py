"""Dominio de chat extraido do entrypoint para separar canais e midias."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import mimetypes
import logging
import os
import re
import secrets
import shutil
import socket
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Literal
from urllib.parse import quote, unquote, urljoin, urlparse
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import Field, model_validator

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
    whatsapp_conversation_mutation_lock,
    whatsapp_conversation_mutation_locks,
)
from app.services.wapi_connect import WapiConnectService, ConsentRequiredError
from app.services.wapi_messaging import (
    WapiMessagingService,
    MessagingUnavailable,
    InvalidGroupParticipants,
    wapi_phone,
)
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
whatsapp_webhook_inflight: Dict[str, asyncio.Future[bool]] = {}
whatsapp_contact_sync_states: Dict[str, Dict[str, Any]] = {}
whatsapp_contact_sync_tasks: Dict[str, asyncio.Task[Any]] = {}
WHATSAPP_CATALOG_CACHE_TTL_SECONDS = max(60, int(os.getenv("WHATSAPP_CATALOG_CACHE_TTL_SECONDS", "300")))
WHATSAPP_CONTACT_SYNC_TTL_SECONDS = max(
    60 * 60,
    int(os.getenv("WHATSAPP_CONTACT_SYNC_TTL_SECONDS", str(6 * 60 * 60))),
)
WHATSAPP_CONTACT_SYNC_RETRY_SECONDS = max(
    60,
    int(os.getenv("WHATSAPP_CONTACT_SYNC_RETRY_SECONDS", "300")),
)
WHATSAPP_CATALOG_SCHEMA_VERSION = 3
WHATSAPP_HISTORY_CACHE_TTL_SECONDS = max(30, int(os.getenv("WHATSAPP_HISTORY_CACHE_TTL_SECONDS", "120")))
WHATSAPP_HISTORY_SCHEMA_VERSION = 2
WHATSAPP_PROFILE_PHOTO_TTL_SECONDS = max(
    3600,
    min(47 * 60 * 60, int(os.getenv("WHATSAPP_PROFILE_PHOTO_TTL_SECONDS", str(36 * 60 * 60)))),
)
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


def _webhook_binding_is_current(user_id: str, data: Dict[str, Any]) -> bool:
    """Reconfirma o vínculo depois de o webhook adquirir o lock do tenant.

    O endpoint resolve o dono antes de aguardar o lock. Se o usuário desconectar
    nesse intervalo, o índice já terá sido removido e o evento em voo precisa ser
    descartado para não recriar conversas, Status ou o estado de conexão local.
    Chamadas internas sem ``instanceId`` continuam permitidas para reaproveitar os
    handlers em testes e rotinas locais; o endpoint público sempre exige a instância.
    """
    instance_id = wapi_webhook.instance_id(data)
    return not instance_id or wb.owner_of_instance(instance_id) == user_id


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
    responder_a: str | None = Field(default=None, min_length=1, max_length=128)
    visualizacao_unica: bool = False

    @model_validator(mode="after")
    def validate_visualizacao_unica(self) -> "EnviarArquivoPayload":
        media_kind = classify_media(self.mime_type, self.nome_arquivo)
        if self.visualizacao_unica and (self.como_figurinha or media_kind not in {"image", "audio", "video"}):
            raise ValueError("Visualizacao unica esta disponivel somente para fotos, audios e videos.")
        return self



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


class EditarMensagemPayload(StrictModel):
    conversa_id: str = Field(min_length=1)
    mensagem_id: str = Field(min_length=1, max_length=128)
    texto: str = Field(min_length=1, max_length=4096)


class CriarGrupoPayload(StrictModel):
    nome: str = Field(min_length=1, max_length=100)
    participantes: list[str] = Field(min_length=1, max_length=256)
    profile_picture_url: str | None = Field(default=None, max_length=2048)
    auto_invite: bool = True


class PublicarStatusPayload(StrictModel):
    tipo: Literal["texto", "imagem", "video"] = "texto"
    texto: str | None = Field(default=None, max_length=4096)
    data_url: str | None = None
    mime_type: str | None = Field(default=None, max_length=120)


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


async def mark_whatsapp_conversation_updated(user_id: str, conversation_id: str) -> int:
    """Registra alteração sem mudar o horário/ordem da última mensagem."""
    cache = await load_whatsapp_catalog_cache(user_id)
    updates = cache.get("conversationUpdates") if isinstance(cache.get("conversationUpdates"), dict) else {}
    last_update = max((int(value or 0) for value in updates.values()), default=0)
    updated_at = max(int(time.time()), last_update + 1)
    updates[str(conversation_id)] = updated_at
    # Limita o mapa a conversas recentes para não crescer indefinidamente.
    newest = sorted(updates.items(), key=lambda item: int(item[1] or 0), reverse=True)[:500]
    await save_whatsapp_catalog_cache(user_id, {**cache, "conversationUpdates": dict(newest)})
    return updated_at


async def load_whatsapp_status_feed(user_id: str) -> Dict[str, Any]:
    payload = await asyncio.to_thread(read_user_db, user_id, "whatsapp_status_feed", {"items": []})
    return payload if isinstance(payload, dict) else {"items": []}


async def save_whatsapp_status_feed(user_id: str, payload: Dict[str, Any]) -> None:
    await asyncio.to_thread(write_user_db, user_id, "whatsapp_status_feed", payload)


def contact_sync_state(user_id: str) -> Dict[str, Any]:
    return whatsapp_contact_sync_states.setdefault(
        user_id,
        {
            "status": "idle",
            "phase": "waiting",
            "progress": 0,
            "current": 0,
            "total": 0,
            "message": "Aguardando sincronizacao do WhatsApp.",
            "contactsSynced": 0,
            "photosSynced": 0,
            "requiresPro": False,
            "reconnectRequired": False,
            "partial": False,
            "warnings": [],
        },
    )


def update_contact_sync_state(user_id: str, **updates: Any) -> Dict[str, Any]:
    state = contact_sync_state(user_id)
    if (
        state.get("status") == "syncing"
        and updates.get("status", "syncing") == "syncing"
        and "progress" in updates
    ):
        try:
            updates["progress"] = max(int(state.get("progress") or 0), int(updates["progress"] or 0))
        except (TypeError, ValueError):
            pass
    state.update(updates)
    state["updatedAt"] = time.time()
    return dict(state)


def catalog_cache_is_fresh(
    cache: Dict[str, Any],
    key: str = "catalogSyncedAt",
    ttl_seconds: int = WHATSAPP_CATALOG_CACHE_TTL_SECONDS,
) -> bool:
    if cache.get("schemaVersion") != WHATSAPP_CATALOG_SCHEMA_VERSION:
        return False
    try:
        cached_at = float(cache.get(key) or 0)
    except (TypeError, ValueError):
        return False
    return cached_at > 0 and time.time() - cached_at < ttl_seconds


def contact_sync_retry_due(cache: Dict[str, Any]) -> bool:
    try:
        attempted_at = float(cache.get("contactSyncAttemptedAt") or 0)
    except (TypeError, ValueError):
        attempted_at = 0
    return attempted_at <= 0 or time.time() - attempted_at >= WHATSAPP_CONTACT_SYNC_RETRY_SECONDS


def _pagination_total_pages(payload: Any, page: int, received: int, per_page: int) -> int | None:
    if not isinstance(payload, dict):
        return page if received < per_page else None
    pagination = payload.get("pagination") if isinstance(payload.get("pagination"), dict) else {}
    for value in (
        payload.get("totalPages"),
        payload.get("lastPage"),
        pagination.get("totalPages"),
        pagination.get("lastPage"),
    ):
        try:
            if value is not None:
                return max(1, int(value))
        except (TypeError, ValueError):
            continue
    total = (
        payload.get("total")
        or payload.get("totalContacts")
        or payload.get("totalChats")
        or pagination.get("total")
        or pagination.get("totalItems")
    )
    try:
        if total is not None:
            return max(1, (int(total) + per_page - 1) // per_page)
    except (TypeError, ValueError):
        pass
    return page if received < per_page else None


def _dedupe_catalog_items(items: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    """Remove duplicatas de paginação preservando o registro mais rico."""
    result: list[Dict[str, Any]] = []
    index_by_alias: Dict[str, int] = {}
    for item in items:
        aliases = _contact_aliases(item)
        existing_index = next((index_by_alias[alias] for alias in aliases if alias in index_by_alias), None)
        if existing_index is None:
            existing_index = len(result)
            result.append(dict(item))
        else:
            merged = dict(result[existing_index])
            reference_id = _contact_primary_id(item) or _contact_primary_id(merged)
            for key, value in item.items():
                if value in (None, "", [], {}):
                    continue
                if key in {
                    "subject", "notify", "name", "savedName", "displayName", "formattedName",
                    "fullName", "shortName", "verifiedName", "verifiedBizName",
                    "verifiedBusinessName", "pushname", "pushName",
                }:
                    existing_value = str(merged.get(key) or "").strip()
                    incoming_value = str(value).strip()
                    if (
                        existing_value
                        and not _is_id_like(existing_value, reference_id)
                        and _is_id_like(incoming_value, reference_id)
                    ):
                        continue
                merged[key] = value
            result[existing_index] = merged
        for alias in aliases:
            index_by_alias[alias] = existing_index
    return result


def merge_catalog_items(
    cached: list[Dict[str, Any]],
    fresh: list[Dict[str, Any]],
) -> list[Dict[str, Any]]:
    """Mescla uma página/sync parcial sem apagar nomes e fotos já conhecidos."""
    return _dedupe_catalog_items([*cached, *fresh])


class WapiCatalogResult(list[Dict[str, Any]]):
    """Lista de catálogo que carrega evidência de páginas indisponíveis."""

    def __init__(
        self,
        items: list[Dict[str, Any]],
        *,
        failed_pages: list[int] | None = None,
        total_pages: int = 1,
    ) -> None:
        super().__init__(items)
        self.failed_pages = tuple(sorted(set(failed_pages or [])))
        self.total_pages = total_pages

    @property
    def partial(self) -> bool:
        return bool(self.failed_pages)


async def _fetch_all_wapi_catalog(
    user_id: str,
    *,
    kind: Literal["contacts", "chats"],
) -> list[Dict[str, Any]]:
    """Busca catálogo paginado com primeira página síncrona e demais paralelas.

    A primeira resposta fornece ``totalPages``. As páginas restantes são
    independentes e são buscadas com concorrência limitada, reduzindo muito o
    onboarding de catálogos grandes sem disparar centenas de requests de uma
    vez. Uma página transitoriamente indisponível não descarta as já recebidas.
    """
    creds = wapi_creds(user_id)
    if not creds:
        raise MessagingUnavailable("Nenhuma instancia de WhatsApp vinculada a esta conta.")
    instance_id, token = creds
    is_contacts = kind == "contacts"
    per_page_env = "WHATSAPP_CONTACTS_PER_PAGE" if is_contacts else "WHATSAPP_CHATS_PER_PAGE"
    max_items_env = "WHATSAPP_CONTACT_SYNC_MAX" if is_contacts else "WHATSAPP_CHAT_SYNC_MAX"
    per_page = max(10, min(200, int(os.getenv(per_page_env, "100" if is_contacts else "50"))))
    max_items = max(100, min(5000, int(os.getenv(max_items_env, "5000" if is_contacts else "1000"))))
    max_pages = min(100, (max_items + per_page - 1) // per_page)
    fetch = wapi_client.fetch_contacts if is_contacts else wapi_client.fetch_chats

    update_contact_sync_state(
        user_id,
        status="syncing",
        phase=kind,
        progress=4 if is_contacts else 18,
        message=("Carregando contatos..." if is_contacts else "Carregando conversas..."),
    )
    first_payload = await fetch(instance_id, token, page=1, perPage=per_page)
    first_items = parse_whatsapp_collection(first_payload)
    total_pages = _pagination_total_pages(first_payload, 1, len(first_items), per_page)
    if total_pages is None:
        # O contrato oficial fornece totalPages; o fallback conservador evita
        # loop infinito quando um gateway intermediário remove a paginação.
        total_pages = 1 if len(first_items) < per_page else max_pages
    total_pages = max(1, min(max_pages, total_pages))
    pages: Dict[int, list[Dict[str, Any]]] = {1: first_items}
    semaphore = asyncio.Semaphore(max(1, min(8, int(os.getenv("WHATSAPP_CATALOG_CONCURRENCY", "4")))))

    async def _page(page: int) -> tuple[int, list[Dict[str, Any]], bool]:
        async with semaphore:
            try:
                payload = await fetch(instance_id, token, page=page, perPage=per_page)
            except WapiError:
                logger.warning("Pagina %s de %s indisponivel na W-API.", page, kind)
                return page, [], True
        return page, parse_whatsapp_collection(payload), False

    failed_pages: list[int] = []
    if total_pages > 1:
        finished = 1
        successful = 1
        tasks = [asyncio.create_task(_page(page)) for page in range(2, total_pages + 1)]
        for task in asyncio.as_completed(tasks):
            page, items, failed = await task
            finished += 1
            if failed:
                failed_pages.append(page)
            else:
                pages[page] = items
                successful += 1
            base, span = (4, 14) if is_contacts else (18, 10)
            update_contact_sync_state(
                user_id,
                phase=kind,
                progress=min(base + span, base + int((successful / total_pages) * span)),
                current=sum(len(page_items) for page_items in pages.values()),
                total=min(max_items, total_pages * per_page),
                message=(
                    f"Contatos: {finished} de {total_pages} paginas"
                    if is_contacts
                    else f"Conversas: {finished} de {total_pages} paginas"
                ),
            )

    combined = [item for page in sorted(pages) for item in pages[page]]
    return WapiCatalogResult(
        _dedupe_catalog_items(combined)[:max_items],
        failed_pages=failed_pages,
        total_pages=total_pages,
    )


async def fetch_all_wapi_contacts(user_id: str) -> list[Dict[str, Any]]:
    """Busca o catálogo PRO inteiro usando ``page`` e ``perPage`` oficiais."""
    return await _fetch_all_wapi_catalog(user_id, kind="contacts")


async def fetch_all_wapi_chats(user_id: str) -> list[Dict[str, Any]]:
    """Busca todos os chats disponíveis no catálogo W-API."""
    return await _fetch_all_wapi_catalog(user_id, kind="chats")


def _identifier_value(value: Any) -> str:
    if isinstance(value, dict):
        serialized = value.get("_serialized") or value.get("serialized")
        if serialized:
            return str(serialized).strip()
        user = str(value.get("user") or value.get("id") or "").strip()
        server = str(value.get("server") or "").strip()
        return f"{user}@{server}" if user and server and "@" not in user else user
    return str(value or "").strip()


def _contact_primary_id(contact: Dict[str, Any]) -> str:
    nested = contact.get("contact") if isinstance(contact.get("contact"), dict) else {}
    for source in (contact, nested):
        for key in (
            "phone", "phoneNumber", "number", "id", "jid", "lid", "senderLid",
            "serialized", "wid",
        ):
            value = _identifier_value(source.get(key))
            if value:
                return value
    return ""


def _newsletter_catalog_id(record: Dict[str, Any]) -> str:
    wrapped = record.get("newsletter") if isinstance(record.get("newsletter"), dict) else record
    candidate = _identifier_value(
        wrapped.get("id")
        or wrapped.get("jid")
        or wrapped.get("chatId")
        or wrapped.get("newsletterId")
        or wrapped.get("channelId")
    )
    return candidate if candidate.lower().endswith("@newsletter") else ""


def _contact_display_name(contact: Dict[str, Any], reference_id: str = "") -> str | None:
    """Extrai nomes de contatos/chats nos shapes conhecidos sem aceitar JID."""
    nested = contact.get("contact") if isinstance(contact.get("contact"), dict) else {}
    for source in (contact, nested):
        for key in (
            "subject", "savedName", "displayName", "formattedName", "fullName", "shortName",
            "contactName", "profileName", "nickname", "givenName", "notify", "name",
            "verifiedName", "verifiedBizName",
            "verifiedBusinessName", "businessName", "pushname", "pushName",
        ):
            candidate = str(source.get(key) or "").strip()
            if candidate and not _is_id_like(candidate, reference_id or _contact_primary_id(contact)):
                return candidate
    return None


def _contact_aliases(contact: Dict[str, Any]) -> set[str]:
    aliases: set[str] = set()
    nested = contact.get("contact") if isinstance(contact.get("contact"), dict) else {}
    for source in (contact, nested):
        for key in (
            "phone", "phoneNumber", "number", "id", "jid", "lid", "senderLid",
            "serialized", "user", "wid",
        ):
            value = _identifier_value(source.get(key))
            if value:
                aliases.add(value)
    for alias in list(aliases):
        lowered = alias.lower()
        if lowered.endswith(("@lid", "@g.us", "@newsletter")):
            continue
        local = alias.split("@", 1)[0]
        digits = re.sub(r"\D", "", local)
        if digits:
            aliases.update({digits, f"{digits}@c.us", f"{digits}@s.whatsapp.net"})
    return aliases


def _iter_contact_records(records: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    """Expande contatos presentes dentro de chats/grupos sem perder o pai.

    Alguns snapshots da W-API trazem ``notify``/``name`` apenas no participante
    do grupo, enquanto o catálogo de contatos retorna somente o número. Esses
    participantes são uma fonte legítima de nomes conhecidos pela própria
    sessão e também carregam o papel de administrador.
    """
    expanded: list[Dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        expanded.append(record)
        for key in ("participants", "participantes", "members", "membros"):
            participants = record.get(key)
            if not isinstance(participants, list):
                continue
            expanded.extend(item for item in participants if isinstance(item, dict))
    return expanded


def _lookup_contact_index(index: Dict[str, Any], identifier: str) -> Any:
    for alias in _contact_aliases({"id": identifier}) or {identifier}:
        value = index.get(alias)
        if value not in (None, "", [], {}):
            return value
    return None


async def _run_contact_sync(user_id: str) -> Dict[str, Any]:
    update_contact_sync_state(
        user_id,
        status="syncing",
        phase="contacts",
        progress=1,
        current=0,
        total=0,
        message="Preparando a sincronizacao dos contatos...",
        contactsSynced=0,
        photosSynced=0,
        requiresPro=False,
        reconnectRequired=False,
        partial=False,
        warnings=[],
    )
    try:
        cache = await load_whatsapp_catalog_cache(user_id)
        raw_cached_contacts = [item for item in (cache.get("contacts") or []) if isinstance(item, dict)]
        raw_cached_chats = [item for item in (cache.get("chats") or []) if isinstance(item, dict)]
        raw_cached_channels = [item for item in (cache.get("channels") or []) if isinstance(item, dict)]

        # Contatos e chats são catálogos independentes. Rodam juntos; se a rota
        # PRO de contatos falhar, nomes já conhecidos e nomes presentes nos
        # chats continuam disponíveis em vez de derrubar toda a sincronização.
        contacts_result, chats_result = await asyncio.gather(
            fetch_all_wapi_contacts(user_id),
            fetch_all_wapi_chats(user_id),
            return_exceptions=True,
        )
        raw_fresh_contacts = contacts_result if isinstance(contacts_result, list) else []
        raw_fresh_chats = chats_result if isinstance(chats_result, list) else []
        status_catalog_payloads = [
            payload
            for record in [
                *raw_cached_contacts,
                *raw_cached_chats,
                *raw_cached_channels,
                *raw_fresh_contacts,
                *raw_fresh_chats,
            ]
            for payload in wapi_webhook.status_broadcast_payloads(record)
        ]
        cached_channels = [
            item
            for item in [*raw_cached_channels, *raw_cached_contacts, *raw_cached_chats]
            if _newsletter_catalog_id(item)
        ]
        fresh_channels = [
            item
            for item in [*raw_fresh_contacts, *raw_fresh_chats]
            if _newsletter_catalog_id(item)
        ]
        cached_contacts = [
            item for item in raw_cached_contacts
            if not wapi_webhook.is_status_broadcast(item) and not _newsletter_catalog_id(item)
        ]
        cached_chats = [
            item for item in raw_cached_chats
            if not wapi_webhook.is_status_broadcast(item) and not _newsletter_catalog_id(item)
        ]
        fresh_contacts = [
            item for item in raw_fresh_contacts
            if not wapi_webhook.is_status_broadcast(item) and not _newsletter_catalog_id(item)
        ]
        fresh_chats = [
            item for item in raw_fresh_chats
            if not wapi_webhook.is_status_broadcast(item) and not _newsletter_catalog_id(item)
        ]
        contacts_partial = bool(getattr(contacts_result, "partial", False))
        chats_partial = bool(getattr(chats_result, "partial", False))
        contacts_failed = isinstance(contacts_result, Exception)
        chats_failed = isinstance(chats_result, Exception)
        partial = contacts_partial or chats_partial or contacts_failed or chats_failed
        warnings: list[str] = []
        if contacts_failed:
            warnings.append("contatos em cache/chats")
        if chats_failed:
            warnings.append("conversas em cache")
        if contacts_partial:
            failed = ", ".join(str(page) for page in getattr(contacts_result, "failed_pages", ()))
            warnings.append(f"paginas de contatos indisponiveis: {failed}")
        if chats_partial:
            failed = ", ".join(str(page) for page in getattr(chats_result, "failed_pages", ()))
            warnings.append(f"paginas de conversas indisponiveis: {failed}")
        contacts = merge_catalog_items(cached_contacts, fresh_contacts)
        chats = merge_catalog_items(cached_chats, fresh_chats)
        channels = merge_catalog_items(cached_channels, fresh_channels)
        contacts_requires_pro = (
            isinstance(contacts_result, WapiError) and contacts_result.status == 403
        )
        if not contacts and not chats and isinstance(contacts_result, Exception) and isinstance(chats_result, Exception):
            raise contacts_result

        total = len(contacts)
        catalog_total = len(_dedupe_catalog_items([*contacts, *chats, *channels]))
        photos_available = sum(1 for item in contacts if extract_photo_url(item))
        update_contact_sync_state(
            user_id,
            phase="conversations",
            progress=60,
            current=0,
            total=max(total, len(chats)),
            contactsSynced=total,
            photosSynced=photos_available,
            message="Aplicando nomes e conversas...",
        )

        # O nome pode vir de fetch-contacts (notify/name) ou de fetch-chats.
        # O segundo catálogo é um fallback importante para instâncias em que a
        # rota PRO de contatos está indisponível ou retorna uma página parcial.
        contact_names, contact_photos, contact_metadata = build_contact_indexes([*contacts, *chats])
        update_contact_sync_state(
            user_id,
            phase="conversations",
            progress=72,
            current=0,
            total=max(total, len(chats)),
            message="Aplicando nomes e fotos nas conversas...",
        )
        # Carrega o snapshot somente depois de adquirir o mesmo lock usado pelos
        # webhooks. Assim uma mensagem que chega durante o sync é gravada antes
        # deste merge ou espera o merge terminar; nunca é apagada por snapshot antigo.
        async with whatsapp_conversation_mutation_lock(user_id):
            db = await load_conversations(user_id)
            local_names, local_photos, local_metadata = build_contact_indexes(
                contact_records_from_conversations(db)
            )
            for key, value in local_names.items():
                contact_names.setdefault(key, value)
            for key, value in local_photos.items():
                contact_photos.setdefault(key, value)
            for key, value in local_metadata.items():
                contact_metadata.setdefault(key, value)
            # Mesmo sem Status novos, aplica nomes/fotos recém-sincronizados aos
            # itens que já estavam no feed (muitos chegam primeiro apenas com JID).
            await _store_status_payloads_unlocked(
                user_id,
                status_catalog_payloads,
                contact_names=contact_names,
                contact_photos=contact_photos,
            )
            changed = await _migrate_legacy_status_conversations_unlocked(user_id, db)
            for index, chat in enumerate(chats):
                conversation_id = _contact_primary_id(chat)
                if not conversation_id:
                    continue
                is_group = is_group_chat(conversation_id, chat)
                name = contact_names.get(conversation_id) or _contact_display_name(chat, conversation_id)
                photo = contact_photos.get(conversation_id) or extract_photo_url(chat)
                metadata = contact_metadata.get(conversation_id) or {}
                conversation = db.get(conversation_id) or new_conversation(
                    conversation_id,
                    contato=name or conversation_id,
                    channel="whatsapp",
                    is_group=is_group,
                    photo_url=photo,
                )
                conversation["contato"] = melhor_nome_contato(
                    conversation.get("contato"), name, conversation_id
                )
                conversation["esGrupo"] = is_group
                if photo:
                    conversation["photoUrl"] = photo
                    conversation.setdefault("metadados", {})["photoUrl"] = photo
                    conversation["metadados"]["photoFetchedAt"] = (
                        metadata.get("photoFetchedAt") or time.time()
                    )
                conversation.setdefault("metadados", {}).update(
                    {key: value for key, value in metadata.items() if value is not None}
                )
                last_timestamp = normalize_whatsapp_timestamp(
                    chat.get("lastMessageTime") or chat.get("timestamp")
                )
                if last_timestamp:
                    conversation["timestampUltimaMsg"] = max(
                        int(conversation.get("timestampUltimaMsg") or 0), last_timestamp
                    )
                    conversation["horario"] = format_whatsapp_time(
                        int(conversation["timestampUltimaMsg"])
                    )
                sync_catalog_messages(conversation, chat)
                db[conversation_id] = normalize_conversation(conversation_id, conversation)
                changed = True
                if index % 50 == 0:
                    update_contact_sync_state(
                        user_id,
                        phase="conversations",
                        progress=min(92, 72 + int(((index + 1) / max(len(chats), 1)) * 20)),
                        current=index + 1,
                        total=max(total, len(chats)),
                    )

            for conversation_id, conversation in db.items():
                if not isinstance(conversation, dict):
                    continue
                conversation_changed = False
                name = contact_names.get(conversation_id)
                photo = contact_photos.get(conversation_id)
                metadata = contact_metadata.get(conversation_id)
                if name:
                    conversation["contato"] = melhor_nome_contato(conversation.get("contato"), name, conversation_id)
                    conversation_changed = True
                if photo:
                    conversation["photoUrl"] = photo
                    conversation.setdefault("metadados", {})["photoUrl"] = photo
                    conversation_changed = True
                if metadata:
                    conversation.setdefault("metadados", {}).update(
                        {key: value for key, value in metadata.items() if value is not None}
                    )
                    conversation_changed = True
                if conversation_changed:
                    db[conversation_id] = normalize_conversation(conversation_id, conversation)
                    changed = True
            if changed:
                await save_conversations(db, user_id)

        now = time.time()
        # Webhooks usam este mesmo lock ao atualizar ``conversationUpdates``.
        # Reler o documento dentro dele torna o merge read-modify-write atômico:
        # qualquer atualização ocorrida durante as chamadas remotas entra no
        # snapshot final, e uma atualização posterior parte do cache já salvo.
        async with whatsapp_conversation_mutation_lock(user_id):
            latest_cache = await load_whatsapp_catalog_cache(user_id)
            latest_raw_contacts = [
                item for item in (latest_cache.get("contacts") or []) if isinstance(item, dict)
            ]
            latest_raw_chats = [
                item for item in (latest_cache.get("chats") or []) if isinstance(item, dict)
            ]
            latest_raw_channels = [
                item for item in (latest_cache.get("channels") or []) if isinstance(item, dict)
            ]
            latest_channels = [
                item
                for item in [*latest_raw_channels, *latest_raw_contacts, *latest_raw_chats]
                if _newsletter_catalog_id(item)
            ]
            latest_contacts = [
                item for item in latest_raw_contacts if not _newsletter_catalog_id(item)
            ]
            latest_chats = [
                item for item in latest_raw_chats if not _newsletter_catalog_id(item)
            ]
            contacts = merge_catalog_items(latest_contacts, contacts)
            chats = merge_catalog_items(latest_chats, chats)
            channels = merge_catalog_items(latest_channels, channels)
            await save_whatsapp_catalog_cache(
                user_id,
                {
                    **latest_cache,
                    "schemaVersion": WHATSAPP_CATALOG_SCHEMA_VERSION,
                    "authenticatedAt": (
                        latest_cache.get("authenticatedAt") or cache.get("authenticatedAt") or now
                    ),
                    "contactSyncAttemptedAt": now,
                    "catalogSyncedAt": (
                        now
                        if not chats_failed and not chats_partial
                        else latest_cache.get("catalogSyncedAt") or cache.get("catalogSyncedAt")
                    ),
                    "contactsSyncedAt": (
                        now
                        if not contacts_failed and not contacts_partial
                        else latest_cache.get("contactsSyncedAt") or cache.get("contactsSyncedAt")
                    ),
                    "channelsSyncedAt": (
                        now
                        if not contacts_failed and not contacts_partial and not chats_failed and not chats_partial
                        else latest_cache.get("channelsSyncedAt") or cache.get("channelsSyncedAt")
                    ),
                    "contacts": contacts,
                    "chats": chats,
                    "channels": channels,
                    "requiresPro": contacts_requires_pro,
                    "reconnectRequired": contacts_requires_pro,
                    "catalogPartial": partial,
                    "catalogWarnings": warnings,
                },
            )
        total = len(contacts)
        catalog_total = len(_dedupe_catalog_items([*contacts, *chats, *channels]))
        photos_available = sum(1 for item in contacts if extract_photo_url(item))
        suffix = f" ({', '.join(warnings)})" if warnings else ""
        return update_contact_sync_state(
            user_id,
            status="partial" if partial else "complete",
            phase="partial" if partial else "complete",
            progress=99 if partial else 100,
            current=catalog_total,
            total=catalog_total,
            contactsSynced=total,
            photosSynced=photos_available,
            requiresPro=contacts_requires_pro,
            reconnectRequired=contacts_requires_pro,
            partial=partial,
            warnings=warnings,
            message=(
                f"Sincronizacao parcial; dados conhecidos preservados{suffix}."
                if partial
                else f"{total} contato(s), {len(chats)} conversa(s) e {len(channels)} canal(is) sincronizados{suffix}."
            ),
        )
    except (MessagingUnavailable, WapiError) as exc:
        logger.warning("Sincronizacao de contatos W-API indisponivel: %s", type(exc).__name__)
        cache = await load_whatsapp_catalog_cache(user_id)
        await save_whatsapp_catalog_cache(
            user_id,
            {**cache, "contactSyncAttemptedAt": time.time()},
        )
        return update_contact_sync_state(
            user_id,
            status="error",
            phase="error",
            requiresPro=isinstance(exc, WapiError) and exc.status == 403,
            reconnectRequired=isinstance(exc, WapiError) and exc.status == 403,
            message=(
                "A sincronizacao de contatos exige uma instancia W-API PRO conectada."
                if isinstance(exc, WapiError) and exc.status == 403
                else "Nao foi possivel sincronizar os contatos agora."
            ),
        )
    except Exception:
        logger.exception("Falha ao sincronizar contatos W-API.")
        cache = await load_whatsapp_catalog_cache(user_id)
        await save_whatsapp_catalog_cache(
            user_id,
            {**cache, "contactSyncAttemptedAt": time.time()},
        )
        return update_contact_sync_state(
            user_id,
            status="error",
            phase="error",
            message="Nao foi possivel sincronizar os contatos agora.",
        )


def schedule_contact_sync(user_id: str, *, force: bool = False) -> Dict[str, Any]:
    running = whatsapp_contact_sync_tasks.get(user_id)
    if running and not running.done():
        return dict(contact_sync_state(user_id))
    state = contact_sync_state(user_id)
    if not force and state.get("status") == "complete":
        return dict(state)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return update_contact_sync_state(
            user_id,
            status="syncing",
            phase="waiting",
            message="Sincronizacao pendente; aguardando o worker assíncrono.",
        )
    task = loop.create_task(_run_contact_sync(user_id))
    whatsapp_contact_sync_tasks[user_id] = task

    def _cleanup(done: asyncio.Task[Any]) -> None:
        if whatsapp_contact_sync_tasks.get(user_id) is done:
            whatsapp_contact_sync_tasks.pop(user_id, None)
        try:
            done.exception()
        except (asyncio.CancelledError, Exception):
            pass

    task.add_done_callback(_cleanup)
    return dict(contact_sync_state(user_id))


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


def unpack_wapi_media_response(payload: Any) -> tuple[str | None, str | None]:
    """Extrai base64/data URI e fileLink mesmo em envelopes data/result/payload."""
    inline: str | None = None
    link: str | None = None
    queue = [payload]
    seen: set[int] = set()
    while queue:
        current = queue.pop(0)
        if not isinstance(current, dict) or id(current) in seen:
            continue
        seen.add(id(current))
        for key in ("fileLink", "url", "link", "downloadUrl"):
            candidate = current.get(key)
            if isinstance(candidate, str) and candidate.startswith("https://"):
                link = link or candidate
        for key in ("base64", "media", "data"):
            candidate = current.get(key)
            if isinstance(candidate, str) and candidate:
                if candidate.startswith("https://"):
                    link = link or candidate
                else:
                    inline = inline or candidate
        for key in ("data", "payload", "result", "response", "media"):
            nested = current.get(key)
            if isinstance(nested, dict):
                queue.append(nested)
    return inline, link


_WHATSAPP_MEDIA_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
_WHATSAPP_MEDIA_MAX_REDIRECTS = 4


def validate_external_media_url(url: str) -> str:
    """Aceita apenas HTTPS público, sem credenciais nem endereços locais.

    A W-API pode devolver um ``fileLink`` em host próprio ou em um CDN público.
    Por isso a política não limita o domínio a uma lista fixa, mas bloqueia os
    destinos que permitem SSRF (localhost, sufixos internos e IPs não globais).
    Cada redirecionamento passa novamente por esta função antes do próximo GET.
    """
    try:
        parsed = urlparse(str(url or "").strip())
        hostname = (parsed.hostname or "").strip().casefold().rstrip(".")
        # Acessar ``port`` também valida portas malformadas no URL.
        _ = parsed.port
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Origem de midia nao autorizada.") from exc
    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or hostname == "localhost"
        or hostname.endswith((".localhost", ".local", ".internal", ".lan"))
    ):
        raise HTTPException(status_code=400, detail="Origem de midia nao autorizada.")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        # Host público por nome, incluindo os CDNs legítimos usados pela W-API.
        # Formas numéricas alternativas de IPv4 não devem cair na resolução DNS.
        if hostname.replace(".", "").isdigit() or hostname.startswith("0x"):
            raise HTTPException(status_code=400, detail="Origem de midia nao autorizada.")
    else:
        if not address.is_global:
            raise HTTPException(status_code=400, detail="Origem de midia nao autorizada.")
    return parsed.geturl()


async def validate_external_media_destination(url: str) -> str:
    """Valida também todos os endereços retornados pelo DNS do hostname.

    A checagem ocorre imediatamente antes de cada GET. Se o DNS devolver uma
    combinação pública/privada, a política conservadora rejeita o destino.
    """
    normalized = validate_external_media_url(url)
    parsed = urlparse(normalized)
    hostname = (parsed.hostname or "").strip().casefold().rstrip(".")
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        try:
            addresses = await asyncio.to_thread(
                socket.getaddrinfo,
                hostname,
                parsed.port or 443,
                type=socket.SOCK_STREAM,
            )
        except OSError as exc:
            raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.") from exc
        if not addresses:
            raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.")
        for address_info in addresses:
            raw_address = str(address_info[4][0]).split("%", 1)[0]
            try:
                resolved = ipaddress.ip_address(raw_address)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="Origem de midia nao autorizada.") from exc
            if not resolved.is_global:
                raise HTTPException(status_code=400, detail="Origem de midia nao autorizada.")
    else:
        if not literal.is_global:
            raise HTTPException(status_code=400, detail="Origem de midia nao autorizada.")
    return normalized


async def fetch_external_whatsapp_media(url: str, *, timeout: float) -> httpx.Response:
    """Baixa mídia validando o destino inicial e todos os redirects manualmente."""
    current_url = await validate_external_media_destination(url)
    async with httpx.AsyncClient(follow_redirects=False) as media_client:
        for redirect_count in range(_WHATSAPP_MEDIA_MAX_REDIRECTS + 1):
            response = await media_client.get(current_url, timeout=timeout)
            if response.status_code not in _WHATSAPP_MEDIA_REDIRECT_STATUSES:
                return response
            location = response.headers.get("Location")
            if not location or redirect_count >= _WHATSAPP_MEDIA_MAX_REDIRECTS:
                raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.")
            current_url = await validate_external_media_destination(urljoin(current_url, location))
    raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.")


@router.get("/api/chat/foto-perfil")
async def obter_foto_perfil(
    phone: str = Query(..., description="ID ou numero do contato/grupo"),
    user: dict[str, Any] = Depends(current_user),
):
    assert_channel_permission(user, "whatsapp")
    photo_url = await fetch_profile_picture(tenant_id(user), phone)
    return {"photoUrl": photo_url, "fetchedAt": time.time() if photo_url else None}


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
        res_media = await fetch_external_whatsapp_media(url, timeout=25.0)
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
        if resultado.get("status") == "conectado":
            catalog_cache = await load_whatsapp_catalog_cache(resolved_user_id)
            if not catalog_cache_is_fresh(
                catalog_cache, "contactsSyncedAt", WHATSAPP_CONTACT_SYNC_TTL_SECONDS
            ) and contact_sync_retry_due(catalog_cache):
                schedule_contact_sync(resolved_user_id, force=True)
        user_status["whatsapp"]["sincronizacao"] = dict(contact_sync_state(resolved_user_id))
    except Exception:
        user_status["whatsapp"] = {
            "conectado": False,
            "qrcode": None,
            "status": "indisponivel",
            "disponivel": False,
        }
        logger.exception("Falha ao sincronizar status WhatsApp.")
    return user_status


@router.get("/api/chat/sincronizacao")
async def obter_sincronizacao_whatsapp(user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    state = contact_sync_state(resolved_user_id)
    if state.get("status") == "idle":
        cache = await load_whatsapp_catalog_cache(resolved_user_id)
        contacts = [item for item in (cache.get("contacts") or []) if isinstance(item, dict)]
        chats = [item for item in (cache.get("chats") or []) if isinstance(item, dict)]
        catalog_items = _dedupe_catalog_items([*contacts, *chats])
        contacts_fresh = catalog_cache_is_fresh(
            cache, "contactsSyncedAt", WHATSAPP_CONTACT_SYNC_TTL_SECONDS
        )
        chats_fresh = bool(chats) and catalog_cache_is_fresh(cache, "catalogSyncedAt")
        partial_cached = bool(cache.get("catalogPartial"))
        partial_recent = partial_cached and not contact_sync_retry_due(cache)
        if contacts_fresh or chats_fresh or partial_recent:
            photos = sum(1 for item in contacts if extract_photo_url(item))
            cached_warnings = [
                str(item) for item in (cache.get("catalogWarnings") or []) if item
            ]
            state = update_contact_sync_state(
                resolved_user_id,
                status="partial" if partial_cached else "complete",
                phase="partial" if partial_cached else "complete",
                progress=99 if partial_cached else 100,
                current=len(catalog_items),
                total=len(catalog_items),
                contactsSynced=len(contacts),
                photosSynced=photos,
                requiresPro=bool(cache.get("requiresPro")),
                reconnectRequired=bool(cache.get("reconnectRequired")),
                partial=partial_cached,
                warnings=cached_warnings,
                message=(
                    "Sincronizacao parcial; dados conhecidos preservados."
                    if partial_cached
                    else f"{len(contacts)} contato(s) e {len(chats)} conversa(s) sincronizados."
                ),
            )
    return dict(state)


@router.post("/api/chat/sincronizacao")
async def iniciar_sincronizacao_whatsapp(user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    status = await wapi_connect.status(resolved_user_id)
    if status.get("status") != "conectado":
        raise HTTPException(status_code=409, detail="WhatsApp nao esta conectado nesta conta.")
    return schedule_contact_sync(resolved_user_id, force=True)


@router.get("/api/chat/status-whatsapp")
async def listar_status_whatsapp(user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    async with whatsapp_conversation_mutation_lock(resolved_user_id):
        db = await load_conversations(resolved_user_id)
        if await _migrate_legacy_status_conversations_unlocked(resolved_user_id, db):
            await save_conversations(db, resolved_user_id)
    feed = await load_whatsapp_status_feed(resolved_user_id)
    cutoff = int(time.time()) - 24 * 60 * 60
    items = [
        item for item in (feed.get("items") or [])
        if isinstance(item, dict) and int(item.get("timestamp") or 0) >= cutoff
    ]
    items.sort(key=lambda item: int(item.get("timestamp") or 0), reverse=True)
    serialized_items: list[Dict[str, Any]] = []
    for item in items:
        media_type = str((item.get("midiaMeta") or {}).get("type") or "").lower()
        status_type = "text"
        if media_type in {"image", "video", "audio"}:
            status_type = media_type
        elif item.get("tipo") == "midia":
            mime = str(item.get("arquivoMime") or "")
            status_type = "video" if mime.startswith("video/") else "image"
        elif item.get("tipo") == "audio":
            status_type = "audio"
        serialized_items.append(
            {
                **item,
                "name": item.get("contactName") or item.get("contactId"),
                "type": status_type,
                "text": item.get("texto") or "",
                "mediaUrl": item.get("arquivoUrl"),
                "viewed": bool(item.get("visualizado")),
                "mine": bool(item.get("fromMe")),
                "color": item.get("color"),
            }
        )
    return {
        "items": serialized_items,
        "unviewedCount": sum(1 for item in items if not item.get("visualizado") and not item.get("fromMe")),
        "canPublish": False,
    }


@router.post("/api/chat/status-whatsapp")
async def publicar_status_whatsapp(
    payload: PublicarStatusPayload,
    user: dict[str, Any] = Depends(current_user),
):
    assert_channel_permission(user, "whatsapp")
    # A documentação pública atual da W-API não expõe endpoint de publicação de
    # Status. Não simula sucesso nem transforma Status em mensagem comum.
    raise HTTPException(
        status_code=501,
        detail="Publicacao de Status ainda nao e suportada pela API oficial W-API.",
    )


@router.post("/api/chat/status-whatsapp/{status_id}/visualizar")
async def visualizar_status_whatsapp(
    status_id: str,
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    async with whatsapp_conversation_mutation_lock(resolved_user_id):
        feed = await load_whatsapp_status_feed(resolved_user_id)
        items = [item for item in (feed.get("items") or []) if isinstance(item, dict)]
        target = next((item for item in items if str(item.get("id") or "") == status_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Status nao encontrado ou expirado.")
        target["visualizado"] = True
        target["visualizadoEm"] = time.time()
        await save_whatsapp_status_feed(
            resolved_user_id,
            {**feed, "items": items, "updatedAt": time.time()},
        )

    synced = False
    creds = wapi_creds(resolved_user_id)
    if creds:
        try:
            await wapi_client.read_message(creds[0], creds[1], "status@broadcast", status_id)
            synced = True
        except WapiError:
            # A visualização local é mantida mesmo quando a instância/planos não
            # aceitam confirmação de leitura para Status.
            synced = False
    return {"status": "visualizado", "synced": synced}


@router.get("/api/chat/perfil-whatsapp")
async def obter_perfil_whatsapp(user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    connection = await wapi_connect.status(resolved_user_id)
    if connection.get("status") != "conectado":
        return {"connected": False, "status": connection.get("status")}
    creds = wapi_creds(resolved_user_id)
    device: Dict[str, Any] = {}
    if creds:
        try:
            device = await wapi_client.device(creds[0], creds[1])
        except WapiError:
            device = {}
    phone = device.get("connectedPhone") or connection.get("numero")
    photo_url = extract_photo_url(device)
    if not photo_url and phone:
        photo_url = await fetch_profile_picture(resolved_user_id, str(phone))
    return {
        "connected": True,
        "status": "conectado",
        "phone": phone,
        "lid": device.get("connectedLid") or device.get("lid"),
        "name": device.get("name") or device.get("pushName") or device.get("notify") or phone or "WhatsApp",
        "notify": device.get("notify") or device.get("pushName"),
        "bio": device.get("bio") or device.get("statusMessage") or device.get("status"),
        "photoUrl": photo_url,
        "photoFetchedAt": time.time() if photo_url else None,
        "connectedAt": connection.get("conectadoEm"),
    }


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
        if status == "conectado":
            schedule_contact_sync(resolved_user_id)
        return {
            "status": status,
            "qrcode": None if status == "conectado" else resultado.get("qrcode"),
            "sincronizacao": dict(contact_sync_state(resolved_user_id)),
        }
    raise HTTPException(status_code=503, detail="API do WhatsApp ainda nao esta disponivel.")


@router.post("/api/chat/desconectar")
async def desconectar_whatsapp(user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    # Desconexão LOCAL: remove o WhatsApp apenas do Norium, SEM chamar o
    # /instance/disconnect da W-API — esse endpoint desloga a conta inteira e
    # derruba o celular e os demais aparelhos. Aqui limpamos só o vínculo e o
    # cache locais; os outros dispositivos do usuário permanecem conectados.
    sync_task = whatsapp_contact_sync_tasks.pop(resolved_user_id, None)
    if sync_task and not sync_task.done():
        sync_task.cancel()
    # Compartilha o lock com sincronização e webhooks. O vínculo é removido antes
    # dos caches para que qualquer evento que já resolveu o tenant, mas ainda
    # aguardava o lock, falhe na reconfirmação e não grave dados após a limpeza.
    async with whatsapp_conversation_mutation_lock(resolved_user_id):
        wb.clear_binding(resolved_user_id)
        await save_conversations({}, resolved_user_id)
        await save_whatsapp_catalog_cache(resolved_user_id, {})
        await save_whatsapp_status_feed(resolved_user_id, {"items": []})
        whatsapp_contact_sync_states.pop(resolved_user_id, None)
    for cache_key in [key for key in profile_photo_attempt_cache if key.startswith(f"{resolved_user_id}:")]:
        profile_photo_attempt_cache.pop(cache_key, None)
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
    instance_id = wapi_webhook.instance_id(data)
    owner_user_id = wb.owner_of_instance(instance_id) if instance_id else None
    if not owner_user_id:
        # Nao revela a existencia de instancias de terceiros.
        raise HTTPException(status_code=404, detail="Evento nao reconhecido.")

    # 3) Deduplicacao por (instancia + tipo de evento + id). Recebido e status
    #    compartilham o messageId, entao a chave inclui o tipo/status. Eventos em
    #    voo aguardam o primeiro processamento; apenas sucesso entra no cache.
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
    dedup_id = ""
    processing_future: asyncio.Future[bool] | None = None
    if raw_id:
        status_token = ""
        if kind == wapi_webhook.EVENT_STATUS:
            wrapped_status = data.get("data") if isinstance(data.get("data"), dict) else {}
            status_token = str(
                data.get("status") or data.get("ack") or data.get("state")
                or data.get("chatStatus") or data.get("unreadCount")
                or wrapped_status.get("status") or wrapped_status.get("ack") or wrapped_status.get("state")
                or wrapped_status.get("chatStatus") or wrapped_status.get("unreadCount") or ""
            ).strip().lower()
        dedup_id = f"{instance_id}:{kind}:{raw_id}:{status_token}"
        while True:
            if dedup_id in whatsapp_webhook_event_cache:
                return {"status": "duplicate"}
            active = whatsapp_webhook_inflight.get(dedup_id)
            if active is None:
                processing_future = asyncio.get_running_loop().create_future()
                whatsapp_webhook_inflight[dedup_id] = processing_future
                break
            if await asyncio.shield(active):
                return {"status": "duplicate"}

    # 4) Dispatch por tipo de evento.
    try:
        if wapi_webhook.is_status_broadcast(data):
            result = await _wapi_handle_status_broadcast(owner_user_id, data)
        elif kind == wapi_webhook.EVENT_RECEIVED:
            result = await _wapi_handle_received(owner_user_id, data)
        elif kind == wapi_webhook.EVENT_STATUS:
            # Algumas configurações usam webhookDelivery ("Ao enviar") para
            # entregar também o conteúdo da mensagem criada no celular. Nesse
            # caso ela precisa aparecer no Norium como fromMe, além do ACK.
            adapted_outgoing = wapi_webhook.adapt_incoming(data)
            if (
                adapted_outgoing
                and adapted_outgoing.get("fromMe")
                and (
                    adapted_outgoing.get("texto")
                    or adapted_outgoing.get("tipo") not in {None, "texto"}
                    or adapted_outgoing.get("midiaMeta")
                )
            ):
                received_result = await _wapi_handle_received(owner_user_id, data)
                status_result = await _wapi_handle_status(owner_user_id, data)
                result = {
                    "status": "success"
                    if "success" in {received_result.get("status"), status_result.get("status")}
                    else received_result.get("status") or status_result.get("status") or "ignored",
                    "event": "outgoing_sync",
                }
            else:
                result = await _wapi_handle_status(owner_user_id, data)
        elif kind == wapi_webhook.EVENT_PRESENCE:
            result = await _wapi_handle_status(owner_user_id, data)
        elif kind in (wapi_webhook.EVENT_CONNECTED, wapi_webhook.EVENT_DISCONNECTED):
            result = await _wapi_handle_connection_event(owner_user_id, kind, data)
        else:
            result = {"status": "ignored", "event": kind}

        if dedup_id:
            whatsapp_webhook_event_cache[dedup_id] = time.time() + 600
        if processing_future is not None and not processing_future.done():
            processing_future.set_result(True)
        return result
    except HTTPException:
        raise
    except Exception:
        logger.exception("Falha ao processar webhook W-API.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao processar webhook.")
    finally:
        if processing_future is not None:
            if not processing_future.done():
                processing_future.set_result(False)
            if whatsapp_webhook_inflight.get(dedup_id) is processing_future:
                whatsapp_webhook_inflight.pop(dedup_id, None)


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
            await mark_whatsapp_conversation_updated(user_id, str(conv.get("id") or msg["chatId"]))
            return {"status": "success", "event": "reaction"}
    return {"status": "ignored", "event": "reaction"}


async def _wapi_handle_received(user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    async with whatsapp_conversation_mutation_lock(user_id):
        if not _webhook_binding_is_current(user_id, data):
            return {"status": "ignored", "event": "stale_binding"}
        return await _wapi_handle_received_unlocked(user_id, data)


async def _wapi_handle_received_unlocked(user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
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
            # Não bloqueia o webhook consultando metadados remotos. O catálogo
            # assíncrono ou a tela de detalhes hidrata nome/foto depois.
            conversa["contato"] = nome_atual or phone
    elif not is_from_me:
        if msg["chatName"]:
            conversa["contato"] = melhor_nome_contato(conversa.get("contato"), msg["chatName"], phone)
        if msg.get("photoUrl"):
            conversa["photoUrl"] = msg["photoUrl"]
            conversa.setdefault("metadados", {})["photoUrl"] = msg["photoUrl"]
            conversa["metadados"]["photoFetchedAt"] = time.time()
        # Se o webhook não trouxer foto, ela é hidratada pelo catálogo/lazy
        # details. Persistir a mensagem não espera outra chamada de rede.
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
    await mark_whatsapp_conversation_updated(user_id, phone)
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


async def _store_status_items_unlocked(
    user_id: str,
    incoming_items: list[Dict[str, Any]],
    *,
    contact_names: Dict[str, str] | None = None,
    contact_photos: Dict[str, str] | None = None,
) -> Dict[str, int]:
    """Mescla Status no feed do tenant sem tocar no banco de conversas."""
    if contact_names is None or contact_photos is None:
        catalog = await load_whatsapp_catalog_cache(user_id)
        cached_contacts = [entry for entry in (catalog.get("contacts") or []) if isinstance(entry, dict)]
        cached_chats = [entry for entry in (catalog.get("chats") or []) if isinstance(entry, dict)]
        names, photos, _metadata = build_contact_indexes([*cached_contacts, *cached_chats])
    else:
        names, photos = contact_names, contact_photos
    feed = await load_whatsapp_status_feed(user_id)
    items = [entry for entry in (feed.get("items") or []) if isinstance(entry, dict)]
    _, current_ts = current_clock()
    added = 0
    updated = 0

    # Um Status pode chegar antes do catálogo de contatos. Reprocessa o feed
    # existente sempre que há índices mais ricos, sem exigir um novo payload.
    for index, existing in enumerate(items):
        contact_id = str(existing.get("contactId") or "")
        enriched = dict(existing)
        enriched["contactName"] = melhor_nome_contato(
            existing.get("contactName"),
            names.get(contact_id),
            contact_id,
        )
        enriched["photoUrl"] = existing.get("photoUrl") or photos.get(contact_id)
        if enriched.get("photoUrl") and not enriched.get("photoFetchedAt"):
            enriched["photoFetchedAt"] = time.time()
        if enriched != existing:
            items[index] = enriched
            updated += 1

    by_id = {str(entry.get("id") or ""): index for index, entry in enumerate(items)}

    for raw_item in incoming_items:
        if not isinstance(raw_item, dict):
            continue
        item = dict(raw_item)
        item["timestamp"] = int(item.get("timestamp") or current_ts)
        item["id"] = str(item.get("id") or f"status_{item['timestamp']}_{uuid.uuid4().hex[:8]}")
        item["horario"] = item.get("horario") or format_whatsapp_time(item["timestamp"])
        item["visualizado"] = bool(item.get("visualizado", item.get("fromMe")))
        item["visualizadoEm"] = (
            item.get("visualizadoEm") or item["timestamp"]
            if item["visualizado"]
            else None
        )
        contact_id = str(item.get("contactId") or "")
        item["contactName"] = melhor_nome_contato(
            item.get("contactName"),
            names.get(contact_id),
            contact_id,
        )
        item["photoUrl"] = item.get("photoUrl") or photos.get(contact_id)
        if item.get("photoUrl"):
            item["photoFetchedAt"] = item.get("photoFetchedAt") or time.time()

        # Imagem/vídeo é baixado sob demanda. Figurinha continua sem URL nem
        # metadados de mídia, para não poluir a galeria de Status.
        if item.get("midiaMeta") and item.get("tipo") != "sticker":
            item["arquivoUrl"] = item.get("arquivoUrl") or whatsapp_media_url(
                item["id"], "status@broadcast"
            )
            item["arquivoMime"] = item.get("arquivoMime") or item["midiaMeta"].get("mimetype")
        elif item.get("tipo") == "sticker":
            item["midiaMeta"] = None
            item["arquivoUrl"] = None

        existing_index = by_id.get(item["id"])
        if existing_index is None:
            by_id[item["id"]] = len(items)
            items.append(item)
            added += 1
            continue
        existing = items[existing_index]
        merged = {
            **existing,
            **{key: value for key, value in item.items() if value not in (None, "")},
        }
        if existing.get("visualizado"):
            merged["visualizado"] = True
            merged["visualizadoEm"] = existing.get("visualizadoEm") or merged.get("visualizadoEm")
        if merged != existing:
            items[existing_index] = merged
            updated += 1

    cutoff = int(time.time()) - 48 * 60 * 60
    filtered = [entry for entry in items if int(entry.get("timestamp") or 0) >= cutoff]
    filtered.sort(key=lambda entry: int(entry.get("timestamp") or 0))
    if added or updated or len(filtered) != len(items):
        await save_whatsapp_status_feed(
            user_id,
            {"items": filtered[-500:], "updatedAt": time.time()},
        )
    return {"added": added, "updated": updated}


async def _store_status_payloads_unlocked(
    user_id: str,
    payloads: list[Dict[str, Any]],
    *,
    contact_names: Dict[str, str] | None = None,
    contact_photos: Dict[str, str] | None = None,
) -> Dict[str, int]:
    adapted = [
        item
        for item in (wapi_webhook.adapt_status_broadcast(payload) for payload in payloads)
        if item is not None
    ]
    return await _store_status_items_unlocked(
        user_id,
        adapted,
        contact_names=contact_names,
        contact_photos=contact_photos,
    )


def _is_technical_status_conversation(
    conversation_id: str,
    conversation: Dict[str, Any],
) -> bool:
    """Reconhece IDs técnicos sem usar o nome humano do contato como prova."""
    metadata = conversation.get("metadados") if isinstance(conversation.get("metadados"), dict) else {}
    identifiers = (
        conversation_id,
        conversation.get("id"),
        metadata.get("numeroCompleto"),
        metadata.get("chatId"),
        metadata.get("remoteJid"),
        metadata.get("jid"),
    )
    return any(wapi_webhook.is_status_broadcast({"chatId": value}) for value in identifiers if value)


async def _migrate_legacy_status_conversations_unlocked(
    user_id: str,
    db: Dict[str, Any],
) -> bool:
    """Move Status persistidos por versões antigas ao feed antes de removê-los."""
    technical_ids = [
        conversation_id
        for conversation_id, conversation in db.items()
        if isinstance(conversation, dict)
        and _is_technical_status_conversation(conversation_id, conversation)
    ]
    if not technical_ids:
        return False

    migrated_items: list[Dict[str, Any]] = []
    for conversation_id in technical_ids:
        conversation = db[conversation_id]
        metadata = conversation.get("metadados") if isinstance(conversation.get("metadados"), dict) else {}
        contact_name = str(conversation.get("contato") or "").strip()
        if wapi_webhook.is_status_broadcast({"chatId": contact_name}):
            contact_name = "Status do WhatsApp"
        for message in conversation.get("mensagens") or []:
            if not isinstance(message, dict):
                continue
            message_id = str(message.get("id") or "")
            sender_id = str(message.get("remetenteId") or "").strip()
            migrated_items.append(
                {
                    "id": message_id or f"legacy_status_{uuid.uuid4().hex[:12]}",
                    "contactId": sender_id or contact_name or f"legacy:{conversation_id}",
                    "contactName": message.get("remetenteNome") or contact_name or "Status do WhatsApp",
                    "photoUrl": conversation.get("photoUrl") or metadata.get("photoUrl"),
                    "fromMe": message.get("remetente") == "usuario",
                    "timestamp": int(message.get("timestamp") or conversation.get("timestampUltimaMsg") or 0),
                    "horario": message.get("horario"),
                    "texto": message.get("texto") or "",
                    "tipo": message.get("tipo") or "texto",
                    "midiaMeta": message.get("midiaMeta"),
                    "arquivoUrl": message.get("arquivoUrl"),
                    "arquivoMime": message.get("arquivoMime"),
                    "visualizado": bool(message.get("remetente") == "usuario" or conversation.get("lida")),
                }
            )

    # Só remove o legado depois que a gravação do feed concluiu sem exceção.
    await _store_status_items_unlocked(user_id, migrated_items)
    for conversation_id in technical_ids:
        db.pop(conversation_id, None)
    return True


async def _wapi_handle_status_broadcast(user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Armazena Status em feed próprio, nunca no banco de conversas."""
    payloads = wapi_webhook.status_broadcast_payloads(data)
    if not payloads:
        return {"status": "ignored", "event": "status_broadcast"}
    async with whatsapp_conversation_mutation_lock(user_id):
        if not _webhook_binding_is_current(user_id, data):
            return {"status": "ignored", "event": "stale_binding"}
        result = await _store_status_payloads_unlocked(user_id, payloads)
    if result["added"]:
        return {"status": "success", "event": "status_broadcast"}
    if result["updated"]:
        return {"status": "success", "event": "status_broadcast"}
    return {"status": "duplicate", "event": "status_broadcast"}


async def _wapi_handle_status(user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    async with whatsapp_conversation_mutation_lock(user_id):
        if not _webhook_binding_is_current(user_id, data):
            return {"status": "ignored", "event": "stale_binding"}
        return await _wapi_handle_status_unlocked(user_id, data)


async def _wapi_handle_status_unlocked(user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    message_id, status = wapi_webhook.extract_status_update(data)
    db = await load_conversations(user_id)
    changed = False
    changed_conversation_id = ""
    if message_id and status:
        for conversation_id, conversation in db.items():
            if not isinstance(conversation, dict):
                continue
            for stored_message in conversation.get("mensagens") or []:
                if str(stored_message.get("id") or "") == message_id:
                    stored_message["status"] = status
                    if conversation.get("ultimaMensagemMinha") and (
                        str((conversation.get("mensagens") or [{}])[-1].get("id") or "") == message_id
                    ):
                        conversation["statusUltimaMensagem"] = status
                    changed = True
                    changed_conversation_id = str(conversation.get("id") or conversation_id)
                    break
            if changed:
                break

    # Leitura realizada no celular/WhatsApp Web chega pelo webhook de status
    # do chat. Atualiza o contador local para todos os clientes do Norium.
    chat_id, is_read, unread_count = wapi_webhook.extract_chat_status_update(data)
    if chat_id and chat_id in db and (is_read is not None or unread_count is not None):
        conversation = db[chat_id]
        if unread_count is not None:
            conversation["naoLidasCount"] = unread_count
        elif is_read:
            conversation["naoLidasCount"] = 0
        conversation["lida"] = bool(is_read) if is_read is not None else int(conversation.get("naoLidasCount") or 0) == 0
        db[chat_id] = normalize_conversation(chat_id, conversation)
        changed = True
        changed_conversation_id = chat_id
    presence = str(data.get("presence") or data.get("chatPresence") or "").strip().lower()
    if chat_id and chat_id in db and presence in {
        "available", "online", "composing", "recording", "unavailable", "offline", "paused",
    }:
        conversation = db[chat_id]
        conversation.setdefault("metadados", {})["statusOnline"] = presence in {
            "available", "online", "composing", "recording",
        }
        db[chat_id] = normalize_conversation(chat_id, conversation)
        changed = True
        changed_conversation_id = chat_id
    if changed:
        await save_conversations(db, user_id)
        if changed_conversation_id:
            await mark_whatsapp_conversation_updated(user_id, changed_conversation_id)
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
    if kind == wapi_webhook.EVENT_CONNECTED:
        update_contact_sync_state(
            user_id,
            status="syncing",
            phase="waiting",
            progress=0,
            current=0,
            total=0,
            message="WhatsApp conectado. Iniciando sincronizacao...",
            contactsSynced=0,
            photosSynced=0,
        )
        try:
            schedule_contact_sync(user_id, force=True)
        except RuntimeError:
            # Testes síncronos ou encerramento do worker: a próxima consulta de
            # status retoma a sincronização, sem perder o sinal de pendência.
            pass
    return {"status": "success", "event": kind}


async def _wapi_handle_connection_event(
    user_id: str,
    kind: str,
    data: Dict[str, Any],
) -> Dict[str, Any]:
    """Aplica conexão/desconexão apenas se a instância ainda pertence ao tenant."""
    async with whatsapp_conversation_mutation_lock(user_id):
        if not _webhook_binding_is_current(user_id, data):
            return {"status": "ignored", "event": "stale_binding"}
        return _wapi_handle_connection(user_id, kind)


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
    async with whatsapp_conversation_mutation_lock(resolved_user_id):
        db = await load_conversations(resolved_user_id)
        # Versões antigas gravavam o pseudo-chat ``status`` junto das conversas.
        # Migra primeiro ao feed exclusivo e só então remove o registro técnico.
        if await _migrate_legacy_status_conversations_unlocked(resolved_user_id, db):
            await save_conversations(db, resolved_user_id)
    catalog_cache = await load_whatsapp_catalog_cache(resolved_user_id)

    if since is not None:
        # O webhook/evento em tempo real ja atualiza o cache. Um delta nunca
        # abre uma varredura completa no navegador do WhatsApp: isso evitava
        # que simples cliques em contatos derrubassem a sessao.
        conversation_updates = (
            catalog_cache.get("conversationUpdates")
            if isinstance(catalog_cache.get("conversationUpdates"), dict)
            else {}
        )
        changed_items: list[Dict[str, Any]] = []
        for conversation_id, conversation in db.items():
            update_timestamp = int(conversation_updates.get(conversation_id) or 0)
            message_timestamp = max(
                [
                    int(conversation.get("timestampUltimaMsg") or 0),
                    *[
                        int(message.get("timestamp") or 0)
                        for message in conversation.get("mensagens", [])
                        if isinstance(message, dict)
                    ],
                ]
            )
            delta_timestamp = max(message_timestamp, update_timestamp)
            if delta_timestamp <= since:
                continue
            item = normalize_conversation(conversation_id, conversation)
            item["timestampAtualizacao"] = update_timestamp or message_timestamp
            item["updatedAt"] = item["timestampAtualizacao"]
            changed_items.append(item)
        changed_items.sort(
            key=lambda item: int(item.get("timestampAtualizacao") or item.get("timestampUltimaMsg") or 0),
            reverse=True,
        )
        cursor = max(
            [
                since,
                *[
                    int(item.get("timestampAtualizacao") or item.get("timestampUltimaMsg") or 0)
                    for item in changed_items
                ],
            ],
        )
        return {
            "items": changed_items[:limit],
            "cursor": cursor,
            "hasMore": len(changed_items) > limit,
        }

    if db and not refresh and catalog_cache_is_fresh(catalog_cache):
        return sorted_conversations(db)
    running_sync = whatsapp_contact_sync_tasks.get(resolved_user_id)
    if running_sync and not running_sync.done():
        # O bootstrap já está buscando todas as páginas em background. Não
        # duplica a mesma varredura no request da lista; o frontend recebe o
        # snapshot local imediatamente e o próximo delta traz o catálogo.
        return sorted_conversations(db)

    # A conectividade é consultada somente quando o snapshot local realmente
    # precisa de atualização. Polling incremental e cache fresco não podem
    # ficar bloqueados por tentativas/retries da API externa.
    whatsapp_status = await wapi_connect.status(resolved_user_id)
    if whatsapp_status.get("status") != "conectado":
        if db and catalog_cache.get("authenticatedAt"):
            return sorted_conversations(db)
        return []

    # A listagem é um caminho interativo e não pode aguardar paginação remota,
    # fotos ou metadados. O worker atualiza o store/cache em background; o
    # frontend recebe imediatamente o snapshot local e depois consulta o delta.
    if refresh or contact_sync_retry_due(catalog_cache):
        schedule_contact_sync(resolved_user_id, force=refresh)
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
    catalog_cache = await load_whatsapp_catalog_cache(resolved_user_id)
    cached_contacts = [
        item for item in (catalog_cache.get("contacts") or []) if isinstance(item, dict)
    ]
    cached_chats = [
        item for item in (catalog_cache.get("chats") or []) if isinstance(item, dict)
    ]
    contact_names, contact_photos, contact_metadata = build_contact_indexes(
        [*cached_contacts, *cached_chats, *contact_records_from_conversations(db)]
    )
    catalog_enriched = False
    if not is_group_chat(conversa_id, conversation):
        catalog_name = _lookup_contact_index(contact_names, conversa_id)
        catalog_photo = _lookup_contact_index(contact_photos, conversa_id)
        catalog_meta = _lookup_contact_index(contact_metadata, conversa_id) or {}
        if catalog_name:
            conversation["contato"] = melhor_nome_contato(conversation.get("contato"), catalog_name, conversa_id)
            catalog_enriched = True
        if catalog_photo:
            conversation["photoUrl"] = catalog_photo
            catalog_enriched = True
        if catalog_meta:
            conversation.setdefault("metadados", {}).update({
                key: value for key, value in catalog_meta.items() if value is not None
            })
            catalog_enriched = True
        if not conversation.get("photoUrl"):
            fresh_photo = await fetch_profile_picture(resolved_user_id, conversa_id)
            if fresh_photo:
                conversation["photoUrl"] = fresh_photo
                conversation.setdefault("metadados", {})["photoUrl"] = fresh_photo
                catalog_enriched = True
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
        if isinstance(details.get("group"), dict):
            details = details["group"]
        raw_participants = details.get("participants") or []
        if not raw_participants and creds:
            try:
                participants_payload = await wapi_client.group_participants(
                    creds[0], creds[1], conversa_id
                )
                raw_participants = participants_payload.get("participants") or []
            except WapiError:
                raw_participants = []
        participants = normalize_group_participants(
            raw_participants or metadata.get("participantes") or [],
            contact_names,
            contact_photos,
        )
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
                "participantes": participants,
                "participantesCount": int(
                    details.get("size") or details.get("participantsCount") or len(participants)
                ),
                "criadoPor": details.get("owner") or metadata.get("criadoPor"),
                "criadoEm": details.get("createdAt") or metadata.get("criadoEm"),
            }
        )
        conversation["metadados"] = metadata
        async with whatsapp_conversation_mutation_lock(resolved_user_id):
            latest_db = await load_conversations(resolved_user_id)
            latest = latest_db.get(conversa_id) or conversation
            latest["contato"] = conversation.get("contato") or latest.get("contato")
            latest["esGrupo"] = True
            latest.setdefault("metadados", {}).update(metadata)
            if conversation.get("photoUrl"):
                latest["photoUrl"] = conversation["photoUrl"]
            latest_db[conversa_id] = normalize_conversation(conversa_id, latest)
            await save_conversations(latest_db, resolved_user_id)
            return latest_db[conversa_id]

    normalized = normalize_conversation(conversa_id, conversation)
    if catalog_enriched:
        db[conversa_id] = normalized
        await save_conversations(db, resolved_user_id)
    return normalized


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
    if not media_meta and (
        not resolved_conversation_id
        or wapi_webhook.is_status_broadcast({"chatId": resolved_conversation_id})
    ):
        status_feed = await load_whatsapp_status_feed(resolved_user_id)
        for item in status_feed.get("items") or []:
            if str(item.get("id") or "") == message_id and isinstance(item.get("midiaMeta"), dict):
                media_meta = item["midiaMeta"]
                resolved_conversation_id = "status@broadcast"
                break
    if not media_meta:
        raise HTTPException(status_code=404, detail="Midia indisponivel no WhatsApp.")
    media_key = str(media_meta.get("mediaKey") or "")
    direct_path = str(media_meta.get("directPath") or "")
    payload: Dict[str, Any] = {}
    if creds and media_key and direct_path:
        try:
            payload = await wapi_client.download_media(
                creds[0], creds[1],
                media_key=media_key,
                direct_path=direct_path,
                media_type=str(media_meta.get("type") or ""),
                mimetype=str(media_meta.get("mimetype") or ""),
            )
        except WapiError:
            # Miniatura/link de catálogo ainda pode manter o Status visível.
            payload = {}
    inline, link = unpack_wapi_media_response(payload)
    fallback_mime = str(media_meta.get("mimetype") or "application/octet-stream")
    file_bytes: bytes | None = None
    mime_type = fallback_mime
    if isinstance(inline, str) and inline:
        # base64 / data URI
        if inline.startswith("data:"):
            file_bytes, mime_type = decode_data_url(inline, fallback_mime)
        else:
            try:
                file_bytes = base64.b64decode(inline, validate=True)
            except Exception:
                file_bytes = None
            mime_type = fallback_mime
    elif isinstance(link, str) and link.startswith("https://"):
        # A W-API entrega a midia decriptada por uma URL temporaria (fileLink).
        try:
            res_link = await fetch_external_whatsapp_media(link, timeout=60.0)
            if res_link.status_code == 200:
                file_bytes = res_link.content
                mime_type = res_link.headers.get("Content-Type", fallback_mime)
        except HTTPException as exc:
            if exc.status_code == 400:
                raise
            file_bytes = None
        except httpx.HTTPError:
            file_bytes = None

    source_url = media_meta.get("sourceUrl")
    if file_bytes is None and isinstance(source_url, str) and source_url:
        if source_url.startswith("data:"):
            try:
                file_bytes, mime_type = decode_data_url(source_url, fallback_mime)
            except HTTPException:
                file_bytes = None
        elif source_url.startswith("https://"):
            try:
                res_source = await fetch_external_whatsapp_media(source_url, timeout=60.0)
                if res_source.status_code == 200:
                    file_bytes = res_source.content
                    mime_type = res_source.headers.get("Content-Type", fallback_mime)
            except HTTPException as exc:
                if exc.status_code == 400:
                    raise
                file_bytes = None
            except httpx.HTTPError:
                file_bytes = None

    thumbnail = media_meta.get("thumbnail")
    media_type = str(media_meta.get("type") or "").strip().lower()
    if file_bytes is None and media_type == "image" and isinstance(thumbnail, str) and thumbnail:
        if thumbnail.startswith("data:"):
            try:
                file_bytes, mime_type = decode_data_url(thumbnail, "image/jpeg")
            except HTTPException:
                file_bytes = None
        elif thumbnail.startswith("https://"):
            try:
                res_thumbnail = await fetch_external_whatsapp_media(thumbnail, timeout=25.0)
                if res_thumbnail.status_code == 200:
                    file_bytes = res_thumbnail.content
                    mime_type = res_thumbnail.headers.get("Content-Type", "image/jpeg")
            except HTTPException as exc:
                if exc.status_code == 400:
                    raise
                file_bytes = None
            except httpx.HTTPError:
                file_bytes = None
        else:
            try:
                file_bytes = base64.b64decode(thumbnail, validate=True)
                mime_type = "image/jpeg"
            except Exception:
                file_bytes = None

    if not file_bytes:
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


def normalize_group_participants(
    participants: Any,
    contact_names: Dict[str, str] | None = None,
    contact_photos: Dict[str, str] | None = None,
) -> list[Dict[str, Any]]:
    names = contact_names or {}
    photos = contact_photos or {}
    normalized: list[Dict[str, Any]] = []
    seen: set[str] = set()
    for raw in participants if isinstance(participants, list) else []:
        participant = raw if isinstance(raw, dict) else {"id": raw}
        participant_id = _contact_primary_id(participant)
        if not participant_id or participant_id in seen:
            continue
        seen.add(participant_id)
        raw_admin = participant.get("admin")
        if isinstance(raw_admin, bool):
            admin_role = "admin" if raw_admin else None
        else:
            admin_role = str(raw_admin or participant.get("role") or "").strip().lower() or None
        is_admin = bool(
            participant.get("isAdmin")
            or participant.get("isSuperAdmin")
            or admin_role in {"admin", "superadmin", "owner"}
        )
        name = (
            _contact_display_name(participant, participant_id)
            or _lookup_contact_index(names, participant_id)
        )
        photo = extract_photo_url(participant) or _lookup_contact_index(photos, participant_id)
        normalized.append(
            {
                "id": participant_id,
                "phone": wapi_phone(participant_id),
                "name": name or wapi_phone(participant_id),
                "admin": admin_role,
                "isAdmin": is_admin,
                "isSuperAdmin": bool(participant.get("isSuperAdmin") or admin_role in {"superadmin", "owner"}),
                "photoUrl": photo,
            }
        )
    return normalized


def normalize_group_payload(
    group: Dict[str, Any],
    contact_names: Dict[str, str] | None = None,
    contact_photos: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    wrapped = group.get("group") if isinstance(group.get("group"), dict) else group
    group_id = str(
        wrapped.get("id")
        or wrapped.get("groupId")
        or wrapped.get("jid")
        or wrapped.get("phone")
        or ""
    )
    participants = normalize_group_participants(
        wrapped.get("participants") or wrapped.get("participantes") or [],
        contact_names,
        contact_photos,
    )
    return {
        "id": group_id,
        "name": (
            wrapped.get("subject")
            or wrapped.get("name")
            or wrapped.get("formattedName")
            or wrapped.get("notify")
            or group_id
        ),
        "description": wrapped.get("description") or wrapped.get("desc") or "",
        "photoUrl": extract_photo_url(wrapped),
        "participants": participants,
        "participantsCount": int(
            wrapped.get("participantsCount") or wrapped.get("size") or len(participants)
        ),
        "owner": wrapped.get("owner") or wrapped.get("creator") or wrapped.get("subjectOwner"),
        "createdAt": wrapped.get("creation") or wrapped.get("createdAt"),
        "inviteLink": wrapped.get("inviteLink") or wrapped.get("inviteCode"),
        "isCommunity": bool(wrapped.get("isCommunity") or wrapped.get("community")),
    }


def normalize_channel_payload(channel: Dict[str, Any]) -> Dict[str, Any] | None:
    wrapped = channel.get("newsletter") if isinstance(channel.get("newsletter"), dict) else channel
    channel_id = _identifier_value(
        wrapped.get("id")
        or wrapped.get("jid")
        or wrapped.get("chatId")
        or wrapped.get("newsletterId")
        or wrapped.get("channelId")
    )
    if not channel_id.lower().endswith("@newsletter"):
        return None
    name = _contact_display_name(wrapped, channel_id) or channel_id
    description = str(
        wrapped.get("description")
        or wrapped.get("desc")
        or wrapped.get("about")
        or wrapped.get("bio")
        or ""
    ).strip()
    verified_value = (
        wrapped.get("verified")
        or wrapped.get("isVerified")
        or wrapped.get("verifiedName")
        or wrapped.get("verifiedBusinessName")
    )
    normalized: Dict[str, Any] = {
        "id": channel_id,
        "name": name,
        "description": description,
        "photoUrl": extract_photo_url(wrapped),
        "verified": bool(verified_value),
    }
    unread_count = wrapped.get("unreadCount")
    if unread_count is None:
        unread_count = wrapped.get("unread")
    if unread_count is not None:
        try:
            normalized["unreadCount"] = max(0, int(float(unread_count)))
        except (TypeError, ValueError):
            pass
    timestamp_value = (
        wrapped.get("lastMessageTime")
        or wrapped.get("timestamp")
        or wrapped.get("updatedAt")
    )
    timestamp = normalize_whatsapp_timestamp(timestamp_value)
    if timestamp:
        normalized["timestamp"] = timestamp
    return normalized


@router.get("/api/chat/canais")
async def listar_canais_whatsapp(user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    cache = await load_whatsapp_catalog_cache(resolved_user_id)
    if (
        not catalog_cache_is_fresh(cache, "channelsSyncedAt")
        and contact_sync_retry_due(cache)
        and wapi_creds(resolved_user_id)
    ):
        schedule_contact_sync(resolved_user_id, force=True)

    dedicated_channels = [
        item for item in (cache.get("channels") or []) if isinstance(item, dict)
    ]
    legacy_channels = [
        item
        for key in ("contacts", "chats")
        for item in (cache.get(key) or [])
        if isinstance(item, dict) and _newsletter_catalog_id(item)
    ]
    channel_records = merge_catalog_items(legacy_channels, dedicated_channels)
    items_by_id: Dict[str, Dict[str, Any]] = {}
    for item in channel_records:
        normalized = normalize_channel_payload(item)
        if normalized is None:
            continue
        channel_id = str(normalized["id"])
        current = items_by_id.get(channel_id)
        if current is None:
            items_by_id[channel_id] = dict(normalized)
            continue
        for key, value in normalized.items():
            if value in (None, "", [], {}):
                continue
            if key == "verified" and value is True:
                current[key] = True
            elif current.get(key) in (None, "") or (key == "name" and current.get(key) == channel_id):
                current[key] = value
    items = list(items_by_id.values())
    items.sort(
        key=lambda item: (int(item.get("timestamp") or 0), str(item.get("name") or "").lower()),
        reverse=True,
    )
    return {"items": items}


@router.get("/api/chat/grupos")
async def listar_grupos(user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    creds = wapi_creds(resolved_user_id)
    if not creds:
        raise HTTPException(status_code=409, detail="WhatsApp nao esta conectado nesta conta.")
    try:
        payload = await wapi_client.get_all_groups(creds[0], creds[1])
    except WapiError as exc:
        raise _messaging_http_error(exc, "A API do WhatsApp nao conseguiu listar os grupos.") from exc
    raw_groups = parse_whatsapp_collection(payload)
    catalog = await load_whatsapp_catalog_cache(resolved_user_id)
    contact_names, contact_photos, _contact_metadata = build_contact_indexes(
        [
            *[item for item in (catalog.get("contacts") or []) if isinstance(item, dict)],
            *[item for item in (catalog.get("chats") or []) if isinstance(item, dict)],
            *raw_groups,
        ]
    )
    groups = [normalize_group_payload(group, contact_names, contact_photos) for group in raw_groups]
    groups = [group for group in groups if group.get("id")]

    async with whatsapp_conversation_mutation_lock(resolved_user_id):
        db = await load_conversations(resolved_user_id)
        changed = False
        for group in groups:
            group_id = str(group["id"])
            conversation = db.get(group_id) or new_conversation(
                group_id,
                contato=str(group.get("name") or group_id),
                channel="whatsapp",
                is_group=True,
            )
            conversation["contato"] = melhor_nome_contato(
                conversation.get("contato"),
                str(group.get("name") or ""),
                group_id,
            )
            conversation["esGrupo"] = True
            metadata = conversation.setdefault("metadados", {})
            metadata.update(
                {
                    "descricaoGrupo": group.get("description") or "",
                    "participantes": group.get("participants") or [],
                    "participantesCount": group.get("participantsCount") or 0,
                    "criadoPor": group.get("owner"),
                    "criadoEm": group.get("createdAt"),
                    "inviteLink": group.get("inviteLink"),
                    "isCommunity": bool(group.get("isCommunity")),
                }
            )
            if group.get("photoUrl"):
                conversation["photoUrl"] = group["photoUrl"]
                metadata["photoUrl"] = group["photoUrl"]
            db[group_id] = normalize_conversation(group_id, conversation)
            changed = True
        if changed:
            await save_conversations(db, resolved_user_id)
        items = [db[str(group["id"])] for group in groups if str(group["id"]) in db]
    items.sort(
        key=lambda item: max(
            float((item.get("metadados") or {}).get("recentlyCreatedAt") or 0),
            int(item.get("timestampUltimaMsg") or 0),
        ),
        reverse=True,
    )
    return {"items": items}


@router.get("/api/chat/grupos/{group_id}")
async def obter_grupo(group_id: str, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    if not is_group_chat(group_id):
        raise HTTPException(status_code=400, detail="Identificador de grupo invalido.")
    details = await fetch_group_metadata(resolved_user_id, group_id)
    if details:
        db = await load_conversations(resolved_user_id)
        conversation = db.get(group_id) or new_conversation(
            group_id,
            contato=str(details.get("nome") or group_id),
            channel="whatsapp",
            is_group=True,
        )
        conversation["contato"] = str(details.get("nome") or conversation.get("contato") or group_id)
        conversation["esGrupo"] = True
        metadata = conversation.setdefault("metadados", {})
        metadata.update(
            {
                "descricaoGrupo": details.get("descricaoGrupo") or "",
                "participantes": details.get("participantes") or [],
                "participantesCount": details.get("participantesCount") or 0,
                "criadoPor": details.get("criadoPor"),
                "criadoEm": details.get("criadoEm"),
            }
        )
        if details.get("photoUrl"):
            conversation["photoUrl"] = details["photoUrl"]
            metadata["photoUrl"] = details["photoUrl"]
            metadata["photoFetchedAt"] = time.time()
        async with whatsapp_conversation_mutation_lock(resolved_user_id):
            latest_db = await load_conversations(resolved_user_id)
            latest = latest_db.get(group_id) or conversation
            latest["contato"] = conversation.get("contato") or latest.get("contato")
            latest["esGrupo"] = True
            latest.setdefault("metadados", {}).update(metadata)
            if conversation.get("photoUrl"):
                latest["photoUrl"] = conversation["photoUrl"]
            latest_db[group_id] = normalize_conversation(group_id, latest)
            await save_conversations(latest_db, resolved_user_id)
            return latest_db[group_id]
    db = await load_conversations(resolved_user_id)
    conversation = db.get(group_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Grupo nao encontrado.")
    metadata = conversation.get("metadados") or {}
    return normalize_conversation(group_id, conversation)


@router.post("/api/chat/grupos")
async def criar_grupo(payload: CriarGrupoPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    try:
        result = await wapi_messaging.create_group(
            resolved_user_id,
            payload.nome,
            payload.participantes,
            profile_picture_url=payload.profile_picture_url or "",
            auto_invite=payload.auto_invite,
        )
    except InvalidGroupParticipants as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "A API do WhatsApp nao conseguiu criar o grupo.") from exc
    catalog = await load_whatsapp_catalog_cache(resolved_user_id)
    contact_names, contact_photos, _contact_metadata = build_contact_indexes(
        [
            *[item for item in (catalog.get("contacts") or []) if isinstance(item, dict)],
            *[item for item in (catalog.get("chats") or []) if isinstance(item, dict)],
        ]
    )
    normalized = normalize_group_payload(result, contact_names, contact_photos)
    if not normalized.get("name") or normalized.get("name") == normalized.get("id"):
        normalized["name"] = payload.nome
    if not normalized.get("participants"):
        normalized["participants"] = normalize_group_participants(
            payload.participantes,
            contact_names,
            contact_photos,
        )
        normalized["participantsCount"] = len(normalized["participants"])
    group_id = str(normalized.get("id") or "")
    group_conversation: Dict[str, Any] = normalized
    if group_id:
        now = int(time.time())
        group_conversation = new_conversation(
            group_id,
            contato=str(normalized.get("name") or payload.nome),
            channel="whatsapp",
            is_group=True,
            photo_url=normalized.get("photoUrl"),
            participantes=normalized.get("participants") or [],
            descricao_grupo=str(normalized.get("description") or ""),
        )
        group_conversation["metadados"].update(
            {
                "criadoPor": normalized.get("owner"),
                "criadoEm": normalized.get("createdAt"),
                "inviteLink": normalized.get("inviteLink"),
                "participantesCount": normalized.get("participantsCount") or 0,
                "recentlyCreatedAt": now,
            }
        )
        # Sem mensagens, um grupo novo teria timestamp zero e iria para o fim.
        # O instante local da criação o posiciona no início até a primeira
        # mensagem real assumir a ordenação cronológica.
        group_conversation["timestampUltimaMsg"] = now
        group_conversation["horario"] = format_whatsapp_time(now)
        async with whatsapp_conversation_mutation_lock(resolved_user_id):
            db = await load_conversations(resolved_user_id)
            db[group_id] = normalize_conversation(group_id, group_conversation)
            await save_conversations(db, resolved_user_id)
            group_conversation = db[group_id]
        await mark_whatsapp_conversation_updated(resolved_user_id, group_id)
    return {"status": "criado", "group": group_conversation}


@router.post("/api/chat/encaminhar")
async def encaminhar_mensagens(payload: EncaminharMensagensPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    db = await load_conversations(resolved_user_id)
    sources: list[tuple[str, Dict[str, Any]]] = []
    for message_id in payload.mensagens_ids:
        source = next(
            (
                (conversation_id, message)
                for conversation_id, conversation in db.items()
                if isinstance(conversation, dict)
                for message in (conversation.get("mensagens") or [])
                if isinstance(message, dict) and str(message.get("id") or "") == message_id
            ),
            None,
        )
        if source is None:
            raise HTTPException(status_code=404, detail=f"Mensagem {message_id} nao encontrada.")
        sources.append(source)

    forwarded_ids: list[str] = []
    for source_conversation_id, source in sources:
        source_type = str(source.get("tipo") or "texto")
        source_text = str(source.get("texto") or "")
        source_message_id = str(source.get("id") or "")
        is_media = source_type in {"audio", "midia", "documento", "sticker"}
        try:
            if not is_media:
                result = await wapi_messaging.send_text(
                    resolved_user_id,
                    payload.destino_id,
                    source_text,
                )
                if not result.get("sent"):
                    raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o encaminhamento.")
                new_id = str(result.get("messageId") or "")
                hora, timestamp = current_clock()
                async with whatsapp_conversation_mutation_lock(resolved_user_id):
                    await append_message(
                        payload.destino_id,
                        {
                            "id": new_id,
                            "remetente": "usuario",
                            "texto": source_text,
                            "tipo": "texto",
                            "horario": hora,
                            "timestamp": timestamp,
                            "status": "enviado",
                            "encaminhada": True,
                        },
                        channel="whatsapp",
                        user_id=resolved_user_id,
                    )
            else:
                source_url = str(source.get("arquivoUrl") or "")
                parsed_source = urlparse(source_url)
                local_file = None
                if "/api/chat/uploads/" in parsed_source.path:
                    local_file = user_upload_dir(resolved_user_id) / Path(
                        unquote(parsed_source.path)
                    ).name
                if local_file and local_file.is_file():
                    file_bytes = await asyncio.to_thread(local_file.read_bytes)
                    mime_type = str(source.get("arquivoMime") or "application/octet-stream")
                else:
                    media_response = await obter_midia_whatsapp(
                        source_message_id,
                        source_conversation_id,
                        user,
                    )
                    file_bytes = bytes(media_response.body)
                    mime_type = str(
                        media_response.media_type
                        or source.get("arquivoMime")
                        or "application/octet-stream"
                    )
                file_name = str(source.get("nomeArquivo") or default_file_name(source_type, mime_type) or "arquivo")
                kind = (
                    "sticker"
                    if source_type == "sticker"
                    else classify_media(mime_type, file_name)
                )
                media_data = f"data:{mime_type};base64,{base64.b64encode(file_bytes).decode()}"
                caption = source_text if source_text and not source_text.startswith("[") else ""
                result = await wapi_messaging.send_media(
                    resolved_user_id,
                    payload.destino_id,
                    kind,
                    media_data,
                    caption=caption,
                    file_name=file_name,
                    extension=file_extension(file_name, mime_type),
                    timeout=110.0,
                )
                if not result.get("sent"):
                    raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o encaminhamento.")
                new_id = str(result.get("messageId") or "")
                local_url, safe_name = save_upload_file(
                    resolved_user_id,
                    file_name,
                    mime_type,
                    file_bytes,
                )
                hora, timestamp = current_clock()
                async with whatsapp_conversation_mutation_lock(resolved_user_id):
                    await append_message(
                        payload.destino_id,
                        {
                            "id": new_id,
                            "remetente": "usuario",
                            "texto": source_text,
                            "tipo": source_type,
                            "arquivoUrl": local_url,
                            "arquivoMime": mime_type,
                            "nomeArquivo": safe_name,
                            "horario": hora,
                            "timestamp": timestamp,
                            "status": "enviado",
                            "encaminhada": True,
                        },
                        channel="whatsapp",
                        user_id=resolved_user_id,
                    )
        except (MessagingUnavailable, WapiError) as exc:
            raise _messaging_http_error(exc, "A API do WhatsApp recusou o encaminhamento.") from exc
        forwarded_ids.append(new_id)

    await mark_whatsapp_conversation_updated(resolved_user_id, payload.destino_id)
    return {"status": "encaminhado", "total": len(forwarded_ids), "mensagensIds": forwarded_ids}


@router.get("/api/chat/contatos-disponiveis")
async def obter_contatos_disponiveis(
    user_id: str | None = Query(default=None, deprecated=True),
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, "whatsapp")
    catalog_cache = await load_whatsapp_catalog_cache(resolved_user_id)

    try:
        cached_contacts = [
            item for item in (catalog_cache.get("contacts") or []) if isinstance(item, dict)
        ]
        cached_chats = [
            item for item in (catalog_cache.get("chats") or []) if isinstance(item, dict)
        ]
        db = await load_conversations(resolved_user_id)
        local_records = [
            {
                "id": conversation_id,
                "name": conversation.get("contato"),
                "phoneNumber": (conversation.get("metadados") or {}).get("numeroCompleto"),
                "photoUrl": conversation.get("photoUrl") or (conversation.get("metadados") or {}).get("photoUrl"),
                "photoFetchedAt": (conversation.get("metadados") or {}).get("photoFetchedAt"),
                "verifiedName": (conversation.get("metadados") or {}).get("verifiedName"),
                "notify": (conversation.get("metadados") or {}).get("notify"),
                "isBusiness": (conversation.get("metadados") or {}).get("isBusiness"),
                "isMyContact": (conversation.get("metadados") or {}).get("isMyContact"),
                "isBlocked": (conversation.get("metadados") or {}).get("isBlocked"),
            }
            for conversation_id, conversation in db.items()
            if (
                isinstance(conversation, dict)
                and not conversation.get("esGrupo")
                and not _is_technical_status_conversation(conversation_id, conversation)
            )
        ]
        local_records.extend(contact_records_from_conversations(db))
        # Esta rota é de interação e precisa responder imediatamente. Atualiza o
        # catálogo em background; nunca abre dezenas de páginas da W-API no
        # request do usuário.
        if (
            not catalog_cache_is_fresh(
                catalog_cache, "contactsSyncedAt", WHATSAPP_CONTACT_SYNC_TTL_SECONDS
            )
            and contact_sync_retry_due(catalog_cache)
            and wapi_creds(resolved_user_id)
        ):
            schedule_contact_sync(resolved_user_id, force=True)

        contatos = merge_catalog_items([*cached_contacts, *cached_chats], local_records)
        contatos_whatsapp: list[Dict[str, Any]] = []
        for c in contatos:
            raw_id = _contact_primary_id(c)
            lowered_id = raw_id.lower()
            if (
                not raw_id
                or wapi_webhook.is_status_broadcast(c)
                or lowered_id.endswith("@g.us")
                or lowered_id.endswith("@newsletter")
            ):
                continue
            display_name = _contact_display_name(c, raw_id)
            # Um LID sem nome não é utilizável para humanos e não deve poluir o
            # seletor de novo chat com um identificador técnico.
            if lowered_id.endswith("@lid") and not display_name:
                continue
            raw_phone = _identifier_value(c.get("phoneNumber") or c.get("phone") or c.get("number") or raw_id)
            if raw_phone.lower().endswith(("@c.us", "@s.whatsapp.net")):
                clean_phone = re.sub(r"\D", "", raw_phone.split("@", 1)[0])
            elif "@" not in raw_phone:
                clean_phone = re.sub(r"\D", "", raw_phone) or raw_phone
            else:
                clean_phone = raw_phone
            contatos_whatsapp.append(
                {
                    "id": raw_id,
                    "phone": clean_phone,
                    "lid": _identifier_value(c.get("lid") or c.get("senderLid")) or None,
                    "aliases": sorted(_contact_aliases(c)),
                    "name": display_name or clean_phone,
                    "notify": c.get("notify"),
                    "pushname": c.get("pushname") or c.get("pushName"),
                    "photoUrl": extract_photo_url(c),
                    "photoFetchedAt": c.get("photoFetchedAt"),
                    "verifiedName": c.get("verifiedName"),
                    "bio": c.get("bio") or c.get("status"),
                    "isBusiness": bool(c.get("isBusiness")),
                    "isMyContact": bool(c.get("isMyContact")),
                    "isBlocked": bool(c.get("isBlocked")),
                    "channel": "whatsapp",
                    "canal": "whatsapp",
                }
            )
        return contatos_whatsapp
    except Exception:
        logger.exception("Falha ao montar catalogo local de contatos WhatsApp.")
        return []


async def quoted_message_preview(
    user_id: str,
    conversation_id: str,
    message_id: str | None,
) -> Dict[str, Any] | None:
    if not message_id:
        return None
    db = await load_conversations(user_id)
    conversation = db.get(conversation_id)
    if isinstance(conversation, dict):
        target = next(
            (
                message
                for message in conversation.get("mensagens") or []
                if str(message.get("id") or "") == message_id
            ),
            None,
        )
        if target:
            return {
                "id": message_id,
                "content": target.get("texto") or "",
                "senderName": target.get("remetenteNome")
                or (None if target.get("remetente") == "usuario" else conversation.get("contato")),
            }
    # Respostas a Status são enviadas ao contato, mas o item citado fica no
    # feed separado e não no histórico dessa conversa.
    feed = await load_whatsapp_status_feed(user_id)
    status_item = next(
        (
            item
            for item in feed.get("items") or []
            if isinstance(item, dict) and str(item.get("id") or "") == message_id
        ),
        None,
    )
    if status_item:
        return {
            "id": message_id,
            "content": status_item.get("texto") or "[Status]",
            "senderName": status_item.get("contactName"),
            "status": True,
        }
    return None


@router.post("/api/chat/enviar")
async def enviar_mensagem(payload: EnviarMensagemPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    assert_channel_permission(user, payload.canal)

    citada = await quoted_message_preview(
        resolved_user_id,
        payload.conversa_id,
        payload.responder_a,
    )

    try:
        result = await wapi_messaging.send_text(
            resolved_user_id, payload.conversa_id, payload.texto, quoted_message_id=payload.responder_a or ""
        )
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "A API do WhatsApp recusou o envio.") from exc
    if not result.get("sent"):
        raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o envio.")

    async with whatsapp_conversation_mutation_lock(resolved_user_id):
        await append_outgoing_message(
            payload.conversa_id,
            payload.texto,
            channel="whatsapp",
            status="enviado",
            message_id=str(result.get("messageId") or "") or None,
            citada=citada,
            user_id=resolved_user_id,
        )
    await mark_whatsapp_conversation_updated(resolved_user_id, payload.conversa_id)
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
    citada = await quoted_message_preview(
        resolved_user_id,
        payload.conversa_id,
        payload.responder_a,
    )
    file_bytes, mime_type = decode_data_url(payload.data_url, payload.mime_type)
    if payload.visualizacao_unica:
        safe_file_name = safe_upload_name(payload.nome_arquivo, mime_type)
        local_url = None
    else:
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
            quoted_message_id=payload.responder_a or "",
            view_once=payload.visualizacao_unica,
        )
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "A API do WhatsApp recusou o envio do arquivo.") from exc
    if not result.get("sent"):
        raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o envio do arquivo.")

    hora, timestamp = current_clock()
    async with whatsapp_conversation_mutation_lock(resolved_user_id):
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
                "visualizacaoUnica": payload.visualizacao_unica,
                "citada": citada,
                "horario": hora,
                "timestamp": timestamp,
                "status": "enviado",
                "canal": "whatsapp",
                "channel": "whatsapp",
            },
            channel="whatsapp",
            user_id=resolved_user_id,
        )
    await mark_whatsapp_conversation_updated(resolved_user_id, payload.conversa_id)
    await record_event(
        source="whatsapp",
        title="Arquivo enviado no WhatsApp",
        description=f"{safe_file_name} ({mime_type})",
        metadata={
            "conversaId": payload.conversa_id,
            "channel": "whatsapp",
            "tipo": tipo,
            "arquivoUrl": local_url,
            "visualizacaoUnica": payload.visualizacao_unica,
            "userId": resolved_user_id,
        },
    )

    return {
        "status": "enviado_real",
        "canal": "whatsapp",
        "tipo": tipo,
        "arquivoUrl": local_url,
        "nomeArquivo": safe_file_name,
        "visualizacaoUnica": payload.visualizacao_unica,
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


@router.patch("/api/chat/editar-mensagem")
async def editar_mensagem(payload: EditarMensagemPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    db = await load_conversations(resolved_user_id)
    conversation = db.get(payload.conversa_id)
    target = next(
        (
            message
            for message in ((conversation or {}).get("mensagens") or [])
            if isinstance(message, dict) and str(message.get("id") or "") == payload.mensagem_id
        ),
        None,
    )
    if target is None:
        raise HTTPException(status_code=404, detail="Mensagem ou conversa nao encontrada.")
    if target.get("remetente") != "usuario":
        raise HTTPException(status_code=403, detail="Somente mensagens enviadas por voce podem ser editadas.")

    try:
        await wapi_messaging.edit(
            resolved_user_id,
            payload.conversa_id,
            payload.mensagem_id,
            payload.texto,
        )
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "O WhatsApp recusou a edicao da mensagem.") from exc

    async with whatsapp_conversation_mutation_lock(resolved_user_id):
        db = await load_conversations(resolved_user_id)
        conversation = db.get(payload.conversa_id)
        target = next(
            (
                message
                for message in ((conversation or {}).get("mensagens") or [])
                if isinstance(message, dict) and str(message.get("id") or "") == payload.mensagem_id
            ),
            None,
        )
        if target is not None and isinstance(conversation, dict):
            target["texto"] = payload.texto
            target["editada"] = True
            target["editadoEm"] = datetime.now(BRAZIL_TZ).isoformat()
            if conversation.get("mensagens") and conversation["mensagens"][-1] is target:
                conversation["ultimoTexto"] = payload.texto
            db[payload.conversa_id] = normalize_conversation(payload.conversa_id, conversation)
            await save_conversations(db, resolved_user_id)
    await mark_whatsapp_conversation_updated(resolved_user_id, payload.conversa_id)
    return {"status": "editada", "mensagemId": payload.mensagem_id, "texto": payload.texto}


@router.post("/api/chat/apagar-mensagem")
async def apagar_mensagem(payload: ApagarMensagemPayload, user: dict[str, Any] = Depends(current_user)):
    assert_channel_permission(user, "whatsapp")
    resolved_user_id = tenant_id(user)
    try:
        await wapi_messaging.delete(resolved_user_id, payload.conversa_id, payload.mensagem_id, payload.para_todos)
    except (MessagingUnavailable, WapiError) as exc:
        raise _messaging_http_error(exc, "O WhatsApp recusou a exclusao da mensagem.") from exc
    async with whatsapp_conversation_mutation_lock(resolved_user_id):
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
    async with whatsapp_conversation_mutation_lock(resolved_user_id):
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
    if sucesso:
        await mark_whatsapp_conversation_updated(resolved_user_id, payload.conversa_id)
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
_JID_LIKE = re.compile(r"^[^\s@]+@(lid|g\.us|c\.us|s\.whatsapp\.net|newsletter|broadcast)$", re.I)
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
        for key in ("data", "contacts", "chats", "groups", "items", "results", "records"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
            if isinstance(value, dict):
                nested = parse_whatsapp_collection(value)
                if nested:
                    return nested
    return []


def normalize_whatsapp_timestamp(value: Any) -> int:
    try:
        timestamp = int(float(value or 0))
    except (TypeError, ValueError):
        return 0
    return timestamp // 1000 if timestamp > 10_000_000_000 else timestamp


_WHATSAPP_MESSAGE_STATUS_RANK = {
    None: 0,
    "erro": 1,
    "pendente": 1,
    "enviado": 2,
    "entregue": 3,
    "lido": 4,
    "reproduzido": 5,
}


def richer_whatsapp_message_status(existing: Any, incoming: Any) -> str | None:
    """Mantém ACKs monotônicos quando o catálogo traz um snapshot mais pobre."""
    current = str(existing or "").strip() or None
    candidate = str(incoming or "").strip() or None
    if candidate not in _WHATSAPP_MESSAGE_STATUS_RANK:
        candidate = None
    if current not in _WHATSAPP_MESSAGE_STATUS_RANK:
        current = None
    if _WHATSAPP_MESSAGE_STATUS_RANK[candidate] >= _WHATSAPP_MESSAGE_STATUS_RANK[current]:
        return candidate
    return current


def sync_catalog_messages(conversation: Dict[str, Any], chat: Dict[str, Any]) -> bool:
    changed = False
    existing_messages = conversation.setdefault("mensagens", [])
    existing_ids = {str(item.get("id") or "") for item in existing_messages if isinstance(item, dict)}
    raw_messages = chat.get("messages") if isinstance(chat.get("messages"), list) else []
    if not raw_messages and isinstance(chat.get("msgs"), list):
        raw_messages = chat["msgs"]
    if isinstance(chat.get("lastMessage"), dict):
        raw_messages = [*raw_messages, chat["lastMessage"]]
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
        key=lambda item: normalize_whatsapp_timestamp(
            item.get("timestamp") or item.get("moment") or item.get("momment")
        ),
    ):
        if wapi_webhook.is_status_broadcast(raw_message):
            continue
        timestamp = normalize_whatsapp_timestamp(
            raw_message.get("timestamp") or raw_message.get("moment") or raw_message.get("momment")
        )
        message_id = wapi_webhook.event_id(raw_message).strip()
        if not message_id or not timestamp:
            continue
        chat_id = _contact_primary_id(chat) or None
        adapted = wapi_webhook.adapt_incoming(
            {
                **raw_message,
                "chatId": raw_message.get("chatId") or chat_id,
                "messageId": message_id,
            }
        )
        if not adapted:
            continue
        raw_type = str(raw_message.get("type") or raw_message.get("messageType") or "chat").lower()
        message_type = str(adapted.get("tipo") or type_map.get(raw_type) or "texto")
        content = str(adapted.get("texto") or raw_message.get("content") or labels.get(raw_type) or "")
        if message_type == "texto" and not content.strip():
            # Não cria bolhas vazias que exibem apenas o horário. O catálogo de
            # chats pode trazer stubs de mensagem sem conteúdo.
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
        from_me = wapi_webhook.message_from_me(raw_message)
        existing_media_url = str((existing_message or {}).get("arquivoUrl") or "")
        preserved_local_media_url = (
            existing_media_url
            if "/api/chat/uploads/" in existing_media_url
            else None
        )
        incoming_media_meta = adapted.get("midiaMeta") if isinstance(adapted.get("midiaMeta"), dict) else None
        existing_media_meta = (
            existing_message.get("midiaMeta")
            if isinstance((existing_message or {}).get("midiaMeta"), dict)
            else None
        )
        resolved_media_meta = incoming_media_meta or existing_media_meta
        incoming_status = (
            wapi_webhook.map_status(str(raw_message.get("status") or "")) or "enviado"
            if from_me
            else None
        )
        resolved_status = richer_whatsapp_message_status(
            (existing_message or {}).get("status"), incoming_status
        ) if from_me else None
        incoming_reactions = raw_message.get("reactions") or raw_message.get("reacoes")
        resolved_reactions = (
            incoming_reactions
            if isinstance(incoming_reactions, list) and incoming_reactions
            else (existing_message or {}).get("reacoes") or []
        )
        incoming_quote = raw_message.get("quoted") or raw_message.get("citada")
        resolved_quote = (
            incoming_quote
            if isinstance(incoming_quote, dict) and incoming_quote
            else (existing_message or {}).get("citada")
        )
        existing_messages.append(
            normalize_message(
                {
                    "id": message_id,
                    "remetente": "usuario" if from_me else "contato",
                    "remetenteNome": adapted.get("senderName") or raw_message.get("senderName"),
                    "remetenteId": adapted.get("senderId") or raw_message.get("senderId"),
                    "texto": content,
                    "tipo": message_type,
                    "arquivoUrl": preserved_local_media_url or (
                        whatsapp_media_url(message_id, chat_id)
                        if incoming_media_meta or (raw_type in type_map and raw_type != "chat")
                        else existing_media_url or None
                    ),
                    "arquivoMime": (
                        (adapted.get("midiaMeta") or {}).get("mimetype")
                        or raw_message.get("mimetype")
                        or (existing_message or {}).get("arquivoMime")
                    ),
                    "nomeArquivo": raw_message.get("filename") or (existing_message or {}).get("nomeArquivo") or default_file_name(type_map.get(raw_type, "texto"), raw_message.get("mimetype")),
                    "duracaoAudio": raw_message.get("duration") or (existing_message or {}).get("duracaoAudio"),
                    "horario": format_whatsapp_time(timestamp),
                    "timestamp": timestamp,
                    "status": resolved_status,
                    "reacoes": resolved_reactions,
                    "citada": resolved_quote,
                    "midiaMeta": resolved_media_meta,
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
    raw_last_message = chat.get("lastMessage")
    if isinstance(raw_last_message, dict):
        last_message_id = wapi_webhook.event_id(raw_last_message)
        adapted_last = wapi_webhook.adapt_incoming(
            {
                **raw_last_message,
                "chatId": _contact_primary_id(chat),
                "messageId": last_message_id,
            }
        )
        latest_text = str((adapted_last or {}).get("texto") or "")
    else:
        latest_text = str(raw_last_message or "")
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

    for contato in _iter_contact_records(contacts):
        jid = _contact_primary_id(contato)
        if not jid:
            continue
        # Chaves alternativas: com @lid os chats chegam por lid, mas o contato
        # costuma vir indexado pelo número. Indexa também por qualquer lid/jid
        # do contato para a busca por telefone do chat casar (ponte @lid → nome).
        alt_keys = _contact_aliases(contato) or {jid}
        # ``notify`` é o nome salvo retornado no contrato oficial de
        # fetch-contacts; grupos priorizam ``subject`` para nunca exibir @g.us.
        nome = _contact_display_name(contato, jid)
        if nome:
            for key in alt_keys:
                # A chamada passa fetch-contacts/cache antes de fetch-chats.
                # Preserva o nome salvo/mais rico já conhecido e usa o nome do
                # chat apenas como fallback, sem rebaixar "Maria da agenda".
                nomes.setdefault(key, str(nome))
        photo = extract_photo_url(contato)
        if photo:
            for key in alt_keys:
                fotos[key] = photo
        contact_meta = {
            "numeroCompleto": (
                _identifier_value(
                    contato.get("phone")
                    or contato.get("phoneNumber")
                    or contato.get("id")
                    or contato.get("jid")
                )
                or jid
            ),
            "participantes": contato.get("participants") or contato.get("participantes") or [],
            "descricaoGrupo": contato.get("description") or contato.get("descricao") or "",
            "verifiedName": contato.get("verifiedName"),
            "notify": contato.get("notify"),
            "bioRecado": contato.get("bio") or contato.get("status"),
            "isBusiness": bool(contato.get("isBusiness")),
            "isMyContact": bool(contato.get("isMyContact")),
            "isBlocked": bool(contato.get("isBlocked")),
            "photoFetchedAt": contato.get("photoFetchedAt"),
        }
        for key in alt_keys:
            metadata[key] = contact_meta

    return nomes, fotos, metadata


def contact_records_from_conversations(db: Dict[str, Any]) -> list[Dict[str, Any]]:
    """Recupera nomes já observados em webhooks/histórico do próprio tenant."""
    records: list[Dict[str, Any]] = []
    for conversation_id, conversation in db.items():
        if not isinstance(conversation, dict):
            continue
        metadata = conversation.get("metadados") if isinstance(conversation.get("metadados"), dict) else {}
        if not is_group_chat(conversation_id, conversation):
            records.append(
                {
                    "id": conversation_id,
                    "phoneNumber": metadata.get("numeroCompleto"),
                    "lid": metadata.get("lid"),
                    "name": conversation.get("contato"),
                    "photoUrl": conversation.get("photoUrl") or metadata.get("photoUrl"),
                }
            )
        for message in conversation.get("mensagens") or []:
            if not isinstance(message, dict) or message.get("remetente") == "usuario":
                continue
            sender_id = _identifier_value(message.get("remetenteId"))
            sender_name = str(message.get("remetenteNome") or "").strip()
            if sender_id and sender_name:
                records.append({"id": sender_id, "name": sender_name})
    return records


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
        data.get("profilePicUrl"),
        data.get("imgUrl"),
        data.get("link"),
        data.get("senderPhoto"),
        data.get("chatPhoto"),
        data.get("picture"),
        data.get("avatar"),
    ]

    contact = data.get("contact")
    if isinstance(contact, dict):
        candidates.extend([contact.get("photoUrl"), contact.get("profilePictureUrl"), contact.get("profilePicUrl"), contact.get("imgUrl"), contact.get("avatar")])

    for value in candidates:
        if isinstance(value, str) and value.startswith(("http://", "https://", "data:image")):
            return value
    return None


def normalize_profile_phone(phone: str) -> str:
    query_phone = phone.strip()
    if query_phone.endswith("-group") or query_phone.endswith("@g.us") or query_phone.endswith("@lid"):
        return query_phone
    if "@" in query_phone:
        query_phone = query_phone.split("@", 1)[0]
    digits = re.sub(r"\D", "", query_phone)
    return digits or query_phone


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
            return data.get("profilePictureUrl") or data.get("profilePicUrl") or data.get("photoUrl") or data.get("imgUrl") or data.get("link") or data.get("value")
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
        raw_participants = g.get("participants") or []
        if not raw_participants:
            try:
                participants_payload = await wapi_client.group_participants(
                    creds[0], creds[1], group_id
                )
                raw_participants = participants_payload.get("participants") or []
            except WapiError:
                raw_participants = []
        catalog = await load_whatsapp_catalog_cache(user_id)
        conversations = await load_conversations(user_id)
        names, photos, _metadata = build_contact_indexes(
            [
                *[item for item in (catalog.get("contacts") or []) if isinstance(item, dict)],
                *[item for item in (catalog.get("chats") or []) if isinstance(item, dict)],
                *[item for item in raw_participants if isinstance(item, dict)],
                *contact_records_from_conversations(conversations),
            ]
        )
        participants = normalize_group_participants(raw_participants, names, photos)
        return {
            "nome": g.get("subject") or g.get("name"),
            "descricaoGrupo": g.get("description") or g.get("desc") or "",
            "participantes": participants,
            "participantesCount": int(g.get("size") or g.get("participantsCount") or len(participants)),
            "criadoPor": g.get("owner") or g.get("creator") or g.get("subjectOwner"),
            "criadoEm": g.get("creation") or g.get("createdAt"),
            "photoUrl": extract_photo_url(g),
        }
    except WapiError:
        logger.warning("Falha ao buscar metadados de grupo W-API.")
    return None
