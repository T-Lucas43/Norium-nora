"""Adaptador Evolution 2.3.7 para os serviços WhatsApp existentes.

Contratos verificados na tag oficial 2.3.7 (cd800f2). Somente o backend
seleciona origem/credenciais. Escritas não são repetidas após falha de rede.
Não devolve envelopes administrativos nem mensagens de erro do provedor.
"""
from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Mapping
from urllib.parse import urlsplit

import httpx

from app.services.wapi_client import WapiClient, WapiConfig, WapiError

EVENTS = ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "PRESENCE_UPDATE", "SEND_MESSAGE",
          "CONTACTS_UPSERT", "CONTACTS_UPDATE", "CHATS_SET", "CHATS_UPSERT", "CHATS_UPDATE", "MESSAGES_SET", "GROUPS_UPSERT", "GROUP_UPDATE"]
_INSTANCE = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")


def _origin() -> str:
    value = os.getenv("EVOLUTION_BASE_URL", "").strip().rstrip("/")
    if not value:
        return ""
    try:
        url = urlsplit(value)
        host = (url.hostname or "").encode("idna").decode("ascii").lower()
        allowed = {item.strip().lower() for item in os.getenv("EVOLUTION_ALLOWED_HOSTS", "").split(",") if item.strip()}
        private = value == "http://evolution-api:8080" and os.getenv("EVOLUTION_PRIVATE_NETWORK_ENABLED", "0") == "1"
        public = url.scheme == "https" and host in allowed and url.port in (None, 443)
        valid = bool(host) and not url.username and not url.password and not url.query and not url.fragment and url.path in ("", "/")
    except (UnicodeError, ValueError):
        valid = public = private = False
    if not valid or not (private or public):
        raise RuntimeError("Origem Evolution inválida; configure HTTPS autorizado ou a rede Docker privada.")
    return "http://evolution-api:8080" if private else f"https://{host}"


def webhook_url() -> str:
    value = os.getenv("EVOLUTION_WEBHOOK_URL", "").strip()
    try:
        url = urlsplit(value)
        private = value in {"http://app:8000/api/whatsapp/webhook", "http://norium-api:8000/api/whatsapp/webhook"} and os.getenv("EVOLUTION_PRIVATE_NETWORK_ENABLED", "0") == "1"
        public = url.scheme == "https" and bool(url.hostname) and url.port in (None, 443)
        valid = not url.username and not url.password and not url.query and not url.fragment and url.path == "/api/whatsapp/webhook"
    except ValueError:
        valid = public = private = False
    secret = os.getenv("WAPI_WEBHOOK_SECRET", "")
    if not valid or not (private or public) or len(secret) < 32 or not secret.isascii() or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in secret):
        raise WapiError("Configure o callback autenticado da Evolution antes de conectar.", code="not_configured")
    return value


def jid(value: str) -> str:
    value = str(value or "").strip()
    if value.endswith("@c.us"):
        value = value[:-5] + "@s.whatsapp.net"
    return value if "@" in value else value + "@s.whatsapp.net"


def message_key(body: Mapping[str, Any], *, from_me: bool = True) -> dict[str, Any]:
    return {"remoteJid": jid(str(body.get("phone") or "")), "id": str(body.get("messageId") or ""), "fromMe": from_me}


