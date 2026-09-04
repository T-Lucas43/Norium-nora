from __future__ import annotations

import re
import unicodedata
from typing import Any

from app.modules.automations.router import read_store as read_automation_store, response_payload as automation_payload
from app.modules.platform.service import list_collection
from app.modules.team.router import message_visible, normalize_thread_id, read_pruned_chat_store, require_team_chat, team_id_for, visible_team_members
from app.services.finance_store import list_finance
from app.services.task_store import list_tasks


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
    safe_messages = [{"id": item.get("id"), "senderName": item.get("senderName"), "text": item.get("text"), "createdAt": item.get("createdAt"), "scope": item.get("scope")} for item in messages[-20:]]
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
    return {"status": "consulta", "response": response, "messages": safe_messages, "member": {"id": target.get("id"), "name": target.get("nome") or target.get("email")} if target else None, "stats": stats}


async def answer_read_query(user: dict[str, Any], domain: str, text: str) -> tuple[str, dict[str, Any]]:
    if domain == "team":
        return "equipe", await _team(user, text)
    if domain == "documents":
        return "operacoes", await _documents(user)
    if domain == "reports":
        return "operacoes", await _overview(user, "Relatório operacional")
    return "operacoes", await _overview(user, "Resumo do dashboard")
