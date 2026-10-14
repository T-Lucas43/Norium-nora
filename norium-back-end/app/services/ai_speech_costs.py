"""Seconds/characters in the central AI ledger, independently of token quotas.

No audio, text or secret is stored. Policies/tariffs are trusted server values;
this module does not select a commercial plan or expose a configuration route.
Uncertain attempts retain their full reservation. No automatic retry/refund.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING

from app.services import ai_costs


class SpeechBudgetDenied(ValueError):
    pass


@dataclass(frozen=True)
class SpeechBudget:
    provider: str
    model: str
    unit: str
    nano_per_unit: Decimal
    meeting_limit: int
    cycle_limit: int

    def validate(self) -> None:
        if (self.unit not in {"seconds", "characters"} or not self.provider or not self.model
                or not self.nano_per_unit.is_finite() or self.nano_per_unit < 0
                or type(self.meeting_limit) is not int or type(self.cycle_limit) is not int
                or self.meeting_limit < 0 or self.cycle_limit < 0):
            raise SpeechBudgetDenied("Política de custo de voz inválida.")


def usage_id(workspace: str, team_id: str, call_id: str, event_id: str) -> str:
    if any(not isinstance(value, str) or not value or len(value) > 200
           for value in (workspace, team_id, call_id, event_id)):
        raise SpeechBudgetDenied("Escopo de custo de voz inválido.")
    return hashlib.sha256(json.dumps([workspace, team_id, call_id, event_id]).encode()).hexdigest()


def reserve_speech(*, user_id: str, workspace: str, team_id: str, call_id: str,
                   event_id: str, budget: SpeechBudget, quantity: float) -> str:
    budget.validate()
    if not user_id or type(quantity) not in {int, float} or not math.isfinite(quantity) or quantity <= 0:
        raise SpeechBudgetDenied("Quantidade de voz inválida.")
    if (budget.unit == "seconds" and quantity > 10) or (budget.unit == "characters" and (quantity > 1800 or quantity != int(quantity))):
        raise SpeechBudgetDenied("Limite por trecho de voz atingido.")
    # Groq STT minimum billed duration, independently of actual source duration.
    units = max(10, math.ceil(quantity)) if budget.unit == "seconds" else int(quantity)
    key = usage_id(workspace, team_id, call_id, event_id)
    with ai_costs.database() as db:
        ai_costs.lock_speech_account(db, user_id)
        if db.execute("SELECT 1 FROM speech_usage WHERE id=?", (key,)).fetchone():
            raise SpeechBudgetDenied("Este trecho já foi reservado. Reenvio automático recusado.")
        cycle = ai_costs.cycle_for(ai_costs.get_limit(db, user_id))
        if not cycle["active"]:
            raise SpeechBudgetDenied("Ciclo de voz indisponível.")
        meeting_used = db.execute(
            "SELECT COALESCE(SUM(units),0) FROM speech_usage WHERE workspace=? AND team_id=? AND call_id=? AND unit=? AND status!='released'",
            (workspace, team_id, call_id, budget.unit),
        ).fetchone()[0]
        cycle_used = db.execute(
            "SELECT COALESCE(SUM(units),0) FROM speech_usage WHERE user_id=? AND unit=? AND status!='released' AND created_at>=? AND created_at<?",
            (user_id, budget.unit, cycle["startAt"], cycle["endAt"]),
        ).fetchone()[0]
        if meeting_used + units > budget.meeting_limit or cycle_used + units > budget.cycle_limit:
            raise SpeechBudgetDenied("Limite de voz da reunião ou do plano atingido.")
        cost = int((budget.nano_per_unit * units).to_integral_value(rounding=ROUND_CEILING))
        tariff = json.dumps({"unit": budget.unit, "nanoPerUnit": str(budget.nano_per_unit)})
        db.execute("INSERT INTO speech_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            key, user_id, workspace, team_id, call_id, ai_costs.now(), budget.provider,
            budget.model, budget.unit, units, math.ceil(quantity * 1000) if budget.unit == "seconds" else 0,
            cost, tariff, "reserved",
        ))
    return key


def settle_speech(key: str, *, sent: bool, completed: bool) -> None:
    if type(sent) is not bool or type(completed) is not bool or (completed and not sent):
        raise SpeechBudgetDenied("Estado de custo inválido.")
    with ai_costs.database() as db:
        row = db.execute("SELECT status FROM speech_usage WHERE id=?", (key,)).fetchone()
        if row is None:
            raise SpeechBudgetDenied("Reserva de voz não encontrada.")
        status = "completed" if completed else "uncertain" if sent else "released"
        # Idempotent terminal settlement cannot change a charged event to free.
        if row[0] == "reserved":
            db.execute("UPDATE speech_usage SET status=? WHERE id=? AND status='reserved'", (status, key))


def speech_overview(user_id: str, workspace: str) -> dict:
    with ai_costs.database() as db:
        rows = [dict(row) for row in db.execute(
            "SELECT id,call_id,provider,model,unit,units,actual_millis,cost_nano,status,created_at FROM speech_usage WHERE user_id=? AND workspace=? ORDER BY created_at DESC",
            (user_id, workspace),
        )]
    charged = [row for row in rows if row["status"] != "released"]
    return {"seconds": sum(row["units"] for row in charged if row["unit"] == "seconds"),
            "characters": sum(row["units"] for row in charged if row["unit"] == "characters"),
            "costUsd": sum(row["cost_nano"] for row in charged) / 1e9,
            "uncertainRequests": sum(row["status"] in {"reserved", "uncertain"} for row in charged),
            "recentUsage": rows[:100]}


class CallSpeechMeter:
    def __init__(self, *, user_id: str, workspace: str, team_id: str, call_id: str, budget: SpeechBudget):
        self.scope = dict(user_id=user_id, workspace=workspace, team_id=team_id, call_id=call_id, budget=budget)

    async def reserve(self, event_id: str, duration: float) -> None:
        task = asyncio.create_task(asyncio.to_thread(reserve_speech, **self.scope, event_id=event_id, quantity=duration))
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            # Thread commits cannot be cancelled; wait and release an unsent
            # reservation instead of leaving a hidden permanent pending lock.
            key = await task
            await asyncio.shield(asyncio.to_thread(settle_speech, key, sent=False, completed=False))
            raise

    async def settle(self, event_id: str, *, sent: bool, completed: bool) -> None:
        key = usage_id(self.scope["workspace"], self.scope["team_id"], self.scope["call_id"], event_id)
        await asyncio.to_thread(settle_speech, key, sent=sent, completed=completed)


def speech_report(db, month: str, *, user_filter: str = "", model_filter: str = "") -> dict:
    """Administrative read projection; token balances and tariffs stay intact."""
    rows = [dict(row) for row in db.execute(
        "SELECT * FROM speech_usage WHERE (?='' OR user_id=?) ORDER BY created_at DESC",
        (user_filter, user_filter),
    )]
    if month == "cycle":
        cycles = {row["user_id"]: ai_costs.cycle_for(ai_costs.get_limit(db, row["user_id"])) for row in rows}
        rows = [row for row in rows if ai_costs.in_cycle(row["created_at"], cycles[row["user_id"]])]
    elif month != "all":
        rows = [row for row in rows if ai_costs.month_for(row["created_at"]) == month]
    if model_filter:
        rows = [row for row in rows if ai_costs.identity({"provider": row["provider"], "model": row["model"]})["id"] == model_filter]

    def totals(values):
        charged = [row for row in values if row["status"] != "released"]
        return {"requests": len(charged), "seconds": sum(row["units"] for row in charged if row["unit"] == "seconds"),
                "actualSeconds": sum(row["actual_millis"] for row in charged) / 1000,
                "characters": sum(row["units"] for row in charged if row["unit"] == "characters"),
                "costUsd": sum(row["cost_nano"] for row in charged) / 1e9,
                "uncertainRequests": sum(row["status"] in {"reserved", "uncertain"} for row in charged),
                "releasedRequests": sum(row["status"] == "released" for row in values)}
    return {"totals": totals(rows),
            "users": [{"userId": user, **totals([row for row in rows if row["user_id"] == user])}
                      for user in sorted({row["user_id"] for row in rows})],
            "recentUsage": [{"id": row["id"], "userId": row["user_id"], "workspace": row["workspace"],
                             "callId": row["call_id"], "provider": row["provider"], "model": row["model"],
                             "unit": row["unit"], "units": row["units"], "actualSeconds": row["actual_millis"] / 1000,
                             "costUsd": row["cost_nano"] / 1e9 if row["status"] != "released" else 0,
                             "status": row["status"], "createdAt": row["created_at"]} for row in rows[:100]]}
