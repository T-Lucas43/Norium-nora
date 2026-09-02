"""Dominio de automacoes extraido para isolar fluxos, gatilhos e execucoes."""

from __future__ import annotations

import copy
import json
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.shared.schemas import StrictModel

from app.core.tenant import read_user_db, write_user_db
from app.routers.auth_router import current_user
from app.routers.inbox_router import record_event
from app.routers.team_chat_router import append_team_message_for_user
from app.services.gmail_service import GmailConfigError, GmailService
from app.services.task_store import create_task

router = APIRouter(prefix="/api/automacoes", tags=["Automacoes"])
AUTOMATION_AGENT_SESSIONS: dict[str, str] = {}

AutomationStatus = Literal["ativa", "desativada"]
AutomationEnvironment = Literal["rascunho", "homologacao", "producao"]
StepKind = Literal["trigger", "action", "nora"]
RunStatus = Literal["sucesso", "erro", "simulado"]


class AutomationNode(StrictModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    kind: StepKind = "action"
    icon: str = "zap"
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=260)
    x: float = 0
    y: float = 0
    config: dict[str, str] = Field(default_factory=dict)


class AutomationConnection(StrictModel):
    source: str = Field(min_length=1)
    target: str = Field(min_length=1)


class AutomationFlow(StrictModel):
    nodes: list[AutomationNode] = Field(default_factory=list)
    connections: list[AutomationConnection] = Field(default_factory=list)


class AutomationPayload(StrictModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=420)
    icon: str = "zap"
    category: str = "Operacional"
    trigger: str = "Manual"
    actions: list[str] = Field(default_factory=list)
    status: AutomationStatus = "ativa"
    active: bool = True
    aiEnabled: bool = False
    favorite: bool = False
    savedMinutesPerRun: int = Field(default=8, ge=1, le=240)
    flow: AutomationFlow | None = None
    variables: dict[str, str] = Field(default_factory=dict)
    schedule: str = ""
    retryPolicy: dict[str, Any] = Field(default_factory=lambda: {"enabled": True, "maxAttempts": 3, "delaySeconds": 30})
    failureAction: str = "notificar_operador"
    requiresApproval: bool = False
    environment: AutomationEnvironment = "rascunho"


class AutomationUpdatePayload(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=420)
    icon: str | None = None
    category: str | None = None
    trigger: str | None = None
    actions: list[str] | None = None
    status: AutomationStatus | None = None
    active: bool | None = None
    aiEnabled: bool | None = None
    favorite: bool | None = None
    savedMinutesPerRun: int | None = Field(default=None, ge=1, le=240)
    flow: AutomationFlow | None = None
    variables: dict[str, str] | None = None
    schedule: str | None = None
    retryPolicy: dict[str, Any] | None = None
    failureAction: str | None = None
    requiresApproval: bool | None = None
    environment: AutomationEnvironment | None = None


class AutomationPromotionPayload(StrictModel):
    environment: AutomationEnvironment
    note: str = Field(default="", max_length=320)


class AutomationRestorePayload(StrictModel):
    note: str = Field(default="", max_length=320)


class AutomationImportPayload(StrictModel):
    automations: list[dict[str, Any]] = Field(default_factory=list)


class AutomationAgentPayload(StrictModel):
    message: str = Field(min_length=1, max_length=1200)


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_text(value: str) -> str:
    lowered = value.lower().strip()
    return "".join(char for char in unicodedata.normalize("NFKD", lowered) if not unicodedata.combining(char))


def slug_id(prefix: str = "auto") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def node(node_id: str, kind: StepKind, icon: str, title: str, description: str, x: int, y: int) -> dict[str, Any]:
    return {
        "id": node_id,
        "kind": kind,
        "icon": icon,
        "title": title,
        "description": description,
        "x": x,
        "y": y,
    }


def flow_from_steps(steps: list[dict[str, Any]]) -> dict[str, Any]:
    connections = [{"source": steps[index]["id"], "target": steps[index + 1]["id"]} for index in range(len(steps) - 1)]
    return {"nodes": steps, "connections": connections}


def default_automations() -> list[dict[str, Any]]:
    created = now_iso()
    examples = [
        {
            "name": "Novo e-mail recebido",
            "description": "Analisa e-mails recebidos, cria uma tarefa e avisa o responsavel no WhatsApp.",
            "icon": "mail",
            "category": "E-mail",
            "trigger": "E-mail",
            "actions": ["Executar IA", "Criar tarefa", "Enviar WhatsApp"],
            "aiEnabled": True,
            "savedMinutesPerRun": 12,
            "flow": flow_from_steps(
                [
                    node("email_received", "trigger", "mail", "Novo e-mail recebido", "Gatilho quando o Gmail sincroniza uma mensagem nova.", 60, 120),
                    node("nora_ai_email", "nora", "sparkles", "Nora IA", "Resume, classifica prioridade e extrai proximas acoes.", 320, 120),
                    node("create_task_email", "action", "check-square", "Criar tarefa", "Cria uma tarefa com prazo e contexto do e-mail.", 580, 120),
                    node("send_whatsapp_email", "action", "message-square", "Enviar WhatsApp", "Avisa o contato ou equipe responsavel.", 840, 120),
                ]
            ),
        },
        {
            "name": "Nova mensagem WhatsApp",
            "description": "Usa IA para analisar mensagens importantes, criar tarefas e notificar a equipe.",
            "icon": "message-square",
            "category": "WhatsApp",
            "trigger": "WhatsApp",
            "actions": ["Executar IA", "Criar tarefa", "Notificar equipe"],
            "aiEnabled": True,
            "savedMinutesPerRun": 10,
            "flow": flow_from_steps(
                [
                    node("whatsapp_message", "trigger", "message-square", "Nova mensagem WhatsApp", "Recebe mensagem de contato ou grupo sincronizado.", 60, 120),
                    node("nora_ai_whatsapp", "nora", "sparkles", "Nora IA", "Detecta intencao, sentimento e urgencia.", 320, 120),
                    node("task_from_whatsapp", "action", "check-square", "Criar tarefa", "Transforma demanda em card no Kanban.", 580, 120),
                    node("notify_team_whatsapp", "action", "users", "Notificar equipe", "Envia resumo no chat interno.", 840, 120),
                ]
            ),
        },
        {
            "name": "Nova tarefa criada",
            "description": "Registra tarefas novas no relatorio operacional e envia uma mensagem ao time.",
            "icon": "check-square",
            "category": "Tarefas",
            "trigger": "Tarefas",
            "actions": ["Adicionar ao relatorio", "Enviar mensagem no Chat da Equipe"],
            "aiEnabled": False,
            "savedMinutesPerRun": 6,
            "flow": flow_from_steps(
                [
                    node("task_created", "trigger", "check-square", "Nova tarefa criada", "Detecta novos cards no projeto ativo.", 60, 120),
                    node("report_task", "action", "bar-chart-3", "Adicionar ao relatorio", "Atualiza volume, status e produtividade.", 360, 120),
                    node("team_chat_task", "action", "messages-square", "Chat da Equipe", "Publica o resumo para os membros.", 660, 120),
                ]
            ),
        },
        {
            "name": "Novo gasto registrado",
            "description": "Atualiza os indicadores financeiros e gera um resumo pronto para o relatorio.",
            "icon": "credit-card",
            "category": "Gastos",
            "trigger": "Gastos",
            "actions": ["Atualizar relatorio", "Gerar resumo financeiro"],
            "aiEnabled": True,
            "savedMinutesPerRun": 9,
            "flow": flow_from_steps(
                [
                    node("expense_created", "trigger", "credit-card", "Novo gasto registrado", "Gatilho ao criar lancamento financeiro.", 60, 120),
                    node("finance_report", "action", "receipt", "Atualizar relatorio", "Recalcula saldo, pendencias e categorias.", 360, 120),
                    node("nora_finance", "nora", "sparkles", "Nora IA", "Gera resumo financeiro em linguagem simples.", 660, 120),
                ]
            ),
        },
        {
            "name": "Novo evento na Agenda",
            "description": "Cria checklist antes do compromisso e notifica a equipe sobre o proximo passo.",
            "icon": "calendar-days",
            "category": "Agenda",
            "trigger": "Agenda",
            "actions": ["Criar checklist", "Notificar equipe"],
            "aiEnabled": True,
            "savedMinutesPerRun": 8,
            "flow": flow_from_steps(
                [
                    node("calendar_event", "trigger", "calendar-days", "Novo evento na Agenda", "Detecta compromissos criados ou sincronizados.", 60, 120),
                    node("meeting_checklist", "nora", "sparkles", "Criar checklist", "Nora prepara pauta, materiais e pendencias.", 360, 120),
                    node("notify_team_calendar", "action", "users", "Notificar equipe", "Avisa data, hora e contexto no chat interno.", 660, 120),
                ]
            ),
        },
    ]

    automations: list[dict[str, Any]] = []
    for index, item in enumerate(examples, start=1):
        automation = {
            "id": f"auto_padrao_{index}",
            "status": "ativa",
            "active": True,
            "favorite": index in {1, 2},
            "lastRunAt": None,
            "executions": 0,
            "savedMinutes": 0,
            "createdAt": created,
            "updatedAt": created,
            "version": 1,
            "environment": "producao",
            "versions": [],
            "variables": {},
            "schedule": "",
            "logs": [],
            **item,
        }
        automations.append(automation)
    return automations