class EvolutionClient(WapiClient):
    """Compatibilidade de contrato; não reutiliza URL/auth HTTP da W-API."""

    def __init__(self) -> None:
        self._config = WapiConfig(_origin(), os.getenv("EVOLUTION_API_KEY", "").strip(), os.getenv("WAPI_WEBHOOK_SECRET", "").strip())
        self._connections_enabled = os.getenv("EVOLUTION_CONNECTIONS_ENABLED", "0").strip() == "1"

    @property
    def configured(self) -> bool:
        from app.services.evolution_data import database_configured
        return self._config.configured and self._connections_enabled and database_configured()

    @property
    def availability_detail(self) -> str:
        if not self._connections_enabled:
            return "O administrador ainda não habilitou as conexões da Evolution API neste ambiente."
        return "O administrador precisa concluir a configuração privada da Evolution e do ciclo de dados."

    async def _call(self, method: str, route: str, *, token: str, body: Mapping[str, Any] | None = None,
                    params: Mapping[str, Any] | None = None, timeout: float = 25, read_only: bool = False,
                    control_plane: bool = False) -> Any:
        if not (self.config.configured if control_plane else self.configured) or not token:
            raise WapiError("Evolution API não configurada.", code="not_configured")
        # Cada rota é construída neste arquivo; nunca aceitar URL do usuário/provedor.
        if not re.fullmatch(r"/[A-Za-z0-9_/-]+", route) or ".." in route or "//" in route:
            raise WapiError("Destino Evolution inválido.", code="invalid_destination")
        attempts = 3 if read_only and not route.startswith("/group/fetchAllGroups/") else 1
        for attempt in range(attempts):
            try:
                async with httpx.AsyncClient(follow_redirects=False, trust_env=False) as client:
                    response = await client.request(method, self.config.base_url + route, headers={"apikey": token},
                                                    json=dict(body) if body is not None else None,
                                                    params=params, timeout=timeout)
            except httpx.HTTPError:
                if attempt + 1 < attempts:
                    await asyncio.sleep(0.3 * 2**attempt)
                    continue
                raise WapiError("Falha de comunicação com a Evolution API.", code="network") from None
            if response.status_code in {429, 500, 502, 503, 504} and attempt + 1 < attempts:
                await asyncio.sleep(0.3 * 2**attempt)
                continue
            if response.status_code >= 300:
                raise WapiError("A Evolution API não concluiu a operação.", status=response.status_code,
                                code="provider_rejected" if response.status_code < 500 else "provider_unavailable")
            try:
                result = response.json()
            except ValueError:
                raise WapiError("Resposta inválida da Evolution API.", code="invalid_response") from None
            if isinstance(result, dict) and result.get("error") is True:
                raise WapiError("A Evolution API não confirmou a operação.", code="remote_outcome_unknown")
            return result
        raise WapiError("Evolution indisponível.", code="network")

    @staticmethod
    def _name(instance: str | None) -> str:
        if not isinstance(instance, str) or not _INSTANCE.fullmatch(instance):
            raise WapiError("Instância Evolution inválida.", code="invalid_instance")
        return instance

    def _hook(self, url: str) -> dict[str, Any]:
        if url != webhook_url():
            raise WapiError("Callback Evolution inválido.", code="invalid_destination")
        return {"enabled": True, "url": url, "headers": {"X-Wapi-Webhook-Secret": self.config.webhook_secret},
                "byEvents": False, "base64": False, "events": list(EVENTS)}

    async def create_instance(self, instance_name: str, **options: Any) -> dict[str, Any]:
        name = self._name(instance_name)
        token = secrets.token_urlsafe(32)
        result = await self._call("POST", "/instance/create", token=self.config.master_api_key, timeout=40,
                                 body={"instanceName": name, "token": token, "integration": "WHATSAPP-BAILEYS",
                                       "qrcode": False, "readMessages": False, "readStatus": False, "alwaysOnline": False,
                                       "syncFullHistory": True, "rejectCall": False, "groupsIgnore": False,
                                       "webhook": self._hook(webhook_url())})
        remote = result.get("instance", {}) if isinstance(result, dict) else {}
        if remote.get("instanceName") != name or not remote.get("instanceId"):
            raise WapiError("Criação Evolution sem confirmação; reconciliação necessária.", code="remote_outcome_unknown")
        # O identificador das rotas/webhook é o nome, não o UUID do PostgreSQL Evolution.
        return {"instanceId": name, "instanceName": name, "token": token}

    async def list_instances(self) -> list[dict[str, Any]]:
        result = await self._call("GET", "/instance/fetchInstances", token=self.config.master_api_key, read_only=True)
        if not isinstance(result, list):
            raise WapiError("Listagem Evolution inválida; criação suspensa.", code="invalid_response")
        return [{"instanceId": row["name"], "instanceName": row["name"], "token": row.get("token", "")}
                for row in result if isinstance(row, dict) and _INSTANCE.fullmatch(str(row.get("name") or ""))]

    async def fetch_history_page(self, instance_id: str, token: str, phone: str,
                                 *, page: int = 1, limit: int = 100, until: int | None = None) -> dict[str, Any]:
        """Read one bounded page from this instance's already available history."""
        if type(page) is not int or not 1 <= page <= 10000 or type(limit) is not int or not 1 <= limit <= 100:
            raise WapiError("Página de histórico inválida.", code="invalid_request")
        remote = jid(phone)
        anchor = int(time.time()) if until is None else until
        if type(anchor) is not int or not 1 <= anchor <= 253402300799:
            raise WapiError("Data do histórico inválida.", code="invalid_request")
        timestamp = datetime.fromtimestamp(anchor, timezone.utc).isoformat()
        result = await self._call("POST", f"/chat/findMessages/{self._name(instance_id)}", token=token,
                                  body={"where": {"key": {"remoteJid": remote, "remoteJidAlt": remote},
                                                  "messageTimestamp": {"gte": "1970-01-01T00:00:00Z", "lte": timestamp}},
                                        "page": page, "offset": limit},
                                  read_only=True)
        messages = result.get("messages") if isinstance(result, dict) else None
        if not isinstance(messages, dict) or not isinstance(messages.get("records"), list):
            raise WapiError("Histórico Evolution inválido.", code="invalid_response")
        records = messages["records"]
        if len(records) > limit:
            raise WapiError("Histórico Evolution excedeu a página solicitada.", code="invalid_response")
        normalized = []
        for row in records:
            if not isinstance(row, dict):
                continue
            key = row.get("key") if isinstance(row.get("key"), dict) else {}
            if remote not in {key.get("remoteJid"), key.get("remoteJidAlt")} or not key.get("id"):
                continue
            normalized.append(_message_record(row))
        pages = messages.get("pages", 1)
        if type(pages) is not int or pages < 0:
            raise WapiError("Paginação Evolution inválida.", code="invalid_response")
        return {"id": remote, "messages": normalized, "page": page,
                "hasMore": page < pages, "nextPage": page + 1 if page < pages else None, "anchor": anchor}

    async def set_webhook(self, instance_id: str, token: str, event: str, url: str) -> dict[str, Any]:
        return await self._call("POST", f"/webhook/set/{self._name(instance_id)}", token=token, body={"webhook": self._hook(url)})

    async def delete_instance_data(self, owned_instance_name: str) -> None:
        """Somente o ciclo de privacidade chama com nome comprovado localmente."""
        name = self._name(owned_instance_name)
        async def listing():
            try:
                rows = await self._call("GET", "/instance/fetchInstances", token=self.config.master_api_key,
                                        params={"instanceName": name}, read_only=True, control_plane=True)
            except WapiError as exc:
                if exc.status == 404:
                    return []
                raise
            if not isinstance(rows, list):
                raise WapiError("Não foi possível confirmar a exclusão Evolution.", code="invalid_response")
            return [row for row in rows if isinstance(row, dict) and row.get("name") == name]
        rows = await listing()
        if not rows:
            return
        if rows[0].get("connectionStatus") != "close":
            await self._call("DELETE", f"/instance/logout/{name}", token=self.config.master_api_key, control_plane=True)
        for attempt in range(6):
            rows = await listing()
            if not rows:
                return
            if rows[0].get("connectionStatus") == "close":
                break
            await asyncio.sleep(0.5)
        else:
            raise WapiError("A sessão Evolution ainda está encerrando; exclusão será retomada.", code="remote_outcome_unknown")
        await self._call("DELETE", f"/instance/delete/{name}", token=self.config.master_api_key, control_plane=True)
        if await listing():
            raise WapiError("A exclusão Evolution ainda não foi confirmada.", code="remote_outcome_unknown")

    async def _referenced_message(self, name: str, token: str, body: Mapping[str, Any]) -> dict[str, Any]:
        remote, identifier = jid(str(body.get("phone") or "")), str(body.get("messageId") or "")
        if not identifier:
            raise WapiError("Mensagem de referência ausente.", status=422, code="invalid_message")
        result = await self._call("POST", f"/chat/findMessages/{name}", token=token, read_only=True,
                                  body={"where": {"key": {"id": identifier}}, "offset": 5, "page": 1})
        rows = result.get("messages", {}).get("records", []) if isinstance(result, dict) else []
        for row in rows:
            key = row.get("key") if isinstance(row, dict) else None
            if isinstance(key, dict) and key.get("id") == identifier and remote in {key.get("remoteJid"), key.get("remoteJidAlt")} and isinstance(key.get("fromMe"), bool):
                return {"key": {field: key[field] for field in ("id", "remoteJid", "fromMe", "participant") if field in key},
                        "message": _media_bytes(row["message"]) if isinstance(row.get("message"), dict) else {}}
        raise WapiError("Mensagem de referência não disponível nesta conta/conversa.", status=422, code="invalid_message")

    async def download_media(self, instance_id: str, token: str, *, media_key: str, direct_path: str,
                             media_type: str, mimetype: str, phone: str = "", message_id: str = "") -> dict[str, Any]:
        # A rota autenticada fornece a conversa/mensagem comprovadas no store local.
        # O gateway resolve o envelope completo, inclusive chave para renovar mídia expirada.
        result = await self._request("POST", "/message/download-media", token=token, instance_id=instance_id,
                                     json_body={"phone": phone, "messageId": message_id, "type": media_type}, timeout=60)
        if not isinstance(result, dict):
            raise WapiError("Resposta de mídia inválida.", code="invalid_response")
        if str(result.get("mimetype") or "").split(";", 1)[0].strip().lower() == "application/x-zip-compressed":
            result = {**result, "mimetype": "application/zip"}
        return result

    async def _request(self, method: str, path: str, *, token: str | None = None, instance_id: str | None = None,
                       params: Mapping[str, Any] | None = None, json_body: Mapping[str, Any] | None = None,
                       timeout: float = 25, retriable: bool = False) -> Any:
        name = self._name(instance_id)
        body, query = dict(json_body or {}), dict(params or {})
        async def call(action: str, data: Mapping[str, Any] | None = None, *, verb: str = "POST", read: bool = False,
                       query_params: Mapping[str, Any] | None = None) -> Any:
            return await self._call(verb, f"/{action}/{name}", token=token or "", body=data,
                                    params=query_params, timeout=timeout, read_only=read)

        if path == "/instance/status-instance":
            result = await call("instance/connectionState", verb="GET", read=True)
            return {"connected": result.get("instance", {}).get("state") == "open"}
        if path in {"/instance/qr-code", "/instance/pairing-code"}:
            result = await call("instance/connect", verb="GET", query_params={"number": query["phoneNumber"]} if query.get("phoneNumber") else None)
            return {"qrcode": result.get("base64"), "pairingCode": result.get("pairingCode")}
        if path in {"/instance/device", "/instance/fetch-instance"}:
            result = await self._call(
                "GET", "/instance/fetchInstances", token=token or "", params={"instanceName": name}, read_only=True)
            row = next((item for item in result if isinstance(item, dict) and item.get("name") == name), {}) if isinstance(result, list) else {}
            phone = str(row.get("ownerJid") or "").split("@", 1)[0].split(":", 1)[0] if row.get("connectionStatus") == "open" else ""
            profile = {}
            if phone:
                try:
                    found = await call("chat/fetchProfile", {"number": phone}, read=True)
                    profile = found if isinstance(found, dict) else {}
                except WapiError:
                    pass
            return {"connectedPhone": phone or None, "name": row.get("profileName") or profile.get("name"),
                    "profilePictureUrl": profile.get("picture") or row.get("profilePicUrl"),
                    "bio": profile.get("status"), "isBusiness": profile.get("isBusiness") is True}
        if path in {"/instance/disconnect", "/instance/restart"}:
            return await call("instance/logout" if path.endswith("disconnect") else "instance/restart", verb="DELETE" if path.endswith("disconnect") else "POST")

        if path in {"/contacts/fetch-contacts", "/chats/fetch-chats"}:
            contacts = path.startswith("/contacts")
            result = await call("chat/findContacts" if contacts else "chat/findChats", {"where": {}}, read=True)
            if not isinstance(result, list) or len(result) > 50000:
                raise WapiError("Catálogo Evolution excedeu o limite ou está inválido.", code="invalid_response")
            # Este contrato retorna a coleção inteira, sem paginação remota.
            # Declara uma página para o consumidor não repetir o download N vezes.
            items = []
            for row in result:
                if not isinstance(row, dict):
                    continue
                identity = row.get("remoteJid")
                if not identity:
                    continue
                normalized = {**row, "id": identity, "name": row.get("subject") or row.get("savedName") or row.get("name") or row.get("pushName"),
                              "profilePictureUrl": row.get("profilePicUrl"), "isGroup": str(identity).endswith("@g.us"),
                              "unreadCount": row.get("unreadMessages", row.get("unreadCount", 0))}
                if isinstance(normalized.get("lastMessage"), dict):
                    last = normalized["lastMessage"]
                    timestamp = last.get("timestamp") or last.get("messageTimestamp")
                    last = {**last, "timestamp": timestamp}
                    normalized["lastMessageTime"] = timestamp
                    normalized["lastMessage"] = _message_record(last)
                    key = last.get("key") if isinstance(last.get("key"), dict) else {}
                    if key.get("remoteJid") == identity and isinstance(key.get("remoteJidAlt"), str):
                        normalized["remoteJidAlt"] = key["remoteJidAlt"]
                items.append(normalized)
            return {"data": items, "totalPages": 1}
        if path == "/chats/chat":
            remote = jid(str(query.get("phoneNumber") or ""))
            return await self.fetch_history_page(name, token or "", remote)
        if path == "/contacts/phone-exists":
            result = await call("chat/whatsappNumbers", {"numbers": [str(query.get("phoneNumber") or "")]}, read=True)
            return result[0] if isinstance(result, list) and result else {"exists": False}
        if path == "/contacts/profile-picture":
            result = await call("chat/fetchProfilePictureUrl", {"number": query.get("phoneNumber")}, read=True)
            return {"profilePictureUrl": result.get("profilePictureUrl")}
        if path == "/contacts/block-contact":
            return await call("chat/updateBlockStatus", {"number": body.get("phoneNumber"), "status": "block" if body.get("blockStatus") else "unblock"})
        if path == "/chats/send-presence":
            return await call("chat/sendPresence", {"number": body.get("phone"), "presence": body.get("presence"), "delay": body.get("delay", 0)})
        if path == "/message/read-message":
            return await call("chat/markMessageAsRead", {"readMessages": [message_key(body, from_me=False)]})
        if path == "/message/edit-message":
            referenced = await self._referenced_message(name, token or "", body)
            if not referenced["key"]["fromMe"]:
                raise WapiError("Somente mensagens próprias podem ser editadas.", status=422, code="invalid_message")
            return await call("chat/updateMessage", {"number": body.get("phone"), "key": referenced["key"], "text": body.get("text")})
        if path == "/message/delete-message":
            referenced = await self._referenced_message(name, token or "", query)
            if not referenced["key"]["fromMe"]:
                raise WapiError("Somente mensagens próprias podem ser apagadas para todos.", status=422, code="invalid_message")
            return await call("chat/deleteMessageForEveryone", referenced["key"], verb="DELETE")
        if path in {"/message/send-reaction", "/message/remove-reaction"}:
            referenced = await self._referenced_message(name, token or "", body)
            result = await call("message/sendReaction", {"key": referenced["key"], "reaction": body.get("reaction", "")})
            identifier = (result.get("key") or {}).get("id") if isinstance(result, dict) else None
            if not isinstance(identifier, str) or not identifier.strip():
                raise WapiError("O provedor não confirmou a reação; não repita automaticamente.", code="remote_outcome_unknown")
            return {"messageId": identifier}
        if path == "/message/download-media":
            kind = str(body.get("type") or "").removesuffix("Message")
            if kind not in {"image", "video", "audio", "document", "sticker"}:
                raise WapiError("Mídia Evolution inválida.", status=422, code="invalid_media")
            referenced = await self._referenced_message(name, token or "", body)
            content = referenced["message"]
            media = content.get(kind + "Message")
            direct = media.get("directPath") if isinstance(media, dict) else None
            if not isinstance(direct, str) or not direct.startswith("/") or direct.startswith("//") or len(direct) > 16384 or any(ord(c) < 32 or ord(c) == 127 for c in direct):
                raise WapiError("Referência de mídia inválida.", status=422, code="invalid_media")
            # Mensagens são dados não confiáveis. Não encaminhar uma URL arbitrária
            # ao downloader do gateway; conservar somente o CDN oficial e a chave real.
            referenced["message"] = {**content, kind + "Message": {**media, "url": "https://mmg.whatsapp.net" + direct}}
            return await call("chat/getBase64FromMediaMessage", {"message": referenced, "convertToMp4": False}, read=True)
        if path.startswith("/message/send-"):
            kind = path.removeprefix("/message/send-")
            outgoing: dict[str, Any] = {"number": body.get("phone"), "delay": body.get("delayMessage", 0)}
            if body.get("messageId"):
                outgoing["quoted"] = await self._referenced_message(name, token or "", body)
            if body.get("viewOnce") or kind in {"gif", "ptv"}:
                raise WapiError("Formato de envio ainda indisponível na integração Evolution.", status=422, code="feature_unavailable")
            if kind == "text":
                outgoing["text"] = body.get("message")
                action = "message/sendText"
            elif kind == "location":
                outgoing.update({"latitude": float(body.get("latitude", 0)), "longitude": float(body.get("longitude", 0)),
                                 "name": body.get("name", ""), "address": body.get("address", "")})
                action = "message/sendLocation"
            elif kind in {"audio", "sticker"}:
                outgoing[kind] = body.get(kind)
                action = "message/sendWhatsAppAudio" if kind == "audio" else "message/sendSticker"
            elif kind in {"image", "video", "document"}:
                media_value = str(body.get(kind) or "")
                mime = media_value[5:].split(";", 1)[0] if media_value.startswith("data:") else mimetypes.guess_type(str(body.get("fileName") or ""))[0]
                outgoing.update({"mediatype": kind, "media": media_value, "caption": body.get("caption", ""),
                                 "fileName": body.get("fileName", ""), "mimetype": mime or "application/octet-stream"})
                action = "message/sendMedia"
            else:
                raise WapiError("Recurso indisponível na integração Evolution.", status=422, code="feature_unavailable")
            result = await call(action, outgoing)
            key = result.get("key", {}) if isinstance(result, dict) else {}
            identifier = key.get("id") if isinstance(key, dict) else None
            if not isinstance(identifier, str) or not identifier.strip():
                raise WapiError("O provedor não confirmou o identificador do envio; não repita automaticamente.", code="remote_outcome_unknown")
            return {"messageId": identifier}
        if path == "/group/get-all-groups":
            # O fornecedor consulta fotos em série. Não repetir essa leitura longa
            # nem prendê-la ao timeout curto das consultas interativas.
            return await self._call("GET", f"/group/fetchAllGroups/{name}", token=token or "",
                                    params={"getParticipants": "false"}, timeout=150, read_only=True)
        if path in {"/group/group-metadata", "/group/get-Participants"}:
            result = await call("group/findGroupInfos", verb="GET", read=True, query_params={"groupJid": query.get("groupId")})
            return {"participants": result.get("participants", [])} if path.endswith("get-Participants") else result
        if path == "/group/create-group":
            if body.get("profilePictureUrl"):
                raise WapiError("Crie o grupo sem imagem e ajuste-a no WhatsApp.", status=422, code="feature_unavailable")
            return await call("group/create", {"subject": body.get("groupName"), "participants": body.get("participants", [])})
        raise WapiError("Recurso indisponível na integração Evolution.", status=422, code="feature_unavailable")


