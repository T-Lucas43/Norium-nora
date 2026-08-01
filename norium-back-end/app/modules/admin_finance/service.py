from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Iterable


CYCLE_MONTHS = {"monthly": 1, "quarterly": 3, "semiannual": 6, "annual": 12}
PRICE_FIELDS = {
    "monthly": "monthlyPriceCents",
    "quarterly": "quarterlyPriceCents",
    "semiannual": "semiannualPriceCents",
    "annual": "annualPriceCents",
    "lifetime": "lifetimePriceCents",
}


def parse_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def month_end(value: date) -> date:
    return value.replace(day=calendar.monthrange(value.year, value.month)[1])


def period_window(preset: str, start: str | None = None, end: str | None = None, today: date | None = None) -> tuple[date, date]:
    current = today or date.today()
    if start and end:
        parsed_start, parsed_end = parse_date(start), parse_date(end)
        if parsed_start and parsed_end:
            return min(parsed_start, parsed_end), max(parsed_start, parsed_end)
    if preset == "today":
        return current, current
    if preset == "7d":
        return current - timedelta(days=6), current
    if preset == "30d":
        return current - timedelta(days=29), current
    if preset == "90d":
        return current - timedelta(days=89), current
    if preset == "quarter":
        month = ((current.month - 1) // 3) * 3 + 1
        return date(current.year, month, 1), current
    if preset == "semester":
        month = 1 if current.month <= 6 else 7
        return date(current.year, month, 1), current
    if preset == "year":
        return date(current.year, 1, 1), current
    return current.replace(day=1), current


def previous_window(start: date, end: date) -> tuple[date, date]:
    duration = (end - start).days + 1
    previous_end = start - timedelta(days=1)
    return previous_end - timedelta(days=duration - 1), previous_end


def record_date(record: dict[str, Any], fields: Iterable[str]) -> date | None:
    for field in fields:
        parsed = parse_date(record.get(field))
        if parsed:
            return parsed
    return None


def in_window(record: dict[str, Any], start: date, end: date, fields: Iterable[str]) -> bool:
    value = record_date(record, fields)
    return bool(value and start <= value <= end)


def net_payment(payment: dict[str, Any]) -> int:
    return max(
        0,
        int(payment.get("grossCents") or 0)
        - int(payment.get("discountCents") or 0)
        - int(payment.get("refundCents") or 0)
        - int(payment.get("taxCents") or 0)
        - int(payment.get("feeCents") or 0),
    )


def billed_payment(payment: dict[str, Any]) -> int:
    return max(0, int(payment.get("grossCents") or 0) - int(payment.get("discountCents") or 0))


def subscription_monthly_value(subscription: dict[str, Any], plans_by_id: dict[str, dict[str, Any]]) -> int:
    plan = plans_by_id.get(str(subscription.get("planId")))
    if not plan:
        return 0
    cycle = str(subscription.get("billingCycle") or "monthly")
    if cycle == "lifetime":
        return 0
    price = int(plan.get(PRICE_FIELDS.get(cycle, "monthlyPriceCents")) or 0)
    months = CYCLE_MONTHS.get(cycle, 1)
    monthly = price // months
    monthly -= int(subscription.get("discountCents") or 0) // months
    percentage = float(subscription.get("discountPercentage") or 0)
    monthly = round(monthly * (1 - percentage / 100))
    return max(0, monthly)


def percentage_delta(current: int | float, previous: int | float) -> float | None:
    if previous == 0:
        return 100.0 if current else 0.0
    return round(((current - previous) / abs(previous)) * 100, 2)


def apply_filters(records: list[dict[str, Any]], filters: dict[str, str]) -> list[dict[str, Any]]:
    def matches(record: dict[str, Any]) -> bool:
        mappings = {
            "planId": "planId", "status": "status", "categoryId": "categoryId",
            "providerId": "providerId", "paymentMethod": "paymentMethod",
            "supplierId": "supplierId", "costCenterId": "costCenterId",
        }
        for filter_key, record_key in mappings.items():
            value = filters.get(filter_key)
            if value and value != "all" and str(record.get(record_key) or "") != value:
                return False
        return True
    return [record for record in records if matches(record)]


def _period_metrics(store: dict[str, Any], start: date, end: date, filters: dict[str, str]) -> dict[str, Any]:
    plans = {str(item.get("id")): item for item in store.get("plans", [])}
    payments = apply_filters(store.get("payments", []), filters)
    expenses = apply_filters(store.get("expenses", []), filters)
    period_payments = [item for item in payments if in_window(item, start, end, ("paidAt", "dueAt"))]
    period_expenses = [item for item in expenses if in_window(item, start, end, ("paidAt", "dueAt"))]
    paid = [item for item in period_payments if item.get("status") == "paid"]
    refunded = [item for item in period_payments if item.get("status") == "refunded" or int(item.get("refundCents") or 0) > 0]
    pending = [item for item in period_payments if item.get("status") in {"pending", "overdue"}]
    failed = [item for item in period_payments if item.get("status") in {"failed", "canceled"}]
    paid_expenses = [item for item in period_expenses if item.get("status") == "paid"]
    variable_expenses = [item for item in paid_expenses if item.get("expenseType") == "variable"]
    billed = sum(billed_payment(item) for item in period_payments if item.get("status") not in {"canceled", "failed"})
    received = sum(net_payment(item) for item in paid)
    refunded_total = sum(int(item.get("refundCents") or 0) for item in refunded)
    pending_total = sum(billed_payment(item) for item in pending)
    lost = sum(billed_payment(item) for item in failed)
    expense_total = sum(int(item.get("amountCents") or 0) for item in paid_expenses)
    variable_total = sum(int(item.get("amountCents") or 0) for item in variable_expenses)
    gross_profit = received - variable_total
    net_profit = received - expense_total
    subscriptions = apply_filters(store.get("subscriptions", []), filters)
    active = [item for item in subscriptions if item.get("status") == "active"]
    mrr = sum(subscription_monthly_value(item, plans) for item in active)
    return {
        "billedRevenueCents": billed,
        "receivedRevenueCents": received,
        "pendingRevenueCents": pending_total,
        "lostRevenueCents": lost,
        "refundedRevenueCents": refunded_total,
        "expensesCents": expense_total,
        "grossProfitCents": gross_profit,
        "netProfitCents": net_profit,
        "grossMarginPercentage": round((gross_profit / received) * 100, 2) if received else 0,
        "netMarginPercentage": round((net_profit / received) * 100, 2) if received else 0,
        "averageTicketCents": round(received / len(paid)) if paid else 0,
        "paidPayments": len(paid),
        "mrrCents": mrr,
        "arrCents": mrr * 12,
    }


def _time_series(store: dict[str, Any], start: date, end: date, filters: dict[str, str]) -> list[dict[str, Any]]:
    span = (end - start).days + 1
    group_monthly = span > 100
    points: dict[str, dict[str, int]] = defaultdict(lambda: {"revenueCents": 0, "expensesCents": 0, "forecastCents": 0})
    payments = apply_filters(store.get("payments", []), filters)
    expenses = apply_filters(store.get("expenses", []), filters)
    for payment in payments:
        value = record_date(payment, ("paidAt", "dueAt"))
        if not value or not start <= value <= end:
            continue
        key = value.strftime("%Y-%m") if group_monthly else value.isoformat()
        if payment.get("status") == "paid":
            points[key]["revenueCents"] += net_payment(payment)
        elif payment.get("status") in {"pending", "overdue"}:
            points[key]["forecastCents"] += billed_payment(payment)
    for expense in expenses:
        value = record_date(expense, ("paidAt", "dueAt"))
        if value and start <= value <= end:
            key = value.strftime("%Y-%m") if group_monthly else value.isoformat()
            if expense.get("status") == "paid":
                points[key]["expensesCents"] += int(expense.get("amountCents") or 0)
    cursor = start.replace(day=1) if group_monthly else start
    while cursor <= end:
        key = cursor.strftime("%Y-%m") if group_monthly else cursor.isoformat()
        points[key]
        if group_monthly:
            cursor = (month_end(cursor) + timedelta(days=1)).replace(day=1)
        else:
            cursor += timedelta(days=1)
    return [{"date": key, **points[key]} for key in sorted(points)]


def _group_totals(records: list[dict[str, Any]], key: str, amount_key: str, status: str | None = None) -> list[dict[str, Any]]:
    totals: dict[str, int] = defaultdict(int)
    for record in records:
        if status and record.get("status") != status:
            continue
        totals[str(record.get(key) or "unassigned")] += int(record.get(amount_key) or 0)
    return [{"id": item_id, "valueCents": value} for item_id, value in sorted(totals.items(), key=lambda item: item[1], reverse=True)]


def _budget_health(store: dict[str, Any], today: date) -> list[dict[str, Any]]:
    results = []
    settings = store.get("settings", {})
    thresholds = settings.get("alertThresholds") or [50, 75, 90, 100]
    for budget in store.get("budgets", []):
        if not budget.get("active", True):
            continue
        start = parse_date(budget.get("startAt")) or today.replace(day=1)
        end = parse_date(budget.get("endAt")) or month_end(today)
        spent = 0
        for expense in store.get("expenses", []):
            expense_date = record_date(expense, ("paidAt", "dueAt"))
            if not expense_date or not start <= expense_date <= end or expense.get("status") == "canceled":
                continue
            if budget.get("categoryId") and expense.get("categoryId") != budget.get("categoryId"):
                continue
            if budget.get("providerId") and expense.get("providerId") != budget.get("providerId"):
                continue
            spent += int(expense.get("amountCents") or 0)
        limit = int(budget.get("limitCents") or 0)
        percentage = round((spent / limit) * 100, 2) if limit else 0
        reached = max((item for item in thresholds if percentage >= item), default=0)
        results.append({**budget, "spentCents": spent, "usagePercentage": percentage, "reachedThreshold": reached})
    return results


def build_dashboard(store: dict[str, Any], preset: str, start: str | None, end: str | None, filters: dict[str, str]) -> dict[str, Any]:
    period_start, period_end = period_window(preset, start, end)
    previous_start, previous_end = previous_window(period_start, period_end)
    current = _period_metrics(store, period_start, period_end, filters)
    previous = _period_metrics(store, previous_start, previous_end, filters)
    subscriptions = apply_filters(store.get("subscriptions", []), filters)
    plans = {str(item.get("id")): item for item in store.get("plans", [])}
    next_30 = date.today() + timedelta(days=30)
    expected = 0
    for subscription in subscriptions:
        due = parse_date(subscription.get("nextBillingAt"))
        if subscription.get("status") == "active" and due and date.today() <= due <= next_30:
            plan = plans.get(str(subscription.get("planId")), {})
            cycle = str(subscription.get("billingCycle") or "monthly")
            expected += int(plan.get(PRICE_FIELDS.get(cycle, "monthlyPriceCents")) or 0)
    jorro_expenses = [
        item for item in store.get("expenses", [])
        if item.get("jorro") or item.get("providerId") == "provider_jorro" or item.get("categoryId") == "cat_jorro"
    ]
    jorro_period = [item for item in jorro_expenses if in_window(item, period_start, period_end, ("paidAt", "dueAt")) and item.get("status") != "canceled"]
    jorro_spend = sum(int(item.get("amountCents") or 0) for item in jorro_period)
    settings = store.get("settings", {})
    jorro_budget = int(settings.get("jorroMonthlyBudgetCents") or 0)
    budget_health = _budget_health(store, date.today())
    deltas = {
        key: percentage_delta(current.get(key, 0), previous.get(key, 0))
        for key in ("receivedRevenueCents", "expensesCents", "netProfitCents", "mrrCents", "averageTicketCents")
    }
    statuses = {status: sum(1 for item in subscriptions if item.get("status") == status) for status in ("active", "canceled", "trial", "defaulting", "paused")}
    revenue_by_plan = []
    for item in _group_totals(
        [payment for payment in store.get("payments", []) if in_window(payment, period_start, period_end, ("paidAt", "dueAt")) and payment.get("status") == "paid"],
        "planId", "grossCents",
    ):
        item["name"] = plans.get(item["id"], {}).get("name", "Sem plano")
        revenue_by_plan.append(item)
    categories = {str(item.get("id")): item for item in store.get("categories", [])}
    expenses_by_category = []
    for item in _group_totals(
        [expense for expense in store.get("expenses", []) if in_window(expense, period_start, period_end, ("paidAt", "dueAt")) and expense.get("status") != "canceled"],
        "categoryId", "amountCents",
    ):
        item["name"] = categories.get(item["id"], {}).get("name", "Sem categoria")
        expenses_by_category.append(item)
    goals = []
    for goal in store.get("goals", []):
        metric = goal.get("metric")
        current_value = {
            "revenue": current["receivedRevenueCents"], "mrr": current["mrrCents"],
            "profit": current["netProfitCents"], "customers": statuses["active"],
            "margin": current["netMarginPercentage"],
        }.get(metric, 0)
        target = int(goal.get("targetCents") or 0) if metric in {"revenue", "mrr", "profit"} else float(goal.get("targetValue") or 0)
        goals.append({**goal, "currentValue": current_value, "progressPercentage": round((current_value / target) * 100, 2) if target else 0})
    alerts = list(store.get("alerts", []))
    for budget in budget_health:
        if budget.get("reachedThreshold"):
            alerts.append({
                "id": f"budget-{budget['id']}-{budget['reachedThreshold']}", "type": "budget",
                "severity": "critical" if budget["usagePercentage"] >= 100 else "warning",
                "title": f"Orcamento {budget['name']} em {budget['usagePercentage']}%",
                "description": "Revise os gastos antes do fechamento do periodo.",
            })
    return {
        "period": {"preset": preset, "start": period_start.isoformat(), "end": period_end.isoformat(), "previousStart": previous_start.isoformat(), "previousEnd": previous_end.isoformat()},
        "metrics": {**current, "expected30DaysCents": expected, "jorroSpendCents": jorro_spend,
                    "jorroRevenuePercentage": round((jorro_spend / current["receivedRevenueCents"]) * 100, 2) if current["receivedRevenueCents"] else 0,
                    "jorroBudgetCents": jorro_budget, "jorroBudgetUsagePercentage": round((jorro_spend / jorro_budget) * 100, 2) if jorro_budget else 0,
                    "subscriptions": statuses},
        "deltas": deltas,
        "charts": {"cashFlow": _time_series(store, period_start, period_end, filters), "revenueByPlan": revenue_by_plan, "expensesByCategory": expenses_by_category},
        "goals": goals, "budgets": budget_health, "alerts": alerts[:100],
        "settings": settings,
    }


def cash_flow_projection(store: dict[str, Any], days: int = 90) -> list[dict[str, Any]]:
    today = date.today()
    points: dict[str, dict[str, int]] = defaultdict(lambda: {"inflowCents": 0, "outflowCents": 0})
    for payment in store.get("payments", []):
        due = parse_date(payment.get("dueAt"))
        if due and today <= due <= today + timedelta(days=days) and payment.get("status") not in {"canceled", "failed", "refunded"}:
            points[due.isoformat()]["inflowCents"] += billed_payment(payment)
    for expense in store.get("expenses", []):
        due = parse_date(expense.get("dueAt"))
        if due and today <= due <= today + timedelta(days=days) and expense.get("status") != "canceled":
            points[due.isoformat()]["outflowCents"] += int(expense.get("amountCents") or 0)
    balance = 0
    result = []
    for offset in range(days + 1):
        key = (today + timedelta(days=offset)).isoformat()
        balance += points[key]["inflowCents"] - points[key]["outflowCents"]
        result.append({"date": key, **points[key], "balanceCents": balance})
    return result
