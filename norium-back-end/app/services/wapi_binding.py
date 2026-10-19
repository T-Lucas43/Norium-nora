"""Vínculo seguro entre conta do Norium e instância da W-API.

Cada conta possui no máximo uma instância W-API. O vínculo guarda o
``instanceId``, o token da instância, o estado do ciclo de vida, timestamps e o
registro de aceite dos termos de uso responsável (exigido antes do QR Code).

Isolamento:

- O vínculo é gravado em store por conta (``read_account_db``), então já nasce
  segregado pelo identificador autenticado.
- Em produção, um registro PostgreSQL transacional aplica unicidade para conta
  e instância. O índice JSON lógico fica no mesmo PostgreSQL para compatibilidade.
  O webhook nunca confia no ``userId`` do payload: resolve o dono pelo registro
  e reconfirma o ``instanceId`` no vínculo.
- O bloqueio de propriedade usa advisory locks do PostgreSQL entre processos.

Nenhum token é exposto ao frontend nem registrado em log.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

from app.core.credentials import CredentialRecoveryError, CredentialStore
from app.core.tenant import (
    get_account_db_path,
    get_data_root,
    safe_tenant_id,
    read_account_db,
    write_account_db,
    read_json_file,
    write_json_file,
    get_system_db_path,
)
from app.services.wapi_credentials import wapi_credential_store
from app.infrastructure.persistence import postgres_store
from app.services.whatsapp_provider import is_evolution


# Versão dos termos de "uso responsável e risco de banimento". Se o texto mudar,
# incremente para forçar novo aceite (ver connect flow).
CONSENT_TERM_VERSION = "2026-10-19-evolution" if is_evolution() else "2026-08-22"

_BINDING_DB = "evolution_instance" if is_evolution() else "wapi_instance"
_INDEX_DB = "evolution_instance_index" if is_evolution() else "wapi_instance_index"
_REGISTRY_DB = "evolution_binding_registry" if is_evolution() else "wapi_binding_registry"
_CREDENTIAL_FIELD = "credential"
_TENANT_FIELD = "tenant_id"
_PROVISIONING_STATES = frozenset(
    {"provisioning", "active", "failed", "disconnecting"}
)
_ownership_lock = threading.RLock()
_postgres_registry_schema_guard = threading.Lock()
_postgres_registry_schema_ready = False
_ownership_lock_state = threading.local()


class InstanceOwnershipError(RuntimeError):
    """Impede que uma instância W-API seja reivindicada por outra conta."""


class BindingPersistenceError(RuntimeError):
    """Falha sanitizada ao gravar um vínculo W-API."""


class ProvisioningLeaseLostError(RuntimeError):
    """Impede que uma tentativa antiga conclua após perder seu lease."""


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
    token: str = field(default="", repr=False)
    instance_name: str = ""
    state: str = "none"  # none|creating|awaiting_qr|connecting|connected|disconnected|error
    created_at: float = 0.0
    connected_at: float | None = None
    updated_at: float = 0.0
    consent: dict[str, Any] | None = None  # serialized ConsentRecord
    plan: str = ""  # "lite" | "pro" | "" (legado, derivado do nome)

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


@dataclass(frozen=True, slots=True)
class ProvisioningClaim:
    """Resultado de um claim transacional; credenciais ficam fora do repr."""

    role: str
    state: str
    attempt_id: str
    lease_owner: str = field(default="", repr=False)
    idempotency_key: str = field(default="", repr=False)
    instance_name: str = ""
    lease_expires_at: float = 0.0
    attempt_count: int = 0
    retry_safe: bool = False
    remote_started: bool = False
    binding: InstanceBinding = field(default_factory=InstanceBinding, repr=False)
    remote_binding: InstanceBinding | None = field(default=None, repr=False)

    @property
    def acquired(self) -> bool:
        return self.role == "owner"


def _index_path() -> str:
    return get_system_db_path(_INDEX_DB)


def _registry_path() -> Path:
    return Path(get_system_db_path(_REGISTRY_DB)).with_suffix(".sqlite3")


def _ownership_lock_path() -> Path:
    return get_data_root() / ".wapi_binding_registry.lock"


@contextmanager
def _interprocess_ownership_lock() -> Iterator[None]:
    """Serializa operações W-API entre processos sem espera ocupada."""
    lock_path = _ownership_lock_path()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_file = lock_path.open("a+b")
    locked = False
    try:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
            os.fsync(lock_file.fileno())
        lock_file.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        locked = True
        yield
    finally:
        if locked:
            lock_file.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


@contextmanager
def _locked_store() -> Iterator[None]:
    """Combina reentrância local com exclusão mútua entre processos."""
    with _ownership_lock:
        depth = int(getattr(_ownership_lock_state, "depth", 0))
        if depth:
            _ownership_lock_state.depth = depth + 1
            try:
                yield
            finally:
                _ownership_lock_state.depth = depth
            return

        distributed_lock = (
            postgres_store.advisory_lock("norium:wapi-binding")
            if postgres_store.configured() or postgres_store.required()
            else _interprocess_ownership_lock()
        )
        with distributed_lock:
            _ownership_lock_state.depth = 1
            try:
                _recover_store()
                yield
            finally:
                delattr(_ownership_lock_state, "depth")


def _read_json_object(path: Path) -> dict[str, Any] | None:
    if postgres_store.configured() or postgres_store.required():
        payload = read_json_file(path, None)
        return payload if payload is None or isinstance(payload, dict) else None
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _known_tenant_ids_by_directory() -> dict[str, set[str]]:
    users_store = _read_json_object(Path(get_system_db_path("usuarios")))
    known: dict[str, set[str]] = {}
    if not users_store:
        return known
    users = users_store.get("users")
    if not isinstance(users, list):
        return known
    for user in users:
        if not isinstance(user, dict):
            continue
        tenant_id = str(user.get("id") or "").strip()
        if tenant_id:
            known.setdefault(safe_tenant_id(tenant_id), set()).add(tenant_id)
    return known


def _active_binding_candidates() -> dict[str, str]:
    candidates: dict[str, str] = {}
    known_tenants = _known_tenant_ids_by_directory()
    if postgres_store.configured() or postgres_store.required():
        paths = [get_data_root() / key for key in postgres_store.list_document_keys("user_")
                 if key.count("/") == 1 and key.endswith(f"/{_BINDING_DB}_db.json")]
    else:
        paths = sorted(get_data_root().glob(f"user_*/{_BINDING_DB}_db.json"))
    for path in paths:
        payload = _read_json_object(path)
        if not payload:
            continue
        instance_id = str(payload.get("instance_id") or "").strip()
        directory_name = path.parent.name
        if instance_id and directory_name.startswith("user_"):
            directory_tenant = directory_name.removeprefix("user_")
            tenant_id = str(payload.get(_TENANT_FIELD) or "").strip()
            if not tenant_id:
                matches = known_tenants.get(directory_tenant, set())
                tenant_id = next(iter(matches)) if len(matches) == 1 else ""
            if tenant_id:
                candidates[tenant_id] = instance_id
    return candidates


def _legacy_ownership_candidates() -> list[tuple[str, str]]:
    active = _active_binding_candidates()
    raw_index = _read_json_object(Path(_index_path()))
    grouped: dict[str, list[str]] = {}
    if raw_index:
        for instance_id, tenant_id in raw_index.items():
            normalized_instance = str(instance_id or "").strip()
            normalized_tenant = str(tenant_id or "").strip()
            if normalized_instance and normalized_tenant:
                grouped.setdefault(normalized_tenant, []).append(normalized_instance)

    selected: list[tuple[str, str]] = []
    used_instances: set[str] = set()
    used_tenants: set[str] = set()
    for tenant_id, instances in grouped.items():
        preferred = active.get(tenant_id)
        if preferred is None:
            preferred = next(
                (
                    instance
                    for active_tenant, instance in active.items()
                    if safe_tenant_id(active_tenant) == safe_tenant_id(tenant_id)
                ),
                None,
            )
        instance_id = preferred if preferred in instances else instances[0]
        if instance_id not in used_instances:
            selected.append((tenant_id, instance_id))
            used_tenants.add(tenant_id)
            used_instances.add(instance_id)

    active_instance_counts: dict[str, int] = {}
    for instance_id in active.values():
        active_instance_counts[instance_id] = active_instance_counts.get(instance_id, 0) + 1
    for tenant_id, instance_id in active.items():
        if (
            active_instance_counts[instance_id] == 1
            and tenant_id not in used_tenants
            and instance_id not in used_instances
        ):
            selected.append((tenant_id, instance_id))
            used_tenants.add(tenant_id)
            used_instances.add(instance_id)
    return selected


def _ensure_registry_schema(connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS wapi_ownership (
            tenant_id TEXT PRIMARY KEY NOT NULL CHECK (length(tenant_id) > 0),
            instance_id TEXT NOT NULL UNIQUE CHECK (length(instance_id) > 0)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS wapi_binding_journal (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            tenant_id TEXT NOT NULL,
            binding_existed INTEGER NOT NULL CHECK (binding_existed IN (0, 1)),
            previous_binding_json TEXT
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS wapi_binding_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS wapi_instance_lifecycle (
            tenant_id TEXT PRIMARY KEY NOT NULL CHECK (length(tenant_id) > 0),
            state TEXT NOT NULL CHECK (
                state IN ('provisioning', 'active', 'failed', 'disconnecting')
            ),
            attempt_id TEXT NOT NULL CHECK (length(attempt_id) > 0),
            idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) > 0),
            instance_name TEXT NOT NULL DEFAULT '',
            instance_id TEXT UNIQUE,
            credential_json TEXT,
            lease_owner TEXT,
            lease_expires_at REAL NOT NULL DEFAULT 0,
            remote_started_at REAL,
            retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0, 1)),
            attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
            error_code TEXT,
            updated_at REAL NOT NULL,
            CHECK (instance_id IS NULL OR length(instance_id) > 0)
        )
        """
    )
    connection.commit()

    if getattr(connection, "postgres", False):
        connection.execute(
            "INSERT INTO wapi_binding_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING",
            ("legacy_index_imported", "1"),
        )
        connection.commit()
        return

    migrated = connection.execute(
        "SELECT value FROM wapi_binding_metadata WHERE key = ?",
        ("legacy_index_imported",),
    ).fetchone()
    if migrated:
        return

    candidates = _legacy_ownership_candidates()
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.executemany(
            "INSERT INTO wapi_ownership (tenant_id, instance_id) VALUES (?, ?)",
            candidates,
        )
        connection.execute(
            "INSERT INTO wapi_binding_metadata (key, value) VALUES (?, ?)",
            ("legacy_index_imported", "1"),
        )
        connection.commit()
    except (sqlite3.DatabaseError, sqlite3.IntegrityError):
        connection.rollback()
        raise BindingPersistenceError(
            "Não foi possível migrar o índice W-API persistido."
        ) from None