def _message_record(row: dict[str, Any]) -> dict[str, Any]:
    result = {**row, "timestamp": row.get("timestamp") or row.get("messageTimestamp")}
    if isinstance(row.get("message"), dict):
        result["message"] = content = _media_bytes(row["message"])
        for field in ("audioMessage", "videoMessage", "documentMessage", "imageMessage", "stickerMessage"):
            media = content.get(field)
            if not isinstance(media, dict):
                continue
            if isinstance(media.get("seconds"), (int, float)) and not isinstance(media["seconds"], bool):
                result["duration"] = max(0, media["seconds"])
            if isinstance(media.get("fileName"), str):
                result["filename"] = media["fileName"][:255]
            break
    return result


def _media_bytes(message: dict[str, Any], depth: int = 0) -> dict[str, Any]:
    if depth > 8:
        return {}
    for wrapper in ("deviceSentMessage", "documentWithCaptionMessage"):
        node = message.get(wrapper)
        if isinstance(node, dict) and isinstance(node.get("message"), dict):
            return _media_bytes(node["message"], depth + 1)
    result = dict(message)
    for key, value in message.items():
        if key in {"mediaKey", "jpegThumbnail", "fileSha256", "fileEncSha256"}:
            if isinstance(value, dict) and value.get("type") == "Buffer":
                value = value.get("data")
            elif isinstance(value, dict) and value and len(value) <= 200000 and set(value) == {str(i) for i in range(len(value))}:
                value = [value[str(i)] for i in range(len(value))]
            if isinstance(value, list) and len(value) <= 200000 and all(type(item) is int and 0 <= item <= 255 for item in value):
                result[key] = base64.b64encode(bytes(value)).decode("ascii")
        elif isinstance(value, dict) and (key.endswith("Message") or key == "message"):
            result[key] = _media_bytes(value, depth + 1)
    return result


