"""Reserve before calling a provider. Lost usage keeps its reservation."""
from __future__ import annotations

from datetime import datetime, timezone

from .contracts import BrainError, PROFILES


class Budget:
    def __init__(self, repository, *, monthly_tokens=1_000_000, user_tokens=200_000):
        self.repo = repository
        self.monthly_tokens, self.user_tokens = monthly_tokens, user_tokens

    def reserve(self, job_id, lease, tokens):
        def change(job, connection):
            limit, budget = PROFILES[job["profile"]], job["budget"]
            if tokens <= 0 or budget["tokens"] + budget["reserved"] + tokens > limit.tokens or budget["calls"] >= limit.calls or budget["seconds"] >= limit.seconds:
                raise BrainError("budget_exhausted")
            period = datetime.fromtimestamp(self.repo.clock(), timezone.utc).strftime("%Y-%m")
            monthly_cap, user_cap = self.monthly_tokens, self.user_tokens
            from app.services.ai_costs import account_plan, database, get_limit, cycle_for
            plan = account_plan(job["scope"]["user"])
            if plan:
                with database() as db:
                    personal = get_limit(db, job["scope"]["user"])
                    cycle = cycle_for(personal)
                monthly_cap = plan["noraTokens"]
                user_cap = personal["monthlyTokenLimit"]
                period = cycle["scheduledStartAt"]
            accounts = [("tenant:" + job["scope"]["tenant"], monthly_cap),
                        ("user:" + job["scope"]["tenant"] + ":" + job["scope"]["user"], user_cap)]
            for account, cap in accounts:
                key = account + ":" + period
                self.repo.sql(connection, "INSERT INTO nora_budget(account,period,used,reserved) VALUES (?,?,0,0) ON CONFLICT DO NOTHING", (key, period))
                cursor = self.repo.sql(connection, "UPDATE nora_budget SET reserved=reserved+? WHERE account=? AND used+reserved+?<=?", (tokens, key, tokens, cap))
                if cursor.rowcount != 1:
                    raise BrainError("account_budget_exhausted")
            budget["reserved"] += tokens
            budget["calls"] += 1
            job["reservation"] = {"tokens": tokens, "accounts": [a + ":" + period for a, _ in accounts]}
            self.repo.event(connection, job, "model_reserved", {"tokens": tokens})
        return self.repo.mutate(job_id, None, change, lease=lease)

    def settle(self, job_id, lease, input_tokens, output_tokens, model):
        if min(input_tokens, output_tokens) < 0:
            raise BrainError("invalid_provider_usage")
        actual = input_tokens + output_tokens
        def change(job, connection):
            reservation = job.pop("reservation")
            for account in reservation["accounts"]:
                self.repo.sql(connection, "UPDATE nora_budget SET reserved=reserved-?,used=used+? WHERE account=?",
                              (reservation["tokens"], actual, account))
            job["budget"]["reserved"] -= reservation["tokens"]
            job["budget"]["tokens"] += actual
            self.repo.event(connection, job, "model_used", {"model": model, "input": input_tokens, "output": output_tokens})
            if actual > reservation["tokens"]:
                job["status"], job["result"] = "budget_paused", "Consumo acima da reserva; revisão necessária."
        return self.repo.mutate(job_id, None, change, lease=lease)

    def forfeit(self, job_id, lease, reason):
        def change(job, connection):
            self.repo.forfeit_reservation(connection, job, reason)
        return self.repo.mutate(job_id, None, change, lease=lease)