class _PostgresRegistryConnection:
    postgres = True

    def __init__(self) -> None:
        from psycopg.rows import tuple_row
        self._context = postgres_store.connection()
        self.raw = self._context.__enter__()
        self._row_factory = tuple_row
        self.closed = False

    @staticmethod
    def _translate(query: str) -> str:
        if is_evolution():
            # SQL interno fixo; parâmetros permanecem separados. Índices e tabelas
            # pertencem ao namespace do provedor, sem reescrever dados antigos.
            query = query.replace("wapi_", "evolution_")
        return ("BEGIN" if query.strip().upper() == "BEGIN IMMEDIATE" else query).replace("?", "%s")

    def execute(self, query: str, params=()):
        try:
            return self.raw.cursor(row_factory=self._row_factory).execute(self._translate(query), params)
        except Exception as exc:
            if str(getattr(exc, "sqlstate", "")).startswith("23"):
                raise sqlite3.IntegrityError("postgresql constraint violation") from exc
            raise sqlite3.DatabaseError("postgresql registry unavailable") from exc

    def executemany(self, query: str, params):
        try:
            return self.raw.cursor(row_factory=self._row_factory).executemany(self._translate(query), params)
        except Exception as exc:
            if str(getattr(exc, "sqlstate", "")).startswith("23"):
                raise sqlite3.IntegrityError("postgresql constraint violation") from exc
            raise sqlite3.DatabaseError("postgresql registry unavailable") from exc

    def commit(self):
        self.raw.commit()

    def rollback(self):
        self.raw.rollback()

    def close(self):
        if not self.closed:
            self.closed = True
            self._context.__exit__(None, None, None)


def _registry_connection():
    if postgres_store.configured() or postgres_store.required():
        global _postgres_registry_schema_ready
        try:
            connection = _PostgresRegistryConnection()
            with _postgres_registry_schema_guard:
                if not _postgres_registry_schema_ready:
                    _ensure_registry_schema(connection)
                    _postgres_registry_schema_ready = True
            return connection
        except Exception as exc:
            if 'connection' in locals():
                connection.close()
            raise BindingPersistenceError("Não foi possível abrir o registro transacional W-API.") from exc
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(str(_registry_path()), timeout=30.0)
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA synchronous = FULL")
        _ensure_registry_schema(connection)
        return connection
    except BindingPersistenceError:
        if connection is not None:
            connection.close()
        raise
    except sqlite3.DatabaseError:
        if connection is not None:
            connection.close()
        raise BindingPersistenceError(
            "Não foi possível abrir o registro transacional W-API."
        ) from None
    except Exception:
        if connection is not None:
            connection.close()
        raise BindingPersistenceError(
            "Não foi possível inicializar o registro transacional W-API."
        ) from None


_LIFECYCLE_COLUMNS = (
    "tenant_id",
    "state",
    "attempt_id",
    "idempotency_key",
    "instance_name",
    "instance_id",
    "credential_json",
    "lease_owner",
    "lease_expires_at",
    "remote_started_at",
    "retry_safe",
    "attempt_count",
    "error_code",
    "updated_at",
)

