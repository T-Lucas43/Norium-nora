import logging
import os
from typing import Any, Dict

import httpx
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)


class WhatsAppService:
    def __init__(self) -> None:
        self.instance_id = ""
        self.base_url = os.getenv("WHATSAPP_API_URL", "").strip().rstrip("/")
        self.api_key = os.getenv("WHATSAPP_API_KEY", "").strip()
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    async def inicializar_instancia(self, user_id: str) -> Dict[str, Any]:
        del user_id
        if not self.configured:
            return {"status": "indisponivel", "qrcode": None, "detail": "API do WhatsApp nao configurada."}

        async with httpx.AsyncClient() as client:
            try:
                status_res = await client.get(
                    f"{self.base_url}/session/status",
                    headers=self.headers,
                    timeout=8.0,
                )
                if status_res.status_code == 200:
                    status_data = status_res.json()
                    state = str(status_data.get("state") or "starting").lower()
                    if status_data.get("connected") is True or state == "connected":
                        return {"status": "conectado", "qrcode": None}

                qr_res = await client.get(
                    f"{self.base_url}/session/qr",
                    headers=self.headers,
                    timeout=8.0,
                )
                if qr_res.status_code == 200:
                    data = qr_res.json()
                    state = str(data.get("state") or "starting").lower()
                    qrcode = data.get("qr")
                    if qrcode:
                        return {"status": "aguardando_qrcode", "qrcode": qrcode}
                    if state == "connected":
                        return {"status": "conectado", "qrcode": None}
                    return {"status": "iniciando", "qrcode": None, "state": state}

                return {"status": "erro", "qrcode": None}
            except Exception as exc:
                logger.warning("Falha de comunicacao com a API privada do WhatsApp (%s).", type(exc).__name__)
                return {"status": "erro", "qrcode": None}

    async def enviar_mensagem_texto(self, numero: str, texto: str) -> bool:
        return await self._post_api("/messages/text", {"to": numero, "text": texto}, timeout=15.0)

    async def enviar_audio(self, numero: str, audio: str) -> bool:
        return await self._send_media(numero, audio, "audio.ogg", "", timeout=45.0)

    async def enviar_imagem(self, numero: str, image: str, caption: str | None = None) -> bool:
        return await self._send_media(numero, image, "imagem.jpg", caption or "", timeout=45.0)

    async def enviar_video(self, numero: str, video: str, caption: str | None = None) -> bool:
        return await self._send_media(numero, video, "video.mp4", caption or "", timeout=60.0)

    async def enviar_documento(self, numero: str, document: str, file_name: str, extension: str) -> bool:
        safe_name = file_name or f"arquivo.{extension or 'bin'}"
        return await self._send_media(numero, document, safe_name, "", timeout=60.0)

    async def _send_media(self, numero: str, data: str, filename: str, caption: str, timeout: float) -> bool:
        return await self._post_api(
            "/messages/media",
            {"to": numero, "data": data, "filename": filename, "caption": caption, "viewOnce": False},
            timeout=timeout,
        )

    async def _post_api(self, endpoint: str, payload: Dict[str, Any], timeout: float) -> bool:
        if not self.configured:
            return False
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    f"{self.base_url}{endpoint}",
                    json=payload,
                    headers=self.headers,
                    timeout=timeout,
                )
                logger.info("API privada do WhatsApp respondeu a %s com status %s.", endpoint, response.status_code)
                return response.status_code in (200, 201)
            except Exception as exc:
                logger.warning("Falha no endpoint WhatsApp %s (%s).", endpoint, type(exc).__name__)
                return False
