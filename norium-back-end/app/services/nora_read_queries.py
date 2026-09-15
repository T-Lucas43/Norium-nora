from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

from app.modules.automations.router import read_store as read_automation_store, response_payload as automation_payload
from app.modules.operations.service import operations_overview
from app.modules.platform.service import list_collection
from app.modules.team.router import message_visible, normalize_thread_id, read_pruned_chat_store, require_team_chat, team_id_for, visible_team_members
from app.services.finance_store import list_finance
from app.services.task_store import list_tasks


logger = logging.getLogger(__name__)


def normalize(value: str) -> str:
    text = unicodedata.normalize("NFKD", value.lower().strip())
    return " ".join("".join(char for char in text if not unicodedata.combining(char)).split())


def _previous_user_message(messages: list[Any]) -> str:
    for message in reversed(messages):
        role = getattr(message, "role", None) if not isinstance(message, dict) else message.get("role")
        content = getattr(message, "content", "") if not isinstance(message, dict) else message.get("content", "")
        if role == "user" and str(content).strip():
            return str(content).strip()
    return ""


def resolve_read_query(message: str, messages: list[Any]) -> tuple[str, str] | None:
    text = normalize(message)
    if text in {"tudo", "todos", "todas", "completo", "mostre tudo", "quero tudo"}:
        previous = _previous_user_message(messages)
        if previous:
            text = normalize(previous)
    if re.search(r"\b(?:crie|criar|adicione|adicionar|exclua|excluir|apague|apagar|edite|editar|atualize|atualizar|mande|mandar|envie|enviar|avise|avisar|notifique|notificar|execute|executar|rode|rodar|ative|ativar|desative|desativar|pause|pausar)\b", text):
        return None
    if re.search(r"\b(?:como (?:usar|funciona)|explique (?:a|o) (?:tela|controle)|para que serve)\b", text):
        return None
    if re.search(r"\b(?:analise|resuma|como (?:anda|esta))\b.*\b(?:meu financeiro|minhas financas|meu caixa)\b", text):
        return "finance", text
    if (
        re.search(r"\b(?:central\s+de\s+trabalho|controle\s+operacional|resumo\s+(?:da|de)\s+operacao)\b", text)
        or re.search(r"\b(?:analise|resuma|priorize).*(?:central|operacao|controle|pendencias)\b", text)
        or re.search(r"\bo\s+que\s+(?:exige|precisa|merece).*(?:atencao|prioridade)\b", text)
        or re.search(r"\bcomo (?:anda|esta) (?:a |minha )?operacao\b", text)
        or re.search(r"\b(?:resuma|resumo d[eo]|organize) (?:o )?meu dia\b", text)
        or re.search(r"\b(?:quais (?:sao )?)?minhas prioridades(?: de hoje)?\b", text)
        or re.search(r"\bo que (?:devo|preciso) priorizar(?: hoje)?\b", text)
    ):
        return "operations", text
    if "dashboard" in text or re.search(r"\bmeu painel\b", text):
        return "dashboard", text
    if re.search(r"\brelatorios?\b", text) and not re.search(r"\bcomo (?:usar|funciona)\b", text):
        return "reports", text
    if re.search(r"\b(?:meus?|minhas?)\s+documentos?\b", text) or re.search(r"\blist(?:e|ar)\s+(?:os\s+)?documentos?\b", text):
        return "documents", text
    if (re.search(r"\bchat\s+(?:da|de|do)\s+(?:equip\w*|time)\b", text) or re.search(r"\bminhas?\s+mensagens?.*\bchat\b", text) or re.search(r"\b(?:desenvolvimento|desempenho|produtividade|andamento).*\b(?:equip\w*|time)\b", text) or re.search(r"\bcomo\s+(?:anda|esta).*\b(?:equip\w*|time)\b", text)):
        return "team", text
    return None


