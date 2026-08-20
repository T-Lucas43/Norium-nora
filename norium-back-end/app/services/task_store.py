from __future__ import annotations

import base64
import json
import mimetypes
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from app.core.tenant import get_data_root, get_user_db_path, public_api_url, read_json_file, write_json_file

BASE_DIR = Path(__file__).resolve().parents[2]
TASKS_PATH = BASE_DIR / "tarefas_db.json"
TASK_UPLOAD_DIR = get_data_root() / "task_uploads"
TASK_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_COLUMNS = [
    {"id": "pendente", "title": "Pendentes", "limit": None},
    {"id": "andamento", "title": "Em andamento", "limit": 5},
    {"id": "revisao", "title": "Em revisão", "limit": 4},
    {"id": "concluida", "title": "Concluídas", "limit": None},
]

DEFAULT_LABELS = [
    {"id": "produto", "name": "Produto", "color": "#60A5FA"},
    {"id": "cliente", "name": "Cliente", "color": "#34D399"},
    {"id": "financeiro", "name": "Financeiro", "color": "#FBBF24"},
    {"id": "operacao", "name": "Operação", "color": "#22D3EE"},
]

PRIORITIES = {"baixa", "media", "alta", "urgente"}
PROJECT_STATUSES = {"planejamento", "ativo", "pausado", "concluido"}
PROJECT_CATEGORIES = {"operacao", "cliente", "produto", "financeiro", "suporte", "pessoal"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_project(user_id: str = "lucas123") -> dict[str, Any]:
    return {
        "id": "default",
        "name": "Operacao Norium",
        "category": "operacao",
        "description": "Quadro principal de tarefas, prazos, anexos e comentarios.",
        "color": "#0EA5E9",
        "defaultPriority": "media",
        "owner": "Operador",
        "ownerUserId": user_id,
        "responsibleUserId": user_id,
        "responsibleName": "Operador",
        "sharedUserIds": [],
        "status": "ativo",
        "startDate": "",
        "dueDate": "",
        "defaultStartTime": "09:00",
        "calendarDurationMinutes": 60,
        "archived": False,
        "archivedAt": None,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }


def load_workspace(user_id: str = "lucas123") -> dict[str, Any]:
    db = _read_db()
    if user_id not in db:
        db[user_id] = {
            "columns": DEFAULT_COLUMNS,
            "labels": DEFAULT_LABELS,
            "projects": [default_project(user_id)],
            "tasks": [],
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        _write_db(db)
    else:
        workspace = db[user_id]
        changed = ensure_workspace_defaults(workspace, user_id)
        if changed:
            db[user_id] = workspace
            _write_db(db)
    return db[user_id]


def ensure_workspace_defaults(workspace: dict[str, Any], user_id: str) -> bool:
    changed = False
    if not isinstance(workspace.get("columns"), list):
        workspace["columns"] = DEFAULT_COLUMNS
        changed = True
    if not isinstance(workspace.get("labels"), list):
        workspace["labels"] = DEFAULT_LABELS
        changed = True
    if not isinstance(workspace.get("tasks"), list):
        workspace["tasks"] = []
        changed = True
    if not isinstance(workspace.get("projects"), list) or not workspace.get("projects"):
        workspace["projects"] = [default_project(user_id)]
        changed = True
    workspace["projects"] = [normalize_project(project, user_id) for project in workspace.get("projects", [])]
    return changed


def list_projects(user_id: str = "lucas123") -> dict[str, Any]:
    db = _read_db()
    if user_id not in db:
        load_workspace(user_id)
        db = _read_db()

    projects: list[dict[str, Any]] = []
    for owner_id, workspace in db.items():
        if not isinstance(workspace, dict):
            continue
        ensure_workspace_defaults(workspace, str(owner_id))
        for project in workspace.get("projects", []):
            normalized = normalize_project(project, str(owner_id))
            if project_accessible(normalized, user_id):
                projects.append(normalized)

    projects.sort(key=lambda item: (bool(item.get("archived")), str(item.get("name", "")).lower()))
    return {"projects": projects, "updatedAt": now_iso()}


def create_project(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    db = _read_db()
    workspace = load_workspace(user_id)
    db = _read_db()
    project = normalize_project(
        {
            **payload,
            "id": str(payload.get("id") or f"workspace_{uuid.uuid4().hex[:12]}"),
            "ownerUserId": user_id,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "archived": False,
            "archivedAt": None,
        },
        user_id,
    )
    workspace.setdefault("projects", []).insert(0, project)
    workspace["updatedAt"] = now_iso()
    db[user_id] = workspace
    _write_db(db)
    return project


def update_project(user_id: str, project_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    db = _read_db()
    resolved = resolve_project_workspace(db, user_id, project_id)
    if not resolved:
        return None
    owner_id, workspace, project = resolved
    if owner_id != user_id:
        return None
    projects = workspace.setdefault("projects", [])
    for index, item in enumerate(projects):
        if str(item.get("id")) != str(project_id):
            continue
        changed = dict(project)
        for key in (
            "name",
            "category",
            "description",
            "color",
            "defaultPriority",
            "owner",
            "responsibleUserId",
            "responsibleName",
            "sharedUserIds",
            "status",
            "startDate",
            "dueDate",
            "defaultStartTime",
            "calendarDurationMinutes",
            "archived",
            "archivedAt",
        ):
            if key in updates:
                changed[key] = updates[key]
        changed["updatedAt"] = now_iso()
        projects[index] = normalize_project(changed, owner_id)
        workspace["updatedAt"] = now_iso()
        db[owner_id] = workspace
        _write_db(db)
        return projects[index]
    return None


def delete_project(user_id: str, project_id: str) -> bool:
    db = _read_db()
    resolved = resolve_project_workspace(db, user_id, project_id)
    if not resolved:
        return False
    owner_id, workspace, _project = resolved
    if owner_id != user_id:
        return False
    workspace["projects"] = [project for project in workspace.get("projects", []) if str(project.get("id")) != str(project_id)]
    workspace["tasks"] = [task for task in workspace.get("tasks", []) if str(task.get("projectId") or "default") != str(project_id)]
    if not workspace["projects"]:
        workspace["projects"] = [default_project(owner_id)]
    workspace["updatedAt"] = now_iso()
    db[owner_id] = workspace
    _write_db(db)
    return True


def list_tasks(
    user_id: str = "lucas123",
    *,
    project_id: str | None = None,
    status: str | None = None,
    q: str | None = None,
    category: str | None = None,
    priority: str | None = None,
    label: str | None = None,
    due: str | None = None,
) -> dict[str, Any]:
    db = _read_db()
    workspace = load_workspace(user_id)
    all_tasks = visible_tasks_for_user(db, user_id, project_id)
    tasks = list(all_tasks)
    today = _local_today()

    if status and status != "todas":
        if status == "ativas":
            tasks = [task for task in tasks if task.get("status") != "concluida"]
        else:
            tasks = [task for task in tasks if task.get("status") == status]

    if priority and priority != "todas":
        tasks = [task for task in tasks if task.get("priority") == priority]

    if category and category != "todas":
        tasks = [task for task in tasks if task.get("category") == category]

    if label and label != "todas":
        tasks = [task for task in tasks if label in task.get("labels", [])]

    if q:
        query = q.lower().strip()
        tasks = [
            task
            for task in tasks
            if query in f"{task.get('title', '')} {task.get('description', '')} {task.get('category', '')}".lower()
        ]

    if due and due != "todas":
        tasks = [task for task in tasks if _matches_due_filter(task.get("dueDate"), due, today)]

    tasks.sort(key=lambda task: (task.get("status", ""), int(task.get("order") or 0), task.get("createdAt", "")))
    return {
        "columns": workspace.get("columns", DEFAULT_COLUMNS),
        "labels": workspace.get("labels", DEFAULT_LABELS),
        "tasks": tasks,
        "stats": build_stats(all_tasks),
        "updatedAt": workspace.get("updatedAt"),
    }


def create_task(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    db = _read_db()
    status = payload.get("status") or "pendente"
    project_id = str(payload.get("projectId") or "default").strip() or "default"
    resolved = resolve_project_workspace(db, user_id, project_id)
    if resolved:
        owner_id, workspace, project = resolved
    else:
        owner_id = user_id
        workspace = load_workspace(user_id)
        project = default_project(user_id)
    task = normalize_task(
        {
            "id": f"task_{uuid.uuid4().hex}",
            "projectId": project_id,
            "title": payload.get("title"),
            "description": payload.get("description", ""),
            "category": payload.get("category", "geral"),
            "status": status,
            "priority": payload.get("priority", "media"),
            "labels": payload.get("labels", []),
            "dueDate": payload.get("dueDate"),
            "assigneeId": payload.get("assigneeId") or project.get("responsibleUserId") or user_id,
            "assigneeName": payload.get("assigneeName") or project.get("responsibleName") or payload.get("authorName") or "Responsavel",
            "createdBy": user_id,
            "attachments": payload.get("attachments", []),
            "comments": payload.get("comments", []),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "completedAt": now_iso() if status == "concluida" else None,
            "order": next_order(workspace.get("tasks", []), status, project_id),
        }
    )
    workspace.setdefault("tasks", []).append(task)
    workspace["updatedAt"] = now_iso()
    db[owner_id] = workspace
    _write_db(db)
    return task


def update_task(user_id: str, task_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    db = _read_db()
    resolved = resolve_task_workspace(db, user_id, task_id)
    if not resolved:
        return None
    owner_id, workspace, _task = resolved
    tasks = workspace.setdefault("tasks", [])
    for index, task in enumerate(tasks):
        if task.get("id") != task_id:
            continue
        changed = dict(task)
        for key in ("title", "description", "category", "status", "priority", "labels", "dueDate", "order", "assigneeId", "assigneeName"):
            if key in updates:
                changed[key] = updates[key]
        if changed.get("status") == "concluida" and not changed.get("completedAt"):
            changed["completedAt"] = now_iso()
        if changed.get("status") != "concluida":
            changed["completedAt"] = None
        changed["updatedAt"] = now_iso()
        tasks[index] = normalize_task(changed)
        workspace["updatedAt"] = now_iso()
        db[owner_id] = workspace
        _write_db(db)
        return tasks[index]
    return None


def delete_task(user_id: str, task_id: str) -> bool:
    db = _read_db()
    resolved = resolve_task_workspace(db, user_id, task_id)
    if not resolved:
        return False
    owner_id, workspace, _task = resolved
    tasks = workspace.setdefault("tasks", [])
    before = len(tasks)
    workspace["tasks"] = [task for task in tasks if task.get("id") != task_id]
    if len(workspace["tasks"]) == before:
        return False
    workspace["updatedAt"] = now_iso()
    db[owner_id] = workspace
    _write_db(db)
    return True


def restore_task(user_id: str, snapshot: dict[str, Any]) -> dict[str, Any] | None:
    """Restaura exatamente o card capturado em um comprovante operacional."""
    task_id = str(snapshot.get("id") or "").strip()
    if not task_id:
        return None
    db = _read_db()
    workspace = load_workspace(user_id)
    db = _read_db()
    tasks = workspace.setdefault("tasks", [])
    restored = normalize_task({**snapshot, "id": task_id, "updatedAt": now_iso()})
    for index, current in enumerate(tasks):
        if str(current.get("id")) == task_id:
            tasks[index] = restored
            break
    else:
        tasks.append(restored)
    workspace["updatedAt"] = now_iso()
    db[user_id] = workspace
    _write_db(db)
    return restored


def add_comment(user_id: str, task_id: str, author: str, text: str) -> dict[str, Any] | None:
    db = _read_db()
    resolved = resolve_task_workspace(db, user_id, task_id)
    if not resolved:
        return None
    owner_id, workspace, _task = resolved
    for task in workspace.setdefault("tasks", []):
        if task.get("id") != task_id:
            continue
        comment = {
            "id": f"comment_{uuid.uuid4().hex}",
            "author": author or "Operador",
            "text": text,
            "createdAt": now_iso(),
        }
        task.setdefault("comments", []).append(comment)
        task["updatedAt"] = now_iso()
        workspace["updatedAt"] = now_iso()
        db[owner_id] = workspace
        _write_db(db)
        return comment
    return None


def add_attachment(user_id: str, task_id: str, *, file_name: str, mime_type: str, data_url: str) -> dict[str, Any] | None:
    db = _read_db()
    resolved = resolve_task_workspace(db, user_id, task_id)
    if not resolved:
        return None
    owner_id, workspace, _task = resolved
    file_bytes, detected_mime = decode_data_url(data_url, mime_type)
    safe_name = safe_upload_name(file_name, detected_mime)
    file_path = TASK_UPLOAD_DIR / safe_name
    file_path.write_bytes(file_bytes)

    attachment = {
        "id": f"att_{uuid.uuid4().hex}",
        "name": Path(file_name).name or safe_name,
        "mimeType": detected_mime,
        "size": len(file_bytes),
        "url": public_api_url(f"/api/tarefas/anexos/{quote(safe_name)}"),
        "storedName": safe_name,
        "createdAt": now_iso(),
    }

    for task in workspace.setdefault("tasks", []):
        if task.get("id") != task_id:
            continue
        task.setdefault("attachments", []).append(attachment)
        task["updatedAt"] = now_iso()
        workspace["updatedAt"] = now_iso()
        db[owner_id] = workspace
        _write_db(db)
        return attachment
    return None


def attachment_path(user_id: str, file_name: str) -> Path | None:
    safe_name = Path(file_name).name
    db = _read_db()
    authorized = False
    for owner_id, workspace in db.items():
        if not isinstance(workspace, dict):
            continue
        for task in workspace.get("tasks", []):
            project_id = str(task.get("projectId") or "default")
            project = next(
                (item for item in workspace.get("projects", []) if str(item.get("id")) == project_id),
                None,
            )
            if not project or not project_accessible(normalize_project(project, str(owner_id)), user_id):
                continue
            if any(
                Path(str(attachment.get("storedName") or "")).name == safe_name
                for attachment in task.get("attachments", [])
                if isinstance(attachment, dict)
            ):
                authorized = True
                break
        if authorized:
            break
    if not authorized:
        return None
    path = TASK_UPLOAD_DIR / safe_name
    if not path.exists() or not path.is_file():
        return None
    return path


def build_stats(tasks: list[dict[str, Any]]) -> dict[str, int]:
    today = _local_today()
    return {
        "total": len(tasks),
        "ativas": len([task for task in tasks if task.get("status") != "concluida"]),
        "pendentes": len([task for task in tasks if task.get("status") == "pendente"]),
        "andamento": len([task for task in tasks if task.get("status") == "andamento"]),
        "concluidas": len([task for task in tasks if task.get("status") == "concluida"]),
        "vencidas": len([task for task in tasks if _is_overdue(task.get("dueDate"), today) and task.get("status") != "concluida"]),
    }


def normalize_task(task: dict[str, Any]) -> dict[str, Any]:
    title = str(task.get("title") or "").strip()
    priority = str(task.get("priority") or "media").lower()
    status = str(task.get("status") or "pendente").lower()
    project_id = str(task.get("projectId") or "default").strip() or "default"
    category = str(task.get("category") or "geral").strip().lower() or "geral"
    return {
        **task,
        "projectId": project_id[:120],
        "title": title[:160],
        "description": str(task.get("description") or "")[:4000],
        "category": category[:80],
        "status": status if status in {column["id"] for column in DEFAULT_COLUMNS} else "pendente",
        "priority": priority if priority in PRIORITIES else "media",
        "labels": [str(label) for label in task.get("labels", []) if str(label).strip()],
        "assigneeId": str(task.get("assigneeId") or "").strip()[:120],
        "assigneeName": str(task.get("assigneeName") or "Responsavel").strip()[:160] or "Responsavel",
        "createdBy": str(task.get("createdBy") or "").strip()[:120],
        "attachments": list(task.get("attachments", [])),
        "comments": list(task.get("comments", [])),
        "order": int(task.get("order") or 0),
    }


def normalize_project(project: dict[str, Any], owner_id: str) -> dict[str, Any]:
    project_id = str(project.get("id") or "default").strip() or "default"
    category = str(project.get("category") or "operacao").lower()
    status = str(project.get("status") or "ativo").lower()
    priority = str(project.get("defaultPriority") or "media").lower()
    shared_ids = [
        str(item).strip()
        for item in project.get("sharedUserIds", [])
        if str(item).strip() and str(item).strip() != owner_id
    ]
    return {
        **project,
        "id": project_id[:120],
        "name": str(project.get("name") or "Projeto sem nome").strip()[:160] or "Projeto sem nome",
        "category": category if category in PROJECT_CATEGORIES else "operacao",
        "description": str(project.get("description") or "Lista de tarefas do Norium.").strip()[:2000],
        "color": str(project.get("color") or "#0EA5E9")[:32],
        "defaultPriority": priority if priority in PRIORITIES else "media",
        "owner": str(project.get("owner") or "Operador").strip()[:160] or "Operador",
        "ownerUserId": str(project.get("ownerUserId") or owner_id),
        "responsibleUserId": str(project.get("responsibleUserId") or project.get("ownerUserId") or owner_id).strip()[:120],
        "responsibleName": str(project.get("responsibleName") or project.get("owner") or "Responsavel").strip()[:160] or "Responsavel",
        "sharedUserIds": sorted(set(shared_ids)),
        "status": status if status in PROJECT_STATUSES else "ativo",
        "startDate": _date_or_blank(project.get("startDate")),
        "dueDate": _date_or_blank(project.get("dueDate")),
        "defaultStartTime": str(project.get("defaultStartTime") or "09:00")[:5],
        "calendarDurationMinutes": max(15, min(int(project.get("calendarDurationMinutes") or 60), 480)),
        "archived": bool(project.get("archived")),
        "archivedAt": project.get("archivedAt"),
        "createdAt": project.get("createdAt") or now_iso(),
        "updatedAt": project.get("updatedAt") or now_iso(),
    }


def project_accessible(project: dict[str, Any], user_id: str) -> bool:
    return project.get("ownerUserId") == user_id or user_id in (project.get("sharedUserIds") or [])


def resolve_project_workspace(
    db: dict[str, Any],
    user_id: str,
    project_id: str | None,
) -> tuple[str, dict[str, Any], dict[str, Any]] | None:
    normalized_project_id = str(project_id or "default").strip() or "default"
    for owner_id, workspace in db.items():
        if not isinstance(workspace, dict):
            continue
        ensure_workspace_defaults(workspace, str(owner_id))
        for project in workspace.get("projects", []):
            normalized = normalize_project(project, str(owner_id))
            if normalized.get("id") == normalized_project_id and project_accessible(normalized, user_id):
                return str(owner_id), workspace, normalized
    return None


def resolve_task_workspace(
    db: dict[str, Any],
    user_id: str,
    task_id: str,
) -> tuple[str, dict[str, Any], dict[str, Any]] | None:
    for owner_id, workspace in db.items():
        if not isinstance(workspace, dict):
            continue
        ensure_workspace_defaults(workspace, str(owner_id))
        visible_project_ids = {
            project.get("id")
            for project in workspace.get("projects", [])
            if project_accessible(normalize_project(project, str(owner_id)), user_id)
        }
        for task in workspace.get("tasks", []):
            if str(task.get("id")) != str(task_id):
                continue
            project_id = str(task.get("projectId") or "default")
            if project_id in visible_project_ids or str(owner_id) == user_id:
                return str(owner_id), workspace, task
    return None


def visible_tasks_for_user(db: dict[str, Any], user_id: str, project_id: str | None = None) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    if project_id:
        resolved = resolve_project_workspace(db, user_id, project_id)
        if not resolved:
            return []
        _owner_id, workspace, _project = resolved
        return [normalize_task(task) for task in workspace.get("tasks", []) if _matches_project(task, project_id)]

    for owner_id, workspace in db.items():
        if not isinstance(workspace, dict):
            continue
        ensure_workspace_defaults(workspace, str(owner_id))
        visible_project_ids = {
            project.get("id")
            for project in workspace.get("projects", [])
            if project_accessible(normalize_project(project, str(owner_id)), user_id)
        }
        for task in workspace.get("tasks", []):
            task_project = str(task.get("projectId") or "default")
            if task_project in visible_project_ids or str(owner_id) == user_id:
                tasks.append(normalize_task(task))
    return tasks


def next_order(tasks: list[dict[str, Any]], status: str, project_id: str = "default") -> int:
    same_column = [
        int(task.get("order") or 0)
        for task in tasks
        if task.get("status") == status and _matches_project(task, project_id)
    ]
    return (max(same_column) + 1) if same_column else 1


def _matches_project(task: dict[str, Any], project_id: str | None) -> bool:
    if not project_id:
        return True
    normalized_project = str(project_id).strip() or "default"
    task_project = str(task.get("projectId") or "default").strip() or "default"
    return task_project == normalized_project


def _date_or_blank(value: Any) -> str:
    parsed = _parse_local_date(str(value) if value else None)
    return parsed.isoformat() if parsed else ""


def decode_data_url(data_url: str, fallback_mime: str) -> tuple[bytes, str]:
    match = re.match(r"^data:([^,]*),(.*)$", data_url, flags=re.DOTALL)
    if not match or "base64" not in match.group(1).lower():
        raise ValueError("Anexo invalido. Envie data URL base64.")
    metadata = [part for part in match.group(1).split(";") if part and part.lower() != "base64"]
    mime_type = next((part for part in metadata if "/" in part), fallback_mime or "application/octet-stream")
    file_bytes = base64.b64decode(match.group(2), validate=True)
    if not file_bytes:
        raise ValueError("Anexo vazio.")
    if len(file_bytes) > 15 * 1024 * 1024:
        raise ValueError("Anexo acima do limite de 15 MB.")
    return file_bytes, mime_type


def safe_upload_name(file_name: str, mime_type: str) -> str:
    suffix = Path(file_name).suffix.lower().lstrip(".")
    if not suffix:
        suffix = (mimetypes.guess_extension(mime_type) or ".bin").lstrip(".")
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(file_name).stem or "anexo").strip("._") or "anexo"
    return f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}_{stem[:48]}.{suffix[:12]}"


def _matches_due_filter(value: str | None, due: str, today: datetime) -> bool:
    parsed = _parse_local_date(value)
    if not parsed:
        return False
    if due == "vencidas":
        return parsed < today.date()
    if due == "hoje":
        return parsed == today.date()
    if due == "semana":
        return today.date() <= parsed <= (today + timedelta(days=7)).date()
    if due == "sem_data":
        return False
    return True


def _is_overdue(value: str | None, today: datetime) -> bool:
    parsed = _parse_local_date(value)
    return bool(parsed and parsed < today.date())


def _parse_local_date(value: str | None):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value[:10]).date()
    except ValueError:
        return None


def _local_today() -> datetime:
    return datetime.now(timezone(timedelta(hours=-3)))


def _read_db() -> dict[str, Any]:
    db: dict[str, Any] = {}
    legacy_payload = read_json_file(TASKS_PATH, {})
    if isinstance(legacy_payload, dict):
        db.update({str(key): value for key, value in legacy_payload.items() if isinstance(value, dict)})

    data_root = get_data_root()
    for user_dir in data_root.glob("user_*"):
        if not user_dir.is_dir():
            continue
        user_id = user_dir.name.removeprefix("user_")
        payload = read_json_file(user_dir / "tarefas_db.json", {})
        if isinstance(payload, dict):
            if "tasks" in payload or "projects" in payload:
                db[user_id] = payload
            elif isinstance(payload.get(user_id), dict):
                db[user_id] = payload[user_id]
    return db


def _write_db(payload: dict[str, Any]) -> None:
    for user_id, workspace in payload.items():
        if isinstance(workspace, dict):
            write_json_file(get_user_db_path(str(user_id), "tarefas"), workspace)
