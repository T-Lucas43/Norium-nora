"""Cliente HTTP da W-API (https://api.w-api.app).

Camada única de acesso à W-API para todo o Norium. Concentra base URL,
autenticação, timeouts, retries idempotentes, normalização de erros e a garantia
de nunca registrar segredos (token da instância, QR Code, conteúdo de mídia).

Contrato confirmado em ``docs/W-API.postman_collection.json`` e verificado ao
vivo. Regras de autenticação:

- Operações de instância/mensagem: header ``Authorization: Bearer <token>`` e
  ``?instanceId=<id>`` na query. O token é próprio de cada instância e vem do
  vínculo por tenant, nunca de um valor global.
- Operações de conta (``/client/*``): usam a API Key Mestra no corpo ou no
  header, conforme o endpoint; credenciais nunca são colocadas na URL.

O cliente é sem estado por tenant: quem chama fornece ``instance_id`` e
``token`` obtidos do store de vínculo. Assim o isolamento por usuário é decidido
na fronteira de autorização, não aqui.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Mapping
from urllib.parse import urlsplit

import httpx
from dotenv import load_dotenv

from app.core.tenant import is_local_or_test_environment


load_dotenv()
logger = logging.getLogger(__name__)

# Códigos idempotentes onde um retry é seguro. Envio de mensagem NUNCA entra aqui
# porque a W-API enfileira mesmo desconectada e um retry duplicaria a mensagem.
_RETRIABLE_STATUS = {429, 500, 502, 503, 504}
_DEFAULT_TIMEOUT = 20.0
_WAPI_ALLOWED_HOSTS = frozenset({"api.w-api.app"})
_WAPI_LOCAL_TEST_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "testserver"})
_WAPI_BASE_PATH_NORMALIZATION = {"": "", "/": "", "/v1": "/v1", "/v1/": "/v1"}
_WAPI_ALLOWED_BASE_PATHS = frozenset({"", "/v1"})


class WapiClientConfigurationError(RuntimeError):
    """Configuração insegura da origem HTTP da W-API."""


def _invalid_base_url() -> WapiClientConfigurationError:
    return WapiClientConfigurationError(
        "WAPI_BASE_URL inválida; configure uma origem W-API autorizada."
    )


def normalize_wapi_base_url(
    raw_base: str,
    environ: Mapping[str, str] | None = None,
) -> str:
    """Valida e reconstrói uma origem canônica antes de qualquer request."""
    try:
        parsed = urlsplit(str(raw_base or "").strip())
        scheme = parsed.scheme.casefold()
        hostname = (parsed.hostname or "").encode("idna").decode("ascii").casefold().rstrip(".")
        port = parsed.port
        normalized_path = _WAPI_BASE_PATH_NORMALIZATION.get(parsed.path)
    except (UnicodeError, ValueError):
        raise _invalid_base_url() from None

    is_local_test = is_local_or_test_environment(environ, require_explicit=True)
    is_local_test_host = hostname in _WAPI_LOCAL_TEST_HOSTS
    allowed_hosts = _WAPI_ALLOWED_HOSTS | (_WAPI_LOCAL_TEST_HOSTS if is_local_test else frozenset())
    if (
        not hostname
        or hostname not in allowed_hosts
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or normalized_path not in _WAPI_ALLOWED_BASE_PATHS
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise _invalid_base_url()

    if scheme == "https":
        if port not in (None, 443):
            raise _invalid_base_url()
        normalized_port: int | None = None
    elif scheme == "http" and is_local_test and is_local_test_host:
        normalized_port = None if port in (None, 80) else port
    else:
        raise _invalid_base_url()

    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    authority = rendered_host if normalized_port is None else f"{rendered_host}:{normalized_port}"
    return f"{scheme}://{authority}"


def _origin_key(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.casefold()
    hostname = (parsed.hostname or "").casefold().rstrip(".")
    default_port = 443 if scheme == "https" else 80
    return scheme, hostname, parsed.port or default_port


def _redact_sensitive_message(message: Any, sensitive_values: tuple[str, ...]) -> str:
    public_message = str(message or "Erro na W-API.")
    for sensitive_value in sensitive_values:
        if sensitive_value:
            public_message = public_message.replace(sensitive_value, "[redacted]")
    return public_message[:500]


class WapiError(Exception):
    """Erro normalizado da W-API, seguro para propagar sem vazar segredos."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"WapiError(status={self.status}, code={self.code}): {self.message}"


@dataclass(frozen=True, slots=True)
class WapiConfig:
    """Configuração da W-API lida do ambiente, sem segredos no código."""

    base_url: str
    master_api_key: str = field(repr=False)
    webhook_secret: str = field(repr=False)

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.master_api_key)