async def _overview(user: dict[str, Any], label: str) -> dict[str, Any]:
    user_id = str(user.get("id") or "lucas123")
    tasks = list_tasks(user_id, status="todas")
    task_stats = tasks.get("stats") if isinstance(tasks.get("stats"), dict) else {}
    finance_data = list_finance(user_id)
    finance = finance_data.get("resumo") if isinstance(finance_data.get("resumo"), dict) else {}
    automations = automation_payload(read_automation_store(user_id))
    automation_metrics = automations.get("metrics") if isinstance(automations.get("metrics"), dict) else {}
    balance = f"{float(finance.get('saldo') or 0):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    response = (
        f"{label} com os dados atuais do seu workspace:\n\n"
        f"- **Tarefas ativas:** {task_stats.get('ativas', 0)}; {task_stats.get('vencidas', 0)} vencidas; {task_stats.get('concluidas', 0)} concluídas.\n"
        f"- **Financeiro:** saldo realizado de R$ {balance}; {finance.get('vencidos', 0)} registro(s) vencido(s).\n"
        f"- **Automações:** {automation_metrics.get('active', 0)} ativas de {automation_metrics.get('total', 0)}; {automation_metrics.get('runsToday', 0)} execução(ões) hoje."
    )
    return {"status": "consulta", "response": response, "overview": {"tasks": task_stats, "finance": finance, "automations": automation_metrics}}


async def _documents(user: dict[str, Any]) -> dict[str, Any]:
    items = await list_collection(user, "knowledge")
    documents = [{"id": item.get("id"), "title": item.get("title"), "sourceType": item.get("sourceType"), "fileName": item.get("fileName"), "pageCount": item.get("pageCount"), "updatedAt": item.get("updatedAt")} for item in items[:50]]
    if not documents:
        response = "Consultei a base de conhecimento deste workspace: ainda não há documentos cadastrados."
    else:
        lines = "\n".join(f"- **{item.get('title') or item.get('fileName') or 'Documento'}**" + (f" — {item['pageCount']} página(s)" if item.get("pageCount") is not None else "") for item in documents[:12])
        response = f"Encontrei {len(items)} documento(s) na base de conhecimento:\n\n{lines}"
    return {"status": "consulta", "response": response, "documents": documents, "total": len(items)}


async def _operations(user: dict[str, Any]) -> dict[str, Any]:
    try:
        overview = await operations_overview(user)
    except Exception:
        logger.exception("Falha na visão operacional completa da Nora; usando leitura isolada por módulo")
        return _operations_fallback(user)
    summary = overview.get("summary") if isinstance(overview.get("summary"), dict) else {}
    briefing = overview.get("briefing") if isinstance(overview.get("briefing"), dict) else {}
    alerts = overview.get("alerts") if isinstance(overview.get("alerts"), list) else []
    approvals = overview.get("approvals") if isinstance(overview.get("approvals"), list) else []
    integrations = overview.get("integrations") if isinstance(overview.get("integrations"), list) else []
    my_day = overview.get("myDay") if isinstance(overview.get("myDay"), dict) else {}
    tasks = my_day.get("tasks") if isinstance(my_day.get("tasks"), list) else []
    calendar = my_day.get("calendar") if isinstance(my_day.get("calendar"), list) else []

    priority = briefing.get("priority") if isinstance(briefing.get("priority"), dict) else None
    attention_lines: list[str] = []
    if priority and priority.get("title"):
        attention_lines.append(f"1. **{priority['title']}** — {priority.get('description') or 'revise os detalhes na Central.'}")
    for alert in alerts:
        if not isinstance(alert, dict) or not alert.get("title"):
            continue
        if priority and alert.get("title") == priority.get("title"):
            continue
        line = f"{len(attention_lines) + 1}. **{alert['title']}**"
        if alert.get("description"):
            line += f" — {alert['description']}"
        attention_lines.append(line)
        if len(attention_lines) >= 4:
            break

    response = (
        "Consultei os dados atuais da sua operação no Norium.\n\n"
        "## Visão geral\n\n"
        f"- **Aprovações pendentes:** {summary.get('pendingApprovals', 0)}\n"
        f"- **Tarefas ativas:** {summary.get('activeTasks', 0)}, sendo {summary.get('overdueTasks', 0)} vencida(s)\n"
        f"- **Compromissos de hoje:** {summary.get('todayEvents', 0)}\n"
        f"- **Alertas financeiros:** {summary.get('financialReminders', 0)}\n"
        f"- **Integrações que exigem atenção:** {summary.get('unhealthyIntegrations', 0)}"
    )
    if attention_lines:
        response += "\n\n## Prioridades recomendadas\n\n" + "\n".join(attention_lines)
    else:
        response += "\n\n## Prioridades recomendadas\n\nNão há alerta crítico registrado agora. Siga pelas tarefas ativas e pelos compromissos de hoje."

    task_lines = []
    for task in tasks[:4]:
        if not isinstance(task, dict):
            continue
        title = str(task.get("title") or task.get("titulo") or "Tarefa sem título")
        status = str(task.get("status") or "status não informado").replace("_", " ")
        due_date = task.get("dueDate") or task.get("due_date") or task.get("deadline")
        suffix = f" · prazo {due_date}" if due_date else ""
        task_lines.append(f"- **{title}** — {status}{suffix}")
    if task_lines:
        response += "\n\n## Tarefas em foco\n\n" + "\n".join(task_lines)

    calendar_lines = []
    for event in calendar[:4]:
        if not isinstance(event, dict):
            continue
        title = str(event.get("titulo") or event.get("title") or event.get("summary") or "Compromisso")
        start = event.get("inicio") or event.get("start") or event.get("startAt")
        calendar_lines.append(f"- **{title}**" + (f" — {start}" if start else " — horário não informado"))
    if calendar_lines:
        response += "\n\n## Agenda de hoje\n\n" + "\n".join(calendar_lines)

    response += "\n\nVocê pode me pedir para detalhar qualquer prioridade, tarefa, compromisso ou alerta acima."

    return {
        "status": "consulta",
        "response": response,
        "summary": summary,
        "briefing": briefing,
        "alerts": alerts[:8],
        "approvals": approvals[:12],
        "integrations": integrations,
        "myDay": my_day,
        "generatedAt": overview.get("generatedAt"),
    }