TEMPLATES = [
    {"id": "tpl_email_task", "title": "E-mail -> Criar tarefa", "description": "Converte e-mails importantes em tarefas priorizadas.", "icon": "mail"},
    {"id": "tpl_whatsapp_ai", "title": "WhatsApp -> Responder com IA", "description": "Sugere ou envia uma resposta com o tom da Nora.", "icon": "message-square"},
    {"id": "tpl_whatsapp_task", "title": "WhatsApp -> Criar tarefa", "description": "Transforma pedidos do WhatsApp em cards.", "icon": "check-square"},
    {"id": "tpl_agenda_team", "title": "Agenda -> Avisar equipe", "description": "Notifica o time antes de reunioes e compromissos.", "icon": "calendar-days"},
    {"id": "tpl_finance_report", "title": "Novo gasto -> Atualizar relatorio", "description": "Atualiza indicadores financeiros automaticamente.", "icon": "credit-card"},
    {"id": "tpl_weekly_report", "title": "Relatorio semanal automatico", "description": "Gera resumo semanal de produtividade.", "icon": "bar-chart-3"},
    {"id": "tpl_ai_reply", "title": "Resposta automatica IA", "description": "Nora classifica contexto e prepara respostas.", "icon": "sparkles"},
    {"id": "tpl_email_summary", "title": "Resumir e-mails", "description": "Resume mensagens longas e destaca proximas acoes.", "icon": "file-text"},
    {"id": "tpl_meeting_checklist", "title": "Checklist para reuniao", "description": "Cria checklist antes de cada evento de agenda.", "icon": "list-checks"},
]


INTEGRATIONS = [
    "WhatsApp",
    "Chat da Equipe",
    "Gmail",
    "Google Agenda",
    "Tarefas",
    "Gastos",
    "Relatorios",
]


def empty_store() -> dict[str, Any]:
    return {"automations": default_automations(), "history": [], "updatedAt": now_iso()}


