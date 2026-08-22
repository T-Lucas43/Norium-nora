import hashlib
import hmac
import logging
import os
from typing import Any, Dict

import httpx
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)


class WhatsAppService:
    def __init__(self) -> None:
        configured_url = os.getenv("WHATSAPP_API_URL", "").strip().rstrip("/")
        self.base_url = (
            configured_url
            if configured_url.endswith("/v1")
            else f"{configured_url}/v1" if configured_url else ""
        )
        self.api_key = os.getenv("WHATSAPP_API_KEY", "").strip()
        self.legacy_owner_user_id = os.getenv(
            "WHATSAPP_LEGACY_OWNER_USER_ID",
            os.getenv("WHATSAPP_OWNER_USER_ID", ""),
        ).strip()

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    def session_id_for(self, user_id: str) -> str:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            raise ValueError("Usuario autenticado ausente.")
        if self.legacy_owner_user_id and normalized_user_id == self.legacy_owner_user_id:
            return "norium"
        digest = hmac.new(
            self.api_key.encode("utf-8"),
            normalized_user_id.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"wa_{digest[:40]}"

    def headers_for(self, user_id: str, *, destructive: bool = False) -> Dict[str, str]:
        session_id = self.session_id_for(user_id)
        normalized_user_id = str(user_id).strip()
        signature = hmac.new(
            self.api_key.encode("utf-8"),
            f"{normalized_user_id}\n{session_id}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "X-Norium-User-Id": normalized_user_id,
            "X-Norium-Session-Id": session_id,
            "X-Norium-Session-Signature": signature,
        }
        if destructive:
            headers["X-Confirm-Destructive"] = "true"
        return headers

    async def consultar_instancia(self, user_id: str) -> Dict[str, Any]:
        if not self.configured:
            return {"status": "indisponivel", "qrcode": None, "detail": "API do WhatsApp nao configurada."}
        status_data = await self._request_json(user_id, "GET", "/session/status", timeout=10.0)
        if not isinstance(status_data, dict):
            return {"status": "erro", "qrcode": None, "detail": "API do WhatsApp indisponivel."}
        state = str(status_data.get("state") or "starting").lower()
        if status_data.get("connected") is True or state == "connected":
            return {
                "status": "conectado",
                "qrcode": None,
                "state": "connected",
                "numero": status_data.get("hostNumber"),
                "conectadoEm": status_data.get("connectedAt"),
            }
        if state == "qr":
            qr_data = await self._request_json(user_id, "GET", "/session/qr", timeout=10.0)
            qrcode = qr_data.get("qr") if isinstance(qr_data, dict) else None
            return {
                "status": "aguardando_qrcode" if qrcode else "iniciando",
                "qrcode": qrcode,
                "state": "qr",
            }
        if state == "disconnected":
            return {"status": "desconectado", "qrcode": None, "state": state}
        if state == "error":
            return {
                "status": "erro",
                "qrcode": None,
                "state": state,
                "detail": str(status_data.get("lastError") or "Falha ao iniciar a sessao do WhatsApp."),
            }
        return {"status": "iniciando", "qrcode": None, "state": state}

    async def inicializar_instancia(self, user_id: str) -> Dict[str, Any]:
        current = await self.consultar_instancia(user_id)
        if current.get("status") in {"conectado", "aguardando_qrcode", "iniciando"}:
            return current
        result = await self._request_json(user_id, "POST", "/session/reconnect", payload={}, timeout=12.0)
        if not isinstance(result, dict):
            return {"status": "erro", "qrcode": None, "detail": "Nao foi possivel iniciar a sessao."}
        return {"status": "iniciando", "qrcode": None, "state": str(result.get("state") or "starting")}

    async def desconectar_instancia(self, user_id: str) -> bool:
        result = await self._request_json(
            user_id,
            "POST",
            "/session/logout",
            payload={},
            timeout=30.0,
            destructive=True,
        )
        return isinstance(result, dict) and result.get("loggedOut") is True

    async def enviar_mensagem_texto(self, user_id: str, numero: str, texto: str) -> Dict[str, Any] | None:
        result = await self._request_json(
            user_id,
            "POST",
            "/messages/text",
            payload={"to": numero, "text": texto},
            timeout=35.0,
        )
        return result if isinstance(result, dict) else None

    async def enviar_audio(self, user_id: str, numero: str, audio: str) -> Dict[str, Any] | None:
        return await self._send_media(user_id, numero, audio, "audio.ogg", "", timeout=50.0)

    async def enviar_imagem(self, user_id: str, numero: str, image: str, caption: str | None = None) -> Dict[str, Any] | None:
        return await self._send_media(user_id, numero, image, "imagem.jpg", caption or "", timeout=50.0)

    async def enviar_video(self, user_id: str, numero: str, video: str, caption: str | None = None) -> Dict[str, Any] | None:
        return await self._send_media(user_id, numero, video, "video.mp4", caption or "", timeout=95.0)

    async def enviar_documento(
        self,
        user_id: str,
        numero: str,
        document: str,
        file_name: str,
        extension: str,
    ) -> Dict[str, Any] | None:
        safe_name = file_name or f"arquivo.{extension or 'bin'}"
        return await self._send_media(user_id, numero, document, safe_name, "", timeout=95.0)

    async def _send_media(
        self,
        user_id: str,
        numero: str,
        data: str,
        filename: str,
        caption: str,
        timeout: float,
    ) -> Dict[str, Any] | None:
        result = await self._request_json(
            user_id,
            "POST",
            "/messages/media",
            payload={"to": numero, "data": data, "filename": filename, "caption": caption, "viewOnce": False},
            timeout=timeout,
        )
        return result if isinstance(result, dict) else None

    async def get(self, user_id: str, endpoint: str, *, timeout: float = 15.0) -> Dict[str, Any] | list[Any] | None:
        return await self._request_json(user_id, "GET", endpoint, timeout=timeout)

    async def post(
        self,
        user_id: str,
        endpoint: str,
        payload: Dict[str, Any],
        *,
        timeout: float = 30.0,
        destructive: bool = False,
    ) -> Dict[str, Any] | list[Any] | None:
        return await self._request_json(
            user_id,
            "POST",
            endpoint,
            payload=payload,
            timeout=timeout,
            destructive=destructive,
        )

    async def delete(
        self,
        user_id: str,
        endpoint: str,
        payload: Dict[str, Any] | None = None,
        *,
        timeout: float = 30.0,
        destructive: bool = True,
    ) -> Dict[str, Any] | list[Any] | None:
        return await self._request_json(
            user_id,
            "DELETE",
            endpoint,
            payload=payload,
            timeout=timeout,
            destructive=destructive,
        )

    async def _request_json(
        self,
        user_id: str,
        method: str,
        endpoint: str,
        *,
        payload: Dict[str, Any] | None = None,
        timeout: float,
        destructive: bool = False,
    ) -> Dict[str, Any] | list[Any] | None:
        if not self.configured:
            return None
        try:
            async with httpx.AsyncClient() as client:
                response = await client.request(
                    method,
                    f"{self.base_url}{endpoint}",
                    json=payload,
                    headers=self.headers_for(user_id, destructive=destructive),
                    timeout=timeout,
                )
            if response.status_code not in (200, 201, 202):
                logger.warning("API privada do WhatsApp recusou %s com status %s.", endpoint, response.status_code)
                return None
            data = response.json()
            return data if isinstance(data, (dict, list)) else None
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("Falha no endpoint WhatsApp %s (%s).", endpoint, type(exc).__name__)
            return None