def _operations_fallback(user: dict[str, Any]) -> dict[str, Any]:
    """Mantém o resumo útil mesmo quando uma fonte agregada está indisponível."""

    user_id = str(user.get("id") or "lucas123")
    unavailable: list[str] = []
    task_stats: dict[str, Any] = {}
    tasks: list[dict[str, Any]] = []
    finance: dict[str, Any] = {}
    automation_metrics: dict[str, Any] = {}

    try:
        task_payload = list_tasks(user_id, status="todas")
        task_stats = task_payload.get("stats") if isinstance(task_payload.get("stats"), dict) else {}
        tasks = task_payload.get("tasks") if isinstance(task_payload.get("tasks"), list) else []
    except Exception:
        logger.exception("Falha ao consultar tarefas no resumo degradado da Nora")
        unavailable.append("tarefas")

    try:
        finance_payload = list_finance(user_id)
        finance = finance_payload.get("resumo") if isinstance(finance_payload.get("resumo"), dict) else {}
    except Exception:
        logger.exception("Falha ao consultar financeiro no resumo degradado da Nora")
        unavailable.append("financeiro")

    try:
        automation_data = automation_payload(read_automation_store(user_id))
        automation_metrics = automation_data.get("metrics") if isinstance(automation_data.get("metrics"), dict) else {}
    except Exception:
        logger.exception("Falha ao consultar automações no resumo degradado da Nora")
        unavailable.append("automações")

    summary_lines: list[str] = []
    next_steps: list[str] = []
    if "tarefas" not in unavailable:
        active = int(task_stats.get("ativas") or 0)
        overdue = int(task_stats.get("vencidas") or 0)
        completed = int(task_stats.get("concluidas") or 0)
        summary_lines.append(f"- **Tarefas:** {active} ativa(s), {overdue} vencida(s) e {completed} concluída(s).")
        if overdue:
            next_steps.append(f"1. Revise as **{overdue} tarefa(s) vencida(s)** e atualize responsáveis e prazos.")
        for task in tasks[:3]:
            if not isinstance(task, dict):
                continue
            title = str(task.get("title") or task.get("titulo") or "Tarefa sem título")
            status = str(task.get("status") or "pendente").replace("_", " ")
            next_steps.append(f"{len(next_steps) + 1}. **{title}** — {status}.")
            if len(next_steps) >= 4:
                break
    if "financeiro" not in unavailable:
        balance = f"{float(finance.get('saldo') or 0):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        summary_lines.append(f"- **Financeiro:** saldo realizado de R$ {balance}; {int(finance.get('vencidos') or 0)} registro(s) vencido(s).")
    if "automações" not in unavailable:
        summary_lines.append(
            f"- **Automações:** {int(automation_metrics.get('active') or 0)} ativa(s) de "
            f"{int(automation_metrics.get('total') or 0)}; {int(automation_metrics.get('runsToday') or 0)} execução(ões) hoje."
        )

    if not summary_lines:
        summary_lines.append("- Nenhum módulo operacional respondeu à consulta neste instante.")
    if not next_steps:
        next_steps.append("1. Confira os compromissos e continue pelas tarefas ativas sem prazo vencido.")

    response = (
        "Consegui preparar um resumo parcial com as fontes disponíveis.\n\n"
        "## Visão geral\n\n"
        + "\n".join(summary_lines)
        + "\n\n## Próximos passos\n\n"
        + "\n".join(next_steps[:4])
    )
    if unavailable:
        response += "\n\n**Consulta parcial:** não consegui atualizar agora: " + ", ".join(unavailable) + ". Tente novamente em instantes para completar o resumo."
    response += "\n\nVocê pode pedir detalhes de uma tarefa, do financeiro ou das automações."
    return {
        "status": "consulta_parcial" if unavailable else "consulta",
        "response": response,
        "summary": {
            "activeTasks": int(task_stats.get("ativas") or 0),
            "overdueTasks": int(task_stats.get("vencidas") or 0),
            "financialReminders": int(finance.get("vencidos") or 0),
        },
        "myDay": {"tasks": tasks[:8], "calendar": [], "financeSummary": finance},
        "unavailableSources": unavailable,
    }


