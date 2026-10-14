"""Central token ledger. Stores counters and tariff snapshots, never prompts or keys."""
from __future__ import annotations

import asyncio
import calendar
import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException

from app.core.request_context import current_ai_user_id, current_workspace_id
from app.core.tenant import get_data_root, get_system_db_path, read_json_file, safe_tenant_id, read_user_db, write_user_db
from app.infrastructure.persistence import postgres_store

BRAZIL = timezone(timedelta(hours=-3))
NANO = Decimal(1_000_000_000)
DEFAULT_URLS = {"groq": "https://api.groq.com/openai/v1", "google": "https://generativelanguage.googleapis.com/v1beta", "openai": "https://api.openai.com/v1", "anthropic": "https://api.anthropic.com/v1", "brave": "https://api.search.brave.com/res/v1"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS rates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, model_id TEXT NOT NULL,
 created_at TEXT NOT NULL, month TEXT NOT NULL, input_tokens INTEGER NOT NULL,
 output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
 input_nano INTEGER, output_nano INTEGER, cost_nano INTEGER, estimated INTEGER NOT NULL,
 source TEXT NOT NULL, workspace TEXT NOT NULL, tariff TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS usage_user_month ON usage(user_id, month);
CREATE INDEX IF NOT EXISTS usage_date ON usage(created_at);
CREATE TABLE IF NOT EXISTS limits (user_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
 month TEXT NOT NULL, tokens INTEGER NOT NULL, cost_nano INTEGER NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS speech_budget_locks (user_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS speech_usage (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace TEXT NOT NULL,
 team_id TEXT NOT NULL, call_id TEXT NOT NULL, created_at TEXT NOT NULL,
 provider TEXT NOT NULL, model TEXT NOT NULL, unit TEXT NOT NULL,
 units INTEGER NOT NULL, actual_millis INTEGER NOT NULL, cost_nano INTEGER NOT NULL,
 tariff TEXT NOT NULL, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS speech_usage_user ON speech_usage(user_id, created_at);
"""
_postgres_schema_guard = threading.Lock()
_postgres_schema_ready = False


class _CostRow(dict):
    def __getitem__(self, key):
        return tuple(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


class _CostCursor:
    def __init__(self, cursor):
        self.cursor = cursor
        self.rowcount = cursor.rowcount

    @staticmethod
    def wrap(row):
        return _CostRow(row) if isinstance(row, dict) else row

    def fetchone(self):
        return self.wrap(self.cursor.fetchone())

    def fetchall(self):
        return [self.wrap(row) for row in self.cursor.fetchall()]

    def __iter__(self):
        return (self.wrap(row) for row in self.cursor)


class _PostgresCosts:
    postgres = True

    def __init__(self, raw):
        self.raw = raw

    def execute(self, query, params=()):
        normalized = query
        if normalized.startswith("INSERT OR IGNORE INTO usage"):
            normalized = normalized.replace("INSERT OR IGNORE", "INSERT", 1) + " ON CONFLICT DO NOTHING"
        elif normalized.startswith("INSERT OR IGNORE INTO metadata"):
            normalized = normalized.replace("INSERT OR IGNORE", "INSERT", 1) + " ON CONFLICT DO NOTHING"
        elif normalized.startswith("INSERT OR REPLACE INTO limits"):
            normalized = "INSERT INTO limits(user_id,data) VALUES (%s,%s) ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data"
            return _CostCursor(self.raw.execute(normalized, params))
        return _CostCursor(self.raw.execute(normalized.replace("?", "%s"), params))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def month_for(value: str | None = None) -> str:
    date = datetime.fromisoformat(value.replace("Z", "+00:00")) if value else datetime.now(timezone.utc)
    return date.replace(tzinfo=date.tzinfo or timezone.utc).astimezone(BRAZIL).strftime("%Y-%m")


@contextmanager
def database():
    if postgres_store.configured() or postgres_store.required():
        global _postgres_schema_ready
        if not _postgres_schema_ready:
            with _postgres_schema_guard:
                if not _postgres_schema_ready:
                    with postgres_store.connection() as schema_connection:
                        schema = _PostgresCosts(schema_connection)
                        for statement in (item.strip() for item in SCHEMA.split(";") if item.strip()):
                            statement = statement.replace(
                                "id INTEGER PRIMARY KEY, created_at",
                                "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at",
                            )
                            if any(statement.startswith("CREATE TABLE IF NOT EXISTS " + table) for table in ("usage", "reservations", "speech_usage")):
                                statement = statement.replace(" INTEGER", " BIGINT")
                            schema.execute(statement)
                        schema.execute("ALTER TABLE reservations ADD COLUMN IF NOT EXISTS created_at TEXT NOT NULL DEFAULT ''")
                        schema.execute("INSERT OR IGNORE INTO metadata VALUES ('trackingStartedAt', ?)", (now(),))
                    _postgres_schema_ready = True
        with postgres_store.connection() as raw:
            db = _PostgresCosts(raw)
            try:
                # A reservation and its balance check form one cross-process
                # transaction, including the commercial team allowance.
                raw.execute("SELECT pg_advisory_xact_lock(782631209441)")
                yield db
                raw.commit()
            except BaseException:
                raw.rollback()
                raise
        return
    # DELETE journaling works with the persistent volume; WAL requires shared memory.
    path = get_data_root() / "ai_costs.sqlite3"
    vfs = os.getenv("NORIUM_AI_COSTS_SQLITE_VFS", "").strip()
    if vfs not in ("", "unix-dotfile"):
        raise ValueError("Unsupported AI costs SQLite VFS")
    # Azure Files SMB does not support SQLite's default POSIX byte-range locks.
    # Dotfile locking serializes connections across processes without disabling locks.
    target = path.resolve().as_uri() + "?vfs=unix-dotfile" if vfs else str(path)
    db = sqlite3.connect(target, uri=bool(vfs), timeout=30)
    db.row_factory = sqlite3.Row
    try:
        db.executescript(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        if "created_at" not in {row[1] for row in db.execute("PRAGMA table_info(reservations)")}:
            db.execute("ALTER TABLE reservations ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")
        db.execute("INSERT OR IGNORE INTO metadata VALUES ('trackingStartedAt', ?)", (now(),))
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def identity(provider: dict, model: str | None = None) -> dict:
    kind = str(provider.get("provider") or "openai-compatible").strip().lower()
    parts = urlsplit(str(provider.get("baseUrl") or DEFAULT_URLS.get(kind, "")))
    # Credentials, query strings and fragments are never part of the public catalog.
    url = urlunsplit((parts.scheme.lower(), parts.hostname or "", parts.path.rstrip("/"), "", ""))
    if parts.port:
        url = urlunsplit((parts.scheme.lower(), f"{parts.hostname}:{parts.port}", parts.path.rstrip("/"), "", ""))
    name = str(model or provider.get("model") or "unknown").strip()
    key = hashlib.sha256(f"{kind}|{url}|{name}".encode()).hexdigest()[:24]
    return {"id": key, "provider": kind, "baseUrl": url, "model": name}


def default_rate(provider: dict, model: str | None = None) -> dict:
    item = identity(provider, model)
    prices = None
    request_usd = None
    source = "Tarifa não cadastrada"
    expires = None
    if item["provider"] == "brave" and item["baseUrl"] == DEFAULT_URLS["brave"] and item["model"] == "web-search":
        prices, request_usd = (0, 0, 0, 0), 0.005
        source = "https://api-dashboard.search.brave.com/documentation/pricing"
    elif item["provider"] == "openai" and item["baseUrl"] == DEFAULT_URLS["openai"] and item["model"] == "text-embedding-3-small":
        prices = (0.02, 0, 0, 0.02)
        source = "https://developers.openai.com/api/docs/models/text-embedding-3-small"
    elif item["provider"] == "groq" and item["baseUrl"] == DEFAULT_URLS["groq"] and item["model"] == "openai/gpt-oss-20b":
        prices = (0.075, 0.30, 0.037, 0.075)
        source = "https://console.groq.com/docs/model/openai/gpt-oss-20b"
    elif item["provider"] == "groq" and item["baseUrl"] == DEFAULT_URLS["groq"] and item["model"] == "qwen/qwen3.6-27b":
        prices = (0.60, 3.00, 0.60, 0.60)
        source = "https://console.groq.com/docs/model/qwen/qwen3.6-27b"
    elif item["provider"] == "google" and item["baseUrl"] == DEFAULT_URLS["google"] and item["model"] == "gemini-3.7-flash":
        prices = (0.75, 3.75, 0.075, 0.75) if month_for() < "2027-01" else (1.5, 7.5, 0.15, 1.5)
        source = "https://ai.google.dev/gemini-api/docs/pricing"
        expires = "2026-12-31" if month_for() < "2027-01" else None
    elif item["provider"] == "openai" and item["baseUrl"] == DEFAULT_URLS["openai"] and item["model"] in {"gpt-5.6-luna", "gpt-5.6-sol"}:
        if item["model"] == "gpt-5.6-luna":
            prices = (0.20, 1.20, 0.02, 0.25)
        elif month_for() <= "2026-11":
            prices, expires = (4.00, 20.00, 0.40, 5.00), "2026-11-21"
        # After the verified promotional date, require a new reviewed tariff.
        source = "https://developers.openai.com/api/docs/models/" + item["model"]
    elif not provider.get("managed") and model in (None, provider.get("model")) and "inputCostPerMillion" in provider:
        inp, out = provider.get("inputCostPerMillion"), provider.get("outputCostPerMillion")
        if inp is not None and out is not None:
            prices = (inp, out, inp, inp)
            source = "Cadastro existente em Modelos de IA"
    return {**item, "name": str(provider.get("name") or item["model"]), "unitTokens": 1_000_000,
            "inputUsd": prices[0] if prices else None, "outputUsd": prices[1] if prices else None,
            "cachedInputUsd": prices[2] if prices else None, "cacheWriteUsd": prices[3] if prices else None,
            "requestUsd": request_usd, "source": source, "validUntil": expires, "updatedAt": now(), "version": 1, "managedPrice": bool(prices and source.startswith("https://"))}


def ensure_rate(db, provider: dict, model: str | None = None) -> dict:
    candidate = default_rate(provider, model)
    existing = db.execute("SELECT data FROM rates WHERE id=?", (candidate["id"],)).fetchone()
    if existing:
        rate = json.loads(existing[0])
        if rate.get("managedPrice") and rate.get("validUntil") and rate["validUntil"] < datetime.now(BRAZIL).date().isoformat():
            candidate["version"] = rate["version"] + 1
            db.execute("UPDATE rates SET data=? WHERE id=?", (json.dumps(candidate), candidate["id"]))
            return candidate
        return rate
    db.execute("INSERT INTO rates VALUES (?, ?)", (candidate["id"], json.dumps(candidate)))
    return candidate


def apply_provider_prices(providers: list[dict]) -> list[dict]:
    """Keep the existing model selector and cost routing aligned with admin tariffs."""
    with database() as db:
        result = []
        for provider in providers:
            rate = ensure_rate(db, provider)
            priced = rate.get("inputUsd") is not None and rate.get("outputUsd") is not None
            prices = {"inputCostPerMillion": rate["inputUsd"] * 1_000_000 / rate["unitTokens"], "outputCostPerMillion": rate["outputUsd"] * 1_000_000 / rate["unitTokens"]} if priced else {}
            result.append({**provider, **prices, "pricingConfigured": priced})
        return result


def token_counts(data: dict, kind: str, input_estimate: int = 0, output_estimate: int = 0) -> dict:
    usage = data.get("usage") or (data.get("x_groq") or {}).get("usage") or data.get("usageMetadata") or {}
    def count(*keys):
        return max(0, int(next((usage[k] for k in keys if usage.get(k) is not None), 0)))
    cached = count("total_cached_tokens", "cache_read_input_tokens", "cachedContentTokenCount")
    reasoning = count("total_thought_tokens", "thoughtsTokenCount")
    cache_write = count("cache_creation_input_tokens")
    if kind == "google":
        inp = count("total_input_tokens", "input_tokens", "promptTokenCount")
        out = count("total_output_tokens", "output_tokens", "candidatesTokenCount") + reasoning
    elif kind == "anthropic":
        inp = count("input_tokens") + cached + cache_write
        out = count("output_tokens")
    else:
        inp, out = count("prompt_tokens", "input_tokens"), count("completion_tokens", "output_tokens")
        cached = max(0, int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0))
        reasoning = max(0, int((usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0))
    measured = any(k in usage for k in ("prompt_tokens", "input_tokens", "total_input_tokens", "promptTokenCount"))
    return {"inputTokens": inp if measured else input_estimate, "outputTokens": out if measured else output_estimate,
            "cachedTokens": min(cached, inp), "reasoningTokens": min(reasoning, out), "cacheWriteTokens": cache_write, "estimated": not measured}


def nano_cost(rate: dict, counts: dict) -> tuple[int | None, int | None]:
    if rate.get("inputUsd") is None or rate.get("outputUsd") is None:
        return None, None
    unit = Decimal(str(rate["unitTokens"]))
    def cost(tokens, price):
        return Decimal(tokens) * Decimal(str(price)) * NANO / unit
    inp, cached = counts["inputTokens"], counts.get("cachedTokens", 0)
    writes = min(counts.get("cacheWriteTokens", 0), inp - cached)
    incoming = cost(inp - cached - writes, rate["inputUsd"]) + cost(cached, rate.get("cachedInputUsd") if rate.get("cachedInputUsd") is not None else rate["inputUsd"]) + cost(writes, rate.get("cacheWriteUsd") if rate.get("cacheWriteUsd") is not None else rate["inputUsd"])
    outgoing = cost(counts["outputTokens"], rate["outputUsd"])
    incoming += Decimal(str(rate.get("requestUsd") or 0)) * NANO
    return int(incoming.quantize(Decimal(1), rounding=ROUND_HALF_UP)), int(outgoing.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _record(db, provider, counts, *, user_id, source, event_id=None, created_at=None, model=None, rate=None, workspace=None):
    rate = rate or ensure_rate(db, provider, model)
    incoming, outgoing = nano_cost(rate, counts)
    total = incoming + outgoing if incoming is not None and outgoing is not None else None
    event_id, created_at = event_id or uuid.uuid4().hex, created_at or now()
    db.execute("INSERT OR IGNORE INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        event_id, user_id, rate["id"], created_at, month_for(created_at), counts["inputTokens"], counts["outputTokens"],
        counts.get("cachedTokens", 0), counts.get("reasoningTokens", 0), incoming, outgoing, total,
        int(counts.get("estimated", False)), source, workspace or current_workspace_id(), json.dumps({**rate, "cacheWriteTokens": counts.get("cacheWriteTokens", 0)})))
    return {"id": event_id, "ledgerId": event_id, "model": rate["model"], **counts, "estimatedCost": total / 1e9 if total is not None else None, "createdAt": created_at}


def record_usage(provider, counts, *, user_id, source, event_id=None, created_at=None, model=None):
    with database() as db:
        return _record(db, provider, counts, user_id=user_id, source=source, event_id=event_id, created_at=created_at, model=model)


def settle_lost_reservation(ledger: dict, scope: dict) -> None:
    """A restarted worker conservatively charges the persisted attempt once."""
    with database() as db:
        _record(db, ledger["provider"], {"inputTokens": ledger["input"], "outputTokens": ledger["output"],
                "estimated": True}, user_id=scope["user"], source="nora-brain-uncertain",
                event_id=ledger["id"], created_at=ledger["createdAt"], workspace=scope["workspace"])
        db.execute("DELETE FROM reservations WHERE id=?", (ledger["id"],))


def account_plan(user_id: str, users: list[dict] | None = None) -> dict:
    from app.shared.plan_catalog import finance_plan_catalog
    if users is None:
        store = read_json_file(get_system_db_path("usuarios"), {})
        users = store.get("users", []) if isinstance(store, dict) else []
    user = next((u for u in users if isinstance(u, dict) and u.get("id") == user_id), None)
    if user is None:
        return {}  # Legacy counters/internal jobs without a commercial account.
    owner_id = str(user.get("teamOwnerId") or user_id)
    owner = next((u for u in users if u.get("id") == owner_id), user)
    code = owner.get("plan") or "free"
    defaults = next((p for p in finance_plan_catalog() if p["code"] == code), finance_plan_catalog()[0])
    store = read_json_file(get_system_db_path("admin_finance"), {})
    custom = next((p for p in store.get("plans", []) if p.get("code") == code), {}) if isinstance(store, dict) else {}
    limits = {**defaults["limits"], **custom.get("limits", {})}
    # Invalid commercial values fail closed; never turn a negative cap unlimited.
    caps = {key: max(0, int(limits.get(key, 0))) for key in ("noraTokens", "noraTokensPerPerson", "noraCalls")}
    return {"code": code, "name": custom.get("name") or defaults["name"], "ownerId": owner_id,
            "members": [u["id"] for u in users if u.get("id") == owner_id or u.get("teamOwnerId") == owner_id], **caps}


def get_limit(db, user_id):
    row = db.execute("SELECT data FROM limits WHERE user_id=?", (user_id,)).fetchone()
    limit = {"monthlyBudgetUsd": None, "monthlyTokenLimit": None, "callsLimit": None,
             "period": "monthly", "startDate": None, "autoRenew": True, "resetAt": None,
             **(json.loads(row[0]) if row else {})}
    plan = account_plan(user_id)
    if plan:
        cap = min(plan["noraTokens"], plan["noraTokensPerPerson"])
        limit["monthlyTokenLimit"] = min(cap, limit["monthlyTokenLimit"]) if limit["monthlyTokenLimit"] is not None else cap
        limit["callsLimit"] = min(plan["noraCalls"], limit["callsLimit"]) if limit["callsLimit"] is not None else plan["noraCalls"]
    return limit


def instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc)


def cycle_for(limit: dict, at: str | None = None) -> dict:
    current = instant(at or now()).astimezone(BRAZIL)
    anchor = date.fromisoformat(limit.get("startDate") or "2000-01-01")
    start = datetime.combine(anchor, datetime.min.time(), BRAZIL)
    def monthly(offset):
        year, month = divmod(anchor.year * 12 + anchor.month - 1 + offset, 12)
        return datetime(year, month + 1, min(anchor.day, calendar.monthrange(year, month + 1)[1]), tzinfo=BRAZIL)
    weekly = limit.get("period") == "weekly"
    if limit.get("autoRenew", True) and current >= start:
        if weekly:
            start += timedelta(weeks=(current.date() - anchor).days // 7)
        else:
            offset = (current.year - anchor.year) * 12 + current.month - anchor.month
            if monthly(offset) > current:
                offset -= 1
            start = monthly(offset)
    end = start + timedelta(days=7) if weekly else monthly((start.year - anchor.year) * 12 + start.month - anchor.month + 1)
    effective = max(start, instant(limit["resetAt"])) if limit.get("resetAt") else start
    utc = lambda value: value.astimezone(timezone.utc).isoformat()
    return {"period": limit.get("period", "monthly"), "startAt": utc(effective), "scheduledStartAt": utc(start), "endAt": utc(end), "nextResetAt": utc(end) if limit.get("autoRenew", True) else None, "active": start <= current < end, "status": "scheduled" if current < start else "expired" if current >= end else "active"}


def in_cycle(created_at: str, cycle: dict) -> bool:
    return instant(cycle["startAt"]) <= instant(created_at) < instant(cycle["endAt"])


def reserve(provider, user_id, input_bound, max_output, started_at=None):
    with database() as db:
        rate = ensure_rate(db, provider)
        limit = get_limit(db, user_id)
        cycle = cycle_for(limit, started_at)
        if not cycle["active"]:
            raise HTTPException(402, "O ciclo de IA ainda não iniciou ou já encerrou. Peça ao administrador para ajustar o início ou reiniciar o ciclo.")
        if limit["monthlyTokenLimit"] == 0:
            raise HTTPException(402, "Uso de IA bloqueado pelo limite do ciclo. Peça ao administrador para ajustar seu saldo.")
        if limit["monthlyTokenLimit"] is None and limit["monthlyBudgetUsd"] is not None:
            # Do not silently convert a legacy monetary cap into unlimited AI.
            raise HTTPException(402, "O administrador precisa definir a franquia desta conta em tokens. O orçamento antigo em dólares não autoriza novas solicitações.")
        db.execute("DELETE FROM reservations WHERE expires < ?", (time.time(),))
        usage = [r for r in db.execute("SELECT * FROM usage WHERE user_id=?", (user_id,)) if in_cycle(r["created_at"], cycle)]
        used_tokens = sum(r["input_tokens"] + r["output_tokens"] for r in usage)
        reservations = [r for r in db.execute("SELECT * FROM reservations WHERE user_id=?", (user_id,)) if not r["created_at"] or in_cycle(r["created_at"], cycle)]
        pending_tokens = sum(r["tokens"] for r in reservations)
        if limit.get("callsLimit") is not None and len(usage) + len(reservations) >= limit["callsLimit"]:
            raise HTTPException(402, "Franquia de chamadas da Nora atingida neste ciclo.")
        plan = account_plan(user_id)
        if plan:
            team_cycle = cycle_for(get_limit(db, plan["ownerId"]), started_at)
            team_usage = [r for r in db.execute("SELECT * FROM usage") if r["user_id"] in plan["members"] and in_cycle(r["created_at"], team_cycle)]
            team_pending = [r for r in db.execute("SELECT * FROM reservations") if r["user_id"] in plan["members"] and (not r["created_at"] or in_cycle(r["created_at"], team_cycle))]
            if len(team_usage) + len(team_pending) >= plan["noraCalls"]:
                raise HTTPException(402, "Franquia de chamadas do plano atingida neste ciclo.")
            team_balance = plan["noraTokens"] - sum(r["input_tokens"] + r["output_tokens"] for r in team_usage) - sum(r["tokens"] for r in team_pending)
            max_output = min(max_output, team_balance - input_bound)
        output = max_output
        if limit["monthlyTokenLimit"] is not None:
            output = min(output, limit["monthlyTokenLimit"] - used_tokens - pending_tokens - input_bound)
        # Franchise authority is tokens. Dollar tariffs remain reporting data;
        # an unavailable price or a legacy monetary reference cannot block AI.
        if output < 1:
            raise HTTPException(402, "Saldo do ciclo de IA insuficiente para esta solicitação. Reduza o contexto ou peça ao administrador para ajustar seus limites.")
        reservation = uuid.uuid4().hex
        conservative = {**rate, "inputUsd": max((rate.get(k) or 0) for k in ("inputUsd", "cachedInputUsd", "cacheWriteUsd"))} if rate.get("inputUsd") is not None else rate
        inc, out = nano_cost(conservative, {"inputTokens": input_bound, "outputTokens": output})
        db.execute("INSERT INTO reservations(id,user_id,month,tokens,cost_nano,expires,created_at) VALUES (?,?,?,?,?,?,?)", (reservation, user_id, month_for(started_at), input_bound + output, (inc or 0) + (out or 0), time.time() + 3600, started_at or now()))
        return reservation, output, rate


class Meter:
    """One reservation per billable attempt, settled even for empty/truncated answers."""
    def __init__(self, provider: dict, messages: Any, max_output: int, *, user_id: str | None = None, source="nora"):
        self.provider, self.user_id = provider, user_id or current_ai_user_id() or "system"
        self.input_bound = len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) + 64
        self.max_output, self.source = max_output, source
        self.reservation = None
        self.recorded = False
        self.started = False
        self.rate = None

    async def __aenter__(self):
        self.started_at = now()
        self.reservation, self.max_output, self.rate = await asyncio.to_thread(reserve, self.provider, self.user_id, self.input_bound, self.max_output, self.started_at)
        return self

    def sent(self):
        self.started = True

    def rejected(self):
        self.started = False

    async def record(self, data: dict, output_text=""):
        counts = token_counts(data, self.provider["provider"], self.input_bound, max(1, len(output_text.encode("utf-8"))) if output_text else self.max_output)
        actual_model = str(data.get("model") or self.provider["model"])
        def settle():
            with database() as db:
                rate = self.rate if actual_model == self.provider["model"] else ensure_rate(db, self.provider, actual_model)
                result = _record(db, self.provider, counts, user_id=self.user_id, source=self.source, event_id=self.reservation, rate=rate, created_at=self.started_at)
                db.execute("DELETE FROM reservations WHERE id=?", (self.reservation,))
                return result
        result = await asyncio.to_thread(settle)
        self.recorded = True
        try:
            await notify_usage(self.user_id)
        except Exception:
            # Usage has already been durably settled; notification outages must
            # not discard a valid provider response or double-charge a retry.
            pass
        return result

    async def __aexit__(self, exc_type, exc, tb):
        if not self.recorded and self.started:
            # On disconnect/timeout, consumption is uncertain, not silently zero.
            await asyncio.shield(self.record({}))
        def release():
            with database() as db:
                db.execute("DELETE FROM reservations WHERE id=?", (self.reservation,))
        await asyncio.shield(asyncio.to_thread(release))


def save_rate(payload: dict, actor: str) -> dict:
    with database() as db:
        rate = ensure_rate(db, payload)
        updated = {**rate, **payload, **identity(payload), "managedPrice": False, "updatedAt": now(), "version": rate["version"] + 1}
        db.execute("UPDATE rates SET data=? WHERE id=?", (json.dumps(updated), updated["id"]))
        db.execute("INSERT INTO audit(created_at,actor,action,target,data) VALUES (?,?,?,?,?)", (now(), actor, "tariff_updated", updated["id"], json.dumps({"before": rate, "after": updated})))
        # Price only previously unpriced rows. Existing cost snapshots never change.
        for row in db.execute("SELECT * FROM usage WHERE model_id=? AND cost_nano IS NULL", (updated["id"],)).fetchall():
            inc, out = nano_cost(updated, {"inputTokens": row["input_tokens"], "outputTokens": row["output_tokens"], "cachedTokens": row["cached_tokens"], "cacheWriteTokens": json.loads(row["tariff"]).get("cacheWriteTokens", 0)})
            db.execute("UPDATE usage SET input_nano=?,output_nano=?,cost_nano=?,tariff=? WHERE id=?", (inc, out, inc + out, json.dumps(updated), row["id"]))
        return updated


def save_limit(user_id: str, payload: dict, actor: str):
    with database() as db:
        before = get_limit(db, user_id)
        assert_no_pending(db, user_id)
        payload = {**before, **payload, "resetAt": before["resetAt"]}
        db.execute("INSERT OR REPLACE INTO limits VALUES (?,?)", (user_id, json.dumps(payload)))
        db.execute("INSERT INTO audit(created_at,actor,action,target,data) VALUES (?,?,?,?,?)", (now(), actor, "limit_updated", user_id, json.dumps({"before": before, "after": payload})))
    return payload


def lock_speech_account(db, user_id):
    db.execute("INSERT INTO speech_budget_locks(user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING", (user_id,))
    if getattr(db, "postgres", False):
        db.execute("SELECT user_id FROM speech_budget_locks WHERE user_id=? FOR UPDATE", (user_id,)).fetchone()


def assert_no_pending(db, user_id):
    lock_speech_account(db, user_id)
    if (db.execute("SELECT 1 FROM reservations WHERE user_id=? AND expires>? LIMIT 1", (user_id, time.time())).fetchone()
            or db.execute("SELECT 1 FROM speech_usage WHERE user_id=? AND status='reserved' LIMIT 1", (user_id,)).fetchone()):
        raise HTTPException(409, "Há chamadas de IA em andamento. Aguarde a conclusão antes de alterar ou resetar o ciclo.")


def reset_limit(user_id: str, actor: str, restart_cycle: bool = True, reason: str = ""):
    with database() as db:
        assert_no_pending(db, user_id)
        before = get_limit(db, user_id)
        timestamp = now()
        if not restart_cycle and not cycle_for(before, timestamp)["active"]:
            raise HTTPException(409, "Este ciclo não está ativo. Escolha reiniciar o calendário a partir de hoje.")
        updated = {**before, "resetAt": timestamp}
        if restart_cycle:
            updated["startDate"] = instant(timestamp).astimezone(BRAZIL).date().isoformat()
        db.execute("INSERT OR REPLACE INTO limits VALUES (?,?)", (user_id, json.dumps(updated)))
        db.execute("INSERT INTO audit(created_at,actor,action,target,data) VALUES (?,?,?,?,?)", (timestamp, actor, "cycle_reset", user_id, json.dumps({"before": before, "after": updated, "reason": reason, "restartCycle": restart_cycle})))
    return updated


def sync_catalog(users: list[dict]) -> dict:
    from app.modules.intelligence.service import builtin_provider, builtin_gemini_provider
    from app.services.nora import NoraIAService
    builtins = [builtin_provider(), builtin_gemini_provider()]
    builtins += [{**builtins[0], "model": model, "name": "Nora · fallback"} for model in NoraIAService()._models() if model != builtins[0]["model"]]
    connections: dict[str, list[dict]] = {}
    root = get_data_root()
    with database() as db:
        def connect(provider, user_id=None, workspace="primary"):
            rate = ensure_rate(db, provider)
            connections.setdefault(rate["id"], []).append({"providerId": provider.get("id"), "userId": user_id, "workspace": workspace, "configured": bool(provider.get("configured") or provider.get("encryptedSecret")), "enabled": bool(provider.get("enabled"))})
        for provider in builtins:
            connect(provider)
        for user in users:
            folder = root / f'user_{safe_tenant_id(user["id"])}'
            if postgres_store.configured() or postgres_store.required():
                prefix = f'user_{safe_tenant_id(user["id"])}/'
                paths = [root / key for key in postgres_store.list_document_keys(prefix)
                         if key == prefix + "intelligence_db.json" or (key.startswith(prefix + "workspace_") and key.endswith("/intelligence_db.json"))]
            else:
                paths = [folder / "intelligence_db.json", *folder.glob("workspace_*/intelligence_db.json")]
            for path in paths:
                if not (postgres_store.configured() or postgres_store.required()) and not path.is_file():
                    continue
                store = read_json_file(path, {})
                if not isinstance(store, dict):
                    continue
                workspace = path.parent.name.removeprefix("workspace_") if path.parent != folder else "primary"
                providers = [*builtins, *store.get("modelProviders", [])]
                for provider in store.get("modelProviders", []):
                    connect(provider, user["id"], workspace)
                for usage in store.get("modelUsage", []):
                    if usage.get("ledgerId") or not usage.get("id") or not usage.get("createdAt"):
                        continue
                    provider = next((p for p in providers if p.get("id") == usage.get("providerId")), {"provider": "unknown", "model": usage.get("model"), "name": "Provedor legado"})
                    event_id = "legacy_" + hashlib.sha256(f'{user["id"]}|{workspace}|{usage["id"]}'.encode()).hexdigest()
                    if db.execute("SELECT 1 FROM usage WHERE id=?", (event_id,)).fetchone():
                        continue
                    counts = {"inputTokens": max(0, int(usage.get("inputTokens") or 0)), "outputTokens": max(0, int(usage.get("outputTokens") or 0)), "estimated": True}
                    try:
                        _record(db, provider, counts, user_id=user["id"], source="legacy", event_id=event_id, created_at=usage["createdAt"], model=usage.get("model"), workspace=workspace)
                    except (ValueError, TypeError):
                        continue
        rates = [json.loads(row[0]) for row in db.execute("SELECT data FROM rates")]
    return {"models": [{**r, "connections": connections.get(r["id"], [])} for r in rates]}


def _totals(rows):
    return {"requests": len(rows), "inputTokens": sum(r["input_tokens"] for r in rows), "outputTokens": sum(r["output_tokens"] for r in rows),
            "cachedTokens": sum(r["cached_tokens"] for r in rows), "reasoningTokens": sum(r["reasoning_tokens"] for r in rows),
            "totalTokens": sum(r["input_tokens"] + r["output_tokens"] for r in rows),
            "inputCostUsd": sum(r["input_nano"] or 0 for r in rows) / 1e9, "outputCostUsd": sum(r["output_nano"] or 0 for r in rows) / 1e9,
            "costUsd": sum(r["cost_nano"] or 0 for r in rows) / 1e9, "unpricedRequests": sum(r["cost_nano"] is None for r in rows), "estimatedRequests": sum(r["estimated"] for r in rows)}


def overview(users: list[dict], month: str, user_filter="", model_filter=""):
    from app.services.ai_speech_costs import speech_report
    catalog = sync_catalog(users)
    with database() as db:
        query = "SELECT * FROM usage WHERE (?='all' OR month=?) AND (?='' OR user_id=?) AND (?='' OR model_id=?) ORDER BY created_at DESC"
        report_month = "all" if month == "cycle" else month
        rows = db.execute(query, (report_month, report_month, user_filter, user_filter, model_filter, model_filter)).fetchall()
        # Cycles differ by account. Report filters never change available balances.
        current_rows = db.execute("SELECT * FROM usage").fetchall()
        reservations = db.execute("SELECT * FROM reservations WHERE expires>?", (time.time(),)).fetchall()
        timestamp = now()
        cycles = {uid: cycle_for(get_limit(db, uid), timestamp) for uid in {u["id"] for u in users} | {r["user_id"] for r in current_rows}}
        if month == "cycle":
            rows = [r for r in rows if in_cycle(r["created_at"], cycles[r["user_id"]])]
        results = []
        accounts = {u["id"]: {"id": u["id"], "name": u.get("nome") or u["id"], "email": u.get("email") or ""} for u in users}
        for row in [*rows, *current_rows]:
            accounts.setdefault(row["user_id"], {"id": row["user_id"], "name": "Sistema / execução sem usuário" if row["user_id"] == "system" else "Conta removida", "email": ""})
        for uid, account in accounts.items():
            if user_filter and uid != user_filter:
                continue
            user_rows = [r for r in rows if r["user_id"] == uid]
            cycle = cycles[uid]
            current = _totals([r for r in current_rows if r["user_id"] == uid and in_cycle(r["created_at"], cycle)])
            pending = [r for r in reservations if r["user_id"] == uid and (not r["created_at"] or in_cycle(r["created_at"], cycle))]
            limit = get_limit(db, uid)
            remaining_usd = max(0, limit["monthlyBudgetUsd"] - current["costUsd"] - sum(r["cost_nano"] for r in pending) / 1e9) if limit["monthlyBudgetUsd"] is not None else None
            remaining_tokens = max(0, limit["monthlyTokenLimit"] - current["totalTokens"] - sum(r["tokens"] for r in pending)) if limit["monthlyTokenLimit"] is not None else None
            allocation_required = limit["monthlyTokenLimit"] is None and limit["monthlyBudgetUsd"] is not None
            if allocation_required:
                remaining_tokens = 0
            models = []
            for model in catalog["models"]:
                if model_filter and model["id"] != model_filter:
                    continue
                model_rows = [r for r in user_rows if r["model_id"] == model["id"]]
                def capacity(input_ratio):
                    if not cycle["active"]:
                        return 0
                    return remaining_tokens
                models.append({"modelId": model["id"], **_totals(model_rows), "capacityInputOnly": capacity(1), "capacityOutputOnly": capacity(0), "capacityMixed": capacity(0.75)})
            results.append({**account, **_totals(user_rows), "limits": limit, "cycle": cycle, "currentCycle": current, "currentMonth": current, "remainingUsd": remaining_usd if cycle["active"] else 0, "remainingTokens": remaining_tokens if cycle["active"] else 0, "tokenAllocationRequired": allocation_required, "pendingRequests": len(pending), "models": models})
        audit = [dict(r) for r in db.execute("SELECT created_at,actor,action,target FROM audit ORDER BY id DESC LIMIT 30")]
        started = db.execute("SELECT value FROM metadata WHERE key='trackingStartedAt'").fetchone()[0]
        speech = speech_report(db, month, user_filter=user_filter, model_filter=model_filter)
    return {"month": month, "currentMonth": month_for(), "trackingStartedAt": started, "updatedAt": now(), "totals": _totals(rows), "speech": speech,
            "models": [{**m, **_totals([r for r in rows if r["model_id"] == m["id"]])} for m in catalog["models"] if not model_filter or m["id"] == model_filter],
            "users": sorted(results, key=lambda u: (-u["costUsd"], u["name"])), "audit": audit,
            "recentUsage": [{"id": r["id"], "userId": r["user_id"], "modelId": r["model_id"], "createdAt": r["created_at"], "source": r["source"], "workspace": r["workspace"], "inputTokens": r["input_tokens"], "outputTokens": r["output_tokens"], "cachedTokens": r["cached_tokens"], "reasoningTokens": r["reasoning_tokens"], "costUsd": r["cost_nano"] / 1e9 if r["cost_nano"] is not None else None, "estimated": bool(r["estimated"])} for r in rows[:100]]}


def nora_usage(user: dict, users: list[dict], can_view_people: bool = False) -> dict:
    """A scoped projection: no catalogue connections, prompts, global totals or audit."""
    plan = account_plan(user["id"], users)
    allowed = plan.get("members", [user["id"]]) if can_view_people else [user["id"]]
    timestamp = now()
    people = []
    with database() as db:
        plan_totals, plan_tokens, plan_calls = {}, None, None
        if plan:
            owner_cycle = cycle_for(get_limit(db, plan["ownerId"]), timestamp)
            all_rows = [r for r in db.execute("SELECT * FROM usage") if r["user_id"] in plan["members"] and in_cycle(r["created_at"], owner_cycle)]
            all_pending = [r for r in db.execute("SELECT * FROM reservations WHERE expires>?", (time.time(),)) if r["user_id"] in plan["members"] and (not r["created_at"] or in_cycle(r["created_at"], owner_cycle))]
            plan_totals = _totals(all_rows)
            plan_tokens = max(0, plan["noraTokens"] - plan_totals["totalTokens"] - sum(r["tokens"] for r in all_pending)) if owner_cycle["active"] else 0
            plan_calls = max(0, plan["noraCalls"] - plan_totals["requests"] - len(all_pending)) if owner_cycle["active"] else 0
        for person in users:
            uid = str(person.get("id") or "")
            if uid not in allowed:
                continue
            limit = get_limit(db, uid)
            cycle = cycle_for(limit, timestamp)
            rows = [r for r in db.execute("SELECT * FROM usage WHERE user_id=?", (uid,)) if in_cycle(r["created_at"], cycle)]
            pending = [r for r in db.execute("SELECT * FROM reservations WHERE user_id=? AND expires>?", (uid, time.time())) if not r["created_at"] or in_cycle(r["created_at"], cycle)]
            totals = _totals(rows)
            used = totals["totalTokens"] + sum(r["tokens"] for r in pending)
            calls = totals["requests"] + len(pending)
            alerts = [n for n in (80, 95) if any(cap is not None and cap > 0 and value / cap * 100 >= n for cap, value in ((limit["monthlyTokenLimit"], used), (limit.get("callsLimit"), calls)))]
            people.append({"id": uid, "name": person.get("nome") or "Pessoa", **totals,
                "pendingRequests": len(pending), "limits": limit, "cycle": cycle, "alerts": alerts,
                "remainingTokens": max(0, limit["monthlyTokenLimit"] - used) if limit["monthlyTokenLimit"] is not None and cycle["active"] else None if limit["monthlyTokenLimit"] is None else 0,
                "remainingCalls": max(0, limit["callsLimit"] - calls) if limit.get("callsLimit") is not None and cycle["active"] else None if limit.get("callsLimit") is None else 0})
        for item in people:
            if plan_tokens is not None:
                item["remainingTokens"] = min(item["remainingTokens"], plan_tokens) if item["remainingTokens"] is not None else plan_tokens
            if plan_calls is not None:
                item["remainingCalls"] = min(item["remainingCalls"], plan_calls) if item["remainingCalls"] is not None else plan_calls
        started = db.execute("SELECT value FROM metadata WHERE key='trackingStartedAt'").fetchone()[0]
    personal = next((p for p in people if p["id"] == user["id"]), None)
    return {"updatedAt": timestamp, "trackingStartedAt": started,
        "plan": {"code": plan.get("code", "free"), "name": plan.get("name", "Free"),
                 "tokenAllowance": plan.get("noraTokens"), "noraCallAllowance": plan.get("noraCalls"),
                 "remainingTokens": plan_tokens, "remainingCalls": plan_calls, "currentCycle": plan_totals},
        "personal": personal, "canViewPeople": can_view_people, "people": people if can_view_people else []}


_notification_lock = asyncio.Lock()


async def notify_usage(user_id: str) -> None:
    """One system notification per threshold and cycle; counters contain no content."""
    from app.modules.inbox.router import record_event, manager
    store = await asyncio.to_thread(read_json_file, get_system_db_path("usuarios"), {})
    users = store.get("users", []) if isinstance(store, dict) else []
    user = next((u for u in users if u.get("id") == user_id), None)
    if user is None:
        return
    report = await asyncio.to_thread(nora_usage, user, users)
    personal = report["personal"]
    async with _notification_lock:
        seen = await asyncio.to_thread(read_user_db, user_id, "nora_usage_alerts", [])
        seen = seen if isinstance(seen, list) else []
        for threshold in personal["alerts"]:
            key = hashlib.sha256(f'{user_id}|{current_workspace_id()}|{personal["cycle"]["startAt"]}|{threshold}'.encode()).hexdigest()
            if key in seen:
                continue
            title = f"Consumo da Nora: {threshold}% da franquia"
            await record_event(source="sistema", title=title,
                description="Confira o consumo e o saldo do ciclo em Configurações > Consumo da Nora.",
                metadata={"userId": user_id, "action": "nora_usage_threshold", "threshold": threshold},
                event_id="nora_usage_" + key)
            await manager.broadcast(user_id, {"type": "SYSTEM_NOTIFICATION", "notification": {
                "id": "nora_usage_" + key, "title": title, "severity": "warning",
                "description": "Confira seu saldo em Configurações > Consumo da Nora."}})
            seen.append(key)
        await asyncio.to_thread(write_user_db, user_id, "nora_usage_alerts", seen[-24:])
