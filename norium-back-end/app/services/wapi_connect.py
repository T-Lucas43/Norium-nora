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

import asyncio
import ipaddress
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import quote, urlparse

from app.services import wapi_binding as wb
from app.services.wapi_binding import InstanceBinding, CONSENT_TERM_VERSION
from app.services.wapi_client import WapiClient, WapiError
from app.core.tenant import is_local_or_test_environment, public_api_url


logger = logging.getLogger(__name__)


class ConsentRequiredError(Exception):
    """Levantada quando o usuário tenta gerar/ler o QR sem aceite válido."""


class WapiConfigurationError(RuntimeError):
    """Configuração insegura da instância de homologação."""


@dataclass(frozen=True, slots=True)
class _HomologationConfig:
    instance_id: str
    token: str
    tenant_id: str


def _load_homologation_config(
    environ: Mapping[str, str] | None = None,
) -> _HomologationConfig | None:
    source = os.environ if environ is None else environ
    instance_id = source.get("WAPI_TEST_INSTANCE_ID", "").strip()
    token = source.get("WAPI_TEST_INSTANCE_TOKEN", "").strip()
    tenant_id = source.get("WAPI_TEST_TENANT_ID", "").strip()

    # Ausência total preserva o fluxo normal de criação por tenant.
    if not any((instance_id, token, tenant_id)):
        return None

    if not is_local_or_test_environment(source, require_explicit=True):
        raise WapiConfigurationError(
            "Credenciais de homologação W-API são permitidas somente em ambiente local ou de teste."
        )
    if not all((instance_id, token, tenant_id)):
        raise WapiConfigurationError(
            "Configuração de homologação W-API incompleta; defina instância, credencial e tenant autorizados."
        )
    return _HomologationConfig(
        instance_id=instance_id,
        token=token,
        tenant_id=tenant_id,
    )


def validate_wapi_test_configuration() -> None:
    """Falha de forma segura antes de iniciar o app com homologação inválida."""
    _load_homologation_config()