def _finance_analysis(user: dict[str, Any]) -> dict[str, Any]:
    finance = list_finance(str(user.get("id") or "lucas123"))
    summary = finance.get("resumo") or {}
    balance = float(summary.get("saldo") or 0)
    pending = float(summary.get("pendente") or 0)
    overdue = int(summary.get("vencidos") or 0)
    money = lambda value: f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    lines = [f"Seu saldo realizado é **{money(balance)}**, com **{money(pending)} a pagar** nos lançamentos pendentes."]
    if overdue:
        lines.append(f"Priorize a revisão dos **{overdue} registros vencidos** e confira cada vencimento antes de tomar uma decisão.")
    if balance < 0:
        lines.append("As saídas pagas superam as entradas registradas. Revise despesas recorrentes e acompanhe os recebimentos previstos.")
    elif pending > balance:
        lines.append("O total pendente supera o saldo realizado. Confira as datas de recebimento e pagamento para planejar o caixa.")
    reminders = finance.get("lembretes") or []
    if reminders:
        lines.append("**Próximos vencimentos e pendências**\n" + "\n".join(
            f"- **{item.get('title') or 'Registro'}**: {money(float(item.get('amount') or 0))}, vencimento {item.get('dueDate') or 'não informado'}."
            for item in reminders[:5]
        ))
    lines.append("Os indicadores e lançamentos estão organizados abaixo. Esta análise usa os registros do Norium; o saldo não é uma consulta bancária.")
    return {"status": "consulta", "response": "\n\n".join(lines), "financeiro": finance}


def _member_from_query(text: str, members: list[dict[str, Any]], current_user_id: str) -> dict[str, Any] | None:
    ignored = {"equipe", "time", "chat", "mensagem", "mensagens", "minha", "minhas", "para", "com", "meu"}
    terms = {term for term in re.findall(r"[a-z0-9]{3,}", text) if term not in ignored}
    matches = []
    for member in members:
        if str(member.get("id") or "") == current_user_id:
            continue
        name = normalize(str(member.get("nome") or member.get("name") or member.get("email") or ""))
        if any(term in name.split() or term in name for term in terms):
            matches.append(member)
    return matches[0] if len(matches) == 1 else None


