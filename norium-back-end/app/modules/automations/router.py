"""Dominio de automacoes extraido para isolar fluxos, gatilhos e execucoes."""

from __future__ import annotations

import asyncio
import copy
import json
import re
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.core.identity import require_team_id, require_user_id
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


class EffectReconciliationPayload(StrictModel):
    outcome: Literal["completed", "no_effect"]
    note: str = Field(min_length=3, max_length=320)


class AutomationEffectBlocked(ValueError):
    """A verified precondition failed before the effect made any mutation."""


class AutomationEffectUncertain(RuntimeError):
    def __init__(self, effect_id: str):
        self.effect_id = effect_id
        super().__init__(f"O efeito {effect_id} precisa ser conciliado antes da retomada.")


def tenant_id(user: dict[str, Any]) -> str:
    return require_user_id(user)


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


def execution_variable_projects(log: dict[str, Any]) -> dict[str, list[dict[str, str]] | None]:
    inputs = log.get("input") or {}
    return variable_projects({"variables": inputs.get("variables") or {}, "logs": [log],
                              "variableTaskProjects": inputs.get("variableTaskProjects") or {}})


def execution_visibility(user_id: str) -> Callable[[dict[str, Any]], bool]:
    from app.services.task_activity import activity_visibility, is_task_activity
    activity_check = activity_visibility(user_id)

    def scoped_visible(metadata):
        if is_task_activity(metadata) and not (metadata.get("taskProjects") or metadata.get("taskProject")):
            return False
        return activity_check(metadata)

    def visible(log: dict[str, Any]) -> bool:
        if not scoped_visible(log):
            return False
        event = (log.get("input") or {}).get("event") or {}
        if not scoped_visible(event.get("metadata") or {}):
            return False
        for key, refs in execution_variable_projects(log).items():
            if key in ((log.get("input") or {}).get("variables") or {}) and (
                not isinstance(refs, list) or not activity_check({"taskProjects": refs})
            ):
                return False
        for effect_id, checkpoint in (log.get("effectCheckpoints") or {}).items():
            result = checkpoint.get("result") or {}
            if effect_id == "task:create" and checkpoint.get("status") != "retryable" and not result.get("taskProject"):
                # Older uncertain effects have no trustworthy destination scope.
                if not log.get("taskProjects"):
                    return False
            if not scoped_visible(result):
                return False
        return True

    return visible


RUNTIME_VARIABLES = {"noraMailWorkId", "lastModelOutput", "lastEmailGrouping", "lastEmailGroupingSummary"}


def retained_execution_projects(log: dict[str, Any], user_id: str) -> list[dict[str, str]]:
    """A retry keeps every authorized source retained by its original execution."""
    if not execution_visibility(user_id)(log):
        raise HTTPException(status_code=404, detail="Execucao nao encontrada.")
    references = []
    metadata_items = [log, ((log.get("input") or {}).get("event") or {}).get("metadata") or {}]
    metadata_items.extend((checkpoint.get("result") or {}) for checkpoint in (log.get("effectCheckpoints") or {}).values())
    for metadata in metadata_items:
        refs = metadata.get("taskProjects") or ([metadata["taskProject"]] if metadata.get("taskProject") else [])
        for ref in refs:
            if ref not in references:
                references.append(copy.deepcopy(ref))
    for key, refs in execution_variable_projects(log).items():
        if key in ((log.get("input") or {}).get("variables") or {}):
            for ref in refs:
                if ref not in references:
                    references.append(copy.deepcopy(ref))
    return references


def variable_projects(automation: dict[str, Any]) -> dict[str, list[dict[str, str]] | None]:
    """Recover old output provenance conservatively; never modify retained evidence."""
    scopes = copy.deepcopy(automation.get("variableTaskProjects") or {})
    variables = automation.get("variables") or {}
    from app.services.task_activity import is_task_activity
    for key, value in variables.items():
        if key in scopes:
            continue
        matches = []
        for log in automation.get("logs") or []:
            for checkpoint in (log.get("effectCheckpoints") or {}).values():
                updates = (checkpoint.get("result") or {}).get("variableUpdates") or {}
                if key in updates and updates[key] == value:
                    matches.append(log)
        if not matches:
            if key in RUNTIME_VARIABLES:
                scopes[key] = None
            continue
        references = []
        uncertain = False
        for log in matches:
            metadata = (log.get("input") or {}).get("event") or {}
            metadata = metadata.get("metadata") or {}
            scoped = log if is_task_activity(log) else metadata
            if is_task_activity(scoped):
                refs = scoped.get("taskProjects") or ([scoped["taskProject"]] if scoped.get("taskProject") else None)
                if not isinstance(refs, list) or not refs:
                    uncertain = True
                    break
                for ref in refs:
                    if ref not in references:
                        references.append(ref)
            if any(effect_id == "task:create" and checkpoint.get("status") != "retryable"
                   for effect_id, checkpoint in (log.get("effectCheckpoints") or {}).items()) and not log.get("taskProjects"):
                uncertain = True
                break
        scopes[key] = None if uncertain else references
    return scopes


def authorized_variable_projects(automation: dict[str, Any], user_id: str) -> list[dict[str, str]]:
    from app.services.task_activity import activity_visibility
    visible = activity_visibility(user_id)
    references = []
    for key, refs in variable_projects(automation).items():
        if key not in (automation.get("variables") or {}):
            continue
        if not isinstance(refs, list) or not visible({"taskProjects": refs}):
            raise HTTPException(status_code=403, detail="Variavel gerada sem acesso atual verificavel; execucao bloqueada.")
        for ref in refs:
            if ref not in references:
                references.append(ref)
    return references


