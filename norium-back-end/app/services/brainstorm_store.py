from __future__ import annotations

import asyncio
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from app.core.tenant import read_user_db, write_user_db
from app.services.studio_templates import build_template_board


DB_NAME = "brainstorm"
MAX_SESSIONS = 120
MAX_HISTORY = 240
brainstorm_lock = asyncio.Lock()


class BrainstormLockedError(RuntimeError):
    """Raised when a collaborative mutation targets a finished session."""


def timer_has_expired(session: dict[str, Any]) -> bool:
    timer = session.get("timer") if isinstance(session.get("timer"), dict) else {}
    ends_at = timer.get("endsAt")
    if not timer.get("running") or not ends_at:
        return False
    try:
        deadline = datetime.fromisoformat(str(ends_at).replace("Z", "+00:00"))
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        return deadline <= datetime.now(timezone.utc)
    except ValueError:
        return False


def session_is_locked(session: dict[str, Any]) -> bool:
    return str(session.get("status") or "ativo") != "ativo" or timer_has_expired(session)


def _finish_expired_session(session: dict[str, Any]) -> bool:
    if not timer_has_expired(session):
        return False
    session["status"] = "encerrado"
    timer = session.get("timer") if isinstance(session.get("timer"), dict) else {}
    session["timer"] = {**timer, "running": False, "finishedAt": now_iso()}
    session["updatedAt"] = now_iso()
    session["revision"] = int(session.get("revision") or 0) + 1
    history = session.setdefault("history", [])
    history.append(
        {
            "id": f"hist_{uuid.uuid4().hex}",
            "action": "timer_finished",
            "detail": "Tempo encerrado; quadro bloqueado para novas alteracoes",
            "actorId": "system",
            "actorName": "Norium",
            "timestamp": now_iso(),
        }
    )
    session["history"] = history[-MAX_HISTORY:]
    return True


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_store() -> dict[str, Any]:
    return {"sessions": []}


def _read_store(tenant_id: str) -> dict[str, Any]:
    payload = read_user_db(tenant_id, DB_NAME, empty_store())
    if not isinstance(payload, dict):
        return empty_store()
    sessions = payload.get("sessions")
    payload["sessions"] = sessions if isinstance(sessions, list) else []
    return payload


def _write_store(tenant_id: str, payload: dict[str, Any]) -> None:
    write_user_db(tenant_id, DB_NAME, payload)


def _public_session(session: dict[str, Any], *, include_board: bool = False) -> dict[str, Any]:
    data = deepcopy(session)
    if not include_board:
        board = data.pop("board", {})
        data["nodeCount"] = len(board.get("nodes", [])) if isinstance(board, dict) else 0
        data["edgeCount"] = len(board.get("edges", [])) if isinstance(board, dict) else 0
    return data


def _history_entry(action: str, actor: dict[str, Any], detail: str) -> dict[str, Any]:
    return {
        "id": f"hist_{uuid.uuid4().hex}",
        "action": action,
        "detail": detail[:280],
        "actorId": str(actor.get("id") or ""),
        "actorName": str(actor.get("nome") or actor.get("email") or "Membro"),
        "timestamp": now_iso(),
    }


async def list_brainstorm_sessions(tenant_id: str) -> list[dict[str, Any]]:
    async with brainstorm_lock:
        store = _read_store(tenant_id)
        sessions = store.get("sessions", [])
        expired_changed = False
        for item in sessions:
            if isinstance(item, dict) and _finish_expired_session(item):
                expired_changed = True
        if expired_changed:
            _write_store(tenant_id, store)
        ordered = sorted(sessions, key=lambda item: str(item.get("updatedAt") or ""), reverse=True)
        return [_public_session(item) for item in ordered if isinstance(item, dict)]


async def get_brainstorm_session(tenant_id: str, session_id: str) -> dict[str, Any] | None:
    async with brainstorm_lock:
        store = _read_store(tenant_id)
        sessions = store.get("sessions", [])
        session = next((item for item in sessions if str(item.get("id")) == session_id), None)
        if isinstance(session, dict) and _finish_expired_session(session):
            _write_store(tenant_id, store)
        return _public_session(session, include_board=True) if isinstance(session, dict) else None


