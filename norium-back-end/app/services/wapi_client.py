"""Cliente HTTP da W-API (https://api.w-api.app).

Camada única de acesso à W-API para todo o Norium. Concentra base URL,
autenticação, timeouts, retries idempotentes, normalização de erros e a garantia
de nunca registrar segredos (token da instância, QR Code, conteúdo de mídia).

Contrato confirmado em ``docs/W-API.postman_collection.json`` e verificado ao
vivo. Regras de autenticação:

- Operações de instância/mensagem: header ``Authorization: Bearer <token>`` e
  ``?instanceId=<id>`` na query. O token é próprio de cada instância e vem do
  vínculo por tenant, nunca de um valor global.
- Operações de conta (``/client/*``): usam a API Key Mestra, enviada no corpo
  (campo ``apiKey``) conforme o contrato oficial.

O cliente é sem estado por tenant: quem chama fornece ``instance_id`` e
``token`` obtidos do store de vínculo. Assim o isolamento por usuário é decidido
na fronteira de autorização, não aqui.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any, Mapping

import httpx
from dotenv import load_dotenv


load_dotenv()
logger = logging.getLogger(__name__)

# Códigos idempotentes onde um retry é seguro. Envio de mensagem NUNCA entra aqui
# porque a W-API enfileira mesmo desconectada e um retry duplicaria a mensagem.
_RETRIABLE_STATUS = {429, 500, 502, 503, 504}
_DEFAULT_TIMEOUT = 20.0


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
    master_api_key: str
    webhook_secret: str

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.master_api_key)


def load_wapi_config() -> WapiConfig:
    raw_base = os.getenv("WAPI_BASE_URL", "https://api.w-api.app").strip().rstrip("/")
    # Aceita tanto ``https://api.w-api.app`` quanto ``.../v1`` para tolerar
    # configurações divergentes; o cliente sempre fala com ``/v1``.
    base = raw_base[:-3].rstrip("/") if raw_base.endswith("/v1") else raw_base
    return WapiConfig(
        base_url=base,
        master_api_key=os.getenv("WAPI_MASTER_API_KEY", "").strip(),
        webhook_secret=os.getenv("WAPI_WEBHOOK_SECRET", "").strip(),
    )


class WapiClient:
    """Fachada assíncrona sobre os endpoints da W-API."""

    def __init__(self, config: WapiConfig | None = None) -> None:
        self._config = config or load_wapi_config()

    @property
    def config(self) -> WapiConfig:
        return self._config

    @property
    def configured(self) -> bool:
        return self._config.configured

    # ---- núcleo HTTP -----------------------------------------------------

    def _url(self, path: str) -> str:
        normalized = path if path.startswith("/") else f"/{path}"
        return f"{self._config.base_url}/v1{normalized}"

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

        query: dict[str, Any] = {}
        if instance_id:
            query["instanceId"] = instance_id
        if params:
            query.update({k: v for k, v in params.items() if v is not None})

        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        attempts = 3 if retriable else 1
        last_exc: Exception | None = None
        for attempt in range(attempts):
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        self._url(path),
                        params=query or None,
                        json=dict(json_body) if json_body is not None else None,
                        headers=headers,
                        timeout=timeout,
                    )
            except httpx.HTTPError as exc:
                last_exc = exc
                if retriable and attempt < attempts - 1:
                    await asyncio.sleep(0.3 * (2**attempt))
                    continue
                # Nunca inclui URL completa com query (evita vazar instanceId em log).
                logger.warning("Falha de rede na W-API em %s (%s).", path, type(exc).__name__)
                raise WapiError("Falha de comunicação com a W-API.", code="network") from exc

            if response.status_code in _RETRIABLE_STATUS and retriable and attempt < attempts - 1:
                await asyncio.sleep(0.3 * (2**attempt))
                continue

            return self._parse(response, path)

        raise WapiError("Falha de comunicação com a W-API.", code="network")  # pragma: no cover

    def _parse(self, response: httpx.Response, path: str) -> Any:
        try:
            data = response.json()
        except ValueError:
            data = None

        if response.status_code >= 400:
            message = "Erro na W-API."
            if isinstance(data, dict):
                message = str(data.get("message") or data.get("error") or message)
            logger.warning("W-API recusou %s com status %s.", path, response.status_code)
            raise WapiError(message, status=response.status_code)

        # A W-API sinaliza erro lógico com ``error: true`` em resposta 200.
        if isinstance(data, dict) and data.get("error") is True:
            message = str(data.get("message") or data.get("errorMessage") or "Erro na W-API.")
            logical_status: int | None = None
            for candidate in (data.get("statusCode"), data.get("httpStatus"), data.get("code")):
                try:
                    numeric = int(candidate)
                except (TypeError, ValueError):
                    continue
                if 400 <= numeric <= 599:
                    logical_status = numeric
                    break
            if "acesso negado" in message.casefold() or "access denied" in message.casefold():
                logical_status = logical_status or 403
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
        # NÃO VERIFICADO ao vivo: auth/param da API Mestra não testados (evitamos
        # tocar em endpoints de conta durante o desenvolvimento).
        return await self._request(
            "GET",
            "/client/list-instances",
            params={"apiKey": self._config.master_api_key},
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
        quoted_message_id: str = "", delay: int = 0, timeout: float = 90.0,
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
