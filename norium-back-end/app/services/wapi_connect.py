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

# A W-API gera um QR NOVO a cada chamada de /instance/qr-code (verificado ao
# vivo: chamadas consecutivas retornam QRs distintos), e cada QR é uma sessão de
# pareamento nova que invalida a anterior. O frontend faz polling de status a
# cada ~3s; se cada poll regenerasse o QR, o código exibido seria substituído
# antes de o WhatsApp concluir a vinculação — o celular acusa "não foi possível
# conectar o dispositivo". Por isso mantemos o último QR estável por uma janela
# (tempo suficiente para escanear) e só renovamos quando ele realmente expira.
_QR_CACHE_TTL_SECONDS = max(5.0, float(os.getenv("WAPI_QR_TTL_SECONDS", "20")))


class WapiConnectService:
    def __init__(self, client: WapiClient | None = None) -> None:
        self._client = client or WapiClient()
        # instance_id -> (qrcode, fetched_at). Estabiliza o QR entre polls para
        # não regenerar a sessão de pareamento a cada consulta de status.
        self._qr_cache: dict[str, tuple[str, float]] = {}

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

    async def _find_instance_by_name(self, name: str) -> dict[str, Any] | None:
        """Procura na conta uma instância já criada com este nome (idempotência)."""
        try:
            listing = await self._client.list_instances()
        except WapiError:
            return None
        items = listing.get("instances") if isinstance(listing, dict) else listing
        for item in items or []:
            if (
                isinstance(item, dict)
                and item.get("instanceName") == name
                and item.get("instanceId")
                and item.get("token")
            ):
                return item
        return None

    async def ensure_instance(self, user_id: str, *, allow_create: bool = True) -> InstanceBinding:
        """Garante o vínculo de uma instância à conta, de forma idempotente."""
        binding = wb.get_binding(user_id)
        if binding.exists:
            # Valida se a instância ainda existe (o usuário pode tê-la apagado no
            # painel). Se sumiu, limpa o vínculo e recria/reutiliza abaixo.
            try:
                await self._client.status(binding.instance_id, binding.token)
                return binding
            except WapiError:
                logger.info("Vínculo aponta para instância inexistente; recriando.")
                wb.clear_binding(user_id)
                binding = wb.get_binding(user_id)

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
        instance_name = f"norium-{user_id}"[:60]

        # Idempotência: se já existe uma instância deste usuário, reutiliza — evita
        # criar duplicatas que religam o mesmo número e derrubam outras sessões.
        existing = await self._find_instance_by_name(instance_name)
        if existing:
            binding.instance_id = str(existing.get("instanceId") or "")
            binding.token = str(existing.get("token") or "")
            binding.instance_name = instance_name
            binding.state = "awaiting_qr"
            binding.created_at = time.time()
            if binding.exists:
                return wb.save_binding(user_id, binding)

        # Plano da instância criada: PRO por padrão (LITE bloqueia reações,
        # figurinhas, listagem e sync de enviadas). Override por WAPI_INSTANCE_LITE.
        lite = os.getenv("WAPI_INSTANCE_LITE", "false").strip().lower() in {"1", "true", "yes"}
        created = await self._client.create_instance(
            instance_name=instance_name,
            lite=lite,
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

    def _drop_qr_cache(self, instance_id: str) -> None:
        self._qr_cache.pop(instance_id, None)

    async def _stable_qr(self, instance_id: str, token: str, *, force: bool = False) -> str | None:
        """Devolve um QR estável dentro da janela de TTL.

        Como cada chamada à W-API cria uma sessão de pareamento nova (invalidando
        a anterior), reusar o último QR dentro da janela dá tempo ao WhatsApp de
        concluir a vinculação. ``force`` renova imediatamente — usado quando o
        usuário (re)inicia a conexão e quer um QR fresco para começar a escanear.
        """
        now = time.time()
        if not force:
            cached = self._qr_cache.get(instance_id)
            if cached and now - cached[1] < _QR_CACHE_TTL_SECONDS:
                return cached[0]
        try:
            qr = await self._client.qr_code(instance_id, token)
        except WapiError:
            return None
        qrcode = qr.get("qrcode") if isinstance(qr, dict) else None
        if qrcode:
            self._qr_cache[instance_id] = (qrcode, now)
            return qrcode
        return None

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
        device: dict[str, Any] | None = None

        # A W-API às vezes reporta connected:false no status-instance mesmo com o
        # aparelho vinculado (segue em "Aparelhos conectados" no celular) logo
        # após o pareamento. O webhook `connected` já confirmou o vínculo, gravando
        # binding.state="connected" e binding.connected_at. Como o ramo do QR
        # sobrescreve `state` a cada poll (corrida), usamos também connected_at —
        # que não é limpo — como sinal durável, e confirmamos pelo /instance/device
        # (só responde com connectedPhone quando realmente conectado) antes de
        # voltar a exibir QR.
        if not connected and (binding.state == "connected" or binding.connected_at is not None):
            try:
                device = await self._client.device(binding.instance_id, binding.token)
                connected = bool(
                    device.get("connectedPhone") or device.get("phone") or device.get("number")
                )
            except WapiError:
                device = None
                connected = False

        if connected:
            number = None
            try:
                if device is None:
                    device = await self._client.device(binding.instance_id, binding.token)
                # Shape verificado ao vivo: {connectedPhone, name, profilePictureUrl, ...}.
                number = device.get("connectedPhone") or device.get("phone") or device.get("number")
            except WapiError:
                number = None
            self._drop_qr_cache(binding.instance_id)
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

        # Retorna o QR atual para o polling do frontend exibir/renovar. Sem isso,
        # o app fica "Gerando QR Code..." para sempre (o polling usa /status). O
        # QR é servido do cache dentro da janela de TTL para não regenerar a
        # sessão de pareamento a cada poll (senão o WhatsApp não vincula).
        qrcode = await self._stable_qr(binding.instance_id, binding.token)
        if qrcode:
            self._apply_state(user_id, binding, "awaiting_qr")
            return {"status": "aguardando_qrcode", "qrcode": qrcode, "state": "qr"}
        return {"status": "iniciando", "qrcode": None, "state": "starting"}

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
            self._drop_qr_cache(binding.instance_id)
            self._apply_state(user_id, binding, "connected")
            return {"status": "conectado", "qrcode": None, "state": "connected"}

        # Usuário iniciando a conexão: renova o QR e abre uma nova janela estável.
        qrcode = await self._stable_qr(binding.instance_id, binding.token, force=True)
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
        self._drop_qr_cache(binding.instance_id)
        self._apply_state(user_id, binding, "disconnected")
        return True
