"""Serviço de mensagens WhatsApp sobre a W-API.

Resolve o vínculo (instância + token) da conta autenticada e delega ao
``WapiClient``. Mantém o router fino e o isolamento na fronteira: só envia pela
instância do próprio usuário.

O ``conversa_id`` do Norium é convertido para o campo ``phone`` esperado pela
W-API (número puro para conversas individuais; id completo para grupos).
"""

from __future__ import annotations

import re
from typing import Any

from app.services import wapi_binding as wb
from app.services.wapi_client import WapiClient, WapiError


class MessagingUnavailable(Exception):
    """Não há instância WhatsApp vinculada/conectada para a conta."""


class InvalidGroupParticipants(ValueError):
    """Nenhum participante de grupo possui número internacional utilizável."""


def wapi_phone(conversa_id: str) -> str:
    """Normaliza o id de conversa do Norium para o campo ``phone`` da W-API."""
    cid = str(conversa_id or "").strip()
    if not cid:
        raise MessagingUnavailable("Conversa invalida.")
    # Grupos (@g.us) e ids de privacidade (@lid) vão inteiros; a W-API os resolve.
    if cid.endswith("@g.us") or cid.endswith("@lid"):
        return cid
    # Individuais (@c.us / @s.whatsapp.net) viram número puro.
    local = cid.split("@", 1)[0]
    digits = re.sub(r"\D", "", local)
    return digits or local


class WapiMessagingService:
    def __init__(self, client: WapiClient | None = None) -> None:
        self._client = client or WapiClient()

    def _creds(self, user_id: str) -> tuple[str, str]:
        binding = wb.get_binding(user_id)
        if not binding.exists:
            raise MessagingUnavailable("Nenhuma instancia de WhatsApp vinculada a esta conta.")
        return binding.instance_id, binding.token

    async def send_text(
        self, user_id: str, conversa_id: str, text: str, *, quoted_message_id: str = ""
    ) -> dict[str, Any]:
        instance_id, token = self._creds(user_id)
        res = await self._client.send_text(
            instance_id, token, wapi_phone(conversa_id), text, quoted_message_id=quoted_message_id
        )
        message_id = str(res.get("messageId") or "")
        return {"sent": bool(message_id), "messageId": message_id}

    async def send_media(
        self, user_id: str, conversa_id: str, kind: str, data: str, *,
        caption: str = "", file_name: str = "", extension: str = "", timeout: float = 90.0,
    ) -> dict[str, Any]:
        instance_id, token = self._creds(user_id)
        res = await self._client.send_media(
            instance_id, token, kind, wapi_phone(conversa_id), data,
            caption=caption, file_name=file_name, extension=extension, timeout=timeout,
        )
        message_id = str(res.get("messageId") or "")
        return {"sent": bool(message_id), "messageId": message_id}

    async def react(self, user_id: str, conversa_id: str, message_id: str, emoji: str) -> dict[str, Any]:
        instance_id, token = self._creds(user_id)
        if emoji:
            await self._client.send_reaction(instance_id, token, wapi_phone(conversa_id), message_id, emoji)
        else:
            await self._client.remove_reaction(instance_id, token, wapi_phone(conversa_id), message_id)
        return {"reacted": True, "emoji": emoji}

    async def edit(self, user_id: str, conversa_id: str, message_id: str, text: str) -> dict[str, Any]:
        instance_id, token = self._creds(user_id)
        await self._client.edit_message(instance_id, token, wapi_phone(conversa_id), message_id, text)
        return {"edited": True}

    async def delete(self, user_id: str, conversa_id: str, message_id: str, for_everyone: bool = True) -> dict[str, Any]:
        instance_id, token = self._creds(user_id)
        # A W-API apaga para todos; a exclusão "somente local" é tratada no store.
        if for_everyone:
            await self._client.delete_message(instance_id, token, wapi_phone(conversa_id), message_id)
        return {"deleted": True}

    async def mark_read(self, user_id: str, conversa_id: str, message_id: str) -> dict[str, Any]:
        instance_id, token = self._creds(user_id)
        await self._client.read_message(instance_id, token, wapi_phone(conversa_id), message_id)
        return {"read": True}

    async def create_group(
        self,
        user_id: str,
        name: str,
        participants: list[str],
        *,
        profile_picture_url: str = "",
        auto_invite: bool = True,
    ) -> dict[str, Any]:
        instance_id, token = self._creds(user_id)
        numbers: list[str] = []
        for participant in participants:
            raw = str(participant or "").strip()
            if not raw or raw.lower().endswith(("@lid", "@g.us", "@newsletter")):
                continue
            local = raw.split("@", 1)[0]
            digits = re.sub(r"\D", "", local)
            if len(digits) >= 8 and digits not in numbers:
                numbers.append(digits)
        if not numbers:
            raise InvalidGroupParticipants(
                "Informe ao menos um contato com numero internacional (DDI, DDD e telefone)."
            )
        return await self._client.create_group(
            instance_id,
            token,
            name,
            numbers,
            profile_picture_url=profile_picture_url,
            auto_invite=auto_invite,
        )


__all__ = [
    "WapiMessagingService",
    "MessagingUnavailable",
    "InvalidGroupParticipants",
    "WapiError",
    "wapi_phone",
]
