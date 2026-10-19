"""Dados do gateway: escopo de conta comprovado pelo registro local.

Não exporta sessão, token, webhook, proxy ou chaves do gateway. A URL do banco
é exclusiva do operador e só aceita o serviço PostgreSQL privado deste Compose.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import hashlib
import json
import os
import time
from typing import Any
from urllib.parse import urlsplit

from app.core.tenant import read_account_db
from app.infrastructure.persistence import postgres_store


def instance_name(user_id: str) -> str:
    return "norium-evo-" + hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()[:24]


def owned_names(user_id: str | None = None) -> list[str]:
    names: set[str] = set()
    if user_id is not None:
        raw = read_account_db(user_id, "evolution_instance", {})
        if isinstance(raw, dict) and raw.get("instance_id"):
            if raw.get("tenant_id") != user_id or raw["instance_id"] != instance_name(user_id):
                raise RuntimeError("Não foi possível comprovar o vínculo Evolution.")
            names.add(raw["instance_id"])
    if postgres_store.configured() or postgres_store.required():
        with postgres_store.connection() as db:
            for table, column in (("evolution_ownership", "instance_id"), ("evolution_instance_lifecycle", "instance_name")):
                if not db.execute("SELECT to_regclass(%s) AS present", (table,)).fetchone()["present"]:
                    continue
                # Tabela/coluna fixas. O filtro de conta é sempre parametrizado.
                query = f'SELECT tenant_id,{column} AS name FROM {table}'  # nosec B608 -- fixed identifiers
                params = ()
                if user_id is not None:
                    query += " WHERE tenant_id=%s"
                    params = (user_id,)
                rows = db.execute(query + " LIMIT 10001", params).fetchall()
                if len(rows) > 10000:
                    raise RuntimeError("Registro Evolution excedeu o limite operacional.")
                for row in rows:
                    name = str(row["name"] or "")
                    if name:
                        if name != instance_name(str(row["tenant_id"])):
                            raise RuntimeError("Vínculo Evolution inconsistente.")
                        names.add(name)
    return sorted(names)


def database_configured() -> bool:
    uri = os.getenv("EVOLUTION_DATABASE_URL", "").strip()
    try:
        parsed = urlsplit(uri)
        valid = (parsed.scheme in {"postgres", "postgresql"} and parsed.hostname == "evolution-database"
                 and parsed.port in {None, 5432} and parsed.username == "evolution" and bool(parsed.password)
                 and parsed.path == "/evolution" and not parsed.query and not parsed.fragment
                 and os.getenv("EVOLUTION_PRIVATE_NETWORK_ENABLED", "0") == "1")
    except ValueError:
        valid = False
    return valid


@contextmanager
def _database():
    if not database_configured():
        raise RuntimeError("Banco privado da Evolution não configurado para o ciclo de dados.")
    uri = os.getenv("EVOLUTION_DATABASE_URL", "").strip()
    try:
        import psycopg
        from psycopg.rows import dict_row
        db = psycopg.connect(uri, sslmode="disable", connect_timeout=5, row_factory=dict_row,
                             options="-c statement_timeout=10000")
    except Exception:
        raise RuntimeError("Banco privado da Evolution indisponível.") from None
    try:
        with db:
            yield db
    except Exception:
        raise RuntimeError("Não foi possível concluir o ciclo de dados Evolution.") from None
    finally:
        db.close()


_EXPORT_COLUMNS = {
    "Instance": ("id", "name", "integration", "connectionStatus", "ownerJid", "profileName", "profilePicUrl", "createdAt", "updatedAt"),
    "Contact": ("id", "remoteJid", "pushName", "profilePicUrl", "createdAt", "updatedAt", "instanceId"),
    "Chat": ("id", "remoteJid", "name", "labels", "createdAt", "updatedAt", "instanceId", "unreadMessages"),
    "Message": ("id", "key", "pushName", "participant", "messageType", "message", "contextInfo", "source", "messageTimestamp", "instanceId", "status"),
    "MessageUpdate": ("id", "keyId", "remoteJid", "fromMe", "participant", "pollUpdates", "status", "messageId", "instanceId"),
}


def export_account(user_id: str) -> dict[str, Any]:
    names = owned_names(user_id)
    if not names:
        return {}
    from psycopg import sql
    result: dict[str, Any] = {}
    total_bytes = 0
    with _database() as db:
        db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        ids = [row["id"] for row in db.execute('SELECT id FROM "Instance" WHERE name=ANY(%s)', (names,)).fetchall()]
        for table, columns in _EXPORT_COLUMNS.items():
            predicate, values = ("name", names) if table == "Instance" else ("instanceId", ids)
            query = sql.SQL("SELECT {} FROM {} WHERE {}=ANY(%s)").format(
                sql.SQL(",").join(map(sql.Identifier, columns)), sql.Identifier(table), sql.Identifier(predicate))
            rows = []
            with db.cursor(name="norium_evolution_export") as cursor:
                cursor.execute(query, (values,))
                while batch := cursor.fetchmany(500):
                    for row in batch:
                        total_bytes += len(json.dumps(row, default=str).encode("utf-8"))
                        if total_bytes > 64 * 1024 * 1024 or len(rows) >= 100000:
                            raise RuntimeError("Exportação Evolution excedeu o limite; nenhum ZIP parcial será entregue.")
                        rows.append(row)
            result[table] = rows
    return result


async def purge_account(user_id: str) -> None:
    names = await asyncio.to_thread(owned_names, user_id)
    if not names:
        return
    from app.services.evolution_client import EvolutionClient
    client = EvolutionClient()
    for name in names:
        try:
            await client.delete_instance_data(name)
        except Exception:
            raise RuntimeError("Exclusão Evolution pendente; os dados locais foram preservados para retomada.") from None


def maintain_gateway_retention() -> int:
    if not os.getenv("EVOLUTION_DATABASE_URL", "").strip():
        return 0
    names = owned_names()
    if not names:
        return 0
    try:
        days = int(os.getenv("EVOLUTION_MESSAGE_RETENTION_DAYS", "30"))
    except ValueError:
        raise RuntimeError("Retenção Evolution inválida.") from None
    if not 1 <= days <= 180:
        raise RuntimeError("Retenção Evolution exige de 1 a 180 dias.")
    cutoff = int(time.time()) - days * 86400
    with _database() as db:
        # MessageUpdate/Media têm FK ON DELETE CASCADE no esquema upstream.
        deleted = db.execute('''DELETE FROM "Message" WHERE id IN (
            SELECT m.id FROM "Message" m JOIN "Instance" i ON i.id=m."instanceId"
            WHERE i.name=ANY(%s) AND m."messageTimestamp"<%s
            ORDER BY m."messageTimestamp" LIMIT 1000)''', (names, cutoff)).rowcount
    return max(0, deleted)