def configuration_variables(automation: dict[str, Any]) -> dict[str, Any]:
    outputs = RUNTIME_VARIABLES | set(variable_projects(automation))
    return {key: copy.deepcopy(value) for key, value in (automation.get("variables") or {}).items() if key not in outputs}


def public_versions(automation: dict[str, Any]) -> list[dict[str, Any]]:
    versions = []
    outputs = RUNTIME_VARIABLES | set(variable_projects(automation))
    for version in automation.get("versions") or []:
        item = copy.deepcopy(version)
        content = item.get("content") or {}
        content.pop("variableTaskProjects", None)
        content["variables"] = {key: value for key, value in configuration_variables(content).items() if key not in outputs}
        item["content"] = content
        versions.append(item)
    return versions


def public_execution(log: dict[str, Any], user_id: str) -> dict[str, Any]:
    from app.services.task_activity import activity_visibility
    visible = activity_visibility(user_id)
    payload = copy.deepcopy(log)
    inputs = payload.setdefault("input", {})
    variables = inputs.get("variables") or {}
    # Provenance belongs to the historical value, never to a newer automation
    # output. Legacy values require evidence from this execution's checkpoints.
    scopes = execution_variable_projects(log)
    inputs.pop("variableTaskProjects", None)
    payload.setdefault("input", {})["variables"] = {
        key: value for key, value in variables.items()
        if key not in scopes or isinstance(scopes[key], list) and visible({"taskProjects": scopes[key]})
    }
    return payload


def public_automation(automation: dict[str, Any], user_id: str, *, visible=None) -> dict[str, Any]:
    visible = visible or execution_visibility(user_id)
    logs = automation.get("logs") or []
    allowed = [public_execution(item, user_id) for item in logs if visible(item)]
    from app.services.task_activity import activity_visibility
    variable_visible = activity_visibility(user_id)
    scopes = variable_projects(automation)
    variables = {key: value for key, value in (automation.get("variables") or {}).items()
                 if key not in scopes or isinstance(scopes[key], list) and variable_visible({"taskProjects": scopes[key]})}
    payload = {**automation, "logs": allowed, "variables": variables, "versions": public_versions(automation)}
    payload.pop("variableTaskProjects", None)
    if len(allowed) != len(logs) or len(variables) != len(automation.get("variables") or {}):
        payload.update(executions=len(allowed), savedMinutes=sum(int(item.get("savedMinutes") or 0) for item in allowed),
                       lastRunAt=max((str(item.get("timestamp") or "") for item in allowed), default=None),
                       updatedAt=automation.get("createdAt"))
    return payload


def execution_response(automation, log, store, user_id):
    visible = execution_visibility(user_id)
    if not visible(log):
        raise HTTPException(status_code=404, detail="Execucao nao encontrada.")
    return {"automation": public_automation(automation, user_id, visible=visible), "historyItem": public_execution(log, user_id),
            "metrics": response_payload(store, user_id)["metrics"]}


def response_payload(store: dict[str, Any], user_id: str) -> dict[str, Any]:
    visible = execution_visibility(user_id)
    automations = [public_automation(item, user_id, visible=visible) for item in store.get("automations", [])]
    ordered = sorted(automations, key=lambda item: (not bool(item.get("favorite")), str(item.get("name", ""))))
    history = sorted((public_execution(item, user_id) for item in store.get("history", []) if visible(item)), key=lambda item: str(item.get("timestamp", "")), reverse=True)
    updated_at = store.get("updatedAt")
    if len(history) != len(store.get("history", [])) or any(len(item.get("logs", [])) != len(raw.get("logs", [])) or len(item.get("variables", {})) != len(raw.get("variables", {})) for item, raw in zip(automations, store.get("automations", []))):
        updated_at = max([str(item.get("updatedAt") or "") for item in automations]
                         + [str(item.get("timestamp") or "") for item in history], default="") or None
    return {
        "automations": ordered,
        "history": history[:80],
        "templates": TEMPLATES,
        "integrations": [{"name": name, "status": "Disponível"} for name in INTEGRATIONS],
        "metrics": metrics({**store, "automations": automations, "history": history}),
        "updatedAt": updated_at,
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
        "variables": {key: value for key, value in payload.variables.items() if key not in RUNTIME_VARIABLES},
        "schedule": payload.schedule,
        "retryPolicy": payload.retryPolicy,
        "failureAction": payload.failureAction,
        "requiresApproval": payload.requiresApproval,
        "flow": flow,
        "logs": [],
    }
    stamp_event_activation(automation)
    automation["versions"] = [automation_snapshot(automation, "Versao inicial")]
    return automation


def stamp_event_activation(automation: dict[str, Any]) -> None:
    from app.modules.automations.events import EVENT_TYPES
    for item in (automation.get("flow") or {}).get("nodes", []):
        config = item.get("config") or {}
        if item.get("kind") != "trigger" or config.get("automatic") != "true":
            continue
        if config.get("eventType") not in EVENT_TYPES:
            raise HTTPException(status_code=422, detail="Selecione um evento suportado para o gatilho automático.")
        if automation.get("requiresApproval") or (automation.get("variables") or {}).get("approvalRequired") == "true":
            raise HTTPException(status_code=422, detail="Fluxos com aprovação obrigatória não podem executar automaticamente.")
        config["enabledAt"] = now_iso()


def automation_snapshot(automation: dict[str, Any], note: str = "") -> dict[str, Any]:
    content = {
        key: copy.deepcopy(value)
        for key, value in automation.items()
        if key not in {"versions", "logs", "executions", "savedMinutes", "lastRunAt", "variableTaskProjects"}
    }
    content["variables"] = configuration_variables(automation)
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