def normalize_store(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return empty_store()
    automations = raw.get("automations")
    if not isinstance(automations, list) or not automations:
        automations = default_automations()
    for automation in automations:
        if not isinstance(automation, dict):
            continue
        automation.setdefault("environment", "producao")
        if not isinstance(automation.get("versions"), list) or not automation.get("versions"):
            automation["versions"] = [automation_snapshot(automation, "Versao importada do fluxo existente")]
    history = raw.get("history") if isinstance(raw.get("history"), list) else []
    return {"automations": automations, "history": history, "updatedAt": raw.get("updatedAt") or now_iso()}


def read_store(user_id: str) -> dict[str, Any]:
    store = normalize_store(read_user_db(user_id, "automacoes", {}))
    if not read_user_db(user_id, "automacoes", {}):
        write_store(user_id, store)
    return store


def write_store(user_id: str, store: dict[str, Any]) -> None:
    store["updatedAt"] = now_iso()
    write_user_db(user_id, "automacoes", store)


def metrics(store: dict[str, Any]) -> dict[str, Any]:
    automations = store.get("automations", [])
    today = datetime.now(timezone.utc).date().isoformat()
    today_runs = [
        item
        for item in store.get("history", [])
        if str(item.get("timestamp", "")).startswith(today)
    ]
    total_saved = sum(int(item.get("savedMinutes") or 0) for item in automations)
    return {
        "total": len(automations),
        "active": len([item for item in automations if item.get("active")]),
        "runsToday": len(today_runs),
        "savedMinutes": total_saved,
    }


def response_payload(store: dict[str, Any]) -> dict[str, Any]:
    ordered = sorted(store.get("automations", []), key=lambda item: (not bool(item.get("favorite")), str(item.get("name", ""))))
    history = sorted(store.get("history", []), key=lambda item: str(item.get("timestamp", "")), reverse=True)
    return {
        "automations": ordered,
        "history": history[:80],
        "templates": TEMPLATES,
        "integrations": [{"name": name, "status": "Conectado"} for name in INTEGRATIONS],
        "metrics": metrics(store),
        "updatedAt": store.get("updatedAt"),
    }


def find_automation(store: dict[str, Any], automation_id: str) -> dict[str, Any] | None:
    return next((item for item in store.get("automations", []) if str(item.get("id")) == automation_id), None)


def find_automation_by_text(store: dict[str, Any], text: str) -> dict[str, Any] | None:
    normalized = normalize_text(text)
    automations = store.get("automations", [])
    for automation in automations:
        name = normalize_text(str(automation.get("name") or ""))
        if name and name in normalized:
            return automation
    words = [word for word in re.split(r"\W+", normalized) if len(word) >= 4]
    best = None
    best_score = 0
    for automation in automations:
        haystack = normalize_text(f"{automation.get('name', '')} {automation.get('description', '')} {automation.get('trigger', '')}")
        score = sum(1 for word in words if word in haystack)
        if score > best_score:
            best = automation
            best_score = score
    return best if best_score > 0 else None


def automation_from_payload(payload: AutomationPayload) -> dict[str, Any]:
    created = now_iso()
    flow = payload.flow.model_dump() if payload.flow else build_flow_from_payload(payload)
    automation = {
        "id": slug_id(),
        "name": payload.name,
        "description": payload.description,
        "icon": payload.icon,
        "category": payload.category,
        "trigger": payload.trigger,
        "actions": payload.actions,
        "status": "ativa" if payload.active else "desativada",
        "active": payload.active,
        "aiEnabled": payload.aiEnabled,
        "favorite": payload.favorite,
        "savedMinutesPerRun": payload.savedMinutesPerRun,
        "savedMinutes": 0,
        "executions": 0,
        "lastRunAt": None,
        "createdAt": created,
        "updatedAt": created,
        "version": 1,
        "environment": payload.environment,
        "versions": [],
        "variables": payload.variables,
        "schedule": payload.schedule,
        "retryPolicy": payload.retryPolicy,
        "failureAction": payload.failureAction,
        "requiresApproval": payload.requiresApproval,
        "flow": flow,
        "logs": [],
    }
    automation["versions"] = [automation_snapshot(automation, "Versao inicial")]
    return automation


def automation_snapshot(automation: dict[str, Any], note: str = "") -> dict[str, Any]:
    content = {
        key: copy.deepcopy(value)
        for key, value in automation.items()
        if key not in {"versions", "logs", "executions", "savedMinutes", "lastRunAt"}
    }
    return {
        "id": slug_id("version"),
        "version": int(automation.get("version") or 1),
        "environment": str(automation.get("environment") or "rascunho"),
        "createdAt": now_iso(),
        "note": note,
        "content": content,
    }


def append_automation_snapshot(automation: dict[str, Any], note: str) -> None:
    versions = automation.setdefault("versions", [])
    if not isinstance(versions, list):
        versions = []
        automation["versions"] = versions
    versions.insert(0, automation_snapshot(automation, note))
    automation["versions"] = versions[:30]


def build_flow_from_payload(payload: AutomationPayload) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = [
        node("trigger", "trigger", payload.icon or "zap", payload.trigger or "Manual", f"Gatilho: {payload.trigger or 'Manual'}.", 60, 120)
    ]
    x = 320
    for index, action in enumerate(payload.actions or ["Executar acao"]):
        kind: StepKind = "nora" if "nora" in normalize_text(action) or "ia" in normalize_text(action) else "action"
        icon = "sparkles" if kind == "nora" else "zap"
        nodes.append(node(f"action_{index + 1}", kind, icon, action, f"Acao automatizada: {action}.", x, 120))
        x += 260
    return flow_from_steps(nodes)


def automation_text(automation: dict[str, Any]) -> str:
    return normalize_text(
        " ".join(
            [
                str(automation.get("name") or ""),
                str(automation.get("description") or ""),
                str(automation.get("trigger") or ""),
                str(automation.get("category") or ""),
                " ".join(str(action) for action in automation.get("actions", [])),
            ]
        )
    )


def classify_email_category(message: dict[str, Any]) -> str:
    labels = {str(label).upper() for label in message.get("labels", [])}
    haystack = normalize_text(
        f"{message.get('fromName', '')} {message.get('fromEmail', '')} {message.get('subject', '')} {message.get('snippet', '')}"
    )
    if "CATEGORY_PROMOTIONS" in labels or any(term in haystack for term in ("promocao", "promocoes", "oferta", "desconto", "cupom", "black friday")):
        return "promocoes"
    if "CATEGORY_SOCIAL" in labels or any(term in haystack for term in ("linkedin", "facebook", "instagram", "rede social")):
        return "social"
    if "CATEGORY_UPDATES" in labels or any(term in haystack for term in ("atualizacao", "notificacao", "alerta", "recibo", "boleto", "fatura", "pagamento", "nubank", "banco")):
        return "financeiro" if any(term in haystack for term in ("recibo", "boleto", "fatura", "pagamento", "nubank", "banco")) else "atualizacoes"
    if any(term in haystack for term in ("proposta", "cliente", "reuniao", "contrato", "orçamento", "orcamento", "comercial", "trabalho")):
        return "trabalho"
    if any(term in haystack for term in ("suporte", "ticket", "erro", "chamado", "atendimento")):
        return "suporte"
    return "principal"


async def apply_automation_effects(user_id: str, automation: dict[str, Any]) -> list[str]:
    text = automation_text(automation)
    variables = automation.get("variables") if isinstance(automation.get("variables"), dict) else {}
    effects: list[str] = []

    flow = automation.get("flow") if isinstance(automation.get("flow"), dict) else {}
    flow_nodes = flow.get("nodes") if isinstance(flow.get("nodes"), list) else []
    browser_node = next(
        (
            item for item in flow_nodes
            if isinstance(item, dict) and "navegador" in normalize_text(item.get("title", ""))
        ),
        None,
    )
    if browser_node:
        from app.modules.intelligence.browser_runtime import queue_browser_run
        from app.modules.intelligence.service import create_browser_plan

        node_config = browser_node.get("config") if isinstance(browser_node.get("config"), dict) else {}
        target_url = str(node_config.get("targetUrl") or variables.get("targetUrl") or "").strip()
        objective = str(
            node_config.get("objective")
            or variables.get("browserObjective")
            or automation.get("description")
            or "Ler e resumir a pagina publica"
        )
        if not target_url:
            raise RuntimeError("Configure a URL publica no bloco do Agente Navegador antes de executar.")
        synthetic_user = {"id": user_id}
        raw_actions = str(node_config.get("actionsJson") or "").strip()
        actions: list[dict[str, Any]] = []
        if raw_actions:
            try:
                parsed_actions = json.loads(raw_actions)
                actions = parsed_actions if isinstance(parsed_actions, list) else []
            except json.JSONDecodeError as exc:
                raise RuntimeError("O plano JSON do no Agente Navegador e invalido.") from exc
        run = await create_browser_plan(
            synthetic_user,
            {
                "objective": objective, "startUrl": target_url,
                "profileId": node_config.get("profileId") or None,
                "executionMode": node_config.get("executionMode") or "automatic",
                "expectedResult": node_config.get("expectedResult") or "structured",
                "maxPages": min(20, max(1, int(node_config.get("maxPages") or 10))),
                "maxSteps": min(40, max(1, int(node_config.get("maxSteps") or 20))),
                "timeoutSeconds": min(900, max(30, int(node_config.get("timeoutSeconds") or 300))),
                "actions": actions, "useAiPlanner": not bool(actions),
            },
            source="automation",
        )
        await queue_browser_run(synthetic_user, str(run["id"]))
        effects.append(f'Agente Navegador iniciou a execucao real {run["id"]}; resultados e aprovacoes ficam na tela Navegador.')

    model_node = next(
        (
            item for item in flow_nodes
            if isinstance(item, dict) and "roteamento" in normalize_text(item.get("title", "")) and "ia" in normalize_text(item.get("title", ""))
        ),
        None,
    )
    if model_node:
        from app.modules.intelligence.service import complete_with_provider, route_model

        node_config = model_node.get("config") if isinstance(model_node.get("config"), dict) else {}
        routing = route_model(
            {"id": user_id},
            {
                "policyId": node_config.get("policyId") or None,
                "preferredProviderId": node_config.get("providerId") or None,
                "requiredCapabilities": ["text"],
                "estimatedInputTokens": 1000,
                "estimatedOutputTokens": 500,
                "privacy": node_config.get("privacy") or "any",
                "externalActionCommitted": False,
            },
        )
        selected = routing.get("selected")
        if not selected:
            raise RuntimeError("Nenhum modelo configurado atende a politica deste bloco.")
        prompt = str(
            node_config.get("prompt")
            or model_node.get("description")
            or automation.get("description")
            or "Resuma o contexto desta automacao."
        )
        answer, usage = await complete_with_provider(
            {"id": user_id},
            str(selected.get("id")),
            [{"role": "user", "content": prompt}],
            "Voce executa um bloco de automacao do Norium. Responda somente com o resultado solicitado, sem inventar dados externos.",
        )
        automation.setdefault("variables", {})["lastModelOutput"] = answer[:4000]
        effects.append(
            f'IA executada por {selected.get("name")} / {selected.get("model")}; '
            f'{int(usage.get("usage", {}).get("outputTokens") or 0)} token(s) de saida registrados.'
        )

    if "criar tarefa" in text or "tarefa" in text and "criar" in text:
        project_id = str(variables.get("taskProjectId") or "default")
        project_name = str(variables.get("taskProjectName") or project_id or "Operacao Norium")
        task_category = str(variables.get("taskCategory") or "geral")
        task = create_task(
            user_id,
            {
                "projectId": project_id,
                "title": f"[Automacao] {automation.get('name') or 'Nova acao'}",
                "description": automation.get("description") or "Tarefa criada automaticamente por fluxo do Norium.",
                "category": task_category,
                "priority": "media",
                "labels": ["automacao", task_category],
                "status": "pendente",
                "authorName": "Nora",
            },
        )
        effects.append(f'Tarefa "{task.get("title")}" criada no projeto "{project_name}".')
        await record_event(
            source="kanban",
            title=f"Tarefa criada por automacao em {project_name}",
            description=f'"{task.get("title")}" foi criada pela automacao "{automation.get("name")}".',
            metadata={
                "action": "automation_task_created",
                "userId": user_id,
                "automationId": automation.get("id"),
                "taskId": task.get("id"),
                "projectId": project_id,
                "projectName": project_name,
                "category": task_category,
            },
        )
        await append_team_message_for_user(
            user_id,
            "\n".join(
                [
                    "Nora executou uma automacao",
                    f"Automacao: {automation.get('name') or 'Fluxo sem nome'}",
                    f"Tarefa criada: {task.get('title')}",
                    f"Projeto: {project_name}",
                ]
            ),
            metadata={
                "action": "automation_task_created",
                "automationId": automation.get("id"),
                "automationName": automation.get("name") or "Fluxo sem nome",
                "taskId": task.get("id"),
                "taskTitle": task.get("title"),
                "projectId": project_id,
                "projectName": project_name,
                "summary": {
                    "automationName": automation.get("name") or "Fluxo sem nome",
                    "taskTitle": task.get("title"),
                    "projectName": project_name,
                    "changes": ["Tarefa criada automaticamente pelo fluxo."],
                    "state": {
                        "Status": "pendente",
                        "Prioridade": "media",
                        "Categoria": task_category,
                        "Responsavel": "Nora",
                        "Vencimento": "sem vencimento",
                        "Etiquetas": f"automacao, {task_category}",
                    },
                },
            },
        )

    if "agrupar e-mails" in text or "agrupar emails" in text or "categoria" in text and ("email" in text or "e-mail" in text):
        try:
            data = GmailService(user_id).list_messages(folder="inbox", max_results=20)
            messages = data.get("messages", [])
            groups: dict[str, list[dict[str, str]]] = {}
            target_category = str(variables.get("emailCategory") or "auto")
            for message in messages:
                category = classify_email_category(message)
                if target_category != "auto" and category != target_category:
                    continue
                groups.setdefault(category, []).append(
                    {
                        "id": str(message.get("id") or ""),
                        "from": str(message.get("fromName") or message.get("fromEmail") or ""),
                        "subject": str(message.get("subject") or "(sem assunto)"),
                    }
                )
            summary = ", ".join(f"{category}: {len(items)}" for category, items in sorted(groups.items())) or "nenhum e-mail encontrado"
            automation.setdefault("variables", {})["lastEmailGrouping"] = groups
            automation.setdefault("variables", {})["lastEmailGroupingSummary"] = summary
            effects.append(f"Gmail agrupado por categoria: {summary}.")
            await record_event(
                source="gmail",
                title="E-mails agrupados por categoria",
                description=summary,
                metadata={
                    "action": "automation_email_grouped",
                    "userId": user_id,
                    "automationId": automation.get("id"),
                    "groups": groups,
                    "targetCategory": target_category,
                },
            )
        except GmailConfigError:
            effects.append("Gmail nao conectado; agrupamento de e-mails ficou pendente.")
        except Exception as exc:
            effects.append(f"Falha ao agrupar e-mails: {str(exc)}")

    if "notificar equipe" in text or "chat interno" in text or "avisar equipe" in text or "mensagem ao time" in text:
        message = (
            f'Nora: automacao "{automation.get("name")}" executada. '
            f'Gatilho: {automation.get("trigger") or "manual"}. '
            f'Acoes: {", ".join(str(action) for action in automation.get("actions", [])[:4]) or "sem acoes registradas"}.'
        )
        await append_team_message_for_user(
            user_id,
            message,
            metadata={"action": "automation_team_notification", "automationId": automation.get("id")},
        )
        effects.append("Equipe notificada no chat interno.")

    return effects


def execution_steps(automation: dict[str, Any]) -> list[dict[str, Any]]:
    flow = automation.get("flow") if isinstance(automation.get("flow"), dict) else {}
    nodes = flow.get("nodes") if isinstance(flow.get("nodes"), list) else []
    return [
        {
            "id": str(item.get("id") or f"step_{index}"),
            "title": str(item.get("title") or "Etapa"),
            "kind": str(item.get("kind") or "action"),
            "status": "pendente",
            "attempt": 0,
            "startedAt": None,
            "finishedAt": None,
            "error": None,
        }
        for index, item in enumerate(nodes)
        if isinstance(item, dict)
    ]


async def simulate_automation(user_id: str, automation_id: str, executed_by: str = "Operador") -> dict[str, Any]:
    store = read_store(user_id)
    automation = find_automation(store, automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    timestamp = now_iso()
    steps = execution_steps(automation)
    variables = automation.get("variables") if isinstance(automation.get("variables"), dict) else {}
    preview = [
        {
            **step,
            "status": "simulado",
            "attempt": 1,
            "startedAt": timestamp,
            "finishedAt": timestamp,
            "preview": (
                "Gatilho validado sem consumir dados reais."
                if step.get("kind") == "trigger"
                else f'Executaria "{step.get("title")}" com {len(variables)} variavel(is) configurada(s).'
            ),
        }
        for step in steps
    ]
    log = {
        "id": slug_id("log"),
        "automationId": automation_id,
        "automationName": automation.get("name"),
        "timestamp": timestamp,
        "status": "simulado",
        "durationMs": 0,
        "result": "Simulacao concluida. Nenhuma mensagem foi enviada e nenhum dado real foi alterado.",
        "executedBy": executed_by,
        "savedMinutes": 0,
        "attempt": 1,
        "input": {"trigger": automation.get("trigger"), "variables": variables},
        "steps": preview,
        "sideEffects": False,
    }
    store.setdefault("history", []).insert(0, log)
    automation.setdefault("logs", []).insert(0, log)
    automation["logs"] = automation["logs"][:50]
    store["history"] = store["history"][:250]
    write_store(user_id, store)
    return {"automation": automation, "historyItem": log, "metrics": metrics(store)}


async def execute_automation(user_id: str, automation_id: str, executed_by: str = "Operador") -> dict[str, Any]:
    store = read_store(user_id)
    automation = find_automation(store, automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    if not automation.get("active"):
        raise HTTPException(status_code=400, detail="Automacao desativada. Ative antes de executar.")

    timestamp = now_iso()
    saved = int(automation.get("savedMinutesPerRun") or 8)
    automation["executions"] = int(automation.get("executions") or 0) + 1
    automation["lastRunAt"] = timestamp
    automation["updatedAt"] = timestamp
    automation["version"] = int(automation.get("version") or 1)

    steps = execution_steps(automation)
    started_at = datetime.now(timezone.utc)
    for step in steps:
        step["attempt"] = 1
        step["startedAt"] = now_iso()
        step["status"] = "executando"
    effects: list[str] = []
    failure: Exception | None = None
    try:
        effects = await apply_automation_effects(user_id, automation)
    except Exception as exc:
        failure = exc
    finished_at = datetime.now(timezone.utc)
    for index, step in enumerate(steps):
        step["finishedAt"] = finished_at.isoformat()
        if failure is not None and index == len(steps) - 1:
            step["status"] = "erro"
            step["error"] = str(failure)
        else:
            step["status"] = "sucesso"
    status: RunStatus = "erro" if failure else "sucesso"
    if failure is None:
        automation["savedMinutes"] = int(automation.get("savedMinutes") or 0) + saved
    result = (
        f"Falha ao executar {automation.get('name')}: {failure}"
        if failure
        else f"{automation.get('name')} executada com sucesso. Nora economizou cerca de {saved} min nesta execucao."
    )
    if effects:
        result = f"{result} " + " ".join(effects)
    log = {
        "id": slug_id("log"),
        "automationId": automation["id"],
        "automationName": automation.get("name"),
        "timestamp": timestamp,
        "status": status,
        "durationMs": max(1, int((finished_at - started_at).total_seconds() * 1000)),
        "result": result,
        "executedBy": executed_by,
        "savedMinutes": 0 if failure else saved,
        "attempt": 1,
        "input": {
            "trigger": automation.get("trigger"),
            "variables": automation.get("variables") if isinstance(automation.get("variables"), dict) else {},
        },
        "steps": steps,
        "error": str(failure) if failure else None,
        "sideEffects": True,
    }
    store.setdefault("history", []).insert(0, log)
    automation.setdefault("logs", []).insert(0, log)
    automation["logs"] = automation["logs"][:20]
    store["history"] = store["history"][:120]
    write_store(user_id, store)

    await record_event(
        source="automacoes",
        title=f"Automacao {'com erro' if failure else 'executada'}: {automation.get('name')}",
        description=result,
        metadata={
            "action": "automation_failed" if failure else "automation_executed",
            "userId": user_id,
            "automationId": automation.get("id"),
            "logId": log["id"],
            "status": status,
        },
    )
    return {"automation": automation, "historyItem": log, "metrics": metrics(store)}


@router.get("")
async def listar_automacoes(user: dict[str, Any] = Depends(current_user)):
    return response_payload(read_store(tenant_id(user)))


@router.post("")
async def criar_automacao(payload: AutomationPayload, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    store = read_store(user_id)
    automation = automation_from_payload(payload)
    store.setdefault("automations", []).insert(0, automation)
    write_store(user_id, store)
    await record_event(
        source="automacoes",
        title=f"Automacao criada: {automation.get('name')}",
        description=f"A automacao '{automation.get('name')}' foi criada com gatilho {automation.get('trigger')}.",
        metadata={"action": "automation_created", "userId": user_id, "automationId": automation.get("id")},
    )
    return response_payload(store)


@router.patch("/{automation_id}")
async def atualizar_automacao(automation_id: str, payload: AutomationUpdatePayload, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    store = read_store(user_id)
    automation = find_automation(store, automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")

    updates = payload.model_dump(exclude_unset=True)
    previous_active = bool(automation.get("active"))
    if "flow" in updates and updates["flow"] is not None:
        updates["flow"] = payload.flow.model_dump() if payload.flow else None
    for key, value in updates.items():
        if value is not None:
            automation[key] = value
    if "active" in updates:
        automation["status"] = "ativa" if automation.get("active") else "desativada"
    if "status" in updates:
        automation["active"] = automation.get("status") == "ativa"
    automation["updatedAt"] = now_iso()
    automation["version"] = int(automation.get("version") or 1) + 1
    append_automation_snapshot(automation, f"Atualizacao: {', '.join(updates.keys()) or 'sem campos'}")
    write_store(user_id, store)
    current_active = bool(automation.get("active"))
    if "active" in updates or "status" in updates:
        event_title = f"Automacao {'ativada' if current_active else 'desativada'}: {automation.get('name')}"
        action = "automation_enabled" if current_active else "automation_disabled"
        event_description = f"A automacao mudou de {'ativa' if previous_active else 'desativada'} para {'ativa' if current_active else 'desativada'}."
    else:
        event_title = f"Automacao atualizada: {automation.get('name')}"
        action = "automation_updated"
        event_description = f"Campos alterados: {', '.join(updates.keys()) or 'nenhum'}."
    await record_event(
        source="automacoes",
        title=event_title,
        description=event_description,
        metadata={
            "action": action,
            "userId": user_id,
            "automationId": automation.get("id"),
            "updates": list(updates.keys()),
            "active": current_active,
        },
    )
    return response_payload(store)


@router.delete("/{automation_id}")
async def apagar_automacao(automation_id: str, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    store = read_store(user_id)
    removed = find_automation(store, automation_id)
    before = len(store.get("automations", []))
    store["automations"] = [item for item in store.get("automations", []) if str(item.get("id")) != automation_id]
    if len(store["automations"]) == before:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    write_store(user_id, store)
    await record_event(
        source="automacoes",
        title=f"Automacao excluida: {(removed or {}).get('name') or automation_id}",
        description=f"A automacao {(removed or {}).get('name') or automation_id} foi removida da lista de fluxos.",
        metadata={"action": "automation_deleted", "userId": user_id, "automationId": automation_id},
    )
    return response_payload(store)


@router.post("/{automation_id}/executar")
async def executar_automacao(automation_id: str, user: dict[str, Any] = Depends(current_user)):
    result = await execute_automation(tenant_id(user), automation_id, str(user.get("nome") or user.get("email") or "Operador"))
    store = read_store(tenant_id(user))
    return {**response_payload(store), "lastExecution": result}


@router.post("/{automation_id}/simular")
async def simular_automacao(automation_id: str, user: dict[str, Any] = Depends(current_user)):
    result = await simulate_automation(
        tenant_id(user),
        automation_id,
        str(user.get("nome") or user.get("email") or "Operador"),
    )
    store = read_store(tenant_id(user))
    return {**response_payload(store), "lastExecution": result}


@router.post("/{automation_id}/reexecutar/{log_id}")
async def reexecutar_automacao(
    automation_id: str,
    log_id: str,
    user: dict[str, Any] = Depends(current_user),
):
    user_id = tenant_id(user)
    store = read_store(user_id)
    previous = next(
        (
            item
            for item in store.get("history", [])
            if str(item.get("id") or "") == log_id
            and str(item.get("automationId") or "") == automation_id
        ),
        None,
    )
    if previous is None:
        raise HTTPException(status_code=404, detail="Execucao nao encontrada.")
    if previous.get("status") != "erro":
        raise HTTPException(status_code=409, detail="Somente execucoes com erro podem ser retomadas.")
    failed_step = next(
        (item for item in previous.get("steps", []) if isinstance(item, dict) and item.get("status") == "erro"),
        None,
    )
    result = await execute_automation(
        user_id,
        automation_id,
        str(user.get("nome") or user.get("email") or "Operador"),
    )
    result["historyItem"]["resumedFromLogId"] = log_id
    result["historyItem"]["resumedFromStepId"] = (failed_step or {}).get("id")
    refreshed = read_store(user_id)
    current_log = next(
        (item for item in refreshed.get("history", []) if item.get("id") == result["historyItem"]["id"]),
        None,
    )
    if current_log is not None:
        current_log.update(
            {
                "resumedFromLogId": log_id,
                "resumedFromStepId": (failed_step or {}).get("id"),
            }
        )
        write_store(user_id, refreshed)
    return {**response_payload(read_store(user_id)), "lastExecution": result}


@router.post("/{automation_id}/duplicar")
async def duplicar_automacao(automation_id: str, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    store = read_store(user_id)
    automation = find_automation(store, automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    clone = copy.deepcopy(automation)
    clone["id"] = slug_id()
    clone["name"] = f"{automation.get('name')} (copia)"
    clone["executions"] = 0
    clone["savedMinutes"] = 0
    clone["lastRunAt"] = None
    clone["favorite"] = False
    clone["createdAt"] = now_iso()
    clone["updatedAt"] = clone["createdAt"]
    clone["version"] = 1
    clone["environment"] = "rascunho"
    clone["versions"] = []
    clone["logs"] = []
    clone["versions"] = [automation_snapshot(clone, f"Criada a partir de {automation.get('name')}")]
    store.setdefault("automations", []).insert(0, clone)
    write_store(user_id, store)
    await record_event(
        source="automacoes",
        title=f"Automacao duplicada: {clone.get('name')}",
        description=f"Uma copia de {automation.get('name')} foi criada para edicao.",
        metadata={"action": "automation_duplicated", "userId": user_id, "automationId": clone.get("id"), "originalAutomationId": automation_id},
    )
    return response_payload(store)


@router.get("/{automation_id}/versoes")
async def listar_versoes_automacao(automation_id: str, user: dict[str, Any] = Depends(current_user)):
    automation = find_automation(read_store(tenant_id(user)), automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    return {
        "automationId": automation_id,
        "currentVersion": int(automation.get("version") or 1),
        "environment": automation.get("environment") or "rascunho",
        "versions": automation.get("versions") if isinstance(automation.get("versions"), list) else [],
    }


@router.post("/{automation_id}/promover")
async def promover_automacao(
    automation_id: str,
    payload: AutomationPromotionPayload,
    user: dict[str, Any] = Depends(current_user),
):
    user_id = tenant_id(user)
    store = read_store(user_id)
    automation = find_automation(store, automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    previous = str(automation.get("environment") or "rascunho")
    automation["environment"] = payload.environment
    automation["updatedAt"] = now_iso()
    automation["version"] = int(automation.get("version") or 1) + 1
    append_automation_snapshot(
        automation,
        payload.note or f"Promovida de {previous} para {payload.environment}",
    )
    write_store(user_id, store)
    await record_event(
        source="automacoes",
        title=f"Automacao promovida para {payload.environment}",
        description=f'"{automation.get("name")}" passou de {previous} para {payload.environment}.',
        metadata={
            "action": "automation_promoted",
            "userId": user_id,
            "automationId": automation_id,
            "from": previous,
            "to": payload.environment,
            "version": automation["version"],
        },
    )
    return response_payload(store)


@router.post("/{automation_id}/restaurar/{version_id}")
async def restaurar_versao_automacao(
    automation_id: str,
    version_id: str,
    payload: AutomationRestorePayload,
    user: dict[str, Any] = Depends(current_user),
):
    user_id = tenant_id(user)
    store = read_store(user_id)
    automation = find_automation(store, automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    versions = automation.get("versions") if isinstance(automation.get("versions"), list) else []
    version = next((item for item in versions if str(item.get("id")) == version_id), None)
    if not version or not isinstance(version.get("content"), dict):
        raise HTTPException(status_code=404, detail="Versao da automacao nao encontrada.")

    preserved = {
        "id": automation.get("id"),
        "createdAt": automation.get("createdAt"),
        "logs": automation.get("logs", []),
        "executions": automation.get("executions", 0),
        "savedMinutes": automation.get("savedMinutes", 0),
        "lastRunAt": automation.get("lastRunAt"),
        "versions": versions,
    }
    automation.clear()
    automation.update(copy.deepcopy(version["content"]))
    automation.update(preserved)
    automation["version"] = max(
        int(item.get("version") or 1) for item in versions if isinstance(item, dict)
    ) + 1
    automation["updatedAt"] = now_iso()
    append_automation_snapshot(
        automation,
        payload.note or f"Restaurada a partir da versao {version.get('version')}",
    )
    write_store(user_id, store)
    await record_event(
        source="automacoes",
        title=f"Versao restaurada: {automation.get('name')}",
        description=f"A versao {version.get('version')} foi restaurada como versao {automation.get('version')}.",
        metadata={
            "action": "automation_version_restored",
            "userId": user_id,
            "automationId": automation_id,
            "restoredVersionId": version_id,
            "version": automation["version"],
        },
    )
    return response_payload(store)


@router.post("/importar")
async def importar_automacoes(payload: AutomationImportPayload, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    store = read_store(user_id)
    imported = []
    for item in payload.automations:
        if not isinstance(item, dict):
            continue
        safe_payload = AutomationPayload(
            name=str(item.get("name") or item.get("title") or "Automacao importada")[:160],
            description=str(item.get("description") or "")[:420],
            icon=str(item.get("icon") or "zap"),
            category=str(item.get("category") or "Operacional"),
            trigger=str(item.get("trigger") or "Manual"),
            actions=[str(action) for action in item.get("actions", []) if str(action).strip()] or ["Mostrar notificacao"],
            status="ativa" if item.get("active", item.get("status") == "ativa") else "desativada",
            active=bool(item.get("active", item.get("status") == "ativa")),
            aiEnabled=bool(item.get("aiEnabled", False)),
            favorite=bool(item.get("favorite", False)),
            savedMinutesPerRun=int(item.get("savedMinutesPerRun") or 8),
            flow=item.get("flow") if isinstance(item.get("flow"), dict) else None,
            variables=item.get("variables") if isinstance(item.get("variables"), dict) else {},
            schedule=str(item.get("schedule") or ""),
            retryPolicy=item.get("retryPolicy") if isinstance(item.get("retryPolicy"), dict) else {"enabled": True, "maxAttempts": 3, "delaySeconds": 30},
            failureAction=str(item.get("failureAction") or "notificar_operador"),
            requiresApproval=bool(item.get("requiresApproval", False)),
            environment=str(item.get("environment") or "rascunho"),
        )
        imported.append(automation_from_payload(safe_payload))
    store.setdefault("automations", [])[0:0] = imported
    write_store(user_id, store)
    await record_event(
        source="automacoes",
        title=f"{len(imported)} automacao(oes) importada(s)",
        description="Fluxos importados para a biblioteca de automacoes do Norium.",
        metadata={"action": "automation_imported", "userId": user_id, "count": len(imported)},
    )
    return {**response_payload(store), "imported": len(imported)}


@router.post("/agente/mensagem")
async def conversar_agente_automacoes(payload: AutomationAgentPayload, user: dict[str, Any] = Depends(current_user)):
    return await handle_automation_agent(tenant_id(user), payload.message, str(user.get("nome") or "Nora"))


async def handle_automation_agent(user_id: str, message: str, executed_by: str = "Nora") -> dict[str, Any]:
    normalized = normalize_text(message)
    store = read_store(user_id)

    if normalized.strip() in {"cancelar", "cancela", "deixa pra la", "deixe para la"}:
        AUTOMATION_AGENT_SESSIONS.pop(user_id, None)
        return {"status": "cancelado", "response": "Certo, cancelei a criacao da automacao."}

    management_request = any(
        term in normalized
        for term in ("listar", "mostre", "quais", "executar", "rode", "rodar", "disparar", "desativar", "pausar", "ativar", "reativar")
    )
    pending_request = AUTOMATION_AGENT_SESSIONS.get(user_id)
    if pending_request and not management_request:
        message = f"{pending_request}. Complemento do usuario: {message}"
        normalized = normalize_text(message)

    if any(term in normalized for term in ("listar", "mostre", "quais", "ver automacoes", "minhas automacoes", "resumo")):
        data = response_payload(store)
        active = data["metrics"]["active"]
        total = data["metrics"]["total"]
        names = ", ".join(item.get("name", "Automacao") for item in data["automations"][:5])
        return {
            "status": "consulta",
            "response": f"Voce tem {total} automacoes, {active} ativas. Principais: {names}.",
            "automacoes": data,
        }

    if any(term in normalized for term in ("executar", "rode", "rodar", "disparar", "iniciar")):
        automation = find_automation_by_text(store, message)
        if not automation:
            return {
                "status": "aguardando_automacao",
                "response": "Qual automacao voce quer executar? Posso rodar por exemplo: Novo e-mail recebido, Nova mensagem WhatsApp ou Novo gasto registrado.",
            }
        result = await execute_automation(user_id, str(automation.get("id")), executed_by)
        return {
            "status": "executada",
            "response": result["historyItem"]["result"],
            "automation": result["automation"],
            "historyItem": result["historyItem"],
        }

    if any(term in normalized for term in ("desativar", "pausar", "desligar", "inativar", "parar automacao")):
        automation = find_automation_by_text(store, message)
        if not automation:
            return {"status": "nao_encontrada", "response": "Nao encontrei qual automacao voce quer desativar."}
        automation["active"] = False
        automation["status"] = "desativada"
        automation["updatedAt"] = now_iso()
        automation["version"] = int(automation.get("version") or 1) + 1
        write_store(user_id, store)
        return {"status": "desativada", "response": f"Pronto, desativei a automacao {automation.get('name')}.", "automation": automation}

    if any(term in normalized for term in ("ativar", "ligar", "reativar")):
        automation = find_automation_by_text(store, message)
        if not automation:
            return {"status": "nao_encontrada", "response": "Nao encontrei qual automacao voce quer ativar."}
        automation["active"] = True
        automation["status"] = "ativa"
        automation["updatedAt"] = now_iso()
        automation["version"] = int(automation.get("version") or 1) + 1
        write_store(user_id, store)
        return {"status": "ativada", "response": f"Pronto, ativei a automacao {automation.get('name')}.", "automation": automation}

    if any(term in normalized for term in ("criar", "crie", "nova automacao", "automatizar", "automacao para")):
        bare_create = normalized.strip() in {
            "criar automacao",
            "crie automacao",
            "nova automacao",
            "criar uma automacao",
            "crie uma automacao",
        }
        has_trigger_hint = any(term in normalized for term in ("quando", "sempre que", "ao ", "todo dia", "semanal", "email", "gmail", "whatsapp", "agenda", "tarefa", "gasto", "boleto", "webhook"))
        has_action_hint = any(term in normalized for term in ("enviar", "avisar", "criar tarefa", "registrar", "resumir", "notificar", "classificar", "agrupar", "executar", "gerar"))
        if bare_create or not (has_trigger_hint and has_action_hint):
            AUTOMATION_AGENT_SESSIONS[user_id] = message[:1800]
            missing = []
            if not has_trigger_hint:
                missing.append("o gatilho que inicia o fluxo")
            if not has_action_hint:
                missing.append("as acoes que devem acontecer")
            missing_text = " e ".join(missing) or "os detalhes do fluxo"
            return {
                "status": "precisa_dados",
                "response": (
                    f"Vamos montar a automacao passo a passo. Agora me diga {missing_text}, em linguagem simples. "
                    "Voce pode informar projeto, tarefa, e-mail, gastos e periodicidade sem usar comandos prontos. "
                    "Exemplo: quando chegar e-mail de cliente, resumir com a Nora, criar tarefa no projeto Operacao Norium e avisar a equipe."
                ),
            }
        name = extract_name_from_message(message)
        payload = AutomationPayload(
            name=name,
            description=f"Automacao criada pela Nora a partir do pedido: {message[:240]}",
            icon=icon_for_message(normalized),
            category=category_for_message(normalized),
            trigger=trigger_for_message(normalized),
            actions=actions_for_message(normalized),
            aiEnabled=any(term in normalized for term in ("ia", "nora", "resum", "classific", "traduz", "responder")),
            savedMinutesPerRun=10,
        )
        automation = automation_from_payload(payload)
        store.setdefault("automations", []).insert(0, automation)
        write_store(user_id, store)
        AUTOMATION_AGENT_SESSIONS.pop(user_id, None)
        return {
            "status": "criada",
            "response": f"Criei a automacao {automation.get('name')} com gatilho {automation.get('trigger')} e {len(automation.get('actions', []))} acao(oes).",
            "automation": automation,
        }

    return {
        "status": "ajuda",
        "response": "Posso listar automacoes, criar uma nova, ativar/desativar ou executar uma automacao existente. Exemplo: 'Nora, execute a automacao Novo gasto registrado'.",
        "automacoes": response_payload(store),
    }


def extract_name_from_message(message: str) -> str:
    patterns = [
        r"chamada\s+(.+)",
        r"nome\s+(.+)",
        r"automacao\s+(.+)",
        r"automatizar\s+(.+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, message, flags=re.IGNORECASE)
        if match:
            value = re.split(r"\s+(?:que|para|quando|com)\s+", match.group(1), maxsplit=1, flags=re.IGNORECASE)[0]
            value = value.strip(" .,:;")
            if value:
                return value[:80]
    return "Automacao criada pela Nora"


def icon_for_message(normalized: str) -> str:
    if "email" in normalized or "e-mail" in normalized or "gmail" in normalized:
        return "mail"
    if "whatsapp" in normalized or "mensagem" in normalized:
        return "message-square"
    if "agenda" in normalized or "evento" in normalized:
        return "calendar-days"
    if "gasto" in normalized or "financeiro" in normalized or "boleto" in normalized:
        return "credit-card"
    if "tarefa" in normalized or "kanban" in normalized:
        return "check-square"
    return "zap"


def category_for_message(normalized: str) -> str:
    if "email" in normalized or "e-mail" in normalized or "gmail" in normalized:
        return "E-mail"
    if "whatsapp" in normalized:
        return "WhatsApp"
    if "agenda" in normalized or "evento" in normalized:
        return "Agenda"
    if "gasto" in normalized or "financeiro" in normalized:
        return "Gastos"
    if "tarefa" in normalized or "kanban" in normalized:
        return "Tarefas"
    return "Operacional"


def trigger_for_message(normalized: str) -> str:
    if "email" in normalized or "e-mail" in normalized or "gmail" in normalized:
        return "E-mail"
    if "whatsapp" in normalized or "mensagem" in normalized:
        return "WhatsApp"
    if "agenda" in normalized or "evento" in normalized:
        return "Agenda"
    if "gasto" in normalized or "financeiro" in normalized:
        return "Gastos"
    if "tarefa" in normalized or "kanban" in normalized:
        return "Tarefas"
    if "horario" in normalized or "todo dia" in normalized or "semanal" in normalized:
        return "Agendamento"
    return "Manual"


def actions_for_message(normalized: str) -> list[str]:
    actions: list[str] = []
    if any(term in normalized for term in ("ia", "nora", "resum", "classific", "traduz", "responder", "analisar")):
        actions.append("Executar IA")
    if "tarefa" in normalized or "kanban" in normalized:
        actions.append("Criar tarefa")
    has_email = any(term in normalized for term in ("email", "e-mail", "gmail"))
    if has_email and any(term in normalized for term in ("categoria", "categorizar", "agrupar", "separar", "classificar")):
        actions.append("Agrupar e-mails por categoria")
    if "whatsapp" in normalized:
        actions.append("Enviar WhatsApp")
    email_action = bool(
        re.search(r"\b(?:enviar|envie|mandar|mande|responder|responda)\b.{0,48}\b(?:e-?mail|gmail)\b", normalized)
        or re.search(r"\b(?:e-?mail|gmail)\b.{0,48}\b(?:enviar|envie|mandar|mande|responder|responda)\b", normalized)
    )
    if has_email and email_action:
        actions.append("Enviar e-mail")
    if "chat" in normalized or "equipe" in normalized or "time" in normalized:
        actions.append("Enviar mensagem no Chat")
    if "relatorio" in normalized:
        actions.append("Atualizar relatorio")
    if "gasto" in normalized or "financeiro" in normalized:
        actions.append("Registrar gasto")
    if not actions:
        actions.append("Mostrar notificacao")
    return list(dict.fromkeys(actions))
