"""Dominio de tarefas extraido para isolar projetos, cards e comentarios."""

from __future__ import annotations

import json
import re
import unicodedata
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import Field

from app.shared.schemas import StrictModel

from app.routers.auth_router import current_user, read_user_store
from app.routers.inbox_router import record_event
from app.routers.team_chat_router import append_team_message_for_user
from app.modules.operations.schemas import ReceiptCreate
from app.modules.operations.service import record_receipt
from app.services.nora import NoraIAService
from app.services.task_activity import activity_project
from app.services.task_store import (
    add_attachment,
    add_comment,
    attachment_path,
    build_stats,
    create_project,
    create_task,
    delete_project,
    delete_task,
    list_projects,
    list_tasks,
    now_iso,
    project_templates,
    update_project,
    update_task,
)

router = APIRouter(prefix="/api/tarefas", tags=["Tarefas"])
_nora = NoraIAService()


class CriarTarefaPayload(StrictModel):
    user_id: str = "lucas123"
    projectId: str = "default"
    projectName: str | None = Field(default=None, max_length=160)
    title: str = Field(min_length=1, max_length=160)
    description: str = ""
    category: str = "geral"
    status: str = Field(default="pendente", pattern=r"^[a-z0-9_-]{1,64}$")
    priority: Literal["baixa", "media", "alta", "urgente"] = "media"
    labels: list[str] = []
    dueDate: str | None = None
    assigneeId: str | None = None
    assigneeName: str | None = Field(default=None, max_length=160)


class AtualizarTarefaPayload(StrictModel):
    user_id: str = "lucas123"
    projectName: str | None = Field(default=None, max_length=160)
    title: str | None = None
    description: str | None = None
    category: str | None = None
    status: str | None = Field(default=None, pattern=r"^[a-z0-9_-]{1,64}$")
    priority: Literal["baixa", "media", "alta", "urgente"] | None = None
    labels: list[str] | None = None
    dueDate: str | None = None
    assigneeId: str | None = None
    assigneeName: str | None = Field(default=None, max_length=160)
    order: int | None = None


class ComentarioPayload(StrictModel):
    user_id: str = "lucas123"
    projectId: str = "default"
    projectName: str | None = Field(default=None, max_length=160)
    author: str = "Operador"
    text: str = Field(min_length=1, max_length=1200)


class AnexoPayload(StrictModel):
    user_id: str = "lucas123"
    projectId: str = "default"
    projectName: str | None = Field(default=None, max_length=160)
    file_name: str = Field(min_length=1, max_length=180)
    mime_type: str = "application/octet-stream"
    data_url: str = Field(min_length=16)


# Mantém o identificador histórico no OpenAPI quando há schemas homônimos.
AnexoPayload.__module__ = "app.routers.tarefas_router"
AnexoPayload.model_rebuild(force=True)


class TaskAgentPayload(StrictModel):
    user_id: str = "lucas123"
    message: str = Field(min_length=1)


class TaskDescriptionNoraPayload(StrictModel):
    title: str = Field(default="", max_length=220)
    description: str = Field(default="", max_length=6000)
    category: str = Field(default="geral", max_length=100)
    projectName: str = Field(default="", max_length=180)


class ProjetoPayload(StrictModel):
    user_id: str = "lucas123"
    name: str = Field(min_length=1, max_length=160)
    category: str = "operacao"
    description: str = ""
    color: str = "#0EA5E9"
    defaultPriority: str = "media"
    owner: str = "Operador"
    responsibleUserId: str | None = None
    responsibleName: str | None = Field(default=None, max_length=160)
    sharedUserIds: list[str] = []
    status: str = "ativo"
    startDate: str = ""
    dueDate: str = ""
    defaultStartTime: str = "09:00"
    calendarDurationMinutes: int = 60
    templateId: str = Field(default="standard", max_length=80)
    workflowColumns: list[dict[str, Any]] | None = None


class AtualizarProjetoPayload(StrictModel):
    user_id: str = "lucas123"
    name: str | None = Field(default=None, max_length=160)
    category: str | None = None
    description: str | None = None
    color: str | None = None
    defaultPriority: str | None = None
    owner: str | None = None
    responsibleUserId: str | None = None
    responsibleName: str | None = Field(default=None, max_length=160)
    sharedUserIds: list[str] | None = None
    status: str | None = None
    startDate: str | None = None
    dueDate: str | None = None
    defaultStartTime: str | None = None
    calendarDurationMinutes: int | None = None
    templateId: str | None = Field(default=None, max_length=80)
    workflowColumns: list[dict[str, Any]] | None = None
    archived: bool | None = None
    archivedAt: str | None = None


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def normalize_lookup(value: Any) -> str:
    text = str(value or "").lower().strip()
    return "".join(char for char in unicodedata.normalize("NFKD", text) if not unicodedata.combining(char))


def same_team(current: dict[str, Any], candidate: dict[str, Any]) -> bool:
    team_id = str(current.get("teamOwnerId") or current.get("id") or "")
    candidate_team = str(candidate.get("teamOwnerId") or candidate.get("id") or "")
    return bool(team_id and candidate_team == team_id)


async def team_directory_ids(user: dict[str, Any]) -> set[str]:
    store = await read_user_store()
    return {
        str(item.get("id") or "")
        for item in store.get("users", [])
        if isinstance(item, dict) and (str(item.get("id") or "") == str(user.get("id") or "") or same_team(user, item))
    } - {""}


async def accessible_team_projects(user: dict[str, Any]) -> list[dict[str, Any]]:
    user_id = tenant_id(user)
    team_ids = await team_directory_ids(user)
    return [
        project
        for project in list_projects(user_id).get("projects", [])
        if str(project.get("ownerUserId") or user_id) == user_id
        or str(project.get("ownerUserId") or "") in team_ids
    ]