async def _team(user: dict[str, Any], text: str) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user.get("id") or "")
    members = await visible_team_members(user)
    store = await read_pruned_chat_store(team_id_for(user))
    target = _member_from_query(text, members, user_id)
    thread_id = normalize_thread_id("direct", user_id, str(target.get("id"))) if target else "team"
    messages = [item for item in store.get("messages", []) if isinstance(item, dict) and item.get("threadId") == thread_id and message_visible(item, user_id)]
    if target and re.search(r"\bminhas?\s+mensagens?\b", text):
        messages = [item for item in messages if str(item.get("senderId") or "") == user_id]
    safe_messages = [{"id": item.get("id"), "senderName": item.get("senderName"), "text": item.get("text"), "createdAt": item.get("createdAt"), "scope": item.get("scope"), "attachments": item.get("attachments") if isinstance(item.get("attachments"), list) else []} for item in messages[-20:]]
    task_payload = list_tasks(user_id, status="todas")
    stats = task_payload.get("stats") if isinstance(task_payload.get("stats"), dict) else {}
    wants_development = bool(re.search(r"\b(?:desenvolvimento|desempenho|produtividade|andamento|como anda|como esta)\b", text))
    if wants_development:
        active_members = len([item for item in members if item.get("status") == "ativo"])
        team_messages = len([item for item in store.get("messages", []) if isinstance(item, dict) and item.get("threadId") == "team"])
        response = ("Visão atual da equipe, baseada no chat e nas tarefas registradas:\n\n" f"- **Membros ativos:** {active_members} de {len(members)}\n" f"- **Tarefas ativas:** {stats.get('ativas', 0)}\n" f"- **Em andamento:** {stats.get('andamento', 0)}\n" f"- **Em revisão:** {stats.get('revisao', 0)}\n" f"- **Concluídas:** {stats.get('concluidas', 0)}\n" f"- **Vencidas:** {stats.get('vencidas', 0)}\n" f"- **Mensagens no canal geral:** {team_messages}")
    elif safe_messages:
        target_label = str(target.get("nome") or target.get("email") or "membro") if target else "equipe"
        lines = "\n".join(f"- **{item.get('senderName') or 'Membro'}:** {item.get('text') or '[anexo]'}" for item in safe_messages[-10:])
        response = f"Consultei o chat com {target_label}. Estas são as {min(len(safe_messages), 10)} mensagens mais recentes do filtro:\n\n{lines}"
    else:
        target_label = str(target.get("nome") or target.get("email") or "equipe") if target else "equipe"
        response = f"Consultei o chat com {target_label} e não há mensagens nesse filtro."
    attachments = [attachment for item in safe_messages for attachment in item.get("attachments", []) if isinstance(attachment, dict)]
    files = [{
        "id": str(item.get("id") or item.get("storedName") or "team-file"),
        "name": str(item.get("name") or item.get("fileName") or "arquivo"),
        "mimeType": str(item.get("mimeType") or "application/octet-stream"),
        "size": int(item.get("size") or 0),
        "previewUrl": str(item.get("url") or ""),
        "downloadUrl": str(item.get("url") or ""),
        "source": "team-chat",
    } for item in attachments if item.get("url")]
    if files and re.search(r"\b(?:midia|midias|anexo|anexos|arquivo|arquivos|foto|fotos|video|videos)\b", text):
        response = f"Encontrei {len(files)} arquivo(s) visível(is) no chat da equipe. Eles estão disponíveis abaixo para visualizar ou baixar."
    return {"status": "consulta", "response": response, "messages": safe_messages, "files": files[:40], "member": {"id": target.get("id"), "name": target.get("nome") or target.get("email")} if target else None, "stats": stats}


async def answer_read_query(user: dict[str, Any], domain: str, text: str) -> tuple[str, dict[str, Any]]:
    if domain == "finance":
        return "financeiro", _finance_analysis(user)
    if domain == "operations":
        return "operacoes", await _operations(user)
    if domain == "team":
        return "equipe", await _team(user, text)
    if domain == "documents":
        return "operacoes", await _documents(user)
    if domain == "reports":
        return "operacoes", await _overview(user, "Relatório operacional")
    return "operacoes", await _overview(user, "Resumo do dashboard")
