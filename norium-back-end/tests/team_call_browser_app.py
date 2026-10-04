"""Aplicacao hermetica para testes reais de navegador e sinalizacao.

Este modulo existe apenas em ``tests`` e nao e copiado para a imagem de
producao. As rotas ``/__test__`` controlam somente os adapters do fixture; as
acoes de chamada, chat e gravacao continuam passando pelo router publico.

Executar::

    python -m uvicorn tests.team_call_browser_app:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import asyncio
import os
import re
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.modules.team import router as team
from app.modules.team.studio_router import router as studio_router
from app.modules.team import studio_router as studio
from app.infrastructure import auth_sessions as fixture_sessions
from app.services import brainstorm_store as studio_library


LOAD_TEAM_COUNT = max(1, int(os.getenv("TEAM_CALL_FIXTURE_LOAD_TEAMS", "25")))
LOAD_USERS_PER_TEAM = max(2, int(os.getenv("TEAM_CALL_FIXTURE_USERS_PER_TEAM", "4")))
_RECORDING_LIMIT_ENV = {
    "maxChunkBytes": "TEAM_RECORDING_MAX_CHUNK_BYTES",
    "maxTotalBytes": "TEAM_RECORDING_MAX_TOTAL_BYTES",
    "maxDurationSeconds": "TEAM_RECORDING_MAX_DURATION_SECONDS",
    "maxConcurrentPerTeam": "TEAM_RECORDING_MAX_CONCURRENT_PER_TEAM",
    "maxTeamBytes": "TEAM_RECORDING_MAX_TEAM_BYTES",
    "requestLimit": "TEAM_RECORDING_REQUEST_LIMIT",
    "requestWindowSeconds": "TEAM_RECORDING_REQUEST_WINDOW_SECONDS",
    "retentionHours": "TEAM_RECORDING_RETENTION_HOURS",
    "orphanGraceSeconds": "TEAM_RECORDING_ORPHAN_GRACE_SECONDS",
}
_original_recording_env = {name: os.environ.get(name) for name in _RECORDING_LIMIT_ENV.values()}
_data = tempfile.TemporaryDirectory(prefix="norium-call-browser-")
_data_root = Path(_data.name)
_fixture_lock = asyncio.Lock()
_websocket_handler_condition = asyncio.Condition()
_active_websocket_handlers = 0
WEBSOCKET_SHUTDOWN_DEADLINE_SECONDS = 20.0


def _base_users() -> list[dict[str, Any]]:
    users: list[dict[str, Any]] = [
        {
            "id": name,
            "nome": name.title(),
            "teamOwnerId": "owner",
            "status": "ativo",
            "teamChatEnabled": True,
            "permissions": {"chat": True, "nora": True},
        }
        for name in ("owner", "member", "other")
    ]
    for team_index in range(LOAD_TEAM_COUNT):
        owner_id = f"load-{team_index:03d}-owner"
        users.append({
            "id": owner_id,
            "nome": f"Load {team_index:03d} Owner",
            "teamOwnerId": owner_id,
            "status": "ativo",
            "teamChatEnabled": True,
            "permissions": {"chat": True},
        })
        for participant_index in range(1, LOAD_USERS_PER_TEAM):
            user_id = f"load-{team_index:03d}-user-{participant_index}"
            users.append({
                "id": user_id,
                "nome": f"Load {team_index:03d} User {participant_index}",
                "teamOwnerId": owner_id,
                "status": "ativo",
                "teamChatEnabled": True,
                "permissions": {"chat": True},
            })
    return users


_users = _base_users()
_fixture_session_ids: dict[str, str] = {}


def _bind_fixture_session(user: dict[str, Any]) -> dict[str, Any]:
    sid = _fixture_session_ids.get(user["id"])
    if not sid:
        row, _, _ = fixture_sessions.create(user["id"], int(user.get("sessionVersion") or 0))
        sid = row["id"]
        _fixture_session_ids[user["id"]] = sid
    user["_authSession"] = sid
    return user


def _find_user(user_id: str) -> dict[str, Any] | None:
    return next((user for user in _users if str(user.get("id") or "") == user_id), None)


async def fixture_user(authorization: str = Header(default="")) -> dict[str, Any]:
    user = _find_user(authorization.removeprefix("Bearer ").strip())
    if user is None:
        raise HTTPException(status_code=401, detail="Usuario de teste desconhecido.")
    return _bind_fixture_session(user)


async def fixture_ticket(ticket: str) -> dict[str, Any]:
    user = _find_user(str(ticket or "").strip())
    if user is None:
        raise ValueError("Ticket de teste desconhecido.")
    return _bind_fixture_session(user)


async def fixture_user_store() -> dict[str, Any]:
    # A lista e deliberadamente viva: rotas de controle mudam o mesmo diretorio
    # que os adapters de autorizacao consultam em cada revalidacao.
    return {"users": _users}


def fixture_team_chat_path(team_id: str) -> str:
    safe_team_id = re.sub(r"[^a-zA-Z0-9_.-]", "_", str(team_id or "unknown"))
    return str(_data_root / f"team_chat_{safe_team_id}.json")


_patches = [
    # The real binary adapter must see the same temporary root as UPLOAD_DIR.
    # Keep its traversal/quota checks enabled in browser and load fixtures.
    patch("app.core.tenant.get_data_root", return_value=_data_root),
    patch.object(fixture_sessions, "get_data_root", return_value=_data_root),
    patch.object(studio.nora_service, "perguntar_nora", AsyncMock(return_value="Plano sugerido pela Nora: validar as decisões e definir os próximos passos.")),
    patch.object(studio_library, "read_user_db", side_effect=lambda tenant, _db, fallback: team.read_json_file(_data_root / f"studio_library_{tenant}.json", fallback)),
    patch.object(studio_library, "write_user_db", side_effect=lambda tenant, _db, value: team.write_json_file(_data_root / f"studio_library_{tenant}.json", value)),
    patch.object(team, "UPLOAD_DIR", _data_root),
    patch.object(team, "team_chat_path", side_effect=fixture_team_chat_path),
    patch.object(team, "read_user_store", side_effect=fixture_user_store),
    patch.object(team, "read_profile_db", return_value={}),
    patch.object(team, "user_from_websocket_ticket", side_effect=fixture_ticket),
    patch.object(team, "emit_due_meeting_reminders", AsyncMock()),
    patch.object(team, "record_team_event", AsyncMock()),
]
for _patch in _patches:
    _patch.start()


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(?:localhost|127\.0\.0\.[12])(?::\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)
app.dependency_overrides[team.current_user] = fixture_user
app.include_router(team.router)
app.include_router(studio_router)


@app.get("/__test__/studio-library")
async def fixture_studio_library(authorization: str = Header(default="")) -> dict:
    user = await fixture_user(authorization)
    return {"sessions": await studio_library.list_brainstorm_sessions(team.team_id_for(user))}


_closing_connections: dict[Any, asyncio.Task] = {}


def _start_closing_connections(user_id: str | None = None) -> list[asyncio.Task]:
    sockets = [
        socket
        for socket, connected_user_id in list(team.manager.socket_user.items())
        if user_id is None or connected_user_id == user_id
    ]
    async def close_socket(socket: Any) -> None:
        try:
            await socket.close(code=1012)
        except Exception:
            pass
        finally:
            _closing_connections.pop(socket, None)

    for socket in sockets:
        if socket not in _closing_connections:
            _closing_connections[socket] = asyncio.create_task(close_socket(socket))
    return [_closing_connections[socket] for socket in sockets]


async def _close_matching_connections(user_id: str | None = None) -> int:
    tasks = _start_closing_connections(user_id)
    if user_id is None:
        tasks = list(dict.fromkeys([*tasks, *_closing_connections.values()]))
    # Offline peers can delay the closing handshake. Close in parallel and
    # retain ownership until reset has waited for every handler/task.
    await asyncio.gather(*tasks)
    return len(tasks)


async def _wait_for_websocket_handlers() -> None:
    deadline = asyncio.get_running_loop().time() + WEBSOCKET_SHUTDOWN_DEADLINE_SECONDS
    async with _websocket_handler_condition:
        while _active_websocket_handlers:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise HTTPException(
                    status_code=503,
                    detail=f"{_active_websocket_handlers} WebSockets ainda encerrando.",
                )
            try:
                await asyncio.wait_for(_websocket_handler_condition.wait(), timeout=remaining)
            except TimeoutError as error:
                raise HTTPException(
                    status_code=503,
                    detail=f"{_active_websocket_handlers} WebSockets ainda encerrando.",
                ) from error


async def _cancel_reconcile_tasks() -> None:
    tasks = list(team._call_reconcile_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    team._call_reconcile_tasks.clear()


def _restore_recording_limits() -> None:
    for name, original in _original_recording_env.items():
        if original is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = original


def _clear_fixture_files() -> None:
    # TemporaryDirectory e o alvo exato. Nao seguimos links nem removemos o
    # diretorio raiz para nao invalidar adapters que ja apontam para ele.
    for path in _data_root.iterdir():
        if path.is_file() or path.is_symlink():
            path.unlink(missing_ok=True)


def _camel_to_snake(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


@app.post("/__test__/reset")
async def reset_fixture() -> dict[str, Any]:
    global _users
    async with _fixture_lock:
        closed = await _close_matching_connections()
        await _wait_for_websocket_handlers()
        await _cancel_reconcile_tasks()
        await team.stop_recording_maintenance()
        team.manager.connections.clear()
        team.manager.user_team.clear()
        team.manager.socket_user.clear()
        team.manager.socket_connection.clear()
        team.manager.socket_session_id.clear()
        team.manager.socket_session_version.clear()
        team._call_coordinator_instance = None
        team._recording_coordinator_instance = None
        _restore_recording_limits()
        _users = _base_users()
        _clear_fixture_files()
    return {"reset": True, "closedConnections": closed, "userCount": len(_users)}


@app.post("/__test__/users/{user_id}/status")
async def set_fixture_user_status(
    user_id: str,
    payload: dict[str, Any] = Body(...),
) -> dict[str, Any]:
    status = str(payload.get("status") or "").strip()
    if status not in {"ativo", "inativo"}:
        raise HTTPException(status_code=422, detail="Status deve ser ativo ou inativo.")
    async with _fixture_lock:
        user = _find_user(user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="Usuario de teste nao encontrado.")
        user["status"] = status
    return {"userId": user_id, "status": status}


@app.post("/__test__/users/{user_id}/team")
async def set_fixture_user_team(
    user_id: str,
    payload: dict[str, Any] = Body(...),
) -> dict[str, Any]:
    team_owner_id = str(payload.get("teamOwnerId") or "").strip()
    if not team_owner_id:
        raise HTTPException(status_code=422, detail="teamOwnerId e obrigatorio.")
    async with _fixture_lock:
        user = _find_user(user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="Usuario de teste nao encontrado.")
        user["teamOwnerId"] = team_owner_id
    return {"userId": user_id, "teamOwnerId": team_owner_id}


@app.post("/__test__/connections/{user_id}/close")
async def close_fixture_connections(user_id: str) -> dict[str, Any]:
    if _find_user(user_id) is None:
        raise HTTPException(status_code=404, detail="Usuario de teste nao encontrado.")
    tasks = _start_closing_connections(user_id)
    # The browser must be able to leave offline mode before the handshake
    # completes. Report initiation; scenarios still prove actual reconnect.
    return {"userId": user_id, "closingConnections": len(tasks)}


@app.post("/__test__/recording-limits")
async def configure_recording_limits(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    unknown = sorted(set(payload) - set(_RECORDING_LIMIT_ENV))
    if unknown:
        raise HTTPException(status_code=422, detail=f"Limites desconhecidos: {', '.join(unknown)}")
    values: dict[str, int] = {}
    for field, raw_value in payload.items():
        if isinstance(raw_value, bool):
            raise HTTPException(status_code=422, detail=f"{field} deve ser inteiro positivo.")
        try:
            value = int(raw_value)
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=f"{field} deve ser inteiro positivo.") from error
        if value < 1:
            raise HTTPException(status_code=422, detail=f"{field} deve ser inteiro positivo.")
        values[field] = value
    async with _fixture_lock:
        for field, value in values.items():
            os.environ[_RECORDING_LIMIT_ENV[field]] = str(value)
        # Recria o factory publico com configuracao de teste; upload e
        # autorizacao continuam no mesmo coordenador usado em producao.
        team._recording_coordinator_instance = None
        limits = team.recording_coordinator().limits
    return {
        "limits": {
            field: getattr(limits, _camel_to_snake(field))
            for field in _RECORDING_LIMIT_ENV
        }
    }


@app.get("/__test__/state")
async def fixture_state(team_id: str | None = Query(default=None, alias="teamId")) -> dict[str, Any]:
    team_ids = [team_id] if team_id else sorted({team.team_id_for(user) for user in _users})
    calls: list[dict[str, Any]] = []
    for current_team_id in team_ids:
        for call in await team.active_calls_snapshot(current_team_id):
            sessions = call.get("participantSessions") or {}
            calls.append({
                "teamId": current_team_id,
                "callId": str(call.get("callId") or ""),
                "participantIds": sorted(str(value) for value in sessions),
                "participantCount": len(sessions),
                "hostUserId": str(call.get("hostUserId") or ""),
            })
    part_files = sorted(path.name for path in _data_root.glob("*.part") if path.is_file())
    return {
        "processId": os.getpid(),
        "activeCallCount": len(calls),
        "participantCount": sum(int(call["participantCount"]) for call in calls),
        "connectionCount": len(team.manager.socket_user),
        "partFileCount": len(part_files),
        "partFiles": part_files,
        "calls": calls,
    }


class _TrackedFixtureApp:
    """Espera o ciclo ASGI completo; mapa de presenca sozinho fecha cedo demais."""

    def __init__(self, inner: FastAPI) -> None:
        self.inner = inner

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        global _active_websocket_handlers
        if scope.get("type") != "websocket":
            await self.inner(scope, receive, send)
            return
        async with _websocket_handler_condition:
            _active_websocket_handlers += 1
            _websocket_handler_condition.notify_all()
        try:
            await self.inner(scope, receive, send)
        finally:
            async with _websocket_handler_condition:
                _active_websocket_handlers -= 1
                _websocket_handler_condition.notify_all()


app = _TrackedFixtureApp(app)
