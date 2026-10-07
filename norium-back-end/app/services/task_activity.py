"""Authorization for persisted task activity, including deleted task snapshots."""
from __future__ import annotations

from typing import Any, Callable
from app.services import task_store


def is_task_activity(metadata: dict[str, Any]) -> bool:
    return bool(metadata.get("taskId") or metadata.get("taskProject") or "taskProjects" in metadata or
                str(metadata.get("action") or "").startswith(("task_", "automation_task_")))


def activity_project(user_id: str, metadata: dict[str, Any]) -> dict[str, str] | None:
    """Resolve by task first; project IDs alone are not unique across owners."""
    db = task_store._read_db()
    task_id = str(metadata.get("taskId") or "")
    resolved = task_store.resolve_task_workspace(db, user_id, task_id) if task_id else None
    if resolved:
        owner_id, _, task = resolved
        return {"ownerId": owner_id, "projectId": str(task.get("projectId") or "default")}
    reference = metadata.get("taskProject")
    if isinstance(reference, dict) and project_visible(reference, user_id, db=db):
        return {"ownerId": str(reference["ownerId"]), "projectId": str(reference["projectId"])}
    return None


def read_directory() -> dict:
    from app.core.tenant import get_system_db_path, read_json_file
    from app.modules.auth.router import normalize_user_store
    payload = read_json_file(get_system_db_path("usuarios"), {"users": []})
    return normalize_user_store(payload)


def project_visible(reference: Any, user_id: str, *, db: dict | None = None, directory: dict | None = None) -> bool:
    if not isinstance(reference, dict) or not reference.get("ownerId") or not reference.get("projectId"):
        return False
    owner_id = str(reference["ownerId"])
    users = {str(item.get("id")): item for item in (read_directory() if directory is None else directory).get("users", []) if isinstance(item, dict)}
    owner, viewer = users.get(owner_id), users.get(user_id)
    if not owner or not viewer or viewer.get("status") != "ativo":
        return False
    from app.modules.auth.router import effective_permissions
    if not effective_permissions(viewer).get("tarefas"):
        return False
    if str(owner.get("teamOwnerId") or owner_id) != str(viewer.get("teamOwnerId") or user_id):
        return False
    db = task_store._read_db() if db is None else db
    workspace = db.get(owner_id) or {}
    project = next((item for item in workspace.get("projects", [])
                    if str(item.get("id")) == str(reference["projectId"])), None)
    return bool(project and task_store.project_accessible(task_store.normalize_project(project, owner_id), user_id))


def activity_projects(user_id: str, metadata: dict[str, Any]) -> list[dict[str, str]] | None:
    if "taskProjects" in metadata:
        references = metadata["taskProjects"]
        if not isinstance(references, list) or not all(project_visible(ref, user_id) for ref in references):
            return None
        return references
    reference = activity_project(user_id, metadata)
    return [reference] if reference else None


def activity_visible(metadata: dict[str, Any], user_id: str, *, db: dict | None = None, directory: dict | None = None) -> bool:
    # Legacy activities lacking an unambiguous reference stay stored as evidence,
    # but must never be returned to clients or reused in team-wide AI replies.
    if not is_task_activity(metadata):
        return True
    if "taskProjects" in metadata:
        references = metadata["taskProjects"]
        return isinstance(references, list) and all(project_visible(ref, user_id, db=db, directory=directory) for ref in references)
    return project_visible(metadata.get("taskProject"), user_id, db=db, directory=directory)


def activity_visibility(user_id: str) -> Callable[[dict[str, Any]], bool]:
    """One authorization snapshot per history read; never cached across requests."""
    db = None
    directory = None

    def visible(metadata: dict[str, Any]) -> bool:
        nonlocal db, directory
        if not is_task_activity(metadata):
            return True
        if not metadata.get("taskProject") and not metadata.get("taskProjects"):
            return isinstance(metadata.get("taskProjects"), list) and not metadata["taskProjects"]
        if db is None:
            db = task_store._read_db()
            directory = read_directory()
        return activity_visible(metadata, user_id, db=db, directory=directory)

    return visible