_LIFECYCLE_SELECT_SQL = """
    SELECT
        tenant_id,
        state,
        attempt_id,
        idempotency_key,
        instance_name,
        instance_id,
        credential_json,
        lease_owner,
        lease_expires_at,
        remote_started_at,
        retry_safe,
        attempt_count,
        error_code,
        updated_at
    FROM wapi_instance_lifecycle
    WHERE tenant_id = ?
"""


def _lifecycle_row(
    connection: sqlite3.Connection,
    user_id: str,
) -> dict[str, Any] | None:
    row = connection.execute(
        _LIFECYCLE_SELECT_SQL,
        (user_id,),
    ).fetchone()
    return dict(zip(_LIFECYCLE_COLUMNS, row)) if row else None


def _remote_binding_from_lifecycle(
    row: dict[str, Any] | None,
    consent: dict[str, Any] | None,
) -> InstanceBinding | None:
    if not row or not row.get("instance_id") or not row.get("credential_json"):
        return None
    try:
        envelope = json.loads(str(row["credential_json"]))
        token = wapi_credential_store().retrieve(envelope).value
    except (TypeError, ValueError, json.JSONDecodeError, CredentialRecoveryError):
        raise BindingPersistenceError(
            "Não foi possível recuperar o resultado do provisionamento W-API."
        ) from None
    return InstanceBinding(
        instance_id=str(row["instance_id"]),
        token=token,
        instance_name=str(row.get("instance_name") or ""),
        state="awaiting_qr",
        created_at=float(row.get("remote_started_at") or row.get("updated_at") or 0.0),
        consent=consent,
    )


def _upsert_active_lifecycle(
    connection: sqlite3.Connection,
    user_id: str,
    instance_id: str,
    instance_name: str,
    *,
    now: float,
) -> None:
    connection.execute(
        """
        INSERT INTO wapi_instance_lifecycle (
            tenant_id, state, attempt_id, idempotency_key, instance_name,
            instance_id, credential_json, lease_owner, lease_expires_at,
            remote_started_at, retry_safe, attempt_count, error_code, updated_at
        ) VALUES (?, 'active', ?, ?, ?, ?, NULL, NULL, 0, NULL, 0, 1, NULL, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
            state = 'active',
            instance_name = excluded.instance_name,
            instance_id = excluded.instance_id,
            credential_json = NULL,
            lease_owner = NULL,
            lease_expires_at = 0,
            remote_started_at = NULL,
            retry_safe = 0,
            error_code = NULL,
            updated_at = excluded.updated_at
        """,
        (
            user_id,
            uuid.uuid4().hex,
            uuid.uuid4().hex,
            instance_name,
            instance_id,
            now,
        ),
    )


def _assert_provisioning_owner(
    connection: sqlite3.Connection,
    user_id: str,
    attempt_id: str,
    lease_owner: str,
) -> None:
    row = connection.execute(
        """
        SELECT 1 FROM wapi_instance_lifecycle
        WHERE tenant_id = ? AND state = 'provisioning'
          AND attempt_id = ? AND lease_owner = ?
        """,
        (user_id, attempt_id, lease_owner),
    ).fetchone()
    if not row:
        raise ProvisioningLeaseLostError(
            "A tentativa de provisionamento W-API perdeu o lease."
        )


def _registry_index(connection: sqlite3.Connection) -> dict[str, str]:
    rows = connection.execute(
        "SELECT instance_id, tenant_id FROM wapi_ownership ORDER BY instance_id"
    ).fetchall()
    return {str(instance_id): str(tenant_id) for instance_id, tenant_id in rows}


def _write_index_mirror(connection: sqlite3.Connection) -> None:
    write_json_file(_index_path(), _registry_index(connection))


def _repair_index_mirror(connection: sqlite3.Connection) -> None:
    expected = _registry_index(connection)
    current = _read_json_object(Path(_index_path()))
    if current != expected:
        _write_index_mirror(connection)


def _binding_snapshot(user_id: str) -> tuple[bool, dict[str, Any] | None]:
    path = Path(get_account_db_path(user_id, _BINDING_DB))
    if postgres_store.configured() or postgres_store.required():
        payload = read_json_file(path, None)
        if payload is None:
            return False, None
        if not isinstance(payload, dict):
            raise BindingPersistenceError("Não foi possível validar o vínculo W-API persistido.")
        return True, payload
    if not path.is_file():
        return False, None
    payload = _read_json_object(path)
    if payload is None:
        raise BindingPersistenceError(
            "Não foi possível validar o vínculo W-API persistido."
        ) from None
    return True, payload


def _recover_pending_transaction() -> None:
    connection = _registry_connection()
    try:
        pending = connection.execute(
            """
            SELECT tenant_id, binding_existed, previous_binding_json
            FROM wapi_binding_journal
            WHERE singleton = 1
            """
        ).fetchone()
        if pending:
            tenant_id = str(pending[0])
            binding_existed = bool(pending[1])
            previous_json = pending[2]
            try:
                previous = json.loads(previous_json) if binding_existed else None
            except (TypeError, json.JSONDecodeError):
                raise BindingPersistenceError(
                    "Não foi possível recuperar uma transação W-API interrompida."
                ) from None
            if binding_existed and isinstance(previous, dict):
                write_account_db(tenant_id, _BINDING_DB, previous)
            elif binding_existed:
                raise BindingPersistenceError(
                    "Não foi possível recuperar uma transação W-API interrompida."
                ) from None
            else:
                binding_path = Path(get_account_db_path(tenant_id, _BINDING_DB))
                if postgres_store.configured() or postgres_store.required():
                    postgres_store.delete_document(postgres_store.canonical_key(binding_path))
                else:
                    binding_path.unlink(missing_ok=True)
            _write_index_mirror(connection)
            connection.execute(
                "DELETE FROM wapi_binding_journal WHERE singleton = 1"
            )
            connection.commit()
        else:
            _repair_index_mirror(connection)
    except BindingPersistenceError:
        raise
    except Exception:
        connection.rollback()
        raise BindingPersistenceError(
            "Não foi possível recuperar o estado W-API persistido."
        ) from None
    finally:
        connection.close()


def _recover_store() -> None:
    _recover_pending_transaction()


