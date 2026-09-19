"""Nora's narrow bridge into the legacy task store, in the web process only.

Mutation, operation receipt and expected-version check share one atomic JSON
replacement and the same in-process lock as all regular task-store mutations.
Only the documented single backend worker/replica topology is supported.
"""
from __future__ import annotations

import copy
import uuid

from .contracts import BrainError, fingerprint


def receipt(user_id, operation_id):
    from app.services import task_store as store
    with store.mutation_lock:
        workspace = store._read_db().get(user_id, {})
        return copy.deepcopy(workspace.get("noraBrainOperations", {}).get(operation_id))


def execute(user_id, prepared, operation_id):
    from app.services import task_store as store
    with store.mutation_lock:
        db = store._read_db()
        workspace = store.load_workspace(user_id, db=db)
        receipts = workspace.setdefault("noraBrainOperations", {})
        if operation_id in receipts:
            return copy.deepcopy(receipts[operation_id])
        if len(receipts) >= 10_000:
            raise BrainError("task_operation_archive_required")
        kind = prepared["action"]
        tasks = workspace.setdefault("tasks", [])
        current = next((t for t in tasks if t["id"] == prepared.get("id")), None)
        if kind != "create" and (not current or fingerprint(current) != prepared["version"]):
            raise BrainError("task_version_conflict")
        if kind == "create":
            # The first write-capable bridge intentionally operates on private tasks.
            # Shared projects require their own verified business approval adapter.
            project = next((p for p in workspace.get("projects", []) if p.get("id") == "default"), None)
            if not project or project.get("sharedUserIds"):
                raise BrainError("private_task_scope_required")
            task = store.normalize_task({"id": "task_" + uuid.uuid4().hex, "projectId": "default",
                "title": prepared["title"], "description": prepared.get("description", ""),
                "status": "pendente", "priority": "media", "dueDate": prepared.get("dueDate"),
                "createdBy": user_id, "assigneeId": user_id, "createdAt": store.now_iso(),
                "updatedAt": store.now_iso(), "order": store.next_order(tasks, "pendente")})
            tasks.append(task)
        elif kind == "delete":
            task = current
            workspace["tasks"] = [t for t in tasks if t["id"] != current["id"]]
        else:
            task = current
            task.update(prepared["changes"])
            task["updatedAt"] = store.now_iso()
            if task.get("status") == "concluida":
                task["completedAt"] = task["updatedAt"]
        result = {"id": task["id"], "action": kind, "beforeVersion": prepared.get("version"),
                  "before": copy.deepcopy(prepared.get("before")),
                  "after": None if kind == "delete" else copy.deepcopy(task)}
        receipts[operation_id] = result
        workspace["updatedAt"] = store.now_iso()
        store._write_db({user_id: workspace})
        return copy.deepcopy(result)
