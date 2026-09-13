"""Administrative cost export from the same ledger snapshot used by the UI."""
from app.modules.reports.pdf import render_report
from app.services.ai_costs import BRAZIL, instant


def render_costs(data: dict) -> bytes:
    def amount(value):
        return "Sem limite" if value is None else "US$ " + f"{value:,.6f}".replace(",", "_").replace(".", ",").replace("_", ".")

    def count(value):
        return "Sem limite" if value is None else f"{value:,}".replace(",", ".")

    def date(value):
        return instant(value).astimezone(BRAZIL).strftime("%d/%m/%Y %H:%M") if value else "Sem renovação automática"

    def table(title, columns, rows):
        return {"title": title, "columns": [{"label": label, "width": width} for label, width in columns], "rows": [{"cells": row} for row in rows]}

    period = {"all": "Todo o histórico", "cycle": "Ciclo atual de cada usuário"}.get(data["month"], data["month"])
    models = {m["id"]: m for m in data["models"]}
    totals = data["totals"]
    tables = [table("Totais por modelo", [("Modelo / provedor", 34), ("Entrada", 18), ("Saída", 18), ("Custo USD", 30)], [[m["model"] + "\n" + m["provider"], count(m["inputTokens"]), count(m["outputTokens"]), amount(m["costUsd"]) + (" + pendente" if m["unpricedRequests"] else "")] for m in data["models"]])]
    for user in data["users"]:
        limit, cycle, current = user["limits"], user["cycle"], user["currentCycle"]
        label = "Semanal" if limit["period"] == "weekly" else "Mensal"
        tables.append(table(user["name"] + " - " + (user["email"] or user["id"]), [("Configuração", 28), ("Valor / período", 72)], [
            ["Total no relatório", amount(user["costUsd"]) + " / " + count(user["totalTokens"]) + " tokens"],
            ["Ciclo " + label.lower(), date(cycle["startAt"]) + " até " + date(cycle["endAt"]) + " (fim exclusivo)"],
            ["Renovação", date(cycle["nextResetAt"])],
            ["Limites por ciclo", amount(limit["monthlyBudgetUsd"]) + " / " + count(limit["monthlyTokenLimit"]) + " tokens"],
            ["Saldo atual", amount(user["remainingUsd"]) + " / " + count(user["remainingTokens"]) + " tokens"],
            ["Uso do ciclo", amount(current["costUsd"]) + " / " + count(current["totalTokens"]) + " tokens"],
            ["Situação", {"active": "Ativo", "scheduled": "Ainda não iniciado", "expired": "Encerrado"}[cycle["status"]] + ("; há chamadas em andamento" if user["pendingRequests"] else "")],
            ["Último reset", date(limit["resetAt"]) if limit["resetAt"] else "Nenhum reset manual"],
        ]))
        tables.append(table("Custos por modelo - " + user["name"], [("Modelo", 27), ("Tokens entrada / saída", 21), ("USD entrada", 17), ("USD saída", 17), ("USD total", 18)], [[models[m["modelId"]]["model"], count(m["inputTokens"]) + " / " + count(m["outputTokens"]), amount(m["inputCostUsd"]), amount(m["outputCostUsd"]), amount(m["costUsd"]) + (" + pendente" if m["unpricedRequests"] else "")] for m in user["models"]]))
    report = {"title": "Custos de inteligência artificial", "subtitle": "Consumo, custos por modelo e limites individuais", "period": period, "filters": [period, "Horário de Brasília", "Emitido em " + date(data["updatedAt"])], "recordCount": totals["requests"], "metrics": [
        {"label": "Custo total", "value": amount(totals["costUsd"]), "detail": "Subtotal dos registros com tarifa cadastrada"},
        {"label": "Tokens", "value": count(totals["totalTokens"]), "detail": "Entrada + saída; cache e raciocínio já incluídos"},
        {"label": "Contas", "value": count(len(data["users"])), "detail": "Usuários incluídos neste relatório"},
        {"label": "Estimativas / sem tarifa", "value": f'{totals["estimatedRequests"]} / {totals["unpricedRequests"]}', "detail": "Chamadas estimadas e chamadas com custo pendente"},
    ], "tables": tables, "notes": ["O recorte do relatório não altera os saldos: os limites exibidos sempre correspondem ao ciclo atual de cada conta.", "No recorte Ciclos atuais, cada usuário pode ter datas diferentes; o total soma esses ciclos individuais.", "Resets renovam o saldo sem apagar o histórico financeiro. Campos de limite vazios significam sem limite; zero bloqueia o uso.", "Renovação automática ocorre às 00h de Brasília. Sem renovação, o ciclo encerra e requer intervenção administrativa.", "Valores estimados e pendências estão identificados. Uso anterior sem registro de tokens não pode ser recuperado. Custos extras de ferramentas, voz e armazenamento não estão incluídos."]}
    return render_report(report, {"includeAnalysis": False, "includeDetails": True})