def _prepare_binding_transaction(
    user_id: str,
    instance_id: str,
    *,
    binding_existed: bool,
    previous_binding: dict[str, Any] | None,
    provisioning_attempt_id: str = "",
    provisioning_lease_owner: str = "",
    disconnecting_attempt_id: str = "",
    disconnecting_lease_owner: str = "",
) -> None:
    connection = _registry_connection()
    try:
        connection.execute("BEGIN IMMEDIATE")
        if provisioning_attempt_id:
            _assert_provisioning_owner(
                connection,
                user_id,
                provisioning_attempt_id,
                provisioning_lease_owner,
            )
        if disconnecting_attempt_id:
            row = connection.execute(
                """
                SELECT 1 FROM wapi_instance_lifecycle
                WHERE tenant_id = ? AND state = 'disconnecting'
                  AND attempt_id = ? AND lease_owner = ?
                """,
                (
                    user_id,
                    disconnecting_attempt_id,
                    disconnecting_lease_owner,
                ),
            ).fetchone()
            if not row:
                raise ProvisioningLeaseLostError(
                    "A tentativa de desconexão W-API perdeu o lease."
                )
        if instance_id:
            owner = connection.execute(
                "SELECT tenant_id FROM wapi_ownership WHERE instance_id = ?",
                (instance_id,),
            ).fetchone()
            if owner and str(owner[0]) != user_id:
                raise InstanceOwnershipError(
                    "A instância W-API já está vinculada a outra conta."
                )
        connection.execute(
            """
            INSERT INTO wapi_binding_journal (
                singleton,
                tenant_id,
                binding_existed,
                previous_binding_json
            ) VALUES (1, ?, ?, ?)
            """,
            (
                user_id,
                int(binding_existed),
                json.dumps(previous_binding, ensure_ascii=False)
                if binding_existed
                else None,
            ),
        )
        connection.commit()
    except (InstanceOwnershipError, ProvisioningLeaseLostError):
        connection.rollback()
        raise
    except (sqlite3.DatabaseError, TypeError, ValueError):
        connection.rollback()
        raise BindingPersistenceError(
            "Não foi possível iniciar a transação do vínculo W-API."
        ) from None
    finally:
        connection.close()


def _index_set(
    connection: sqlite3.Connection,
    instance_id: str,
    user_id: str,
) -> None:
    """Atualiza o índice por UPSERT protegido pelas constraints do SQLite."""
    try:
        connection.execute(
            """
            INSERT INTO wapi_ownership (tenant_id, instance_id)
            VALUES (?, ?)
            ON CONFLICT(tenant_id) DO UPDATE
            SET instance_id = excluded.instance_id
            """,
            (user_id, instance_id),
        )
    except sqlite3.IntegrityError:
        owner = connection.execute(
            "SELECT tenant_id FROM wapi_ownership WHERE instance_id = ?",
            (instance_id,),
        ).fetchone()
        if owner and str(owner[0]) != user_id:
            raise InstanceOwnershipError(
                "A instância W-API já está vinculada a outra conta."
            ) from None
        raise BindingPersistenceError(
            "Não foi possível atualizar o índice W-API."
        ) from None


def _index_remove(
    connection: sqlite3.Connection,
    instance_id: str,
    expected_owner: str,
) -> None:
    connection.execute(
        """
        DELETE FROM wapi_ownership
        WHERE tenant_id = ? AND instance_id = ?
        """,
        (expected_owner, instance_id),
    )


def _complete_binding_transaction(
    user_id: str,
    previous_instance_id: str,
    instance_id: str,
    *,
    instance_name: str = "",
    provisioning_attempt_id: str = "",
    provisioning_lease_owner: str = "",
    disconnecting_attempt_id: str = "",
    disconnecting_lease_owner: str = "",
) -> None:
    connection = _registry_connection()
    try:
        connection.execute("BEGIN IMMEDIATE")
        if instance_id:
            _index_set(connection, instance_id, user_id)
        elif previous_instance_id:
            _index_remove(connection, previous_instance_id, user_id)
        now = time.time()
        if provisioning_attempt_id:
            _assert_provisioning_owner(
                connection,
                user_id,
                provisioning_attempt_id,
                provisioning_lease_owner,
            )
            updated = connection.execute(
                """
                UPDATE wapi_instance_lifecycle
                SET state = 'active', instance_name = ?, instance_id = ?,
                    credential_json = NULL, lease_owner = NULL,
                    lease_expires_at = 0, remote_started_at = NULL,
                    retry_safe = 0, error_code = NULL, updated_at = ?
                WHERE tenant_id = ? AND state = 'provisioning'
                  AND attempt_id = ? AND lease_owner = ?
                """,
                (
                    instance_name,
                    instance_id,
                    now,
                    user_id,
                    provisioning_attempt_id,
                    provisioning_lease_owner,
                ),
            )
            if updated.rowcount != 1:
                raise ProvisioningLeaseLostError(
                    "A tentativa de provisionamento W-API perdeu o lease."
                )
        elif disconnecting_attempt_id:
            updated = connection.execute(
                """
                UPDATE wapi_instance_lifecycle
                SET state = 'active', instance_name = ?, instance_id = ?,
                    credential_json = NULL, lease_owner = NULL,
                    lease_expires_at = 0, remote_started_at = NULL,
                    retry_safe = 0, error_code = NULL, updated_at = ?
                WHERE tenant_id = ? AND state = 'disconnecting'
                  AND attempt_id = ? AND lease_owner = ?
                """,
                (
                    instance_name,
                    instance_id,
                    now,
                    user_id,
                    disconnecting_attempt_id,
                    disconnecting_lease_owner,
                ),
            )
            if updated.rowcount != 1:
                raise ProvisioningLeaseLostError(
                    "A tentativa de desconexão W-API perdeu o lease."
                )
        elif instance_id:
            lifecycle = _lifecycle_row(connection, user_id)
            disconnect_in_flight = bool(
                lifecycle
                and lifecycle["state"] == "disconnecting"
                and float(lifecycle.get("lease_expires_at") or 0.0) > now
            )
            if not disconnect_in_flight:
                _upsert_active_lifecycle(
                    connection,
                    user_id,
                    instance_id,
                    instance_name,
                    now=now,
                )
        elif previous_instance_id:
            connection.execute(
                """
                DELETE FROM wapi_instance_lifecycle
                WHERE tenant_id = ? AND instance_id = ?
                """,
                (user_id, previous_instance_id),
            )
        _write_index_mirror(connection)
        connection.execute(
            "DELETE FROM wapi_binding_journal WHERE singleton = 1"
        )
        connection.commit()
    except (
        InstanceOwnershipError,
        BindingPersistenceError,
        ProvisioningLeaseLostError,
    ):
        connection.rollback()
        raise
    except Exception:
        connection.rollback()
        raise BindingPersistenceError(
            "Não foi possível concluir a transação do vínculo W-API."
        ) from None
    finally:
        connection.close()


