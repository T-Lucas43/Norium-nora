from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

from app.core.tenant import public_api_url, read_profile_db, write_profile_db

load_dotenv()


class TelegramConfigError(RuntimeError):
    pass


class TelegramService:
    def __init__(self) -> None:
        self.bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
        self.webhook_secret = os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip()
        self.api_root = "https://api.telegram.org"

    @property
    def configured(self) -> bool:
        return bool(self.bot_token)

    def webhook_url(self, user_id: str) -> str:
        safe_user_id = "".join(char if char.isalnum() or char in "._-" else "_" for char in str(user_id or "lucas123"))
        return public_api_url(f"/api/telegram/webhook/{safe_user_id}")

    async def status(self, user_id: str) -> dict[str, Any]:
        if not self.configured:
            return {
                "conectado": False,
                "qrcode": None,
                "disponivel": False,
                "detail": "Configure TELEGRAM_BOT_TOKEN no backend.",
            }

        try:
            bot = await self.request("getMe")
            webhook = await self.request("getWebhookInfo")
            return {
                "conectado": True,
                "qrcode": None,
                "disponivel": True,
                "username": bot.get("username"),
                "nome": bot.get("first_name"),
                "webhookUrl": webhook.get("url") or "",
                "pendingUpdates": webhook.get("pending_update_count", 0),
                "webhookEsperado": self.webhook_url(user_id),
            }
        except Exception as exc:
            return {
                "conectado": False,
                "qrcode": None,
                "disponivel": True,
                "detail": str(exc),
            }

    async def configure_webhook(self, user_id: str) -> dict[str, Any]:
        if not self.configured:
            raise TelegramConfigError("Configure TELEGRAM_BOT_TOKEN no backend.")

        webhook_url = self.webhook_url(user_id)
        if not webhook_url.startswith("https://"):
            return {
                "status": "conectado_polling",
                "webhookUrl": webhook_url,
                "detail": "Backend local sem HTTPS. O Norium vai sincronizar por polling enquanto voce estiver usando a tela de Chat.",
            }

        payload: dict[str, Any] = {
            "url": webhook_url,
            "drop_pending_updates": False,
            "allowed_updates": ["message", "edited_message", "channel_post", "edited_channel_post"],
        }
        if self.webhook_secret:
            payload["secret_token"] = self.webhook_secret

        await self.request("setWebhook", json=payload)
        return {"status": "conectado", "webhookUrl": webhook_url}

    async def get_updates(self, user_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
        if not self.configured:
            return []

        state = self._read_state(user_id)
        payload: dict[str, Any] = {
            "limit": max(1, min(limit, 100)),
            "timeout": 0,
            "allowed_updates": ["message", "edited_message", "channel_post", "edited_channel_post"],
        }
        if state.get("lastUpdateId") is not None:
            payload["offset"] = int(state["lastUpdateId"]) + 1

        try:
            updates = await self.request("getUpdates", json=payload)
        except TelegramConfigError as exc:
            if "webhook" in str(exc).lower():
                return []
            raise

        if updates:
            state["lastUpdateId"] = max(int(update.get("update_id") or 0) for update in updates)
            self._write_state(user_id, state)
        return updates if isinstance(updates, list) else []

    async def send_text(self, chat_id: str, text: str) -> dict[str, Any]:
        return await self.request(
            "sendMessage",
            json={
                "chat_id": chat_id,
                "text": text,
                "disable_web_page_preview": False,
            },
        )

    async def send_file(
        self,
        chat_id: str,
        *,
        file_bytes: bytes,
        file_name: str,
        mime_type: str,
        media_kind: str,
        caption: str | None = None,
    ) -> dict[str, Any]:
        method, field = self._upload_method(media_kind)
        data: dict[str, str] = {"chat_id": chat_id}
        if caption:
            data["caption"] = caption
        files = {
            field: (
                Path(file_name).name or "arquivo",
                file_bytes,
                mime_type or mimetypes.guess_type(file_name)[0] or "application/octet-stream",
            )
        }
        return await self.request(method, data=data, files=files)

    async def download_file(self, file_id: str) -> tuple[bytes, str]:
        file_info = await self.request("getFile", json={"file_id": file_id})
        file_path = file_info.get("file_path")
        if not file_path:
            raise TelegramConfigError("Arquivo Telegram sem caminho de download.")
        url = f"{self.api_root}/file/bot{self.bot_token}/{file_path}"
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=35.0)
        if response.status_code != 200:
            raise TelegramConfigError("Telegram recusou o download do arquivo.")
        return response.content, response.headers.get("Content-Type", "application/octet-stream")

    async def request(
        self,
        method: str,
        *,
        json: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
    ) -> Any:
        if not self.configured:
            raise TelegramConfigError("Configure TELEGRAM_BOT_TOKEN no backend.")

        url = f"{self.api_root}/bot{self.bot_token}/{method}"
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=json, data=data, files=files, timeout=35.0)
        payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        if response.status_code >= 400 or payload.get("ok") is False:
            detail = payload.get("description") or response.text or f"Erro Telegram {response.status_code}"
            raise TelegramConfigError(detail)
        return payload.get("result")

    def _upload_method(self, media_kind: str) -> tuple[str, str]:
        if media_kind == "audio":
            return "sendAudio", "audio"
        if media_kind == "image":
            return "sendPhoto", "photo"
        if media_kind == "video":
            return "sendVideo", "video"
        return "sendDocument", "document"

    def _read_state(self, user_id: str) -> dict[str, Any]:
        profile = read_profile_db(user_id, {})
        state = profile.get("telegramSync")
        return state if isinstance(state, dict) else {}

    def _write_state(self, user_id: str, state: dict[str, Any]) -> None:
        profile = read_profile_db(user_id, {})
        profile["telegramSync"] = state
        write_profile_db(user_id, profile)
