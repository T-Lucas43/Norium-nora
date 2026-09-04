"""Harness LOCAL de teste. Nao e copiado para a imagem de producao.

Executar: python -m uvicorn tests.team_call_browser_app:app --host 127.0.0.1 --port 8000
"""
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, Header
from fastapi.middleware.cors import CORSMiddleware
from app.modules.team import router as team

_data = tempfile.TemporaryDirectory(prefix="norium-call-browser-")
_users = [
    {"id": name, "nome": name.title(), "teamOwnerId": "owner", "status": "ativo", "permissions": {"chat": True}}
    for name in ("owner", "member", "other")
]


async def fixture_user(authorization: str = Header(default="")):
    return next(user for user in _users if user["id"] == authorization.removeprefix("Bearer "))


async def fixture_ticket(ticket):
    return next(user for user in _users if user["id"] == ticket)


_patches = [
    patch.object(team, "team_chat_path", return_value=str(Path(_data.name) / "team_chat.json")),
    patch.object(team, "read_user_store", AsyncMock(return_value={"users": _users})),
    patch.object(team, "read_profile_db", return_value={}),
    patch.object(team, "user_from_websocket_ticket", fixture_ticket),
    patch.object(team, "emit_due_meeting_reminders", AsyncMock()),
]
for _patch in _patches:
    _patch.start()
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:5173"], allow_methods=["*"], allow_headers=["*"])
app.dependency_overrides[team.current_user] = fixture_user
app.include_router(team.router)
