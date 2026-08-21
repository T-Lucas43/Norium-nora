import httpx
import logging
import os
from typing import Dict, Any
from dotenv import load_dotenv

# 👑 CRÍTICO: Carrega explicitamente o arquivo .env da raiz do projeto
load_dotenv()
logger = logging.getLogger(__name__)

class WhatsAppService:
    def __init__(self):
        self.instance_id = os.getenv("WHATSAPP_INSTANCE_ID", "").strip()
        self.instance_token = os.getenv("WHATSAPP_INSTANCE_TOKEN", "").strip()
        self.client_token = os.getenv("WHATSAPP_CLIENT_TOKEN", "").strip()
        self.api_url = os.getenv("WHATSAPP_API_URL", "").strip().rstrip("/")
        self.api_key = os.getenv("WHATSAPP_API_KEY", "").strip()

        if self.api_url:
            self.base_url = self.api_url
            self.headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
            self.provider = "openwa"
        else:
            self.base_url = f"https://api.z-api.io/instances/{self.instance_id}/token/{self.instance_token}"
            # Compatibilidade temporaria com a integracao legada.
            self.headers = {
                "client-token": self.client_token,
                "Content-Type": "application/json",
            }
            self.provider = "z-api"

    async def inicializar_instancia(self, user_id: str) -> Dict[str, Any]:
        async with httpx.AsyncClient() as client:
            try:
                status_res = await client.get(f"{self.base_url}/status-connection", headers=self.headers, timeout=5.0)
                if status_res.status_code == 200:
                    status_data = status_res.json()
                    if status_data.get("connected") is True or status_data.get("status") == "CONNECTED":
                        return {"status": "conectado", "qrcode": None}

                qr_res = await client.get(f"{self.base_url}/qr-code", headers=self.headers, timeout=10.0)
                if qr_res.status_code == 200:
                    data = qr_res.json()
                    qrcode_base64 = data.get("value") or data.get("image")
                    if qrcode_base64:
                        if not qrcode_base64.startswith("data:image"):
                            qrcode_base64 = f"data:image/png;base64,{qrcode_base64}"
                        return {"status": "aguardando_qrcode", "qrcode": qrcode_base64}
                return {"status": "erro", "qrcode": None}
            except Exception as exc:
                logger.warning("Falha de comunicacao com o gateway WhatsApp (%s).", type(exc).__name__)
                return {"status": "erro", "qrcode": None}

    async def enviar_mensagem_texto(self, numero: str, texto: str) -> bool:
        async with httpx.AsyncClient() as client:
            try:
                payload = {"phone": numero, "message": texto}
                res = await client.post(f"{self.base_url}/send-text", json=payload, headers=self.headers, timeout=10.0)
                logger.info("Gateway WhatsApp respondeu ao envio de texto com status %s.", res.status_code)
                return res.status_code in [200, 201]
            except Exception as exc:
                logger.warning("Falha no envio pelo gateway WhatsApp (%s).", type(exc).__name__)
                return False
    async def enviar_audio(self, numero: str, audio: str) -> bool:
        return await self._post_gateway("/send-audio", {"phone": numero, "audio": audio, "waveform": True}, timeout=35.0)

    async def enviar_imagem(self, numero: str, image: str, caption: str | None = None) -> bool:
        payload: Dict[str, Any] = {"phone": numero, "image": image}
        if caption:
            payload["caption"] = caption
        return await self._post_gateway("/send-image", payload, timeout=35.0)

    async def enviar_video(self, numero: str, video: str, caption: str | None = None) -> bool:
        payload: Dict[str, Any] = {"phone": numero, "video": video}
        if caption:
            payload["caption"] = caption
        return await self._post_gateway("/send-video", payload, timeout=45.0)

    async def enviar_documento(self, numero: str, document: str, file_name: str, extension: str) -> bool:
        payload = {
            "phone": numero,
            "document": document,
            "fileName": file_name,
        }
        if await self._post_gateway(f"/send-document/{extension}", payload, timeout=45.0):
            return True
        return await self._post_gateway("/send-document", payload, timeout=45.0)

    async def _post_gateway(self, endpoint: str, payload: Dict[str, Any], timeout: float = 15.0) -> bool:
        async with httpx.AsyncClient() as client:
            try:
                res = await client.post(f"{self.base_url}{endpoint}", json=payload, headers=self.headers, timeout=timeout)
                logger.info("Gateway WhatsApp respondeu a %s com status %s.", endpoint, res.status_code)
                return res.status_code in [200, 201]
            except Exception as exc:
                logger.warning("Falha no endpoint WhatsApp %s (%s).", endpoint, type(exc).__name__)
                return False