def _write_binding_transactionally(
    user_id: str,
    payload: dict[str, Any],
    *,
    previous_instance_id: str,
    instance_id: str,
    instance_name: str = "",
    provisioning_attempt_id: str = "",
    provisioning_lease_owner: str = "",
    disconnecting_attempt_id: str = "",
    disconnecting_lease_owner: str = "",
) -> None:
    binding_existed, previous_binding = _binding_snapshot(user_id)
    _prepare_binding_transaction(
        user_id,
        instance_id,
        binding_existed=binding_existed,
        previous_binding=previous_binding,
        provisioning_attempt_id=provisioning_attempt_id,
        provisioning_lease_owner=provisioning_lease_owner,
        disconnecting_attempt_id=disconnecting_attempt_id,
        disconnecting_lease_owner=disconnecting_lease_owner,
    )
    failure = ""
    try:
        write_account_db(user_id, _BINDING_DB, payload)
        _complete_binding_transaction(
            user_id,
            previous_instance_id,
            instance_id,
            instance_name=instance_name,
            provisioning_attempt_id=provisioning_attempt_id,
            provisioning_lease_owner=provisioning_lease_owner,
            disconnecting_attempt_id=disconnecting_attempt_id,
            disconnecting_lease_owner=disconnecting_lease_owner,
        )
    except InstanceOwnershipError:
        failure = "ownership"
        try:
            _recover_pending_transaction()
        except Exception:
            failure = "recovery"
    except ProvisioningLeaseLostError:
        failure = "lease"
        try:
            _recover_pending_transaction()
        except Exception:
            failure = "recovery"
    except Exception:
        failure = "persistence"
        try:
            _recover_pending_transaction()
        except Exception:
            failure = "recovery"

    if failure == "ownership":
        raise InstanceOwnershipError(
            "A instância W-API já está vinculada a outra conta."
        ) from None
    if failure == "lease":
        raise ProvisioningLeaseLostError(
            "A tentativa de provisionamento W-API perdeu o lease."
        ) from None
    if failure == "recovery":
        raise BindingPersistenceError(
            "Não foi possível persistir nem recuperar o vínculo W-API."
        ) from None
    if failure:
        raise BindingPersistenceError(
            "Não foi possível persistir o vínculo W-API."
        ) from None


def _serialize_binding(
    binding: InstanceBinding,
    credential_store: CredentialStore | None = None,
) -> dict[str, Any]:
    payload = asdict(binding)
    token = payload.pop("token", "")
    if token:
        store = credential_store or wapi_credential_store()
        payload[_CREDENTIAL_FIELD] = store.store(token)
    return payload


def _binding_from_raw(
    raw: dict[str, Any],
    *,
    rewrite: Callable[[dict[str, Any]], None] | None = None,
) -> InstanceBinding:
    token = ""
    store: CredentialStore | None = None
    needs_rewrite = False

    if _CREDENTIAL_FIELD in raw:
        store = wapi_credential_store()
        recovered = store.retrieve(raw[_CREDENTIAL_FIELD])
        token = recovered.value
        needs_rewrite = recovered.needs_rewrite or "token" in raw
    elif "token" in raw:
        legacy_token = raw.get("token")
        if legacy_token not in ("", None) and not isinstance(legacy_token, str):
            raise CredentialRecoveryError(
                "Não foi possível recuperar a credencial protegida."
            ) from None
        token = legacy_token if isinstance(legacy_token, str) else ""
        if token:
            store = wapi_credential_store()
        needs_rewrite = True

    if needs_rewrite and rewrite is not None:
        migrated = dict(raw)
        migrated.pop("token", None)
        if token:
            active_store = store or wapi_credential_store()
            migrated[_CREDENTIAL_FIELD] = active_store.store(token)
        else:
            migrated.pop(_CREDENTIAL_FIELD, None)
        rewrite_failed = False
        try:
            rewrite(migrated)
        except Exception:
            rewrite_failed = True
        if rewrite_failed:
            raise BindingPersistenceError(
                "Não foi possível migrar a credencial W-API persistida."
            ) from None

    known = set(InstanceBinding.__slots__) - {"token"}  # type: ignore[attr-defined]
    binding_values = {key: value for key, value in raw.items() if key in known}
    return InstanceBinding(token=token, **binding_values)


def get_binding(user_id: str) -> InstanceBinding:
    with _locked_store():
        raw = read_account_db(user_id, _BINDING_DB, {})
        if not isinstance(raw, dict):
            return InstanceBinding()
        return _binding_from_raw(
            raw,
            rewrite=lambda payload: write_account_db(
                user_id,
                _BINDING_DB,
                payload,
            ),
        )


