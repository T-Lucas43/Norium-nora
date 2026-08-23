"""Orquestra o ciclo de vida da conexão WhatsApp de cada conta via W-API.

Fluxo: aceite obrigatório dos termos → garantir instância → QR/pairing →
status → desconexão. O aceite é pré-requisito inviolável para gerar/entregar o
QR Code (regra de "uso responsável e risco de banimento").

A resposta de estado segue o formato já consumido pelo frontend
(``/api/chat/status-canais``), para preservar o contrato público durante a troca
do backend de WhatsApp pela W-API.

Isolamento: todas as operações recebem o ``user_id`` da sessão autenticada e
atuam somente sobre o vínculo daquela conta.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any
from urllib.parse import quote

from app.services import wapi_binding as wb
from app.services.wapi_binding import InstanceBinding, CONSENT_TERM_VERSION
from app.services.wapi_client import WapiClient, WapiError
from app.core.tenant import public_api_url


logger = logging.getLogger(__name__)


class ConsentRequiredError(Exception):
    """Levantada quando o usuário tenta gerar/ler o QR sem aceite válido."""


# Mapeia os 6 tipos de webhook da W-API para o endpoint público único do Norium.
_WEBHOOK_PATH = "/api/whatsapp/webhook"
_WEBHOOK_EVENTS = ("connected", "disconnected", "delivery", "received", "status", "presence")


class WapiConnectService:
    def __init__(self, client: WapiClient | None = None) -> None:
        self._client = client or WapiClient()

    @property
    def configured(self) -> bool:
        return self._client.configured

    # ---- aceite ----------------------------------------------------------

    def consent_terms(self, user_id: str) -> dict[str, Any]:
        binding = wb.get_binding(user_id)
        record = binding.consent_record()
        return {
            "termVersion": CONSENT_TERM_VERSION,
            "accepted": binding.has_valid_consent(),
            "acceptedVersion": record.term_version if record else None,
        }

    def accept_consent(self, user_id: str, *, origin: str = "chat_whatsapp") -> dict[str, Any]:
        wb.record_consent(user_id, origin=origin)
        return self.consent_terms(user_id)

    def _require_consent(self, user_id: str) -> None:
        if not wb.has_valid_consent(user_id):
            raise ConsentRequiredError(
                "É necessário aceitar as orientações de uso responsável antes de gerar o QR Code."
            )

    # ---- instância -------------------------------------------------------

    def _webhook_urls(self) -> dict[str, str]:
        url = public_api_url(_WEBHOOK_PATH)
        # Sem URL pública configurada não adianta registrar webhook.
        if not url.startswith("http"):
            return {}
        # O segredo viaja na URL registrada para autenticar cada entrega recebida.
        secret = self._client.config.webhook_secret
        if secret:
            url = f"{url}?secret={quote(secret)}"
        return {event: url for event in _WEBHOOK_EVENTS}

    def _homolog_instance(self) -> tuple[str, str]:
        return (
            os.getenv("WAPI_TEST_INSTANCE_ID", "").strip(),
            os.getenv("WAPI_TEST_INSTANCE_TOKEN", "").strip(),
        )

    async def ensure_instance(self, user_id: str, *, allow_create: bool = True) -> InstanceBinding:
        """Garante o vínculo de uma instância à conta, de forma idempotente."""
        binding = wb.get_binding(user_id)
        if binding.exists:
            return binding

        # Homologação: vincula uma instância pré-provisionada (sem create-instance).
        test_id, test_token = self._homolog_instance()
        if test_id and test_token:
            binding.instance_id = test_id
            binding.token = test_token
            binding.instance_name = "homologacao"
            binding.state = "awaiting_qr"
            binding.created_at = time.time()
            logger.info("Instância de homologação vinculada à conta autenticada.")
            return wb.save_binding(user_id, binding)

        if not allow_create:
            raise WapiError("Nenhuma instância de WhatsApp vinculada.", code="no_instance")

        # Produção: cria a instância pela API Key Mestra, já com os webhooks.
        binding.state = "creating"
        wb.save_binding(user_id, binding)
        created = await self._client.create_instance(
            instance_name=f"norium-{user_id}"[:60],
            lite=True,
            webhooks=self._webhook_urls(),
        )
        new_id = str(created.get("instanceId") or created.get("id") or "")
        new_token = str(created.get("token") or created.get("instanceToken") or "")
        if not new_id or not new_token:
            binding.state = "error"
            wb.save_binding(user_id, binding)
            raise WapiError("A W-API não retornou instância válida na criação.", code="create_failed")
        binding.instance_id = new_id
        binding.token = new_token
        binding.state = "awaiting_qr"
        binding.created_at = time.time()
        return wb.save_binding(user_id, binding)

    # ---- estado / QR -----------------------------------------------------

    def _apply_state(self, user_id: str, binding: InstanceBinding, status: str) -> None:
        binding.state = status
        if status == "connected" and binding.connected_at is None:
            binding.connected_at = time.time()
        wb.save_binding(user_id, binding)

    async def status(self, user_id: str) -> dict[str, Any]:
        if not self.configured:
            return {"status": "indisponivel", "qrcode": None, "detail": "W-API não configurada."}
        binding = wb.get_binding(user_id)
        if not binding.exists:
            accepted = binding.has_valid_consent()
            return {
                "status": "sem_instancia" if accepted else "aguardando_aceite",
                "qrcode": None,
                "state": "none",
                "consentRequired": not accepted,
            }
        try:
            live = await self._client.status(binding.instance_id, binding.token)
        except WapiError as exc:
            return {"status": "erro", "qrcode": None, "state": "error", "detail": exc.message}

        connected = live.get("connected") is True
        if connected:
            number = None
            try:
                device = await self._client.device(binding.instance_id, binding.token)
                # Shape verificado ao vivo: {connectedPhone, name, profilePictureUrl, ...}.
                number = device.get("connectedPhone") or device.get("phone") or device.get("number")
            except WapiError:
                number = None
            self._apply_state(user_id, binding, "connected")
            return {
                "status": "conectado",
                "qrcode": None,
                "state": "connected",
                "numero": number,
                "conectadoEm": binding.connected_at,
            }

        # Desconectado: só oferece QR se houver aceite válido.
        if not wb.has_valid_consent(user_id):
            return {"status": "aguardando_aceite", "qrcode": None, "state": "disconnected", "consentRequired": True}
        return {"status": "desconectado", "qrcode": None, "state": "disconnected"}

    async def start(self, user_id: str) -> dict[str, Any]:
        """Inicia a conexão. Exige aceite; retorna o estado já com QR quando houver."""
        self._require_consent(user_id)
        await self.ensure_instance(user_id)
        return await self.qr(user_id)

    async def qr(self, user_id: str) -> dict[str, Any]:
        self._require_consent(user_id)
        binding = wb.get_binding(user_id)
        if not binding.exists:
            await self.ensure_instance(user_id)
            binding = wb.get_binding(user_id)

        live = await self._client.status(binding.instance_id, binding.token)
        if live.get("connected") is True:
            self._apply_state(user_id, binding, "connected")
            return {"status": "conectado", "qrcode": None, "state": "connected"}

        qr = await self._client.qr_code(binding.instance_id, binding.token)
        qrcode = qr.get("qrcode") if isinstance(qr, dict) else None
        self._apply_state(user_id, binding, "awaiting_qr" if qrcode else "connecting")
        return {
            "status": "aguardando_qrcode" if qrcode else "iniciando",
            "qrcode": qrcode,
            "state": "qr" if qrcode else "starting",
        }

    async def disconnect(self, user_id: str) -> bool:
        binding = wb.get_binding(user_id)
        if not binding.exists:
            return False
        try:
            await self._client.disconnect(binding.instance_id, binding.token)
        except WapiError:
            return False
        self._apply_state(user_id, binding, "disconnected")
        return True