def task_creation_project(user_id: str, project_id: str, source_projects: list[dict[str, str]]) -> dict[str, str]:
    from app.services import task_store
    from app.services.task_activity import project_visible, read_directory
    db, directory = task_store._read_db(), read_directory()
    destination = task_store.resolve_project_workspace(db, user_id, project_id)
    if not destination:
        raise ValueError("Projeto de destino da tarefa sem acesso verificavel.")
    reference = {"ownerId": destination[0], "projectId": str(destination[2]["id"])}
    if not project_visible(reference, user_id, db=db, directory=directory):
        raise ValueError("Projeto de destino da tarefa sem acesso verificavel.")
    if source_projects and any(
        project_visible(reference, str(item.get("id") or ""), db=db, directory=directory)
        and not all(project_visible(source, str(item.get("id") or ""), db=db, directory=directory) for source in source_projects)
        for item in directory.get("users", [])
    ):
        raise ValueError("Projeto de destino amplia o publico da atividade privada; criacao de tarefa bloqueada.")
    return reference


async def apply_automation_effects(
    user_id: str,
    automation: dict[str, Any],
    *,
    event: dict[str, Any] | None = None,
    retained_projects: list[dict[str, str]] | None = None,
    checkpoints: dict[str, dict[str, Any]] | None = None,
    save_checkpoint: Callable[[str, str, dict[str, Any] | None], Awaitable[None]] | None = None,
    save_scope: Callable[[list[dict[str, str]]], Awaitable[None]] | None = None,
) -> list[str]:
    # A trigger/name mentioning a task must not cause an unconfigured action.
    action_nodes = [item for item in (automation.get("flow") or {}).get("nodes", []) if item.get("kind") != "trigger"]
    text = normalize_text(" ".join(str(item.get("title") or "") for item in action_nodes)) if action_nodes else normalize_text(" ".join(automation.get("actions") or []))
    variables = automation.get("variables") if isinstance(automation.get("variables"), dict) else {}
    effects: list[str] = []
    from app.modules.automations.events import task_event_projects
    source_references = [dict(ref) for ref in task_event_projects(event, user_id)]
    for reference in [*authorized_variable_projects(automation, user_id), *(retained_projects or [])]:
        if reference not in source_references:
            source_references.append(copy.deepcopy(reference))
    from app.services.task_activity import activity_projects
    if source_references and activity_projects(user_id, {"taskProjects": source_references}) is None:
        raise ValueError("Atividade de tarefa sem acesso atual ao projeto.")
    task_references = [dict(reference) for reference in source_references]
    creates_task = "criar tarefa" in text or "tarefa" in text and "criar" in text
    has_task_effect = bool(task_references) or creates_task
    effect_checkpoints = checkpoints or {}
    if source_references and any(
        normalize_text(str(item.get("title") or "")) == "preparar leitura paginada de e-mails"
        or "navegador" in normalize_text(str(item.get("title") or ""))
        for item in action_nodes
    ):
        raise AutomationEffectBlocked("Atividade de tarefa exige destino com escopo verificavel; operacao delegada bloqueada.")
    if creates_task:
        previous = effect_checkpoints.get("task:create") or {}
        if previous.get("status") == "succeeded":
            from app.services.task_activity import activity_project
            result = previous.get("result") or {}
            reference = activity_project(user_id, result)
            if reference is None:
                raise ValueError("Tarefa de execucao anterior sem projeto verificavel.")
            if reference not in task_references:
                task_references.append(reference)
        destination_reference = task_creation_project(user_id, str(variables.get("taskProjectId") or "default"), source_references)
        if destination_reference not in task_references:
            task_references.append(destination_reference)
    if task_references and save_scope is not None:
        await save_scope(task_references)

    async def run_effect(
        effect_id: str,
        operation: Callable[[], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        task_event_projects(event, user_id)
        authorized_variable_projects(automation, user_id)
        from app.services.task_activity import activity_projects
        if task_references and activity_projects(user_id, {"taskProjects": task_references}) is None:
            raise ValueError("Atividade de tarefa sem acesso atual ao projeto.")
        previous = effect_checkpoints.get(effect_id) or {}
        if previous.get("status") == "succeeded":
            result = previous.get("result") if isinstance(previous.get("result"), dict) else {}
            updates = result.get("variableUpdates") if isinstance(result.get("variableUpdates"), dict) else {}
            automation.setdefault("variables", {}).update(updates)
            for key in updates:
                automation.setdefault("variableTaskProjects", {})[key] = copy.deepcopy(task_references)
            if save_checkpoint is not None:
                await save_checkpoint(effect_id, "succeeded", result)
            description = str(result.get("description") or "Efeito concluido em tentativa anterior.")
            effects.append(description)
            return result
        if previous.get("status") == "uncertain":
            raise AutomationEffectUncertain(effect_id)
        if save_checkpoint is not None:
            await save_checkpoint(effect_id, "running", None)
        try:
            result = await operation()
        except Exception as exc:
            if save_checkpoint is not None:
                await save_checkpoint(effect_id, "retryable" if isinstance(exc, AutomationEffectBlocked) else "uncertain", None)
            raise
        updates = result.get("variableUpdates") if isinstance(result.get("variableUpdates"), dict) else {}
        automation.setdefault("variables", {}).update(updates)
        for key in updates:
            automation.setdefault("variableTaskProjects", {})[key] = copy.deepcopy(task_references)
        if save_checkpoint is not None:
            await save_checkpoint(effect_id, "succeeded", result)
        effects.append(str(result.get("description") or "Efeito concluido."))
        return result

    flow = automation.get("flow") if isinstance(automation.get("flow"), dict) else {}
    flow_nodes = flow.get("nodes") if isinstance(flow.get("nodes"), list) else []
    for item in flow_nodes:
        if not isinstance(item, dict) or item.get("kind") == "trigger":
            continue
        if normalize_text(str(item.get("title") or "")) != "preparar leitura paginada de e-mails":
            continue
        async def prepare_mailbox_work(current_item=item):
            from app.modules.auth.router import read_user_store, find_user, sanitize_user
            from app.modules.mail.productivity import WorkRequest, require_mail, create
            raw = find_user(await read_user_store(), user_id)
            if not raw or raw.get("status") != "ativo":
                raise ValueError("A conta responsável não está ativa.")
            actor = sanitize_user(raw)
            require_mail(actor)
            config = current_item.get("config") or {}
            work = await create(actor, WorkRequest(requestId=uuid.uuid4().hex,
                query=str(config.get("gmailQuery") or "newer_than:1d")[:600], messageBudget=100))
            return {"description": f"Trabalho de leitura {work['id']} preparado em E-mails; aguardando continuação. Nenhum envio foi feito.",
                    "variableUpdates": {"noraMailWorkId": work["id"]}}
        await run_effect(f"mailbox:{item.get('id')}", prepare_mailbox_work)
    message_nodes = []
    for item in flow_nodes:
        if not isinstance(item, dict) or item.get("kind") == "trigger":
            continue
        config = item.get("config") or {}
        title = normalize_text(str(item.get("title") or ""))
        action_type = config.get("actionType")
        if action_type in {"send_whatsapp", "send_team"} or "enviar whatsapp" in title or "enviar mensagem no chat" in title:
            message_nodes.append((item, config, action_type or ("send_whatsapp" if "whatsapp" in title else "send_team")))

    # Validate every destination before sending any message; use the same permission
    # checks and tenant resolution as the interactive messaging endpoints.
    if message_nodes:
        from app.routers.auth_router import read_user_store
        from app.modules.team.router import thread_participant_ids, read_chat_store, team_id_for, require_team_chat

        users = await read_user_store()
        actor = next((item for item in users.get("users", []) if str(item.get("id")) == user_id), None)
        if not actor or actor.get("status") != "ativo":
            raise ValueError("A conta responsável pela automação não está ativa.")
        for item, config, action_type in message_nodes:
            if not str(config.get("message") or "").strip():
                raise ValueError(f'{item.get("title")}: informe a mensagem.')
            if action_type == "send_whatsapp":
                completed = (effect_checkpoints.get(f"message:{item.get('id') or 'configured'}") or {}).get("status") == "succeeded"
                if source_references and not completed:
                    raise ValueError("Atividade de tarefa exige destinatario verificavel no projeto; envio externo bloqueado.")
                from app.modules.chat.router import assert_channel_permission
                assert_channel_permission(actor, "whatsapp")
                recipient = str(config.get("recipient") or "").strip()
                if not recipient:
                    raise ValueError("Selecione um contato ou informe um número de WhatsApp.")
                if config.get("recipientMode") == "number" and not re.fullmatch(r"\d{10,15}", re.sub(r"[+\s()-]", "", recipient)):
                    raise ValueError("Informe o número de WhatsApp com DDI e DDD.")
            else:
                require_team_chat(actor)
                if len(str(config.get("message") or "")) > 2000:
                    raise ValueError("A mensagem do chat deve ter até 2000 caracteres.")
                scope = config.get("scope") or "team"
                if scope not in {"team", "direct", "subteam"}:
                    raise ValueError("Destino de chat inválido.")
                participants = await thread_participant_ids(actor, read_chat_store(team_id_for(actor)), scope,
                                                          config.get("recipientId") if scope == "direct" else None,
                                                          config.get("recipientId") if scope == "subteam" else None)
                if task_references and scope != "team":
                    from app.services.task_activity import project_visible
                    if not all(project_visible(reference, participant) for participant in participants for reference in task_references):
                        raise ValueError("Destino do chat sem acesso atual ao projeto da tarefa.")
        for item, config, action_type in message_nodes:
            message = str(config["message"]).strip()
            async def send_configured_message(
                current_config: dict[str, Any] = config,
                current_type: str = action_type,
                current_message: str = message,
            ) -> dict[str, Any]:
                if current_type == "send_whatsapp":
                    from app.modules.chat.router import EnviarMensagemPayload, enviar_mensagem
                    recipient = str(current_config["recipient"]).strip()
                    if current_config.get("recipientMode") == "number":
                        recipient = re.sub(r"[+\s()-]", "", recipient)
                    await enviar_mensagem(
                        EnviarMensagemPayload(conversa_id=recipient, texto=current_message), actor
                    )
                    return {"description": "Mensagem enviada no WhatsApp."}
                if task_references:
                    activity_metadata = {"taskProjects": task_references, "automationId": automation.get("id")}
                    if current_config.get("scope", "team") == "team":
                        await append_team_message_for_user(user_id, current_message, metadata=activity_metadata)
                    else:
                        from app.modules.team.router import persist_message
                        await persist_message(
                            scope=current_config.get("scope") or "team",
                            recipient_id=current_config.get("recipientId") if current_config.get("scope") == "direct" else None,
                            subteam_id=current_config.get("recipientId") if current_config.get("scope") == "subteam" else None,
                            text=current_message, attachment_payloads=[], user=actor,
                            activity_metadata=activity_metadata,
                        )
                    return {"description": "Mensagem enviada aos participantes autorizados do projeto."}
                from app.modules.team.router import (
                    SendSubteamMessagePayload,
                    SendTeamMessagePayload,
                    send_message,
                    send_subteam_message,
                )
                if current_config.get("scope") == "subteam":
                    await send_subteam_message(
                        current_config["recipientId"], SendSubteamMessagePayload(text=current_message), actor
                    )
                else:
                    await send_message(
                        SendTeamMessagePayload(
                            scope=current_config.get("scope") or "team",
                            recipientId=current_config.get("recipientId") or None,
                            text=current_message,
                        ),
                        actor,
                    )
                return {"description": "Mensagem enviada ao destino selecionado no chat da equipe."}

            await run_effect(f"message:{item.get('id') or 'configured'}", send_configured_message)
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
        async def start_browser_run() -> dict[str, Any]:
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
            return {
                "description": (
                    f'Agente Navegador iniciou a execucao real {run["id"]}; '
                    "resultados e aprovacoes ficam na tela Navegador."
                ),
                "runId": str(run["id"]),
            }

        await run_effect(f"browser:{browser_node.get('id') or 'run'}", start_browser_run)

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
        routing = await asyncio.to_thread(route_model,
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
        async def run_model() -> dict[str, Any]:
            answer, usage = await complete_with_provider(
                {"id": user_id},
                str(selected.get("id")),
                [{"role": "user", "content": prompt}],
                "Voce executa um bloco de automacao do Norium. Responda somente com o resultado solicitado, sem inventar dados externos.",
            )
            return {
                "description": (
                    f'IA executada por {selected.get("name")} / {selected.get("model")}; '
                    f'{int(usage.get("usage", {}).get("outputTokens") or 0)} token(s) de saida registrados.'
                ),
                "variableUpdates": {"lastModelOutput": answer[:4000]},
            }

        await run_effect(f"model:{model_node.get('id') or 'completion'}", run_model)

    if creates_task:
        project_id = str(variables.get("taskProjectId") or "default")
        project_name = str(variables.get("taskProjectName") or project_id or "Operacao Norium")
        task_category = str(variables.get("taskCategory") or "geral")
        async def create_configured_task() -> dict[str, Any]:
            from app.services.task_activity import activity_project
            try:
                current_destination = task_creation_project(user_id, project_id, source_references)
            except ValueError as exc:
                raise AutomationEffectBlocked(str(exc)) from exc
            if current_destination != destination_reference:
                raise AutomationEffectBlocked("Projeto de destino da tarefa mudou durante a execucao.")
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
            await record_event(
                source="kanban",
                title=f"Tarefa criada por automacao em {project_name}",
                description=f'"{task.get("title")}" foi criada pela automacao "{automation.get("name")}".',
                metadata={
                    "action": "automation_task_created", "userId": user_id,
                    "automationId": automation.get("id"), "taskId": task.get("id"),
                    "taskProjects": task_references,
                    "projectId": project_id, "projectName": project_name, "category": task_category,
                },
            )
            await append_team_message_for_user(
                user_id,
                "\n".join([
                    "Nora executou uma automacao",
                    f"Automacao: {automation.get('name') or 'Fluxo sem nome'}",
                    f"Tarefa criada: {task.get('title')}",
                    f"Projeto: {project_name}",
                ]),
                metadata={
                    "action": "automation_task_created", "automationId": automation.get("id"),
                    "automationName": automation.get("name") or "Fluxo sem nome",
                    "taskProjects": task_references,
                    "taskId": task.get("id"), "taskTitle": task.get("title"),
                    "projectId": project_id, "projectName": project_name,
                    "summary": {
                        "automationName": automation.get("name") or "Fluxo sem nome",
                        "taskTitle": task.get("title"), "projectName": project_name,
                        "changes": ["Tarefa criada automaticamente pelo fluxo."],
                        "state": {
                            "Status": "pendente", "Prioridade": "media", "Categoria": task_category,
                            "Responsavel": "Nora", "Vencimento": "sem vencimento",
                            "Etiquetas": f"automacao, {task_category}",
                        },
                    },
                },
            )
            return {
                "description": f'Tarefa "{task.get("title")}" criada no projeto "{project_name}".',
                "taskId": task.get("id"),
                "taskProject": activity_project(user_id, {"taskId": task.get("id")}),
            }

        task_effect = await run_effect("task:create", create_configured_task)
        from app.services.task_activity import activity_project
        reference = task_effect.get("taskProject") or activity_project(user_id, {"taskId": task_effect.get("taskId")})
        has_task_effect = True
        if reference is not None and reference not in task_references:
            task_references.append(reference)

    if "agrupar e-mails" in text or "agrupar emails" in text or "categoria" in text and ("email" in text or "e-mail" in text):
        async def group_email() -> dict[str, Any]:
            try:
                data = GmailService(user_id).list_messages(folder="inbox", max_results=20)
                messages = data.get("messages", [])
                groups: dict[str, list[dict[str, str]]] = {}
                target_category = str(variables.get("emailCategory") or "auto")
                for message in messages:
                    category = classify_email_category(message)
                    if target_category != "auto" and category != target_category:
                        continue
                    groups.setdefault(category, []).append({
                        "id": str(message.get("id") or ""),
                        "from": str(message.get("fromName") or message.get("fromEmail") or ""),
                        "subject": str(message.get("subject") or "(sem assunto)"),
                    })
                summary = ", ".join(
                    f"{category}: {len(items)}" for category, items in sorted(groups.items())
                ) or "nenhum e-mail encontrado"
                await record_event(
                    source="gmail", title="E-mails agrupados por categoria", description=summary,
                    metadata={
                        "action": "automation_email_grouped", "userId": user_id,
                        "automationId": automation.get("id"), "groups": groups,
                        "targetCategory": target_category,
                        **({"taskProjects": task_references} if task_references else {}),
                    },
                )
                return {
                    "description": f"Gmail agrupado por categoria: {summary}.",
                    "variableUpdates": {
                        "lastEmailGrouping": groups, "lastEmailGroupingSummary": summary,
                    },
                }
            except GmailConfigError:
                return {"description": "Gmail nao conectado; agrupamento de e-mails ficou pendente."}
            except Exception as exc:
                return {"description": f"Falha ao agrupar e-mails: {str(exc)}"}

        await run_effect("gmail:group", group_email)

    if not message_nodes and ("notificar equipe" in text or "chat interno" in text or "avisar equipe" in text or "mensagem ao time" in text):
        message = (
            f'Nora: automacao "{automation.get("name")}" executada. '
            f'Gatilho: {automation.get("trigger") or "manual"}. '
            f'Acoes: {", ".join(str(action) for action in automation.get("actions", [])[:4]) or "sem acoes registradas"}.'
        )
        async def notify_team() -> dict[str, Any]:
            if has_task_effect and not task_references:
                raise ValueError("A tarefa da automacao nao tem projeto verificavel para notificar a equipe.")
            await append_team_message_for_user(
                user_id,
                message,
                metadata={"action": "automation_team_notification", "automationId": automation.get("id"), **({"taskProjects": task_references} if task_references else {})},
            )
            return {"description": "Equipe notificada no chat interno."}

        await run_effect("team:notification", notify_team)

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
    references = authorized_variable_projects(automation, user_id)
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
        "input": {"trigger": automation.get("trigger"), "variables": copy.deepcopy(variables),
                  "variableTaskProjects": variable_projects(automation)},
        "steps": preview,
        "sideEffects": False,
        **({"taskProjects": references} if references else {}),
    }
    store.setdefault("history", []).insert(0, log)
    automation.setdefault("logs", []).insert(0, log)
    automation["logs"] = automation["logs"][:50]
    store["history"] = store["history"][:250]
    write_store(user_id, store)
    return execution_response(automation, log, store, user_id)


async def execute_automation(
    user_id: str,
    automation_id: str,
    executed_by: str = "Operador",
    *,
    event: dict[str, Any] | None = None,
    resume_from: dict[str, Any] | None = None,
) -> dict[str, Any]:
    store = read_store(user_id)
    automation = find_automation(store, automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    if not automation.get("active"):
        raise HTTPException(status_code=400, detail="Automacao desativada. Ative antes de executar.")
    if event is None and resume_from:
        event = (resume_from.get("input") or {}).get("event")
    from app.modules.automations.events import task_event_projects
    source_projects = [dict(ref) for ref in task_event_projects(event, user_id)]
    retained_projects = retained_execution_projects(resume_from, user_id) if resume_from else []
    for reference in [*authorized_variable_projects(automation, user_id), *retained_projects]:
        if reference not in source_projects:
            source_projects.append(reference)
    if resume_from and resume_from.get("automationVersion") not in {None, automation.get("version")}:
        raise HTTPException(
            status_code=409,
            detail="A automacao mudou desde a falha. Duplique ou restaure a versao antes de retomar.",
        )
    previous_checkpoints = copy.deepcopy(
        resume_from.get("effectCheckpoints") if isinstance((resume_from or {}).get("effectCheckpoints"), dict) else {}
    )
    uncertain = [key for key, value in previous_checkpoints.items() if value.get("status") == "uncertain"]
    if uncertain:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "automation_effect_reconciliation_required",
                "effectIds": uncertain,
                "message": "Concilie os efeitos de resultado incerto antes de retomar.",
            },
        )

    original_variables = copy.deepcopy(automation.get("variables") or {})
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
    log_id = slug_id("log")
    log: dict[str, Any] = {
        "id": log_id,
        "automationId": automation["id"],
        "automationName": automation.get("name"),
        "automationVersion": automation.get("version"),
        "timestamp": timestamp,
        "status": "executando",
        "durationMs": 0,
        "result": "Execucao iniciada.",
        "executedBy": executed_by,
        "savedMinutes": 0,
        "attempt": int((resume_from or {}).get("attempt") or 0) + 1,
        "input": {
            "trigger": automation.get("trigger"),
            "variables": copy.deepcopy(automation.get("variables") or {}),
            "variableTaskProjects": variable_projects(automation),
            "event": event,
        },
        "steps": steps,
        "error": None,
        "sideEffects": False,
        "effectCheckpoints": previous_checkpoints,
        "leaseExpiresAt": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
        "resumedFromLogId": (resume_from or {}).get("id"),
        **({"taskProjects": source_projects} if source_projects else {}),
    }
    store.setdefault("history", []).insert(0, copy.deepcopy(log))
    automation.setdefault("logs", []).insert(0, copy.deepcopy(log))
    automation["logs"] = automation["logs"][:20]
    store["history"] = store["history"][:120]
    write_store(user_id, store)

    async def save_effect_checkpoint(
        effect_id: str,
        status: str,
        result: dict[str, Any] | None,
    ) -> None:
        checkpoint = {
            "status": status,
            "updatedAt": now_iso(),
            "result": copy.deepcopy(result) if result is not None else copy.deepcopy((previous_checkpoints.get(effect_id) or {}).get("result")),
        }
        previous_checkpoints[effect_id] = checkpoint
        current = read_store(user_id)
        current_automation = find_automation(current, automation_id)
        targets = [item for item in current.get("history", []) if item.get("id") == log_id]
        if current_automation:
            targets.extend(item for item in current_automation.get("logs", []) if item.get("id") == log_id)
        if not targets:
            raise RuntimeError("Registro duravel da execucao nao encontrado.")
        for target in targets:
            target.setdefault("effectCheckpoints", {})[effect_id] = copy.deepcopy(checkpoint)
            reference = (checkpoint.get("result") or {}).get("taskProject")
            if reference and reference not in target.get("taskProjects", []):
                target.setdefault("taskProjects", []).append(copy.deepcopy(reference))
            target["sideEffects"] = True
            target["requiresReconciliation"] = any(
                value.get("status") == "uncertain"
                for value in target["effectCheckpoints"].values()
            )
        updates = (checkpoint.get("result") or {}).get("variableUpdates") or {}
        if current_automation and updates:
            current_automation.setdefault("variables", {}).update(copy.deepcopy(updates))
            for key in updates:
                current_automation.setdefault("variableTaskProjects", {})[key] = copy.deepcopy(targets[0].get("taskProjects") or [])
        write_store(user_id, current)
    async def save_activity_scope(references: list[dict[str, str]]) -> None:
        current = read_store(user_id)
        current_automation = find_automation(current, automation_id)
        targets = [item for item in current.get("history", []) if item.get("id") == log_id]
        if current_automation:
            targets.extend(item for item in current_automation.get("logs", []) if item.get("id") == log_id)
        if not targets:
            raise RuntimeError("Registro duravel da execucao nao encontrado.")
        for target in targets:
            target["taskProjects"] = copy.deepcopy(references)
        write_store(user_id, current)

    effects: list[str] = []
    failure: Exception | None = None
    from app.modules.automations.events import automation_origin
    origin_token = automation_origin.set(True)
    try:
        effects = await apply_automation_effects(
            user_id,
            automation,
            event=event,
            retained_projects=retained_projects,
            checkpoints=previous_checkpoints,
            save_checkpoint=save_effect_checkpoint,
            save_scope=save_activity_scope,
        )
    except Exception as exc:
        failure = exc
    finally:
        automation_origin.reset(origin_token)
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
    # External sends await I/O. Preserve edits/deactivation made during that
    # wait instead of replacing the user's newer flow with our old snapshot.
    latest_store = read_store(user_id)
    latest = find_automation(latest_store, automation_id)
    if latest:
        if failure is None:
            latest["savedMinutes"] = int(latest.get("savedMinutes") or 0) + saved
        for key, value in (automation.get("variables") or {}).items():
            if value != original_variables.get(key):
                latest.setdefault("variables", {})[key] = value
        automation = latest
    store = latest_store
    final_values = {
        "status": status,
        "durationMs": max(1, int((finished_at - started_at).total_seconds() * 1000)),
        "result": result,
        "savedMinutes": 0 if failure else saved,
        "input": {
            "trigger": automation.get("trigger"),
            "variables": copy.deepcopy(automation.get("variables") or {}),
            "variableTaskProjects": variable_projects(automation),
            "event": event,
        },
        "steps": steps,
        "error": str(failure) if failure else None,
        "sideEffects": bool(previous_checkpoints),
        "effectCheckpoints": previous_checkpoints,
        "requiresReconciliation": any(
            value.get("status") == "uncertain" for value in previous_checkpoints.values()
        ),
        "finishedAt": finished_at.isoformat(),
    }
    history_log = next(item for item in store.get("history", []) if item.get("id") == log_id)
    history_log.update(copy.deepcopy(final_values))
    automation_log = next(item for item in automation.get("logs", []) if item.get("id") == log_id)
    automation_log.update(copy.deepcopy(final_values))
    log = history_log
    write_store(user_id, store)

    if not execution_visibility(user_id)(log):
        raise HTTPException(status_code=404, detail="Execucao nao encontrada.")
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
            **({"taskProjects": log["taskProjects"]} if log.get("taskProjects") else {}),
        },
    )
    return execution_response(automation, log, store, user_id)


