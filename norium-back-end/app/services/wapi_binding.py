"""Vínculo seguro entre conta do Norium e instância da W-API.

Cada conta possui no máximo uma instância W-API. O vínculo guarda o
``instanceId``, o token da instância, o estado do ciclo de vida, timestamps e o
registro de aceite dos termos de uso responsável (exigido antes do QR Code).

Isolamento:

- O vínculo é gravado em store por conta (``read_account_db``), então já nasce
  segregado pelo identificador autenticado.
- Um índice em store de sistema mapeia ``instanceId -> owner`` apenas para o
  webhook resolver o dono. O webhook nunca confia no ``userId`` do payload:
  resolve o dono por este índice e reconfirma o ``instanceId`` no vínculo.

Nenhum token é exposto ao frontend nem registrado em log.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any

from app.core.tenant import (
    read_account_db,
    write_account_db,
    read_json_file,
    write_json_file,
    get_system_db_path,
)


# Versão dos termos de "uso responsável e risco de banimento". Se o texto mudar,
# incremente para forçar novo aceite (ver connect flow).
CONSENT_TERM_VERSION = "2026-08-22"

_BINDING_DB = "wapi_instance"
_INDEX_DB = "wapi_instance_index"
_ownership_lock = threading.RLock()


class InstanceOwnershipError(RuntimeError):
    """Impede que uma instância W-API seja reivindicada por outra conta."""


@dataclass(slots=True)
class ConsentRecord:
    term_version: str
    accepted_at: float  # epoch UTC
    origin: str

    def is_valid(self, required_version: str) -> bool:
        return bool(self.term_version) and self.term_version == required_version


@dataclass(slots=True)
class InstanceBinding:
    instance_id: str = ""
    token: str = ""
    instance_name: str = ""
    state: str = "none"  # none|creating|awaiting_qr|connecting|connected|disconnected|error
    created_at: float = 0.0
    connected_at: float | None = None
    updated_at: float = 0.0
    consent: dict[str, Any] | None = None  # serialized ConsentRecord

    @property
    def exists(self) -> bool:
        return bool(self.instance_id and self.token)

    def consent_record(self) -> ConsentRecord | None:
        if not isinstance(self.consent, dict):
            return None
        try:
            return ConsentRecord(
                term_version=str(self.consent.get("term_version") or ""),
                accepted_at=float(self.consent.get("accepted_at") or 0.0),
                origin=str(self.consent.get("origin") or ""),
            )
        except (TypeError, ValueError):
            return None

    def has_valid_consent(self, required_version: str = CONSENT_TERM_VERSION) -> bool:
        record = self.consent_record()
        return bool(record and record.is_valid(required_version))


def _index_path() -> str:
    return get_system_db_path(_INDEX_DB)


def get_binding(user_id: str) -> InstanceBinding:
    raw = read_account_db(user_id, _BINDING_DB, {})
    if not isinstance(raw, dict):
        return InstanceBinding()
    known = {f for f in InstanceBinding.__slots__}  # type: ignore[attr-defined]
    return InstanceBinding(**{k: v for k, v in raw.items() if k in known})


def get_owned_binding(user_id: str) -> InstanceBinding:
    """Lê o vínculo somente quando o índice confirma esta conta como dona."""
    with _ownership_lock:
        binding = get_binding(user_id)
        if binding.exists and owner_of_instance(binding.instance_id) != user_id:
            raise InstanceOwnershipError(
                "Não foi possível confirmar a propriedade da instância W-API."
            )
        return binding


def save_binding(user_id: str, binding: InstanceBinding) -> InstanceBinding:
    with _ownership_lock:
        current = get_binding(user_id)
        previous_instance_id = current.instance_id

        # Reserva o índice antes de persistir o vínculo. Assim um conflito nunca
        # deixa uma segunda conta gravada com credenciais que pertencem à primeira.
        if binding.instance_id:
            _index_set(binding.instance_id, user_id)

        binding.updated_at = time.time()
        try:
            write_account_db(user_id, _BINDING_DB, asdict(binding))
        except Exception:
            # Restaura o índice se a gravação do vínculo falhar após a reserva.
            if binding.instance_id and binding.instance_id != previous_instance_id:
                _index_remove(binding.instance_id, user_id)
            if previous_instance_id:
                _index_set(previous_instance_id, user_id)
            raise

        if previous_instance_id and previous_instance_id != binding.instance_id:
            _index_remove(previous_instance_id, user_id)
        return binding


def clear_binding(user_id: str) -> None:
    """Remove o vínculo preservando o registro de aceite já obtido."""
    with _ownership_lock:
        current = get_binding(user_id)
        consent = current.consent
        write_account_db(user_id, _BINDING_DB, asdict(InstanceBinding(consent=consent)))
        if current.instance_id:
            # Um vínculo antigo/corrompido nunca remove o índice do dono atual.
            _index_remove(current.instance_id, user_id)


def record_consent(user_id: str, *, origin: str, term_version: str = CONSENT_TERM_VERSION) -> InstanceBinding:
    binding = get_binding(user_id)
    binding.consent = asdict(ConsentRecord(term_version=term_version, accepted_at=time.time(), origin=origin))
    return save_binding(user_id, binding)


def has_valid_consent(user_id: str, required_version: str = CONSENT_TERM_VERSION) -> bool:
    return get_binding(user_id).has_valid_consent(required_version)


# ---- índice instanceId -> owner (uso exclusivo do webhook) ----------------


def _index_set(instance_id: str, user_id: str) -> None:
    path = _index_path()
    index = read_json_file(path, {})
    if not isinstance(index, dict):
        index = {}
    claimed_by = str(index.get(instance_id) or "")
    if claimed_by and claimed_by != user_id:
        # Índices órfãos/divergentes exigem reconciliação explícita. Nunca
        # transferimos propriedade automaticamente com base em ausência local.
        raise InstanceOwnershipError(
            "A instância W-API já está vinculada a outra conta."
        )
    index[instance_id] = user_id
    write_json_file(path, index)


def _index_remove(instance_id: str, expected_owner: str) -> None:
    path = _index_path()
    index = read_json_file(path, {})
    if isinstance(index, dict) and index.get(instance_id) == expected_owner:
        index.pop(instance_id, None)
        write_json_file(path, index)


def _homologation_owner_allowed(instance_id: str, user_id: str) -> bool:
    homologation_instance_id = os.getenv("WAPI_TEST_INSTANCE_ID", "").strip()
    if not homologation_instance_id or instance_id != homologation_instance_id:
        return True
    homologation_tenant_id = os.getenv("WAPI_TEST_TENANT_ID", "").strip()
    return bool(homologation_tenant_id) and str(user_id).strip() == homologation_tenant_id


def owner_of_instance(instance_id: str) -> str | None:
    """Resolve o dono de uma instância e reconfirma o vínculo (para webhooks)."""
    if not instance_id:
        return None
    with _ownership_lock:
        index = read_json_file(_index_path(), {})
        owner = index.get(instance_id) if isinstance(index, dict) else None
        if not owner:
            return None
        # Reconfirma: o vínculo do dono precisa apontar para a mesma instância.
        if (
            get_binding(str(owner)).instance_id == instance_id
            and _homologation_owner_allowed(instance_id, str(owner))
        ):
            return str(owner)
        return None