# Mapeia os 6 tipos de webhook da W-API para o endpoint público único do Norium.
_WEBHOOK_PATH = "/api/whatsapp/webhook"
_WEBHOOK_EVENTS = ("connected", "disconnected", "delivery", "received", "status", "presence")
_WEBHOOK_UPDATE_EVENTS = {
    "connected": "connected",
    "disconnected": "disconnected",
    "delivery": "delivery",
    "received": "received",
    "status": "message-status",
    "presence": "chat-presence",
}
_RETRIABLE_WEBHOOK_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504}
_WEBHOOK_REFRESH_TIMEOUT_SECONDS = 20.0

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
        # Valida e congela a configuração: nenhum tenant pode ativá-la
        # tardiamente por uma alteração de ambiente durante o processo.
        self._homologation = _load_homologation_config()
        # instance_id -> (qrcode, fetched_at). Estabiliza o QR entre polls para
        # não regenerar a sessão de pareamento a cada consulta de status.
        self._qr_cache: dict[str, tuple[str, float]] = {}
        self._qr_locks: dict[str, asyncio.Lock] = {}

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
        # A W-API precisa alcançar o callback pela Internet. Nunca registra o
        # fallback local de desenvolvimento como se fosse uma URL pública.
        try:
            parsed = urlparse(url)
            hostname = (parsed.hostname or "").strip().casefold().rstrip(".")
        except ValueError:
            return {}
        if (
            # O contrato W-API rejeita webhooks HTTP, mesmo fora de localhost.
            parsed.scheme != "https"
            or not hostname
            or parsed.username is not None
            or parsed.password is not None
            or hostname == "localhost"
            or hostname.endswith((".localhost", ".local", ".internal", ".lan"))
        ):
            return {}
        try:
            address = ipaddress.ip_address(hostname)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            return {}
        # O segredo viaja na URL registrada para autenticar cada entrega recebida.
        secret = self._client.config.webhook_secret
        if secret:
            url = f"{url}?secret={quote(secret)}"
        return {event: url for event in _WEBHOOK_EVENTS}

    async def _refresh_existing_webhooks(self, binding: InstanceBinding) -> None:
        """Reaplica callbacks oficiais em uma instância já provisionada.

        Instâncias antigas podem ter sido criadas antes de algum webhook ser
        habilitado. A falha de um callback não invalida o vínculo/QR; ela fica
        registrada e uma nova inicialização tentará novamente.
        """
        urls = self._webhook_urls()
        if not binding.exists or not urls:
            return
        async def _set_one(event: str, url: str) -> None:
            endpoint_event = _WEBHOOK_UPDATE_EVENTS[event]
            for attempt in range(2):
                try:
                    await self._client.set_webhook(
                        binding.instance_id,
                        binding.token,
                        endpoint_event,
                        url,
                    )
                    return
                except WapiError as exc:
                    can_retry = exc.status is None or exc.status in _RETRIABLE_WEBHOOK_STATUSES
                    if attempt == 0 and can_retry:
                        await asyncio.sleep(0.4)
                        continue
                    logger.warning(
                        "Nao foi possivel atualizar o webhook W-API %s: status=%s.",
                        endpoint_event,
                        exc.status,
                    )
                    return

        try:
            # Os seis PUTs são independentes e idempotentes. Executá-los em
            # paralelo evita bloquear o onboarding por até seis timeouts.
            await asyncio.wait_for(
                asyncio.gather(*(_set_one(event, url) for event, url in urls.items())),
                timeout=_WEBHOOK_REFRESH_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            logger.warning("Tempo limite ao atualizar os webhooks da instancia W-API existente.")

    def _homolog_instance(self, user_id: str) -> tuple[str, str]:
        config = self._homologation
        if config is None:
            return "", ""
        if str(user_id).strip() != config.tenant_id:
            raise WapiError(
                "Instância de homologação indisponível para esta conta.",
                code="homologation_tenant_mismatch",
            )
        return config.instance_id, config.token

    @staticmethod
    def _save_owned_binding(user_id: str, binding: InstanceBinding) -> InstanceBinding:
        try:
            return wb.save_binding(user_id, binding)
        except wb.InstanceOwnershipError as exc:
            raise WapiError(
                "Instância W-API já vinculada a outra conta.",
                code="instance_owned_by_another_tenant",
            ) from exc

    @staticmethod
    def _get_owned_binding(user_id: str) -> InstanceBinding:
        try:
            return wb.get_owned_binding(user_id)
        except wb.InstanceOwnershipError as exc:
            raise WapiError(
                "Não foi possível confirmar a propriedade da instância W-API.",
                code="instance_owned_by_another_tenant",
            ) from exc

    @staticmethod
    def _instance_declares_lite(item: dict[str, Any]) -> bool:
        """Reconhece apenas metadados explícitos de plano LITE.

        A listagem da W-API variou de shape ao longo do tempo. Não adivinhamos
        o plano quando o campo não existe; porém uma instância que declara
        ``lite=true``/plano LITE nunca deve ser reutilizada quando o fluxo exige
        os catálogos PRO.
        """
        for key in ("lite", "isLite", "instanceLite"):
            value = item.get(key)
            if value is True or (isinstance(value, str) and value.strip().lower() in {"1", "true", "yes"}):
                return True
        for key in ("plan", "planName", "tier", "type", "instanceType"):
            value = item.get(key)
            if isinstance(value, dict):
                value = value.get("name") or value.get("type") or value.get("slug")
            normalized = str(value or "").strip().lower()
            if normalized == "lite" or normalized.startswith("lite_") or normalized.startswith("lite-"):
                return True
        return False

    async def _find_instance_by_name(
        self,
        name: str,
        *,
        require_pro: bool = False,
    ) -> dict[str, Any] | None:
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
                if require_pro and self._instance_declares_lite(item):
                    continue
                return item
        return None

    async def ensure_instance(self, user_id: str, *, allow_create: bool = True) -> InstanceBinding:
        """Garante o vínculo de uma instância à conta, de forma idempotente."""
        binding = self._get_owned_binding(user_id)
        homologation = self._homologation
        if (
            homologation is not None
            and binding.instance_id == homologation.instance_id
            and str(user_id).strip() != homologation.tenant_id
        ):
            # Bloqueia também vínculos inseguros persistidos por versões antigas,
            # sem tocar na sessão remota nem remover dados locais.
            raise WapiError(
                "Instância de homologação indisponível para esta conta.",
                code="homologation_tenant_mismatch",
            )
        if binding.exists:
            # Valida se a instância ainda existe (o usuário pode tê-la apagado no
            # painel). Se sumiu, limpa o vínculo e recria/reutiliza abaixo.
            try:
                await self._client.status(binding.instance_id, binding.token)
                await self._refresh_existing_webhooks(binding)
                return binding
            except WapiError as exc:
                if exc.status not in {401, 404}:
                    # Rate limit/5xx/rede não provam que a instância sumiu.
                    # Preservar o vínculo evita criar outra sessão e derrubar o
                    # WhatsApp já conectado em uma indisponibilidade transitória.
                    raise
                logger.info("Vínculo aponta para instância inexistente; recriando.")
                wb.clear_binding(user_id)
                binding = self._get_owned_binding(user_id)

        # Homologação: vincula uma instância pré-provisionada (sem create-instance).
        test_id, test_token = self._homolog_instance(user_id)
        if test_id and test_token:
            owner = wb.owner_of_instance(test_id)
            if owner is not None and owner != user_id:
                raise WapiError(
                    "Instância W-API já vinculada a outra conta.",
                    code="instance_owned_by_another_tenant",
                )
            binding.instance_id = test_id
            binding.token = test_token
            binding.instance_name = "homologacao"
            binding.state = "awaiting_qr"
            binding.created_at = time.time()
            logger.info("Instância de homologação vinculada ao tenant autorizado.")
            binding = self._save_owned_binding(user_id, binding)
            await self._refresh_existing_webhooks(binding)
            return binding

        if not allow_create:
            raise WapiError("Nenhuma instância de WhatsApp vinculada.", code="no_instance")

        # Produção: cria a instância pela API Key Mestra, já com os webhooks.
        binding.state = "creating"
        wb.save_binding(user_id, binding)
        legacy_instance_name = f"norium-{user_id}"[:60]
        lite = os.getenv("WAPI_INSTANCE_LITE", "false").strip().lower() in {"1", "true", "yes"}
        # Instâncias PRO usam um nome próprio para que uma reconexão local não
        # volte a capturar uma instância LITE antiga com o nome legado.
        instance_name = (
            legacy_instance_name
            if lite
            else f"norium-{user_id}-pro"[:60]
        )

        # Idempotência: se já existe uma instância deste usuário, reutiliza — evita
        # criar duplicatas que religam o mesmo número e derrubam outras sessões.
        existing = await self._find_instance_by_name(instance_name, require_pro=not lite)
        if not existing and not lite and legacy_instance_name != instance_name:
            # Compatibilidade com instâncias PRO criadas antes do sufixo. Se a
            # listagem declarar LITE, ela é preservada na W-API, mas não vinculada.
            existing = await self._find_instance_by_name(legacy_instance_name, require_pro=True)
            if existing:
                instance_name = legacy_instance_name
        if existing:
            binding.instance_id = str(existing.get("instanceId") or "")
            binding.token = str(existing.get("token") or "")
            binding.instance_name = instance_name
            binding.state = "awaiting_qr"
            binding.created_at = time.time()
            if binding.exists:
                binding = self._save_owned_binding(user_id, binding)
                await self._refresh_existing_webhooks(binding)
                return binding

        # Plano da instância criada: PRO por padrão (LITE bloqueia reações,
        # figurinhas, listagem e sync de enviadas). Override por WAPI_INSTANCE_LITE.
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
        return self._save_owned_binding(user_id, binding)

    # ---- estado / QR -----------------------------------------------------

    def _apply_state(self, user_id: str, binding: InstanceBinding, status: str) -> None:
        previous_state = binding.state
        binding.state = status
        if status == "connected" and (previous_state != "connected" or binding.connected_at is None):
            binding.connected_at = time.time()
        elif status == "disconnected":
            binding.connected_at = None
        self._save_owned_binding(user_id, binding)

    def _drop_qr_cache(self, instance_id: str) -> None:
        self._qr_cache.pop(instance_id, None)

    async def _stable_qr(self, instance_id: str, token: str, *, force: bool = False) -> str | None:
        """Devolve um QR estável dentro da janela de TTL.

        Como cada chamada à W-API cria uma sessão de pareamento nova (invalidando
        a anterior), reusar o último QR dentro da janela dá tempo ao WhatsApp de
        concluir a vinculação. ``force`` renova imediatamente — usado quando o
        usuário (re)inicia a conexão e quer um QR fresco para começar a escanear.
        """
        requested_at = time.monotonic()
        lock = self._qr_locks.setdefault(instance_id, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            cached = self._qr_cache.get(instance_id)
            if cached and (
                (not force and now - cached[1] < _QR_CACHE_TTL_SECONDS)
                or (force and cached[1] >= requested_at)
            ):
                return cached[0]
            try:
                qr = await self._client.qr_code(instance_id, token)
            except WapiError:
                return None
            qrcode = qr.get("qrcode") if isinstance(qr, dict) else None
            if qrcode:
                self._qr_cache[instance_id] = (qrcode, time.monotonic())
                return qrcode
            return None

    async def status(self, user_id: str) -> dict[str, Any]:
        if not self.configured:
            return {"status": "indisponivel", "qrcode": None, "detail": "W-API não configurada."}
        binding = self._get_owned_binding(user_id)
        if not binding.exists:
            accepted = binding.has_valid_consent()
            return {
                "status": "sem_instancia" if accepted else "aguardando_aceite",
                "qrcode": None,
                "state": "none",
                "consentRequired": not accepted,
            }
        instance_id = binding.instance_id
        token = binding.token
        binding_version = binding.updated_at
        try:
            live = await self._client.status(instance_id, token)
        except WapiError as exc:
            return {"status": "erro", "qrcode": None, "state": "error", "detail": exc.message}

        connected = live.get("connected") is True
        device: dict[str, Any] | None = None
        latest = self._get_owned_binding(user_id)
        if not latest.exists or latest.instance_id != instance_id or latest.token != token:
            return {"status": "iniciando", "qrcode": None, "state": "starting"}
        binding = latest
        # Um webhook `connected` recebido enquanto status-instance estava em voo
        # é evidência mais nova e não pode ser sobrescrito pela resposta atrasada.
        if binding.updated_at > binding_version and binding.state == "connected":
            connected = True

        # A W-API às vezes reporta connected:false no status-instance mesmo com o
        # aparelho vinculado (segue em "Aparelhos conectados" no celular) logo
        # após o pareamento. O webhook `connected` já confirmou o vínculo, gravando
        # binding.state="connected" e binding.connected_at. Como o ramo do QR
        # sobrescreve `state` a cada poll (corrida), usamos também connected_at —
        # que não é limpo — como sinal durável, e confirmamos pelo /instance/device
        # (só responde com connectedPhone quando realmente conectado) antes de
        # voltar a exibir QR.
        if not connected and (binding.state == "connected" or binding.connected_at is not None):
            probe_version = binding.updated_at
            try:
                device = await self._client.device(binding.instance_id, binding.token)
                connected = bool(
                    device.get("connectedPhone") or device.get("phone") or device.get("number")
                )
            except WapiError as exc:
                device = None
                connected = False
                latest = self._get_owned_binding(user_id)
                if latest.exists and latest.instance_id == instance_id:
                    # Um webhook novo sempre vence a sondagem iniciada antes dele.
                    if latest.updated_at > probe_version and latest.state == "connected":
                        binding = latest
                        connected = True
                    elif exc.status in {401, 404}:
                        binding = latest
                        self._apply_state(user_id, binding, "disconnected")

        if connected:
            number = None
            probe_version = binding.updated_at
            try:
                if device is None:
                    device = await self._client.device(binding.instance_id, binding.token)
                # Shape verificado ao vivo: {connectedPhone, name, profilePictureUrl, ...}.
                number = device.get("connectedPhone") or device.get("phone") or device.get("number")
            except WapiError:
                number = None
            latest = self._get_owned_binding(user_id)
            if (
                latest.exists
                and latest.instance_id == instance_id
                and latest.updated_at > probe_version
                and latest.state == "disconnected"
            ):
                # Uma desconexão entregue enquanto o device estava em voo vence
                # a resposta antiga e segue para o fluxo de QR abaixo.
                binding = latest
                connected = False
            if connected:
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
        latest = self._get_owned_binding(user_id)
        if (
            not latest.exists
            or latest.instance_id != instance_id
            or latest.token != token
        ):
            self._drop_qr_cache(instance_id)
            return {"status": "iniciando", "qrcode": None, "state": "starting"}
        if (
            latest.updated_at > binding.updated_at
            and latest.state == "connected"
        ):
            self._drop_qr_cache(instance_id)
            return {
                "status": "conectado",
                "qrcode": None,
                "state": "connected",
                "numero": None,
                "conectadoEm": latest.connected_at,
            }
        binding = latest
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
        binding = self._get_owned_binding(user_id)
        if not binding.exists:
            await self.ensure_instance(user_id)
            binding = self._get_owned_binding(user_id)

        instance_id = binding.instance_id
        token = binding.token
        live = await self._client.status(instance_id, token)
        latest = self._get_owned_binding(user_id)
        if (
            not latest.exists
            or latest.instance_id != instance_id
            or latest.token != token
        ):
            self._drop_qr_cache(instance_id)
            return {"status": "iniciando", "qrcode": None, "state": "starting"}
        binding = latest
        if live.get("connected") is True:
            self._drop_qr_cache(instance_id)
            self._apply_state(user_id, binding, "connected")
            return {"status": "conectado", "qrcode": None, "state": "connected"}

        # Usuário iniciando a conexão: renova o QR e abre uma nova janela estável.
        qrcode = await self._stable_qr(instance_id, token, force=True)
        latest = self._get_owned_binding(user_id)
        if (
            not latest.exists
            or latest.instance_id != instance_id
            or latest.token != token
        ):
            self._drop_qr_cache(instance_id)
            return {"status": "iniciando", "qrcode": None, "state": "starting"}
        if latest.state == "connected":
            self._drop_qr_cache(instance_id)
            return {"status": "conectado", "qrcode": None, "state": "connected"}
        binding = latest
        self._apply_state(user_id, binding, "awaiting_qr" if qrcode else "connecting")
        return {
            "status": "aguardando_qrcode" if qrcode else "iniciando",
            "qrcode": qrcode,
            "state": "qr" if qrcode else "starting",
        }

    async def disconnect(self, user_id: str) -> bool:
        binding = self._get_owned_binding(user_id)
        if not binding.exists:
            return False
        try:
            await self._client.disconnect(binding.instance_id, binding.token)
        except WapiError:
            return False
        self._drop_qr_cache(binding.instance_id)
        self._apply_state(user_id, binding, "disconnected")
        return True