async def require_task_access(user: dict[str, Any], task_id: str) -> dict[str, Any]:
    from app.services.task_activity import project_visible
    task = find_task_snapshot(tenant_id(user), task_id)
    reference = activity_project(tenant_id(user), {"taskId": task_id})
    if not task or not project_visible(reference, tenant_id(user)):
        raise HTTPException(status_code=404, detail="Tarefa nao encontrada.")
    task["taskProject"] = reference
    return task


async def validate_task_assignee(user: dict[str, Any], project_id: str, assignee_id: Any, *, task_id: str | None = None) -> None:
    if not assignee_id:
        return
    from app.services.task_activity import project_visible
    reference = activity_project(tenant_id(user), {"taskId": task_id}) if task_id else None
    if reference is None:
        project = next((item for item in await accessible_team_projects(user) if item.get("id") == project_id), None)
        reference = {"ownerId": project.get("ownerUserId"), "projectId": project_id} if project else None
    if str(assignee_id) not in await team_directory_ids(user) or not project_visible(reference, str(assignee_id)):
        raise HTTPException(status_code=400, detail="O responsavel precisa ter acesso ao projeto. Compartilhe o projeto explicitamente antes de atribuir a tarefa.")


async def safe_project_payload(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    team_ids = await team_directory_ids(user)
    cleaned = dict(payload)
    if "sharedUserIds" in cleaned:
        cleaned["sharedUserIds"] = sorted({
            str(item)
            for item in cleaned.get("sharedUserIds", [])
            if str(item) in team_ids and str(item) != user_id
        })
    responsible = str(cleaned.get("responsibleUserId") or "")
    if responsible and responsible not in team_ids:
        cleaned["responsibleUserId"] = user_id
        cleaned["responsibleName"] = str(user.get("nome") or user.get("email") or "Operador")
    return cleaned


def member_matches_task(member: dict[str, Any], task: dict[str, Any]) -> bool:
    member_id = str(member.get("id") or "")
    if member_id and member_id in {str(task.get("assigneeId") or ""), str(task.get("createdBy") or "")}:
        return True
    names = {
        normalize_lookup(member.get("nome")),
        normalize_lookup(member.get("email")),
    }
    task_names = {
        normalize_lookup(task.get("assigneeName")),
        normalize_lookup(task.get("authorName")),
    }
    return bool((names - {""}) & (task_names - {""}))


def member_task_stats(member: dict[str, Any], tasks: list[dict[str, Any]]) -> dict[str, Any]:
    related = [task for task in tasks if member_matches_task(member, task)]
    return {
        "total": len(related),
        "pendentes": len([task for task in related if task.get("status") == "pendente"]),
        "andamento": len([task for task in related if task.get("status") == "andamento"]),
        "revisao": len([task for task in related if task.get("status") == "revisao"]),
        "concluidas": len([task for task in related if task.get("status") == "concluida"]),
        "vencidas": build_stats(related).get("vencidas", 0),
        "urgentes": len([task for task in related if task.get("priority") == "urgente"]),
        "recentes": related[:8],
    }


def find_task_snapshot(user_id: str, task_id: str) -> dict[str, Any] | None:
    tasks = list_tasks(user_id, status="todas").get("tasks", [])
    return next((task for task in tasks if task.get("id") == task_id), None)


def clean_project_name(project_id: str | None, project_name: str | None = None) -> str:
    name = str(project_name or "").strip()
    if name:
        return name[:160]
    project = str(project_id or "").strip()
    if not project or project == "default":
        return "Projeto principal"
    return project[:160]


def value_label(value: Any, fallback: str = "nao informado") -> str:
    text = str(value or "").strip()
    return text if text else fallback


def date_label(value: Any) -> str:
    text = str(value or "").strip()
    return text[:10] if text else "sem vencimento"


def list_label(values: Any) -> str:
    if not isinstance(values, list) or not values:
        return "nenhuma"
    return ", ".join(str(item) for item in values if str(item).strip()) or "nenhuma"


def task_state_sentence(task: dict[str, Any]) -> str:
    return (
        f"Status: {status_label(str(task.get('status') or 'pendente'))}; "
        f"prioridade: {value_label(task.get('priority'), 'media')}; "
        f"categoria: {value_label(task.get('category'), 'geral')}; "
        f"responsavel: {value_label(task.get('assigneeName'), 'sem responsavel')}; "
        f"vencimento: {date_label(task.get('dueDate'))}; "
        f"etiquetas: {list_label(task.get('labels'))}; "
        f"anexos: {len(task.get('attachments') or [])}; "
        f"comentarios: {len(task.get('comments') or [])}."
    )


def task_state_payload(task: dict[str, Any]) -> dict[str, str]:
    return {
        "Status": status_label(str(task.get("status") or "pendente")),
        "Prioridade": value_label(task.get("priority"), "media"),
        "Categoria": value_label(task.get("category"), "geral"),
        "Responsavel": value_label(task.get("assigneeName"), "sem responsavel"),
        "Vencimento": date_label(task.get("dueDate")),
        "Etiquetas": list_label(task.get("labels")),
        "Anexos": str(len(task.get("attachments") or [])),
        "Comentarios": str(len(task.get("comments") or [])),
    }


def task_summary_payload(task: dict[str, Any], project: str, changes: list[str] | None = None) -> dict[str, Any]:
    return {
        "taskTitle": task.get("title") or "sem titulo",
        "projectName": project,
        "changes": changes or [],
        "state": task_state_payload(task),
    }


def update_change_sentences(previous: dict[str, Any] | None, task: dict[str, Any], updates: dict[str, Any]) -> list[str]:
    changes: list[str] = []
    previous = previous or {}
    labels = {
        "status": "Status",
        "priority": "Prioridade",
        "category": "Categoria",
        "dueDate": "Vencimento",
        "assigneeName": "Responsavel",
        "title": "Titulo",
        "labels": "Etiquetas",
        "order": "Posicao no quadro",
    }
    for key in ("status", "priority", "category", "dueDate", "assigneeName", "title", "labels", "order"):
        if key not in updates:
            continue
        before = previous.get(key)
        after = task.get(key)
        if key == "status":
            before_text = status_label(str(before or "pendente"))
            after_text = status_label(str(after or "pendente"))
        elif key == "dueDate":
            before_text = date_label(before)
            after_text = date_label(after)
        elif key == "labels":
            before_text = list_label(before)
            after_text = list_label(after)
        else:
            before_text = value_label(before)
            after_text = value_label(after)
        if before_text != after_text:
            changes.append(f"{labels[key]}: {before_text} -> {after_text}")
    if "description" in updates:
        changes.append("Descricao atualizada")
    return changes or ["Tarefa atualizada sem mudanca visual relevante."]


async def record_task_created(task: dict[str, Any], project_name: str | None = None, user_id: str | None = None) -> None:
    project = clean_project_name(task.get("projectId"), project_name)
    await record_event(
        source="kanban",
        title=f"Nova tarefa em {project}",
        description=f'"{task.get("title", "Nova tarefa")}" foi criada no projeto "{project}". {task_state_sentence(task)}',
        metadata={
            "taskProject": activity_project(str(user_id or ""), {"taskId": task.get("id")}),
            "action": "task_created",
            "userId": user_id,
            "taskId": task.get("id"),
            "taskTitle": task.get("title"),
            "projectId": task.get("projectId"),
            "projectName": project,
            "category": task.get("category"),
            "status": task.get("status"),
            "priority": task.get("priority"),
            "dueDate": task.get("dueDate"),
            "assigneeId": task.get("assigneeId"),
            "assigneeName": task.get("assigneeName"),
        },
    )


async def record_task_updated(
    task: dict[str, Any],
    previous: dict[str, Any] | None,
    updates: dict[str, Any],
    project_name: str | None = None,
    user_id: str | None = None,
) -> None:
    project = clean_project_name(task.get("projectId"), project_name)
    status_changed = previous and previous.get("status") != task.get("status") and "status" in updates
    title = (
        f'Tarefa "{task.get("title", "sem titulo")}" mudou para {status_label(str(task.get("status") or ""))}'
        if status_changed
        else f'Tarefa "{task.get("title", "sem titulo")}" atualizada em {project}'
    )
    changes = update_change_sentences(previous, task, updates)
    await record_event(
        source="kanban",
        title=title,
        description=(
            f'Projeto: "{project}". Alteracoes: {"; ".join(changes)}. '
            f"Estado atual: {task_state_sentence(task)}"
        ),
        metadata={
            "taskProject": activity_project(str(user_id or ""), {"taskId": task.get("id")}),
            "action": "task_updated",
            "userId": user_id,
            "taskId": task.get("id"),
            "taskTitle": task.get("title"),
            "projectId": task.get("projectId"),
            "projectName": project,
            "updates": updates,
            "changes": changes,
            "previousStatus": previous.get("status") if previous else None,
            "status": task.get("status"),
            "priority": task.get("priority"),
            "category": task.get("category"),
            "dueDate": task.get("dueDate"),
            "assigneeId": task.get("assigneeId"),
            "assigneeName": task.get("assigneeName"),
        },
    )
    if user_id:
        summary = task_summary_payload(task, project, changes)
        await append_team_message_for_user(
            user_id,
            "\n".join(
                [
                    "Nora atualizou uma tarefa",
                    f"Tarefa: {summary['taskTitle']}",
                    f"Projeto: {project}",
                    f"Alteracoes: {'; '.join(changes)}",
                ]
            ),
            metadata={
                "taskProject": activity_project(str(user_id or ""), {"taskId": task.get("id")}),
                "action": "task_updated",
                "taskId": task.get("id"),
                "taskTitle": task.get("title"),
                "projectName": project,
                "changes": changes,
                "summary": summary,
            },
        )


async def record_task_deleted(task: dict[str, Any] | None, task_id: str, project_id: str | None, project_name: str | None = None, user_id: str | None = None) -> None:
    project_id = (task or {}).get("projectId")
    project = clean_project_name(project_id, project_name)
    title = (task or {}).get("title") or task_id
    await record_event(
        source="kanban",
        title=f"Tarefa removida de {project}",
        description=f'A tarefa "{title}" foi apagada do projeto "{project}". Ultimo estado: {task_state_sentence(task or {})}',
        metadata={
            "taskProject": (task or {}).get("taskProject"),
            "action": "task_deleted",
            "userId": user_id,
            "taskId": task_id,
            "taskTitle": title,
            "projectId": project_id or (task or {}).get("projectId"),
            "projectName": project,
            "previousStatus": (task or {}).get("status"),
        },
    )
    if user_id:
        summary = task_summary_payload(task or {"title": title}, project, ["A tarefa foi removida do quadro."])
        await append_team_message_for_user(
            user_id,
            "\n".join(
                [
                    "Nora excluiu uma tarefa",
                    f"Tarefa: {title}",
                    f"Projeto: {project}",
                    f"Ultimo estado registrado antes da exclusao.",
                ]
            ),
            metadata={
                "taskProject": (task or {}).get("taskProject"),
                "action": "task_deleted",
                "taskId": task_id,
                "taskTitle": title,
                "projectName": project,
                "previousStatus": (task or {}).get("status"),
                "summary": summary,
            },
        )


@router.get("")
async def obter_tarefas(
    user_id: str = "lucas123",
    project_id: str | None = None,
    status: str | None = None,
    q: str | None = None,
    category: str | None = None,
    priority: str | None = None,
    label: str | None = None,
    due: str | None = None,
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    if project_id and project_id not in {str(item.get("id") or "") for item in await accessible_team_projects(user)}:
        raise HTTPException(status_code=404, detail="Projeto nao encontrado.")
    return list_tasks(
        resolved_user_id,
        project_id=project_id,
        status=status,
        q=q,
        category=category,
        priority=priority,
        label=label,
        due=due,
    )


@router.get("/projetos")
async def listar_projetos(user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    return {"projects": await accessible_team_projects(user), "updatedAt": now_iso()}


@router.get("/modelos-projeto")
async def listar_modelos_projeto(_user: dict[str, Any] = Depends(current_user)):
    return {"templates": project_templates()}


@router.get("/relatorio-equipe")
async def relatorio_equipe(user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    users_store = await read_user_store()
    members = [
        item
        for item in users_store.get("users", [])
        if isinstance(item, dict) and (str(item.get("id")) == resolved_user_id or same_team(user, item))
    ]
    if not members:
        members = [user]

    task_payload = list_tasks(resolved_user_id, status="todas")
    tasks = task_payload.get("tasks", [])
    by_member = []
    for member in members:
        stats = member_task_stats(member, tasks)
        by_member.append(
            {
                "id": str(member.get("id") or ""),
                "nome": str(member.get("nome") or member.get("email") or "Membro"),
                "email": str(member.get("email") or ""),
                "role": str(member.get("role") or "member"),
                "status": str(member.get("status") or "ativo"),
                "stats": {key: value for key, value in stats.items() if key != "recentes"},
                "recentes": stats["recentes"],
            }
        )

    totals = build_stats(tasks)
    totals.update(
        {
            "revisao": len([task for task in tasks if task.get("status") == "revisao"]),
            "urgentes": len([task for task in tasks if task.get("priority") == "urgente"]),
        }
    )
    return {
        "members": by_member,
        "totals": totals,
        "tasks": tasks,
        "updatedAt": now_iso(),
    }


@router.post("/projetos")
async def criar_projeto(payload: ProjetoPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    project = create_project(resolved_user_id, await safe_project_payload(user, payload.model_dump(exclude={"user_id"})))
    await record_event(
        source="kanban",
        title=f"Projeto criado: {project.get('name')}",
        description=(
            f'O projeto "{project.get("name")}" foi criado com responsavel '
            f'{project.get("responsibleName") or project.get("owner")}. '
            f'Compartilhado com {len(project.get("sharedUserIds") or [])} membro(s).'
        ),
        metadata={"action": "project_created", "userId": resolved_user_id, "projectId": project.get("id"), "projectName": project.get("name")},
    )
    return {"project": project}


@router.patch("/projetos/{project_id}")
async def atualizar_projeto(project_id: str, payload: AtualizarProjetoPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    updates = await safe_project_payload(user, {key: getattr(payload, key) for key in payload.model_fields_set if key != "user_id"})
    project = update_project(resolved_user_id, project_id, updates)
    if not project:
        raise HTTPException(status_code=404, detail="Projeto nao encontrado ou sem permissao para editar.")
    await record_event(
        source="kanban",
        title=f"Projeto atualizado: {project.get('name')}",
        description=(
            f'O projeto "{project.get("name")}" foi atualizado. '
            f'Responsavel: {project.get("responsibleName") or project.get("owner")}; '
            f'compartilhado com {len(project.get("sharedUserIds") or [])} membro(s).'
        ),
        metadata={"action": "project_updated", "userId": resolved_user_id, "projectId": project.get("id"), "projectName": project.get("name"), "updates": updates},
    )
    return {"project": project}


@router.delete("/projetos/{project_id}")
async def apagar_projeto(project_id: str, user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    if delete_project(resolved_user_id, project_id):
        await record_event(
            source="kanban",
            title="Projeto excluido",
            description=f'O projeto "{project_id}" e suas tarefas foram removidos.',
            metadata={"action": "project_deleted", "userId": resolved_user_id, "projectId": project_id},
        )
        return {"status": "sucesso"}
    raise HTTPException(status_code=404, detail="Projeto nao encontrado ou sem permissao para excluir.")


@router.post("/nora/detalhar-descricao")
async def detalhar_descricao_com_nora(
    payload: TaskDescriptionNoraPayload,
    user: dict[str, Any] = Depends(current_user),
):
    title = payload.title.strip() or "Nova tarefa"
    current_description = payload.description.strip()
    project_name = payload.projectName.strip() or "projeto atual"
    fallback = (
        f"Objetivo: concluir {title} no {project_name}.\n\n"
        f"Contexto: {current_description or 'Organizar a execução da tarefa com informações suficientes para o responsável iniciar o trabalho.'}\n\n"
        "Resultado esperado:\n"
        "- Entrega concluída e validada pelo responsável do projeto.\n"
        "- Evidências, arquivos ou links relevantes anexados ao card.\n\n"
        "Critérios de conclusão:\n"
        "- O resultado foi revisado.\n"
        "- As pendências e decisões foram registradas nos comentários."
    )
    prompt = f"""
Você está escrevendo a descrição de uma tarefa do Norium.
Título: {title}
Projeto: {project_name}
Categoria: {payload.category or 'geral'}
Descrição atual: {current_description or 'não informada'}

Expanda a ideia sem inventar datas, pessoas, valores ou requisitos. Escreva em português do Brasil, de forma objetiva e acionável.
Retorne somente JSON válido no formato:
{{"description":"texto completo com objetivo, contexto, resultado esperado e critérios de conclusão","comment":"comentário curto e útil da Nora"}}
""".strip()

    raw = await _nora.perguntar_nora(
        [{"role": "user", "content": prompt}],
        screen_context="Tarefas > criação de card",
    )
    try:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.IGNORECASE | re.DOTALL)
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        parsed = json.loads(cleaned[start : end + 1]) if start >= 0 and end > start else {}
        description = str(parsed.get("description") or "").strip()
        comment = str(parsed.get("comment") or "").strip()
    except (json.JSONDecodeError, TypeError, ValueError):
        description = ""
        comment = ""

    return {
        "description": description or fallback,
        "comment": comment or "Organizei a descrição em objetivo, resultado esperado e critérios de conclusão. Revise os detalhes antes de criar a tarefa.",
        "generatedBy": "nora" if description else "fallback",
        "userId": tenant_id(user),
    }


@router.post("")
async def criar_tarefa(payload: CriarTarefaPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    if payload.projectId not in {str(item.get("id") or "") for item in await accessible_team_projects(user)}:
        raise HTTPException(status_code=404, detail="Projeto nao encontrado.")
    await validate_task_assignee(user, payload.projectId, payload.assigneeId)
    task = create_task(resolved_user_id, payload.model_dump(exclude={"user_id", "projectName"}))
    await record_task_created(task, payload.projectName, resolved_user_id)
    await record_receipt(
        user,
        ReceiptCreate(
            action="task_created",
            title="Tarefa criada",
            description=f'"{task.get("title")}" foi criada no projeto {clean_project_name(task.get("projectId"), payload.projectName)}.',
            entityType="task",
            entityId=str(task.get("id") or ""),
            undoAction="delete_task",
            metadata={
                "current": task,
                "projectId": task.get("projectId"),
                "projectName": clean_project_name(task.get("projectId"), payload.projectName),
                "status": task.get("status"),
                "priority": task.get("priority"),
            },
        ),
    )
    return {"task": task}


@router.patch("/{task_id}")
async def atualizar_tarefa(task_id: str, payload: AtualizarTarefaPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    updates = {
        key: getattr(payload, key)
        for key in payload.model_fields_set
        if key not in {"user_id", "projectName"}
    }
    previous = await require_task_access(user, task_id)
    if "assigneeId" in updates:
        await validate_task_assignee(user, str(previous.get("projectId")), updates["assigneeId"], task_id=task_id)
    task = update_task(resolved_user_id, task_id, updates)
    if not task:
        raise HTTPException(status_code=404, detail="Tarefa nao encontrada.")
    await record_task_updated(task, previous, updates, payload.projectName, resolved_user_id)
    await record_receipt(
        user,
        ReceiptCreate(
            action="task_updated",
            title="Tarefa atualizada",
            description=f'"{task.get("title")}" teve {len(updates)} campo(s) alterado(s).',
            entityType="task",
            entityId=str(task.get("id") or task_id),
            undoAction="restore_task_snapshot",
            metadata={
                "projectId": task.get("projectId"),
                "changedFields": sorted(updates.keys()),
                "previous": previous or {},
                "current": task,
            },
        ),
    )
    return {"task": task}


@router.delete("/{task_id}")
async def apagar_tarefa(
    task_id: str,
    user_id: str = "lucas123",
    project_id: str | None = None,
    project_name: str | None = None,
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    previous = await require_task_access(user, task_id)
    if delete_task(resolved_user_id, task_id):
        await record_task_deleted(previous, task_id, project_id, project_name, resolved_user_id)
        await record_receipt(
            user,
            ReceiptCreate(
                action="task_deleted",
                title="Tarefa excluida",
                description=f'"{(previous or {}).get("title") or task_id}" foi removida do projeto {clean_project_name(project_id or (previous or {}).get("projectId"), project_name)}.',
                entityType="task",
                entityId=task_id,
                undoAction="restore_task_snapshot",
                metadata={"previous": previous or {}, "projectId": project_id or (previous or {}).get("projectId")},
            ),
        )
        return {"status": "sucesso"}
    raise HTTPException(status_code=404, detail="Tarefa nao encontrada.")


@router.post("/{task_id}/comentarios")
async def comentar_tarefa(task_id: str, payload: ComentarioPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    await require_task_access(user, task_id)
    authenticated_author = str(user.get("nome") or user.get("email") or "Operador").strip()
    comment = add_comment(resolved_user_id, task_id, authenticated_author, payload.text)
    if not comment:
        raise HTTPException(status_code=404, detail="Tarefa nao encontrada.")
    await record_event(
        source="kanban",
        title=f"Comentario em tarefa de {clean_project_name(payload.projectId, payload.projectName)}",
        description=(
            f'{authenticated_author} comentou na tarefa "{(find_task_snapshot(resolved_user_id, task_id) or {}).get("title", task_id)}": '
            f"{payload.text}"
        ),
        metadata={
            "action": "task_comment_added",
            "userId": resolved_user_id,
            "taskId": task_id,
            "projectId": payload.projectId,
            "projectName": clean_project_name(payload.projectId, payload.projectName),
            "commentId": comment.get("id"),
            "author": authenticated_author,
        },
    )
    return {"comment": comment}


@router.post("/{task_id}/anexos")
async def anexar_arquivo(task_id: str, payload: AnexoPayload, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    await require_task_access(user, task_id)
    try:
        attachment = add_attachment(
            resolved_user_id,
            task_id,
            file_name=payload.file_name,
            mime_type=payload.mime_type,
            data_url=payload.data_url,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not attachment:
        raise HTTPException(status_code=404, detail="Tarefa nao encontrada.")
    await record_event(
        source="kanban",
        title=f"Anexo em tarefa de {clean_project_name(payload.projectId, payload.projectName)}",
        description=(
            f'O arquivo "{attachment.get("name", payload.file_name)}" foi anexado na tarefa '
            f'"{(find_task_snapshot(resolved_user_id, task_id) or {}).get("title", task_id)}". '
            f"Tipo: {attachment.get('mimeType')}; tamanho: {attachment.get('size')} bytes."
        ),
        metadata={
            "action": "task_attachment_added",
            "userId": resolved_user_id,
            "taskId": task_id,
            "projectId": payload.projectId,
            "projectName": clean_project_name(payload.projectId, payload.projectName),
            "attachmentId": attachment.get("id"),
            "mimeType": attachment.get("mimeType"),
            "size": attachment.get("size"),
        },
    )
    return {"attachment": attachment}


@router.get("/anexos/{file_name}")
async def baixar_anexo(file_name: str, user: dict[str, Any] = Depends(current_user)):
    path = attachment_path(tenant_id(user), file_name)
    if not path:
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    from app.infrastructure.persistence import files as persistent_files
    return Response(
        persistent_files.read(path), media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{Path(path).name}"', "Cache-Control": "private, no-store"},
    )


@router.post("/agente/mensagem")
async def conversar_agente_tarefas(payload: TaskAgentPayload, user: dict[str, Any] = Depends(current_user)):
    return await handle_task_agent(tenant_id(user), payload.message)


async def handle_task_agent(user_id: str, message: str) -> dict[str, Any]:
    normalized = normalize(message)
    if is_project_create_intent(normalized):
        project_name = extract_project_create_name(message)
        if not project_name:
            return {
                "status": "precisa_dados",
                "response": (
                    "Vamos criar o projeto. Me diga o nome e, se quiser, ja mande categoria, descricao, prazo e responsavel. "
                    "Exemplo: criar projeto Atendimento Premium, categoria cliente, prazo 30/07."
                ),
            }
        project = create_project(
            user_id,
            {
                "name": project_name,
                "description": extract_description(message) or "Projeto criado pela Nora via linguagem natural.",
                "category": extract_category(normalized),
                "defaultPriority": extract_priority(normalized),
                "dueDate": extract_due_date(normalized) or "",
                "owner": "Nora",
            },
        )
        await record_event(
            source="kanban",
            title=f"Projeto criado pela Nora: {project.get('name')}",
            description=(
                f'O projeto "{project.get("name")}" foi criado com categoria {project.get("category")} '
                f'e prioridade padrao {project.get("defaultPriority")}.'
            ),
            metadata={"action": "project_created_by_nora", "userId": user_id, "projectId": project.get("id"), "projectName": project.get("name")},
        )
        return {
            "status": "projeto_criado",
            "response": (
                f"Criei o projeto {project.get('name')}.\n"
                f"Categoria: {project.get('category')}\n"
                f"Prioridade padrao: {project.get('defaultPriority')}\n"
                f"Prazo: {project.get('dueDate') or 'sem prazo'}"
            ),
            "project": project,
        }

    if is_delete_intent(normalized):
        title = extract_after(message, ["excluir tarefa", "exclua a tarefa", "apagar tarefa", "apague a tarefa", "remover tarefa", "remova a tarefa"])
        all_tasks: list[dict[str, Any]] = []
        for status_filter in ("ativas", "andamento", "concluida"):
            all_tasks.extend(list_tasks(user_id, status=status_filter).get("tasks", []))
        match = find_task(all_tasks, title)
        if not match:
            return {"status": "nao_encontrada", "response": "Nao achei essa tarefa. Me diga um trecho mais especifico do titulo."}
        reference = activity_project(user_id, {"taskId": match.get("id")})
        if not delete_task(user_id, str(match.get("id"))):
            return {"status": "nao_executada", "response": "A tarefa foi localizada, mas nao pude exclui-la."}
        await record_event(
            source="kanban",
            title=f"Tarefa excluida pela Nora: {match.get('title')}",
            description=f'A tarefa "{match.get("title")}" do projeto {match.get("projectName") or "Operacao Norium"} foi excluida apos aprovacao.',
            metadata={
                "taskProject": reference,
                "action": "task_deleted_by_nora",
                "userId": user_id,
                "taskId": match.get("id"),
                "projectId": match.get("projectId"),
                "projectName": match.get("projectName"),
            },
        )
        return {"status": "excluida", "response": f"Exclui a tarefa: {match.get('title')}.", "task": match}

    if is_status_update_intent(normalized):
        target_status = status_from_text(normalized)
        title = extract_status_title(message)
        all_tasks = list_tasks(user_id, status="ativas").get("tasks", [])
        if target_status == "concluida":
            all_tasks += list_tasks(user_id, status="andamento").get("tasks", [])
        match = find_task(all_tasks, title)
        if not match:
            return {"status": "nao_encontrada", "response": "Nao achei essa tarefa. Me diga um trecho mais especifico do titulo."}
        previous = dict(match)
        task = update_task(user_id, match["id"], {"status": target_status})
        if task:
            await record_task_updated(task, previous, {"status": target_status}, None, user_id)
        return {
            "status": "atualizada",
            "response": f"Atualizei {task['title']} para {status_label(target_status)}.",
            "task": task,
        }

    if is_plan_intent(normalized):
        data = list_tasks(
            user_id,
            status="ativas",
            priority=priority_filter_from_text(normalized),
            due=due_filter_from_text(normalized),
        )
        tasks = rank_tasks_for_planning(data.get("tasks", []))[:5]
        if not tasks:
            return {"status": "planejamento", "response": "Nao encontrei tarefas ativas para priorizar agora.", "tasks": [], "total": 0}
        lines = []
        for index, task in enumerate(tasks, start=1):
            due = task.get("dueDate") or "sem vencimento"
            lines.append(f"{index}. {task['title']} - {task['priority']} - {due}")
        return {
            "status": "planejamento",
            "response": "Eu comecaria por aqui:\n" + "\n".join(lines),
            "tasks": tasks,
        }

    if is_filtered_list_intent(normalized):
        data = list_tasks(
            user_id,
            status="concluida" if "concluida" in normalized else "ativas",
            priority=priority_filter_from_text(normalized),
            due=due_filter_from_text(normalized),
        )
        tasks = data.get("tasks", [])[:8]
        if not tasks:
            return {"status": "consulta", "response": "Nao encontrei tarefas nesse filtro.", "tasks": [], "total": 0}
        lines = [f"- {task['title']} ({task['priority']}, {task.get('dueDate') or 'sem vencimento'})" for task in tasks]
        return {"status": "consulta", "response": "Aqui estao suas tarefas filtradas:\n" + "\n".join(lines), "tasks": tasks, "total": len(data.get("tasks", []))}

    if is_list_intent(normalized):
        status = "concluida" if "concluida" in normalized else "ativas"
        data = list_tasks(user_id, status=status)
        tasks = data.get("tasks", [])[:8]
        if not tasks:
            return {"status": "consulta", "response": "Não encontrei tarefas nesse filtro.", "tasks": [], "total": 0}
        lines = [f"- {task['title']} ({task['priority']}, {task.get('dueDate') or 'sem vencimento'})" for task in tasks]
        return {"status": "consulta", "response": "Aqui estão suas tarefas:\n" + "\n".join(lines), "tasks": tasks, "total": len(data.get("tasks", []))}

    if is_complete_intent(normalized):
        title = extract_after(message, ["concluir", "finalizar", "marcar como concluida", "marcar como concluída"])
        all_tasks = list_tasks(user_id, status="ativas").get("tasks", [])
        match = find_task(all_tasks, title)
        if not match:
            return {"status": "nao_encontrada", "response": "Não achei essa tarefa ativa. Me diga um trecho mais específico do título."}
        previous = dict(match)
        task = update_task(user_id, match["id"], {"status": "concluida"})
        if task:
            await record_task_updated(task, previous, {"status": "concluida"}, None, user_id)
        return {"status": "concluida", "response": f"Marquei como concluída: {task['title']}", "task": task}

    if is_create_intent(normalized):
        title = extract_title_for_create(message)
        if not title:
            return {"status": "precisa_titulo", "response": "Qual é o título da tarefa que você quer criar?"}
        project_name = extract_project_name(message)
        project_id = project_id_from_name(project_name) if project_name else "default"
        task = create_task(
            user_id,
            {
                "title": title,
                "description": extract_description(message) or "Criada pela Nora via Agente de Tarefas.",
                "projectId": project_id,
                "projectName": project_name,
                "category": extract_category(normalized),
                "priority": extract_priority(normalized),
                "labels": extract_labels(normalized),
                "dueDate": extract_due_date(normalized),
                "status": "pendente",
            },
        )
        await record_task_created(task, project_name, user_id)
        project_label = project_name or "Operacao Norium"
        return {"status": "criada", "response": f"Criei a tarefa: {task['title']} no projeto {project_label}.", "task": task}

    data = list_tasks(user_id, status="ativas")
    stats = data.get("stats", {})
    return {
        "status": "resumo",
        "response": (
            f"Você tem {stats.get('ativas', 0)} tarefas ativas, "
            f"{stats.get('andamento', 0)} em andamento e {stats.get('vencidas', 0)} vencidas."
        ),
        "stats": stats,
    }


def is_list_intent(value: str) -> bool:
    return any(word in value for word in ["listar", "mostrar", "ver tarefas", "minhas tarefas", "pendentes", "concluidas"])


def is_create_intent(value: str) -> bool:
    return any(
        word in value
        for word in [
            "criar tarefa",
            "criar uma tarefa",
            "nova tarefa",
            "adicionar tarefa",
            "adiciona tarefa",
            "cadastre uma tarefa",
            "crie uma tarefa",
            "colocar tarefa",
            "me lembre de",
            "me lembra de",
            "preciso fazer",
        ]
    )


def is_delete_intent(value: str) -> bool:
    return bool(
        re.search(r"\b(?:excluir|exclua|apagar|apague|remover|remova)\b", value)
        and re.search(r"\b(?:tarefa|card)\b", value)
    )


def is_project_create_intent(value: str) -> bool:
    return bool(
        re.search(r"\b(criar|crie|novo|nova|adicionar|cadastre)\s+(?:um|uma)?\s*(projeto|lista)\b", value)
        or value.strip() in {"criar projeto", "crie projeto", "novo projeto", "nova lista", "criar lista"}
    )


def is_complete_intent(value: str) -> bool:
    return any(word in value for word in ["concluir", "finalizar", "marcar como concluida", "marcar como concluída"])


def extract_after(message: str, markers: list[str]) -> str:
    lower = message.lower()
    for marker in markers:
        index = lower.find(marker)
        if index >= 0:
            return message[index + len(marker):].strip(" :-.,")
    return message.strip()


def extract_title_for_create(message: str) -> str:
    cleaned = re.sub(r"\b(criar|crie|nova|novo|adicionar|cadastre|uma|tarefa|task|chamada|chamado|nomeada|nomeado)\b", "", message, flags=re.I)
    cleaned = re.sub(r"\b(?:no|na|para o|para a|do|da)\s+(?:projeto|lista)\s+[^,.;]+", " ", cleaned, flags=re.I)
    cleaned = re.split(r"\b(para hoje|para amanha|até|ate|com prioridade|prioridade|#)\b", cleaned, maxsplit=1, flags=re.I)[0]
    return cleaned.strip(" :-.,")[:160]


def extract_project_create_name(message: str) -> str:
    match = re.search(
        r"\b(?:criar|crie|novo|nova|adicionar|cadastre)\s+(?:um|uma)?\s*(?:projeto|lista)\s*(?:chamado|chamada|com nome|nomeado|nomeada)?\s*(.*)$",
        message,
        flags=re.I | re.S,
    )
    value = match.group(1) if match else ""
    value = re.split(
        r"\b(?:categoria|descricao|descri|prazo|vencimento|responsavel|com prioridade|prioridade|para hoje|para amanha|ate|at)\b",
        value,
        maxsplit=1,
        flags=re.I,
    )[0]
    value = value.strip(" :-.,")
    if normalize(value) in {"", "projeto", "lista", "um", "uma", "novo", "nova"}:
        return ""
    return value[:160]


def extract_project_name(message: str) -> str | None:
    match = re.search(r"\b(?:no|na|para o|para a|do|da)?\s*(?:projeto|lista)\s+([a-zA-Z0-9 _.-]{2,100})", message, flags=re.I)
    if not match:
        return None
    name = re.split(r"\b(para hoje|para amanha|ate|atÃ©|com prioridade|prioridade|categoria|descricao|descriÃ§Ã£o|#)\b", match.group(1), maxsplit=1, flags=re.I)[0]
    return name.strip(" :-.,")[:80] or None


def project_id_from_name(name: str | None) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", normalize(name or "default")).strip("-")
    return slug[:80] or "default"


def extract_description(message: str) -> str:
    match = re.search(r"\b(?:descricao|descriÃ§Ã£o|obs|observacao|observaÃ§Ã£o)\s*[:\-]\s*(.+)$", message, flags=re.I | re.S)
    return match.group(1).strip()[:600] if match else ""


def extract_category(normalized: str) -> str:
    for category in ["produto", "cliente", "financeiro", "operacao", "suporte", "comercial", "pessoal"]:
        if category in normalized:
            return category
    return "geral"


def extract_priority(normalized: str) -> str:
    if "urgente" in normalized:
        return "urgente"
    if "alta" in normalized:
        return "alta"
    if "baixa" in normalized:
        return "baixa"
    return "media"


def extract_labels(normalized: str) -> list[str]:
    labels = []
    for label in ["produto", "cliente", "financeiro", "operacao"]:
        if label in normalized:
            labels.append(label)
    hashtag_labels = re.findall(r"#([a-z0-9_-]+)", normalized)
    return sorted(set(labels + hashtag_labels))


def extract_due_date(normalized: str) -> str | None:
    today = datetime.now(timezone(timedelta(hours=-3))).date()
    if "hoje" in normalized:
        return today.isoformat()
    if "amanha" in normalized:
        return (today + timedelta(days=1)).isoformat()
    match = re.search(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b", normalized)
    if match:
        day = int(match.group(1))
        month = int(match.group(2))
        year = int(match.group(3) or today.year)
        year = 2000 + year if year < 100 else year
        try:
            parsed = date(year, month, day)
            if parsed < today and not match.group(3):
                parsed = date(today.year + 1, month, day)
            return parsed.isoformat()
        except ValueError:
            return None
    return None


def find_task(tasks: list[dict[str, Any]], title: str) -> dict[str, Any] | None:
    needle = normalize(title)
    if not needle:
        return tasks[0] if tasks else None
    return next((task for task in tasks if needle in normalize(task.get("title", ""))), None)


def normalize(value: str) -> str:
    lowered = value.lower().strip()
    return "".join(char for char in unicodedata.normalize("NFKD", lowered) if not unicodedata.combining(char))


def is_list_intent(value: str) -> bool:
    if is_create_intent(value) or is_project_create_intent(value):
        return False
    return any(
        word in value
        for word in [
            "listar",
            "mostrar",
            "ver tarefas",
            "minhas tarefas",
            "pendentes",
            "concluidas",
            "alta prioridade",
            "prioridade alta",
            "urgentes",
            "vencidas",
            "atrasadas",
        ]
    )


def is_plan_intent(value: str) -> bool:
    return any(
        word in value
        for word in [
            "por onde comecar",
            "qual tarefa comecar",
            "quais tarefas comecar",
            "planejar tarefas",
            "priorizar tarefas",
            "organizar tarefas",
            "comecar primeiro",
        ]
    )


def is_status_update_intent(value: str) -> bool:
    return bool(
        re.search(r"\b(mudar|alterar|atualizar|mover|colocar|marcar)\b", value)
        and re.search(r"\b(pendente|andamento|revisao|concluida|feito|finalizada)\b", value)
    )


def is_filtered_list_intent(value: str) -> bool:
    return is_list_intent(value) and (
        priority_filter_from_text(value) is not None
        or due_filter_from_text(value) is not None
        or "concluida" in value
    )


def status_from_text(value: str) -> str:
    if "concluida" in value or "feito" in value or "finalizada" in value:
        return "concluida"
    if "revisao" in value:
        return "revisao"
    if "andamento" in value or "progresso" in value:
        return "andamento"
    return "pendente"


def status_label(status: str) -> str:
    return {
        "pendente": "pendente",
        "andamento": "em andamento",
        "revisao": "em revisao",
        "concluida": "concluida",
    }.get(status, status)


def priority_filter_from_text(value: str) -> str | None:
    if "urgente" in value:
        return "urgente"
    if "alta prioridade" in value or "prioridade alta" in value:
        return "alta"
    if "baixa prioridade" in value or "prioridade baixa" in value:
        return "baixa"
    return None


def due_filter_from_text(value: str) -> str | None:
    if "vencida" in value or "atrasada" in value:
        return "vencidas"
    if "hoje" in value:
        return "hoje"
    return None


def extract_status_title(message: str) -> str:
    cleaned = re.sub(
        r"\b(mudar|alterar|atualizar|mover|colocar|marcar|a tarefa|tarefa|para|como|status|pendente|andamento|revisao|concluida|feito|finalizada)\b",
        " ",
        message,
        flags=re.I,
    )
    return re.sub(r"\s+", " ", cleaned).strip(" :-.,")


def rank_tasks_for_planning(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    today = datetime.now(timezone(timedelta(hours=-3))).date()
    priority_weight = {"urgente": 0, "alta": 1, "media": 2, "baixa": 3}

    def due_weight(task: dict[str, Any]) -> int:
        due_value = task.get("dueDate")
        if not due_value:
            return 9999
        try:
            parsed = date.fromisoformat(str(due_value)[:10])
        except ValueError:
            return 9999
        return (parsed - today).days

    return sorted(
        tasks,
        key=lambda task: (
            priority_weight.get(task.get("priority", "media"), 2),
            due_weight(task),
            task.get("title", ""),
        ),
    )