async def create_brainstorm_session(
    tenant_id: str,
    payload: dict[str, Any],
    actor: dict[str, Any],
) -> dict[str, Any]:
    async with brainstorm_lock:
        store = _read_store(tenant_id)
        created_at = now_iso()
        session_id = f"brain_{uuid.uuid4().hex}"
        title = str(payload.get("title") or "Nova sessao de ideias").strip()[:160]
        objective = str(payload.get("objective") or "").strip()[:1200]
        template = str(payload.get("template") or "livre").strip()[:60]
        responsible_id = str(payload.get("responsibleId") or actor.get("id") or "")
        responsible_name = str(payload.get("responsibleName") or actor.get("nome") or actor.get("email") or "Responsavel")
        session = {
            "id": session_id,
            "title": title,
            "objective": objective,
            "template": template,
            "status": "ativo",
            "responsibleId": responsible_id,
            "responsibleName": responsible_name[:160],
            "createdBy": str(actor.get("id") or ""),
            "createdByName": str(actor.get("nome") or actor.get("email") or "Membro")[:160],
            "createdAt": created_at,
            "updatedAt": created_at,
            "revision": 1,
            "participants": [
                {
                    "id": str(actor.get("id") or ""),
                    "name": str(actor.get("nome") or actor.get("email") or "Membro"),
                    "photoUrl": str(actor.get("fotoUrl") or ""),
                }
            ],
            "timer": {"durationMinutes": int(payload.get("durationMinutes") or 15), "endsAt": None, "running": False},
            "board": build_template_board(template, objective),
            "history": [_history_entry("session_created", actor, f"Sessao '{title}' criada")],
        }
        store["sessions"] = [session, *store.get("sessions", [])][:MAX_SESSIONS]
        _write_store(tenant_id, store)
        return _public_session(session, include_board=True)


async def update_brainstorm_session(
    tenant_id: str,
    session_id: str,
    updates: dict[str, Any],
    actor: dict[str, Any],
) -> dict[str, Any] | None:
    allowed = {"title", "objective", "status", "responsibleId", "responsibleName", "template", "timer"}
    async with brainstorm_lock:
        store = _read_store(tenant_id)
        session = next((item for item in store.get("sessions", []) if str(item.get("id")) == session_id), None)
        if not isinstance(session, dict):
            return None
        changed: list[str] = []
        for key, value in updates.items():
            if key not in allowed:
                continue
            session[key] = deepcopy(value)
            changed.append(key)
        session["updatedAt"] = now_iso()
        session["revision"] = int(session.get("revision") or 0) + 1
        history = session.setdefault("history", [])
        history.append(_history_entry("session_updated", actor, f"Campos atualizados: {', '.join(changed) or 'nenhum'}"))
        session["history"] = history[-MAX_HISTORY:]
        _write_store(tenant_id, store)
        return _public_session(session, include_board=True)


async def save_brainstorm_board(
    tenant_id: str,
    session_id: str,
    board: dict[str, Any],
    actor: dict[str, Any],
    *,
    detail: str = "Quadro atualizado",
) -> dict[str, Any] | None:
    async with brainstorm_lock:
        store = _read_store(tenant_id)
        session = next((item for item in store.get("sessions", []) if str(item.get("id")) == session_id), None)
        if not isinstance(session, dict):
            return None
        if _finish_expired_session(session):
            _write_store(tenant_id, store)
        if session_is_locked(session):
            raise BrainstormLockedError("O tempo terminou e o quadro esta bloqueado para alteracoes.")
        nodes = board.get("nodes") if isinstance(board.get("nodes"), list) else []
        edges = board.get("edges") if isinstance(board.get("edges"), list) else []
        viewport = board.get("viewport") if isinstance(board.get("viewport"), dict) else {"x": 0, "y": 0, "zoom": 1}
        session["board"] = {"nodes": nodes[:600], "edges": edges[:1000], "viewport": viewport}
        session["updatedAt"] = now_iso()
        session["revision"] = int(session.get("revision") or 0) + 1
        history = session.setdefault("history", [])
        history.append(_history_entry("board_updated", actor, detail))
        session["history"] = history[-MAX_HISTORY:]
        _write_store(tenant_id, store)
        return _public_session(session, include_board=True)


async def delete_brainstorm_session(tenant_id: str, session_id: str) -> bool:
    async with brainstorm_lock:
        store = _read_store(tenant_id)
        before = len(store.get("sessions", []))
        store["sessions"] = [item for item in store.get("sessions", []) if str(item.get("id")) != session_id]
        if len(store["sessions"]) == before:
            return False
        _write_store(tenant_id, store)
        return True