def migrate_binding_file(path: str | Path) -> bool:
    """Migra/rotaciona um binding ativo ou snapshot sem expor seu conteúdo."""
    binding_path = Path(path)
    if binding_path.name in {"wapi_instance_db.json", "evolution_instance_db.json"} and binding_path.name != f"{_BINDING_DB}_db.json":
        return False
    if not binding_path.is_file():
        return False
    rewritten = False

    def rewrite(payload: dict[str, Any]) -> None:
        nonlocal rewritten
        write_json_file(binding_path, payload)
        rewritten = True

    with _locked_store():
        try:
            raw = json.loads(binding_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raw = None
        if not isinstance(raw, dict):
            raise CredentialRecoveryError(
                "Não foi possível validar o binding W-API persistido."
            ) from None
        _binding_from_raw(raw, rewrite=rewrite)
    return rewritten


def restore_binding_snapshot(
    user_id: str,
    path: str | Path,
) -> InstanceBinding:
    """Restaura um snapshot mantendo binding e ownership no mesmo commit."""
    binding_path = Path(path)
    if binding_path.name in {"wapi_instance_db.json", "evolution_instance_db.json"} and binding_path.name != f"{_BINDING_DB}_db.json":
        raise CredentialRecoveryError("O backup de WhatsApp pertence a outro provedor.")
    with _locked_store():
        try:
            raw = json.loads(binding_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raw = None
        if not isinstance(raw, dict):
            raise CredentialRecoveryError(
                "Não foi possível validar o binding W-API persistido."
            ) from None

        payload = dict(raw)

        def rewrite(migrated: dict[str, Any]) -> None:
            nonlocal payload
            payload = migrated
            write_json_file(binding_path, migrated)

        binding = _binding_from_raw(raw, rewrite=rewrite)
        current = get_binding(user_id)
        payload[_TENANT_FIELD] = user_id
        _write_binding_transactionally(
            user_id,
            payload,
            previous_instance_id=current.instance_id,
            instance_id=binding.instance_id,
        )
        return binding


def migrate_account_binding_credentials(
    user_id: str,
    *,
    include_backups: bool = True,
) -> dict[str, int]:
    """Migra o binding da conta e, opcionalmente, seus snapshots históricos."""
    active_path = Path(get_account_db_path(user_id, _BINDING_DB))
    paths = [active_path]
    backups_dir = active_path.parent / "backups"
    if include_backups and backups_dir.is_dir():
        paths.extend(backups_dir.rglob(active_path.name))

    scanned = 0
    rewritten = 0
    for path in dict.fromkeys(paths):
        if not path.is_file():
            continue
        scanned += 1
        rewritten += int(migrate_binding_file(path))
    return {"scanned": scanned, "rewritten": rewritten}


def migrate_all_binding_credentials(
    data_root: str | Path | None = None,
) -> dict[str, int]:
    """Varre bindings ativos e snapshots para migração operacional/rotação."""
    root = Path(data_root) if data_root is not None else get_data_root()
    paths = sorted(root.glob(f"user_*/**/{_BINDING_DB}_db.json"))
    rewritten = sum(int(migrate_binding_file(path)) for path in paths)
    return {"scanned": len(paths), "rewritten": rewritten}


def get_owned_binding(user_id: str) -> InstanceBinding:
    """Lê o vínculo somente quando o índice confirma esta conta como dona."""
    with _locked_store():
        binding = get_binding(user_id)
        if binding.exists and owner_of_instance(binding.instance_id) != user_id:
            raise InstanceOwnershipError(
                "Não foi possível confirmar a propriedade da instância W-API."
            )
        return binding


def save_binding(user_id: str, binding: InstanceBinding) -> InstanceBinding:
    with _locked_store():
        current = get_binding(user_id)
        previous_instance_id = current.instance_id
        binding.updated_at = time.time()
        payload = _serialize_binding(binding)
        payload[_TENANT_FIELD] = user_id
        _write_binding_transactionally(
            user_id,
            payload,
            previous_instance_id=previous_instance_id,
            instance_id=binding.instance_id,
            instance_name=binding.instance_name,
        )
        return binding


def _claim_from_row(
    row: dict[str, Any],
    binding: InstanceBinding,
    *,
    role: str,
    include_remote: bool = False,
) -> ProvisioningClaim:
    return ProvisioningClaim(
        role=role,
        state=str(row.get("state") or "failed"),
        attempt_id=str(row.get("attempt_id") or ""),
        lease_owner=str(row.get("lease_owner") or ""),
        idempotency_key=str(row.get("idempotency_key") or ""),
        instance_name=str(row.get("instance_name") or ""),
        lease_expires_at=float(row.get("lease_expires_at") or 0.0),
        attempt_count=int(row.get("attempt_count") or 1),
        retry_safe=bool(row.get("retry_safe")),
        remote_started=row.get("remote_started_at") is not None,
        binding=binding,
        remote_binding=(
            _remote_binding_from_lifecycle(row, binding.consent)
            if include_remote
            else None
        ),
    )


def get_provisioning(user_id: str) -> ProvisioningClaim | None:
    """Lê o lifecycle persistido sem expor a credencial recuperável no repr."""
    with _locked_store():
        binding = get_owned_binding(user_id)
        connection = _registry_connection()
        try:
            row = _lifecycle_row(connection, user_id)
        finally:
            connection.close()
        if row is None:
            return None
        return _claim_from_row(row, binding, role="snapshot")


def claim_provisioning(
    user_id: str,
    instance_name: str,
    lease_owner: str,
    *,
    lease_seconds: float = 120.0,
    now: float | None = None,
) -> ProvisioningClaim:
    """Elege um único provisionador e relê o binding dentro do lock distribuído."""
    if not str(user_id).strip() or not str(instance_name).strip() or not str(lease_owner).strip():
        raise ValueError("tenant, nome da instância e dono do lease são obrigatórios")
    current_time = time.time() if now is None else float(now)
    expires_at = current_time + max(1.0, float(lease_seconds))

    with _locked_store():
        # Esta leitura acontece obrigatoriamente depois da aquisição do lock.
        binding = get_owned_binding(user_id)
        connection = _registry_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = _lifecycle_row(connection, user_id)

            if (
                row
                and row["state"] == "disconnecting"
                and float(row.get("lease_expires_at") or 0.0) > current_time
            ):
                connection.commit()
                return _claim_from_row(row, binding, role="disconnecting")

            if binding.exists:
                _upsert_active_lifecycle(
                    connection,
                    user_id,
                    binding.instance_id,
                    binding.instance_name,
                    now=current_time,
                )
                row = _lifecycle_row(connection, user_id)
                connection.commit()
                if row is None:
                    raise BindingPersistenceError(
                        "Não foi possível confirmar o lifecycle W-API ativo."
                    )
                return _claim_from_row(row, binding, role="active")

            if (
                row
                and row["state"] == "provisioning"
                and float(row.get("lease_expires_at") or 0.0) > current_time
            ):
                if str(row.get("lease_owner") or "") == lease_owner:
                    connection.execute(
                        """
                        UPDATE wapi_instance_lifecycle
                        SET lease_expires_at = ?, updated_at = ?
                        WHERE tenant_id = ? AND state = 'provisioning'
                          AND attempt_id = ? AND lease_owner = ?
                        """,
                        (
                            expires_at,
                            current_time,
                            user_id,
                            row["attempt_id"],
                            lease_owner,
                        ),
                    )
                    row["lease_expires_at"] = expires_at
                    row["updated_at"] = current_time
                    role = "owner"
                else:
                    role = "wait"
                connection.commit()
                return _claim_from_row(
                    row,
                    binding,
                    role=role,
                    include_remote=role == "owner",
                )

            attempt_id = uuid.uuid4().hex
            if row is None:
                idempotency_key = uuid.uuid4().hex
                connection.execute(
                    """
                    INSERT INTO wapi_instance_lifecycle (
                        tenant_id, state, attempt_id, idempotency_key,
                        instance_name, instance_id, credential_json,
                        lease_owner, lease_expires_at, remote_started_at,
                        retry_safe, attempt_count, error_code, updated_at
                    ) VALUES (?, 'provisioning', ?, ?, ?, NULL, NULL, ?, ?,
                              NULL, 1, 1, NULL, ?)
                    """,
                    (
                        user_id,
                        attempt_id,
                        idempotency_key,
                        instance_name,
                        lease_owner,
                        expires_at,
                        current_time,
                    ),
                )
            else:
                retry_safe = bool(row.get("retry_safe"))
                clear_uncertain_result = (
                    row["state"] == "failed"
                    and retry_safe
                    and not row.get("credential_json")
                )
                remote_started_at = (
                    None if clear_uncertain_result else row.get("remote_started_at")
                )
                instance_id = None if clear_uncertain_result else row.get("instance_id")
                credential_json = (
                    None if clear_uncertain_result else row.get("credential_json")
                )
                if row["state"] == "active" and remote_started_at is None:
                    remote_started_at = row.get("updated_at") or current_time
                connection.execute(
                    """
                    UPDATE wapi_instance_lifecycle
                    SET state = 'provisioning', attempt_id = ?,
                        instance_name = ?, instance_id = ?, credential_json = ?,
                        lease_owner = ?, lease_expires_at = ?,
                        remote_started_at = ?, retry_safe = 0,
                        attempt_count = attempt_count + 1,
                        error_code = NULL, updated_at = ?
                    WHERE tenant_id = ?
                    """,
                    (
                        attempt_id,
                        str(row.get("instance_name") or instance_name),
                        instance_id,
                        credential_json,
                        lease_owner,
                        expires_at,
                        remote_started_at,
                        current_time,
                        user_id,
                    ),
                )
            row = _lifecycle_row(connection, user_id)
            connection.commit()
            if row is None:
                raise BindingPersistenceError(
                    "Não foi possível confirmar o lease de provisionamento W-API."
                )
            return _claim_from_row(row, binding, role="owner", include_remote=True)
        except (InstanceOwnershipError, ProvisioningLeaseLostError, BindingPersistenceError):
            connection.rollback()
            raise
        except (sqlite3.DatabaseError, TypeError, ValueError):
            connection.rollback()
            raise BindingPersistenceError(
                "Não foi possível adquirir o lease de provisionamento W-API."
            ) from None
        finally:
            connection.close()


def renew_provisioning(
    user_id: str,
    claim: ProvisioningClaim,
    *,
    lease_seconds: float = 120.0,
    now: float | None = None,
) -> None:
    """Renova o lease com fencing por tentativa e por dono."""
    current_time = time.time() if now is None else float(now)
    expires_at = current_time + max(1.0, float(lease_seconds))
    with _locked_store():
        connection = _registry_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            updated = connection.execute(
                """
                UPDATE wapi_instance_lifecycle
                SET lease_expires_at = ?, updated_at = ?
                WHERE tenant_id = ? AND state = 'provisioning'
                  AND attempt_id = ? AND lease_owner = ?
                """,
                (
                    expires_at,
                    current_time,
                    user_id,
                    claim.attempt_id,
                    claim.lease_owner,
                ),
            )
            if updated.rowcount != 1:
                raise ProvisioningLeaseLostError(
                    "A tentativa de provisionamento W-API perdeu o lease."
                )
            connection.commit()
        except ProvisioningLeaseLostError:
            connection.rollback()
            raise
        except sqlite3.DatabaseError:
            connection.rollback()
            raise BindingPersistenceError(
                "Não foi possível renovar o lease de provisionamento W-API."
            ) from None
        finally:
            connection.close()


def mark_remote_started(
    user_id: str,
    claim: ProvisioningClaim,
    *,
    lease_seconds: float = 120.0,
    now: float | None = None,
) -> None:
    """Persiste que o resultado do POST remoto pode ter se tornado ambíguo."""
    current_time = time.time() if now is None else float(now)
    expires_at = current_time + max(1.0, float(lease_seconds))
    with _locked_store():
        connection = _registry_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            updated = connection.execute(
                """
                UPDATE wapi_instance_lifecycle
                SET remote_started_at = COALESCE(remote_started_at, ?),
                    lease_expires_at = ?, retry_safe = 0, updated_at = ?
                WHERE tenant_id = ? AND state = 'provisioning'
                  AND attempt_id = ? AND lease_owner = ?
                """,
                (
                    current_time,
                    expires_at,
                    current_time,
                    user_id,
                    claim.attempt_id,
                    claim.lease_owner,
                ),
            )
            if updated.rowcount != 1:
                raise ProvisioningLeaseLostError(
                    "A tentativa de provisionamento W-API perdeu o lease."
                )
            connection.commit()
        except ProvisioningLeaseLostError:
            connection.rollback()
            raise
        except sqlite3.DatabaseError:
            connection.rollback()
            raise BindingPersistenceError(
                "Não foi possível registrar o início da criação W-API."
            ) from None
        finally:
            connection.close()


def record_remote_result(
    user_id: str,
    claim: ProvisioningClaim,
    binding: InstanceBinding,
    *,
    lease_seconds: float = 120.0,
    now: float | None = None,
) -> None:
    """Guarda o resultado remoto cifrado antes de tocar no binding em arquivo."""
    if not binding.exists:
        raise ValueError("resultado remoto incompleto")
    current_time = time.time() if now is None else float(now)
    expires_at = current_time + max(1.0, float(lease_seconds))
    try:
        credential_json = json.dumps(
            wapi_credential_store().store(binding.token),
            ensure_ascii=True,
            separators=(",", ":"),
        )
    except Exception:
        raise BindingPersistenceError(
            "Não foi possível proteger o resultado do provisionamento W-API."
        ) from None

    with _locked_store():
        connection = _registry_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            _assert_provisioning_owner(
                connection,
                user_id,
                claim.attempt_id,
                claim.lease_owner,
            )
            owner = connection.execute(
                "SELECT tenant_id FROM wapi_ownership WHERE instance_id = ?",
                (binding.instance_id,),
            ).fetchone()
            if owner and str(owner[0]) != user_id:
                raise InstanceOwnershipError(
                    "A instância W-API já está vinculada a outra conta."
                )
            updated = connection.execute(
                """
                UPDATE wapi_instance_lifecycle
                SET instance_name = ?, instance_id = ?, credential_json = ?,
                    lease_expires_at = ?,
                    remote_started_at = COALESCE(remote_started_at, ?),
                    retry_safe = 0, error_code = NULL, updated_at = ?
                WHERE tenant_id = ? AND state = 'provisioning'
                  AND attempt_id = ? AND lease_owner = ?
                """,
                (
                    binding.instance_name,
                    binding.instance_id,
                    credential_json,
                    expires_at,
                    current_time,
                    current_time,
                    user_id,
                    claim.attempt_id,
                    claim.lease_owner,
                ),
            )
            if updated.rowcount != 1:
                raise ProvisioningLeaseLostError(
                    "A tentativa de provisionamento W-API perdeu o lease."
                )
            connection.commit()
        except (InstanceOwnershipError, ProvisioningLeaseLostError):
            connection.rollback()
            raise
        except sqlite3.IntegrityError:
            connection.rollback()
            raise InstanceOwnershipError(
                "A instância W-API já está vinculada a outra conta."
            ) from None
        except sqlite3.DatabaseError:
            connection.rollback()
            raise BindingPersistenceError(
                "Não foi possível registrar o resultado do provisionamento W-API."
            ) from None
        finally:
            connection.close()


def fail_provisioning(
    user_id: str,
    claim: ProvisioningClaim,
    *,
    error_code: str,
    retry_safe: bool,
    now: float | None = None,
) -> bool:
    """Marca falha sem apagar um eventual resultado remoto recuperável."""
    current_time = time.time() if now is None else float(now)
    safe_code = str(error_code or "provisioning_failed")[:80]
    with _locked_store():
        connection = _registry_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            updated = connection.execute(
                """
                UPDATE wapi_instance_lifecycle
                SET state = 'failed', lease_owner = NULL,
                    lease_expires_at = 0, retry_safe = ?,
                    error_code = ?, updated_at = ?
                WHERE tenant_id = ? AND state = 'provisioning'
                  AND attempt_id = ? AND lease_owner = ?
                """,
                (
                    int(retry_safe),
                    safe_code,
                    current_time,
                    user_id,
                    claim.attempt_id,
                    claim.lease_owner,
                ),
            )
            connection.commit()
            return updated.rowcount == 1
        except sqlite3.DatabaseError:
            connection.rollback()
            raise BindingPersistenceError(
                "Não foi possível registrar a falha do provisionamento W-API."
            ) from None
        finally:
            connection.close()


def complete_provisioning(
    user_id: str,
    claim: ProvisioningClaim,
    binding: InstanceBinding,
) -> InstanceBinding:
    """Consolida binding, ownership e lifecycle active com rollback journalizado."""
    with _locked_store():
        current = get_binding(user_id)
        if binding.consent is None:
            binding.consent = current.consent
        binding.updated_at = time.time()
        payload = _serialize_binding(binding)
        payload[_TENANT_FIELD] = user_id
        _write_binding_transactionally(
            user_id,
            payload,
            previous_instance_id=current.instance_id,
            instance_id=binding.instance_id,
            instance_name=binding.instance_name,
            provisioning_attempt_id=claim.attempt_id,
            provisioning_lease_owner=claim.lease_owner,
        )
        return binding


def begin_disconnecting(
    user_id: str,
    instance_id: str,
    lease_owner: str,
    *,
    lease_seconds: float = 120.0,
) -> ProvisioningClaim | None:
    """Publica o estado disconnecting antes da chamada remota."""
    current_time = time.time()
    with _locked_store():
        binding = get_owned_binding(user_id)
        if not binding.exists or binding.instance_id != instance_id:
            return None
        connection = _registry_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            existing = _lifecycle_row(connection, user_id)
            if (
                existing
                and existing["state"] in {"provisioning", "disconnecting"}
                and float(existing.get("lease_expires_at") or 0.0) > current_time
            ):
                role = (
                    "owner"
                    if existing["state"] == "disconnecting"
                    and str(existing.get("lease_owner") or "") == lease_owner
                    else "wait"
                )
                connection.commit()
                return _claim_from_row(existing, binding, role=role)
            attempt_id = uuid.uuid4().hex
            idempotency_key = (
                str(existing.get("idempotency_key") or "")
                if existing
                else uuid.uuid4().hex
            )
            connection.execute(
                """
                INSERT INTO wapi_instance_lifecycle (
                    tenant_id, state, attempt_id, idempotency_key,
                    instance_name, instance_id, credential_json,
                    lease_owner, lease_expires_at, remote_started_at,
                    retry_safe, attempt_count, error_code, updated_at
                ) VALUES (?, 'disconnecting', ?, ?, ?, ?, NULL, ?, ?, NULL,
                          0, 1, NULL, ?)
                ON CONFLICT(tenant_id) DO UPDATE SET
                    state = 'disconnecting', attempt_id = excluded.attempt_id,
                    instance_name = excluded.instance_name,
                    instance_id = excluded.instance_id,
                    credential_json = NULL,
                    lease_owner = excluded.lease_owner,
                    lease_expires_at = excluded.lease_expires_at,
                    remote_started_at = NULL, retry_safe = 0,
                    attempt_count = wapi_instance_lifecycle.attempt_count + 1,
                    error_code = NULL, updated_at = excluded.updated_at
                """,
                (
                    user_id,
                    attempt_id,
                    idempotency_key,
                    binding.instance_name,
                    instance_id,
                    lease_owner,
                    current_time + max(1.0, float(lease_seconds)),
                    current_time,
                ),
            )
            row = _lifecycle_row(connection, user_id)
            connection.commit()
            if row is None:
                raise BindingPersistenceError(
                    "Não foi possível confirmar o estado da desconexão W-API."
                )
            return _claim_from_row(row, binding, role="owner")
        except sqlite3.DatabaseError:
            connection.rollback()
            raise BindingPersistenceError(
                "Não foi possível iniciar a desconexão W-API."
            ) from None
        finally:
            connection.close()


def complete_disconnecting(
    user_id: str,
    claim: ProvisioningClaim,
    binding: InstanceBinding,
) -> InstanceBinding:
    """Persiste disconnected e conclui o lifecycle com fencing no mesmo commit."""
    with _locked_store():
        current = get_binding(user_id)
        if not current.exists or current.instance_id != binding.instance_id:
            raise ProvisioningLeaseLostError(
                "A tentativa de desconexão W-API perdeu o lease."
            )
        binding.consent = current.consent
        binding.updated_at = time.time()
        payload = _serialize_binding(binding)
        payload[_TENANT_FIELD] = user_id
        _write_binding_transactionally(
            user_id,
            payload,
            previous_instance_id=current.instance_id,
            instance_id=binding.instance_id,
            instance_name=binding.instance_name,
            disconnecting_attempt_id=claim.attempt_id,
            disconnecting_lease_owner=claim.lease_owner,
        )
        return binding


def fail_disconnecting(
    user_id: str,
    claim: ProvisioningClaim,
    *,
    error_code: str = "disconnect_failed",
) -> None:
    with _locked_store():
        connection = _registry_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE wapi_instance_lifecycle
                SET state = 'failed', lease_owner = NULL,
                    lease_expires_at = 0, error_code = ?, updated_at = ?
                WHERE tenant_id = ? AND state = 'disconnecting'
                  AND attempt_id = ? AND lease_owner = ?
                """,
                (
                    str(error_code or "disconnect_failed")[:80],
                    time.time(),
                    user_id,
                    claim.attempt_id,
                    claim.lease_owner,
                ),
            )
            connection.commit()
        except sqlite3.DatabaseError:
            connection.rollback()
            raise BindingPersistenceError(
                "Não foi possível registrar a falha da desconexão W-API."
            ) from None
        finally:
            connection.close()


def clear_binding_if_matches(
    user_id: str,
    expected_instance_id: str,
    *,
    expected_updated_at: float | None = None,
) -> bool:
    """Remove só o binding observado, sem apagar uma substituição concorrente."""
    with _locked_store():
        current = get_binding(user_id)
        if (
            current.instance_id != expected_instance_id
            or (
                expected_updated_at is not None
                and current.updated_at != expected_updated_at
            )
        ):
            return False
        consent = current.consent
        payload = _serialize_binding(InstanceBinding(consent=consent))
        payload[_TENANT_FIELD] = user_id
        _write_binding_transactionally(
            user_id,
            payload,
            previous_instance_id=current.instance_id,
            instance_id="",
        )
        return True


def clear_binding(user_id: str) -> None:
    """Remove o vínculo preservando o registro de aceite já obtido."""
    with _locked_store():
        current = get_binding(user_id)
        clear_binding_if_matches(user_id, current.instance_id)


def record_consent(user_id: str, *, origin: str, term_version: str = CONSENT_TERM_VERSION) -> InstanceBinding:
    with _locked_store():
        binding = get_binding(user_id)
        binding.consent = asdict(
            ConsentRecord(
                term_version=term_version,
                accepted_at=time.time(),
                origin=origin,
            )
        )
        return save_binding(user_id, binding)


def has_valid_consent(user_id: str, required_version: str = CONSENT_TERM_VERSION) -> bool:
    return get_binding(user_id).has_valid_consent(required_version)


# ---- resolução instanceId -> owner (uso exclusivo do webhook) -------------


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
    with _locked_store():
        connection = _registry_connection()
        try:
            row = connection.execute(
                "SELECT tenant_id FROM wapi_ownership WHERE instance_id = ?",
                (instance_id,),
            ).fetchone()
        finally:
            connection.close()
        owner = str(row[0]) if row else ""
        if not owner:
            return None
        # Reconfirma: o vínculo do dono precisa apontar para a mesma instância.
        if (
            get_binding(str(owner)).instance_id == instance_id
            and _homologation_owner_allowed(instance_id, str(owner))
        ):
            return str(owner)
        return None