@router.get("")
async def listar_automacoes(user: dict[str, Any] = Depends(current_user)):
    return response_payload(read_store(tenant_id(user)), tenant_id(user))


@router.get("/eventos/fila")
async def listar_eventos_automaticos(user: dict[str, Any] = Depends(current_user)):
    import asyncio
    from app.core.request_context import current_workspace_id
    from app.modules.automations.events import recent_jobs
    return {"jobs": await asyncio.to_thread(recent_jobs, tenant_id(user), current_workspace_id())}


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
    return response_payload(store, user_id)


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
    if "flow" in updates or (not previous_active and automation.get("active")):
        stamp_event_activation(automation)
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
    return response_payload(store, user_id)


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
    return response_payload(store, user_id)


@router.post("/{automation_id}/executar")
async def executar_automacao(automation_id: str, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    result = await execute_automation(tenant_id(user), automation_id, str(user.get("nome") or user.get("email") or "Operador"))
    store = read_store(tenant_id(user))
    return {**response_payload(store, user_id), "lastExecution": result}


@router.post("/{automation_id}/simular")
async def simular_automacao(automation_id: str, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    result = await simulate_automation(
        tenant_id(user),
        automation_id,
        str(user.get("nome") or user.get("email") or "Operador"),
    )
    store = read_store(tenant_id(user))
    return {**response_payload(store, user_id), "lastExecution": result}


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
    if previous is None or not execution_visibility(user_id)(previous):
        raise HTTPException(status_code=404, detail="Execucao nao encontrada.")
    if previous.get("status") == "executando":
        try:
            lease_expired = datetime.fromisoformat(str(previous.get("leaseExpiresAt"))) <= datetime.now(timezone.utc)
        except (TypeError, ValueError):
            lease_expired = True
        if not lease_expired:
            raise HTTPException(status_code=409, detail="A execucao ainda possui lease ativo.")
        automation = find_automation(store, automation_id)
        automation_log = next(
            (item for item in (automation or {}).get("logs", []) if item.get("id") == log_id),
            None,
        )
        for target in (previous, automation_log):
            if target is None:
                continue
            for checkpoint in (target.get("effectCheckpoints") or {}).values():
                if checkpoint.get("status") == "running":
                    checkpoint.update({"status": "uncertain", "updatedAt": now_iso()})
            target.update({
                "status": "erro",
                "error": "Execucao interrompida apos o vencimento do lease.",
                "requiresReconciliation": any(
                    item.get("status") == "uncertain"
                    for item in (target.get("effectCheckpoints") or {}).values()
                ),
            })
        write_store(user_id, store)
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
        resume_from=previous,
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
    return {**response_payload(read_store(user_id), user_id), "lastExecution": result}


@router.post("/{automation_id}/execucoes/{log_id}/efeitos/{effect_id}/conciliar")
async def reconcile_automation_effect(
    automation_id: str,
    log_id: str,
    effect_id: str,
    payload: EffectReconciliationPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    user_id = tenant_id(user)
    store = read_store(user_id)
    automation = find_automation(store, automation_id)
    if automation is None:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    history_log = next(
        (item for item in store.get("history", []) if item.get("id") == log_id),
        None,
    )
    automation_log = next(
        (item for item in automation.get("logs", []) if item.get("id") == log_id),
        None,
    )
    if history_log is None or automation_log is None or not execution_visibility(user_id)(history_log):
        raise HTTPException(status_code=404, detail="Execucao nao encontrada.")
    checkpoint = (history_log.get("effectCheckpoints") or {}).get(effect_id)
    if not isinstance(checkpoint, dict) or checkpoint.get("status") != "uncertain":
        raise HTTPException(status_code=409, detail="O efeito nao aguarda conciliacao.")
    status = "succeeded" if payload.outcome == "completed" else "retryable"
    stamp = now_iso()
    for target in (history_log, automation_log):
        target_checkpoint = target.setdefault("effectCheckpoints", {}).setdefault(effect_id, {})
        target_checkpoint.update({
            "status": status,
            "reconciledAt": stamp,
            "reconciledBy": str(user.get("id") or ""),
            "reconciliation": payload.outcome,
            "note": payload.note,
            "updatedAt": stamp,
        })
        if status == "succeeded" and not isinstance(target_checkpoint.get("result"), dict):
            target_checkpoint["result"] = {
                "description": "Efeito confirmado por conciliacao do operador."
            }
        target["requiresReconciliation"] = any(
            item.get("status") == "uncertain"
            for item in target["effectCheckpoints"].values()
        )
    write_store(user_id, store)
    await record_event(
        source="automacoes",
        title="Efeito de automacao conciliado",
        description=payload.note,
        metadata={
            "action": "automation_effect_reconciled", "userId": user_id,
            "automationId": automation_id, "logId": log_id,
            "effectId": effect_id, "outcome": payload.outcome,
            **({"taskProjects": history_log["taskProjects"]} if history_log.get("taskProjects") else {}),
        },
    )
    return {"log": public_execution(history_log, user_id), "effectId": effect_id, "status": status}


@router.post("/{automation_id}/duplicar")
async def duplicar_automacao(automation_id: str, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    store = read_store(user_id)
    automation = find_automation(store, automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    clone = copy.deepcopy(automation)
    clone["variables"] = configuration_variables(automation)
    clone.pop("variableTaskProjects", None)
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
    return response_payload(store, user_id)


@router.get("/{automation_id}/versoes")
async def listar_versoes_automacao(automation_id: str, user: dict[str, Any] = Depends(current_user)):
    automation = find_automation(read_store(tenant_id(user)), automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automacao nao encontrada.")
    return {
        "automationId": automation_id,
        "currentVersion": int(automation.get("version") or 1),
        "environment": automation.get("environment") or "rascunho",
        "versions": public_versions(automation),
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
    return response_payload(store, user_id)


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
    outputs = RUNTIME_VARIABLES | set(variable_projects(automation))
    runtime_values = {key: value for key, value in (automation.get("variables") or {}).items() if key in outputs}
    scopes = variable_projects(automation)
    content = copy.deepcopy(version["content"])
    content.pop("variableTaskProjects", None)
    content["variables"] = {key: value for key, value in configuration_variables(content).items() if key not in outputs}
    content["variables"].update(runtime_values)
    content["variableTaskProjects"] = scopes
    automation.clear()
    automation.update(content)
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
    return response_payload(store, user_id)


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
    return {**response_payload(store, user_id), "imported": len(imported)}


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
        data = response_payload(store, user_id)
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
        return {"status": "desativada", "response": f"Pronto, desativei a automacao {automation.get('name')}.", "automation": public_automation(automation, user_id)}

    if any(term in normalized for term in ("ativar", "ligar", "reativar")):
        automation = find_automation_by_text(store, message)
        if not automation:
            return {"status": "nao_encontrada", "response": "Nao encontrei qual automacao voce quer ativar."}
        automation["active"] = True
        automation["status"] = "ativa"
        automation["updatedAt"] = now_iso()
        automation["version"] = int(automation.get("version") or 1) + 1
        write_store(user_id, store)
        return {"status": "ativada", "response": f"Pronto, ativei a automacao {automation.get('name')}.", "automation": public_automation(automation, user_id)}

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
        "automacoes": response_payload(store, user_id),
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