def normalize_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    """Remove segredos/envelope do fornecedor antes do pipeline existente."""
    instance = str(payload.get("instance") or "")
    if not _INSTANCE.fullmatch(instance):
        return {"event": "unknown"}
    event = str(payload.get("event") or "").lower().replace("_", ".")
    if event == "messages.set":
        # History sync is an invalidation, never a burst of new-message actions.
        return {"instanceId": instance, "event": "history_ready"}
    if event in {"contacts.upsert", "contacts.update", "chats.set", "chats.upsert", "chats.update", "groups.upsert", "groups.update", "group.update"}:
        raw = payload.get("data")
        rows = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
        if len(rows) > 50000:
            return {"instanceId": instance, "event": "unknown"}
        fields = {"id", "remoteJid", "remoteJidAlt", "lid", "name", "savedName", "pushName", "subject",
                  "profilePicUrl", "pictureUrl", "desc", "owner", "creation", "size", "isCommunity", "linkedParent"}
        records = [{key: value for key, value in row.items() if key in fields and
                    ((isinstance(value, str) and len(value) <= 4096) or type(value) in (int, bool))}
                   for row in rows if isinstance(row, dict)]
        for row in records:
            row["id"] = row.get("remoteJid") or row.get("id")
            if isinstance(row.get("desc"), str):
                row["description"] = row["desc"]
            if row.get("pictureUrl"):
                row["profilePictureUrl"] = row["pictureUrl"]
        return {"instanceId": instance, "event": "catalog", "catalogType": "contacts" if event.startswith("contacts.") else "chats",
                "catalogItems": records}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    fields = {key: data[key] for key in ("key", "message", "messageTimestamp", "pushName", "messageType", "status", "presences", "id", "state", "remoteJid", "fromMe", "participant") if key in data}
    if isinstance(fields.get("message"), dict):
        fields["message"] = _media_bytes(fields["message"])
    if event == "messages.update" and data.get("keyId"):
        fields["messageId"] = data["keyId"]
    if event in {"messages.upsert", "send.message"}:
        event = "received"
    elif event == "messages.update":
        event = "status"
    elif event == "connection.update":
        state = data.get("state")
        event = "connected" if state == "open" else "disconnected" if state == "close" else "unknown"
    elif event == "presence.update":
        event = "presence"
        remote = str(data.get("id") or "")
        presences = data.get("presences")
        # Presença em grupo é por participante e não deve alterar o estado do grupo.
        if not remote.endswith("@g.us") and isinstance(presences, dict):
            presence = presences.get(remote)
            if isinstance(presence, dict):
                fields["chatId"] = remote
                fields["presence"] = presence.get("lastKnownPresence")
    else:
        event = "unknown"
    return {**fields, "instanceId": instance, "event": event}