def load_wapi_config() -> WapiConfig:
    base = normalize_wapi_base_url(os.getenv("WAPI_BASE_URL", "https://api.w-api.app"))
    return WapiConfig(
        base_url=base,
        master_api_key=os.getenv("WAPI_MASTER_API_KEY", "").strip(),
        webhook_secret=os.getenv("WAPI_WEBHOOK_SECRET", "").strip(),
    )


class WapiClient:
    """Fachada assíncrona sobre os endpoints da W-API."""

    def __init__(self, config: WapiConfig | None = None) -> None:
        loaded = config or load_wapi_config()
        self._config = WapiConfig(
            base_url=normalize_wapi_base_url(loaded.base_url),
            master_api_key=loaded.master_api_key,
            webhook_secret=loaded.webhook_secret,
        )
        self._validated_origin = _origin_key(self._config.base_url)

    @property
    def config(self) -> WapiConfig:
        return self._config

    @property
    def configured(self) -> bool:
        return self._config.configured

    # ---- núcleo HTTP -----------------------------------------------------

    def _url(self, path: str) -> str:
        normalized = path if path.startswith("/") else f"/{path}"
        parsed_path = urlsplit(normalized)
        if (
            parsed_path.scheme
            or parsed_path.netloc
            or parsed_path.query
            or parsed_path.fragment
            or normalized.startswith("//")
            or "\\" in normalized
        ):
            raise WapiError("Destino W-API inválido.", code="invalid_destination")
        target_url = f"{self._config.base_url}/v1{parsed_path.path}"
        if _origin_key(target_url) != self._validated_origin:
            raise WapiError("Destino W-API inválido.", code="invalid_destination")
        return target_url

    async def _request(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        instance_id: str | None = None,
        params: Mapping[str, Any] | None = None,
        json_body: Mapping[str, Any] | None = None,
        timeout: float = _DEFAULT_TIMEOUT,
        retriable: bool = False,
    ) -> Any:
        if not self._config.base_url:
            raise WapiError("W-API não configurada.", code="not_configured")

        target_url = self._url(path)

        query: dict[str, Any] = {}
        if instance_id:
            query["instanceId"] = instance_id
        if params:
            query.update({k: v for k, v in params.items() if v is not None})

        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        attempts = 3 if retriable else 1
        for attempt in range(attempts):
            try:
                async with httpx.AsyncClient(follow_redirects=False) as client:
                    response = await client.request(
                        method,
                        target_url,
                        params=query or None,
                        json=dict(json_body) if json_body is not None else None,
                        headers=headers,
                        timeout=timeout,
                    )
            except httpx.HTTPError as exc:
                if retriable and attempt < attempts - 1:
                    await asyncio.sleep(0.3 * (2**attempt))
                    continue
                logger.warning("Falha de rede na W-API (%s).", type(exc).__name__)
                break

            if 300 <= response.status_code < 400:
                raise WapiError(
                    "Redirecionamento recusado pela W-API.",
                    status=response.status_code,
                    code="redirect_not_allowed",
                )

            if response.status_code in _RETRIABLE_STATUS and retriable and attempt < attempts - 1:
                await asyncio.sleep(0.3 * (2**attempt))
                continue

            return self._parse(
                response,
                sensitive_values=(
                    str(token or ""),
                    self._config.master_api_key,
                    self._config.webhook_secret,
                ),
            )

        raise WapiError("Falha de comunicação com a W-API.", code="network") from None

    def _parse(
        self,
        response: httpx.Response,
        *,
        sensitive_values: tuple[str, ...] = (),
    ) -> Any:
        try:
            data = response.json()
        except ValueError:
            data = None

        if response.status_code >= 400:
            raw_message: Any = "Erro na W-API."
            if isinstance(data, dict):
                raw_message = data.get("message") or data.get("error") or raw_message
            logger.warning("W-API recusou uma requisição com status %s.", response.status_code)
            message = _redact_sensitive_message(raw_message, sensitive_values)
            raise WapiError(message, status=response.status_code)

        # A W-API sinaliza erro lógico com ``error: true`` em resposta 200.
        if isinstance(data, dict) and data.get("error") is True:
            raw_message = str(data.get("message") or data.get("errorMessage") or "Erro na W-API.")
            logical_status: int | None = None
            for candidate in (data.get("statusCode"), data.get("httpStatus"), data.get("code")):
                try:
                    numeric = int(candidate)
                except (TypeError, ValueError):
                    continue
                if 400 <= numeric <= 599:
                    logical_status = numeric
                    break
            if "acesso negado" in raw_message.casefold() or "access denied" in raw_message.casefold():
                logical_status = logical_status or 403
            message = _redact_sensitive_message(raw_message, sensitive_values)
            raise WapiError(message, status=logical_status or response.status_code)
        return data

    # ---- conta / instâncias (API Key Mestra) -----------------------------

    async def create_instance(
        self,
        instance_name: str,
        *,
        lite: bool = True,
        webhooks: Mapping[str, str] | None = None,
        automatic_reading: bool = False,
        reject_calls: bool = False,
    ) -> dict[str, Any]:
        """Cria uma nova instância pela API Key Mestra (onboarding transparente).

        ``webhooks`` mapeia tipo→URL: connected, delivery, disconnected, status,
        presence, received. Retorna o payload com o novo instanceId e token.
        """
        hooks = webhooks or {}
        body = {
            "apiKey": self._config.master_api_key,
            "instanceName": instance_name,
            "lite": lite,
            "webhookConnectedUrl": hooks.get("connected", ""),
            "webhookDeliveryUrl": hooks.get("delivery", ""),
            "webhookDisconnectedUrl": hooks.get("disconnected", ""),
            "webhookStatusUrl": hooks.get("status", ""),
            "webhookPresenceUrl": hooks.get("presence", ""),
            "webhookReceivedUrl": hooks.get("received", ""),
            "automaticReading": automatic_reading,
            "rejectCalls": reject_calls,
        }
        result = await self._request("POST", "/client/create-instance", json_body=body, timeout=40.0)
        return result if isinstance(result, dict) else {}

    async def list_instances(self) -> Any:
        """Lista instâncias do owner usando a API Key Mestra no Bearer header.

        A coleção local não define um envelope único para a resposta. O payload
        permanece intacto para a reconciliação idempotente aceitar instances,
        data ou uma lista direta sem enviar credenciais na query string.
        """
        return await self._request(
            "GET",
            "/client/list-instances",
            token=self._config.master_api_key,
            timeout=25.0,
            retriable=True,
        )

    # ---- instância (token da instância) ----------------------------------

    async def status(self, instance_id: str, token: str) -> dict[str, Any]:
        result = await self._request(
            "GET", "/instance/status-instance", token=token, instance_id=instance_id, timeout=12.0, retriable=True
        )
        return result if isinstance(result, dict) else {}

    async def qr_code(
        self,
        instance_id: str,
        token: str,
        *,
        sync_contacts: bool = True,
    ) -> dict[str, Any]:
        # O contrato oficial expõe ``syncContacts=enable|disable`` no momento
        # do pareamento. Sem ele a sessão Web pode nascer apenas com JIDs e
        # números, impossibilitando que fetch-contacts devolva o catálogo que o
        # aparelho disponibilizou ao WhatsApp Web.
        result = await self._request(
            "GET",
            "/instance/qr-code",
            token=token,
            instance_id=instance_id,
            params={"syncContacts": "enable" if sync_contacts else "disable"},
            timeout=15.0,
        )
        return result if isinstance(result, dict) else {}

    async def pairing_code(
        self,
        instance_id: str,
        token: str,
        phone: str,
        *,
        sync_contacts: bool = True,
    ) -> dict[str, Any]:
        result = await self._request(
            "GET", "/instance/pairing-code", token=token, instance_id=instance_id,
            params={
                "phoneNumber": phone,
                "syncContacts": "enable" if sync_contacts else "disable",
            },
            timeout=15.0,
        )
        return result if isinstance(result, dict) else {}

    async def device(self, instance_id: str, token: str) -> dict[str, Any]:
        result = await self._request(
            "GET", "/instance/device", token=token, instance_id=instance_id, timeout=12.0, retriable=True
        )
        return result if isinstance(result, dict) else {}

    async def fetch_instance(self, instance_id: str, token: str) -> dict[str, Any]:
        result = await self._request(
            "GET", "/instance/fetch-instance", token=token, instance_id=instance_id, timeout=12.0, retriable=True
        )
        return result if isinstance(result, dict) else {}

    async def disconnect(self, instance_id: str, token: str) -> dict[str, Any]:
        result = await self._request(
            "GET", "/instance/disconnect", token=token, instance_id=instance_id, timeout=30.0
        )
        return result if isinstance(result, dict) else {}

    async def restart(self, instance_id: str, token: str) -> dict[str, Any]:
        result = await self._request(
            "GET", "/instance/restart", token=token, instance_id=instance_id, timeout=30.0
        )
        return result if isinstance(result, dict) else {}

    async def set_webhook(self, instance_id: str, token: str, event: str, url: str) -> dict[str, Any]:
        """Configura a URL de um webhook por tipo de evento.

        ``event`` ∈ {connected, disconnected, delivery, received,
        message-status, chat-presence}.
        """
        path = f"/webhook/update-webhook-{event}"
        result = await self._request(
            "PUT", path, token=token, instance_id=instance_id, json_body={"value": url}, timeout=15.0
        )
        return result if isinstance(result, dict) else {}

    # ---- mensagens (token da instância; envio NUNCA faz retry) ------------

    async def send_text(
        self, instance_id: str, token: str, phone: str, message: str, *,
        quoted_message_id: str = "", delay: int = 0,
    ) -> dict[str, Any]:
        body = {"phone": phone, "message": message, "messageId": quoted_message_id, "delayMessage": delay}
        result = await self._request(
            "POST", "/message/send-text", token=token, instance_id=instance_id, json_body=body, timeout=35.0
        )
        return result if isinstance(result, dict) else {}

    async def send_media(
        self, instance_id: str, token: str, kind: str, phone: str, data: str, *,
        caption: str = "", file_name: str = "", extension: str = "",
        quoted_message_id: str = "", delay: int = 0, timeout: float = 90.0, view_once: bool = False,
    ) -> dict[str, Any]:
        """Envia mídia. ``kind`` ∈ {image, audio, video, sticker, gif, ptv, document}.

        ``data`` é URL pública ou base64 (data URI), conforme aceito pela W-API.
        """
        field = "document" if kind == "document" else kind
        body: dict[str, Any] = {
            "phone": phone,
            field: data,
            "messageId": quoted_message_id,
            "delayMessage": delay,
        }
        if view_once and kind in {"image", "audio", "video"}:
            body["viewOnce"] = True
        if kind in {"image", "video", "gif", "document"}:
            body["caption"] = caption
        if kind == "document":
            body["fileName"] = file_name
            body["extension"] = extension
        result = await self._request(
            "POST", f"/message/send-{kind}", token=token, instance_id=instance_id, json_body=body, timeout=timeout
        )
        return result if isinstance(result, dict) else {}

    async def send_location(
        self, instance_id: str, token: str, phone: str, latitude: str, longitude: str, *,
        name: str = "", address: str = "", delay: int = 0,
    ) -> dict[str, Any]:
        body = {
            "phone": phone, "latitude": latitude, "longitude": longitude,
            "name": name, "address": address, "delayMessage": delay,
        }
        result = await self._request(
            "POST", "/message/send-location", token=token, instance_id=instance_id, json_body=body, timeout=35.0
        )
        return result if isinstance(result, dict) else {}

    async def send_reaction(
        self, instance_id: str, token: str, phone: str, message_id: str, reaction: str, *, delay: int = 0
    ) -> dict[str, Any]:
        body = {"phone": phone, "messageId": message_id, "reaction": reaction, "delayMessage": delay}
        result = await self._request(
            "POST", "/message/send-reaction", token=token, instance_id=instance_id, json_body=body, timeout=25.0
        )
        return result if isinstance(result, dict) else {}

    async def remove_reaction(self, instance_id: str, token: str, phone: str, message_id: str) -> dict[str, Any]:
        body = {"phone": phone, "messageId": message_id}
        result = await self._request(
            "POST", "/message/remove-reaction", token=token, instance_id=instance_id, json_body=body, timeout=25.0
        )
        return result if isinstance(result, dict) else {}

    async def edit_message(self, instance_id: str, token: str, phone: str, message_id: str, text: str) -> dict[str, Any]:
        body = {"phone": phone, "messageId": message_id, "text": text}
        result = await self._request(
            "POST", "/message/edit-message", token=token, instance_id=instance_id, json_body=body, timeout=25.0
        )
        return result if isinstance(result, dict) else {}

    async def delete_message(self, instance_id: str, token: str, phone: str, message_id: str) -> dict[str, Any]:
        result = await self._request(
            "DELETE",
            "/message/delete-message",
            token=token,
            instance_id=instance_id,
            params={"phone": phone, "messageId": message_id},
            timeout=25.0,
        )
        return result if isinstance(result, dict) else {}

    async def read_message(self, instance_id: str, token: str, phone: str, message_id: str) -> dict[str, Any]:
        body = {"phone": phone, "messageId": message_id}
        result = await self._request(
            "POST", "/message/read-message", token=token, instance_id=instance_id, json_body=body, timeout=25.0
        )
        return result if isinstance(result, dict) else {}

    async def download_media(
        self, instance_id: str, token: str, *, media_key: str, direct_path: str, media_type: str, mimetype: str
    ) -> dict[str, Any]:
        body = {"mediaKey": media_key, "directPath": direct_path, "type": media_type, "mimetype": mimetype}
        result = await self._request(
            "POST", "/message/download-media", token=token, instance_id=instance_id, json_body=body, timeout=60.0
        )
        return result if isinstance(result, dict) else {}

    # ---- conversas / contatos --------------------------------------------

    async def fetch_chats(self, instance_id: str, token: str, **params: Any) -> Any:
        return await self._request(
            "GET", "/chats/fetch-chats", token=token, instance_id=instance_id, params=params, timeout=30.0, retriable=True
        )

    async def fetch_chat(self, instance_id: str, token: str, phone: str) -> Any:
        return await self._request(
            "GET",
            "/chats/chat",
            token=token,
            instance_id=instance_id,
            params={"phoneNumber": phone},
            timeout=25.0,
            retriable=True,
        )

    async def send_presence(self, instance_id: str, token: str, phone: str, presence: str, *, delay: int = 0) -> dict[str, Any]:
        body = {"phone": phone, "presence": presence, "delay": delay}
        result = await self._request(
            "POST", "/chats/send-presence", token=token, instance_id=instance_id, json_body=body, timeout=15.0
        )
        return result if isinstance(result, dict) else {}

    # Caminhos de contatos verificados ao vivo: prefixo único /contacts/ (a
    # coleção Postman trazia o segmento duplicado) e parâmetro `phoneNumber`.
    async def fetch_contacts(self, instance_id: str, token: str, **params: Any) -> Any:
        return await self._request(
            "GET", "/contacts/fetch-contacts", token=token, instance_id=instance_id,
            params=params, timeout=30.0, retriable=True,
        )

    async def phone_exists(self, instance_id: str, token: str, phone: str) -> dict[str, Any]:
        result = await self._request(
            "GET", "/contacts/phone-exists", token=token, instance_id=instance_id,
            params={"phoneNumber": phone}, timeout=20.0, retriable=True,
        )
        return result if isinstance(result, dict) else {}

    async def contact_profile_picture(self, instance_id: str, token: str, phone: str) -> dict[str, Any]:
        result = await self._request(
            "GET", "/contacts/profile-picture", token=token, instance_id=instance_id,
            params={"phoneNumber": phone}, timeout=20.0, retriable=True,
        )
        return result if isinstance(result, dict) else {}

    async def block_contact(self, instance_id: str, token: str, phone: str, block: bool = True) -> dict[str, Any]:
        # Contrato oficial: {phoneNumber, blockStatus}.
        body = {"phoneNumber": phone, "blockStatus": block}
        result = await self._request(
            "POST", "/contacts/block-contact", token=token, instance_id=instance_id, json_body=body, timeout=20.0
        )
        return result if isinstance(result, dict) else {}

    # ---- grupos ----------------------------------------------------------

    async def create_group(
        self, instance_id: str, token: str, group_name: str, participants: list[str], *,
        profile_picture_url: str = "", auto_invite: bool = True,
    ) -> dict[str, Any]:
        body = {
            "groupName": group_name, "participants": participants,
            "profilePictureUrl": profile_picture_url, "autoInvite": auto_invite,
        }
        result = await self._request(
            "POST", "/group/create-group", token=token, instance_id=instance_id, json_body=body, timeout=40.0
        )
        return result if isinstance(result, dict) else {}

    async def group_metadata(self, instance_id: str, token: str, group_id: str) -> dict[str, Any]:
        result = await self._request(
            "GET", "/group/group-metadata", token=token, instance_id=instance_id,
            params={"groupId": group_id}, timeout=25.0, retriable=True,
        )
        return result if isinstance(result, dict) else {}

    async def group_participants(self, instance_id: str, token: str, group_id: str) -> dict[str, Any]:
        """Busca os participantes pelo caminho publicado na coleção oficial.

        A capitalização de ``get-Participants`` é mantida porque faz parte do
        contrato atual da W-API.
        """
        result = await self._request(
            "GET",
            "/group/get-Participants",
            token=token,
            instance_id=instance_id,
            params={"groupId": group_id},
            timeout=25.0,
            retriable=True,
        )
        return result if isinstance(result, dict) else {}

    async def get_all_groups(self, instance_id: str, token: str, **params: Any) -> Any:
        return await self._request(
            "GET", "/group/get-all-groups", token=token, instance_id=instance_id, params=params, timeout=30.0, retriable=True
        )
