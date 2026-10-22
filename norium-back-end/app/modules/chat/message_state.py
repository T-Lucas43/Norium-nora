"""Small local visibility/reaction overrides; messages remain in the provider DB."""
from __future__ import annotations

import hashlib
import time
from pathlib import Path
from fastapi import HTTPException
from app.core.tenant import get_user_db_path, read_json_file
from app.modules.business.store import mutate_path


def _path(runtime, owner: str) -> Path | None:
    if not isinstance(owner, str) or not owner.strip():
        raise ValueError("Message state requires an explicit owner")
    if not getattr(runtime, "is_evolution", lambda: False)():
        return None
    binding = runtime.wapi_owned_binding(owner)
    if binding is None or not binding.exists:
        return None
    signature = hashlib.sha256(f"{binding.instance_id}:{binding.created_at}".encode()).hexdigest()
    return Path(get_user_db_path(owner, "whatsapp_message_state_" + signature))


def _id(conversation_id: str, message_id: str) -> str:
    return hashlib.sha256(f"{conversation_id}\0{message_id}".encode()).hexdigest()


def snapshot(runtime, owner: str) -> dict:
    path = _path(runtime, owner)
    return read_json_file(path, {"items": []}) if path else {"items": []}


def apply(value: dict, conversation_id: str, messages: list[dict], aliases=()) -> list[dict]:
    rows = {row["id"]: row for row in value.get("items", [])}
    result = []
    for message in messages:
        states = [rows.get(_id(alias, str(message.get("id") or "")), {}) for alias in dict.fromkeys([conversation_id, *aliases])]
        state = max(states, key=lambda row: float(row.get("updatedAt") or 0), default={})
        if not any(row.get("hidden") for row in states):
            result.append({**message, **({"reacoes": state["reacoes"]} if "reacoes" in state else {})})
    return result


def update(runtime, owner: str, conversation_id: str, message_id: str, changes: dict) -> bool:
    if set(changes) - {"hidden", "reacoes"}:
        raise ValueError("Unsupported message state")
    path = _path(runtime, owner)
    if path is None:
        return False
    identifier = _id(conversation_id, message_id)
    def operation(value):
        rows = value.setdefault("items", [])
        row = next((row for row in rows if row.get("id") == identifier), None)
        if row is None:
            if len(rows) >= 50000:
                raise HTTPException(409, "Limite local de alterações atingido. Solicite manutenção ao administrador.")
            row = {"id": identifier}
            rows.append(row)
        row.update({**changes, "updatedAt": time.time()})
    mutate_path(path, operation)
    return True
