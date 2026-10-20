"""Purpose-bound public capabilities. Only hashes are stored in the link registry.

Links use a URL fragment: their bearer token is not in HTTP paths or referrers.
Only explicitly registered resource projections can issue or redeem a link.
"""
from __future__ import annotations

import asyncio
import hashlib
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from typing import Awaitable, Callable, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field

from app.core.identity import require_team_id, require_user_id
from app.core.rate_limit import SlidingWindowRateLimiter
from app.core.request_context import current_workspace_id, reset_request_context, set_request_context
from app.core.tenant import get_data_root, public_api_base_url, read_account_db
from app.infrastructure.persistence import postgres_store
from app.modules.auth.router import current_user
from app.shared.schemas import StrictModel
from .jobs import sql

Purpose = Literal["budget", "portal", "documents", "satisfaction", "site-chat", "waitlist"]
router = APIRouter(prefix="/api/public-links", tags=["Páginas públicas"])
_limiter = SlidingWindowRateLimiter(limit=40, window_seconds=60)
_projections: dict[str, Callable[..., Awaitable[dict]]] = {}
SCHEMA = """CREATE TABLE IF NOT EXISTS norium_public_links (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
 team_id TEXT NOT NULL, workspace TEXT NOT NULL, purpose TEXT NOT NULL,
 resource_id TEXT NOT NULL, resource_version INTEGER NOT NULL,
 expires_at DOUBLE PRECISION NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
 revoked INTEGER NOT NULL DEFAULT 0, created_at DOUBLE PRECISION NOT NULL,
 last_access_at DOUBLE PRECISION NOT NULL DEFAULT 0)"""


@contextmanager
def database():
    if postgres_store.configured() or postgres_store.required():
        with postgres_store.connection() as db:
            db.execute(SCHEMA)
            yield db, True
        return
    db = sqlite3.connect(get_data_root() / "public_links.sqlite3", timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        yield db, False
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def register_projection(purpose: str, projection: Callable[..., Awaitable[dict]]):
    if purpose not in {"budget", "portal", "documents", "satisfaction", "site-chat", "waitlist"} or purpose in _projections:
        raise ValueError("Invalid or duplicate public projection")
    _projections[purpose] = projection


async def project(user: dict, purpose: str, resource_id: str, *, issuing: bool = False):
    projection = _projections.get(purpose)
    if projection is None:
        raise HTTPException(404, "Página indisponível.")
    # The projection enforces its own current resource ACL and returns an
    # explicit public DTO, version and company brand. Never return a raw store.
    return await projection(user, resource_id, issuing=issuing)


async def issue(user: dict, purpose: str, resource_id: str, *, ttl_seconds: int = 86400, max_uses: int = 100):
    if not 300 <= ttl_seconds <= 30*86400 or not 1 <= max_uses <= 10_000:
        raise HTTPException(422, "Validade ou limite de acessos inválido.")
    projection = await project(user, purpose, resource_id, issuing=True)
    token = secrets.token_urlsafe(32)
    identifier, expires = "public_" + uuid.uuid4().hex, time.time()+ttl_seconds
    actor, team, workspace = require_user_id(user), require_team_id(user), current_workspace_id()
    def save():
        with database() as (db, pg):
            sql(db, pg, """INSERT INTO norium_public_links
                (id,token_hash,user_id,team_id,workspace,purpose,resource_id,resource_version,expires_at,max_uses,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (identifier, hashlib.sha256(token.encode()).hexdigest(), actor, team, workspace,
                 purpose, resource_id, int(projection["version"]), expires, max_uses, time.time()))
    await asyncio.to_thread(save)
    return {"id": identifier, "url": public_api_base_url().rstrip("/") + "/p/" + purpose + "#" + token,
            "expiresAt": expires, "maxUses": max_uses}


def revoke(user: dict, identifier: str):
    with database() as (db, pg):
        row = sql(db, pg, "UPDATE norium_public_links SET revoked=1 WHERE id=? AND user_id=? AND team_id=? AND workspace=?",
                  (identifier, require_user_id(user), require_team_id(user), current_workspace_id()))
        if row.rowcount != 1:
            raise HTTPException(404, "Link não encontrado.")


def lookup(token: str, purpose: str):
    with database() as (db, pg):
        row = sql(db, pg, """SELECT * FROM norium_public_links WHERE token_hash=? AND purpose=?
                  AND revoked=0 AND expires_at>? AND uses<max_uses""", (hashlib.sha256(token.encode()).hexdigest(), purpose, time.time())).fetchone()
        if not row:
            raise HTTPException(404, "Página indisponível. Solicite um link atualizado à equipe.")
        return dict(row)


def consume(record):
    with database() as (db, pg):
        cursor = sql(db, pg, """UPDATE norium_public_links SET uses=uses+1,last_access_at=?
            WHERE id=? AND token_hash=? AND revoked=0 AND expires_at>? AND uses<max_uses""",
            (time.time(), record["id"], record["token_hash"], time.time()))
        if cursor.rowcount != 1:
            raise HTTPException(404, "Página indisponível. Solicite um link atualizado à equipe.")


async def resolve(token: str, purpose: str):
    from app.modules.auth.router import effective_permissions, find_user, read_user_store
    record = await asyncio.to_thread(lookup, token, purpose)
    context = set_request_context("public-capability", record["workspace"])
    try:
        directory = await read_user_store()
        user = find_user(directory, record["user_id"])
        owner = find_user(directory, record["team_id"])
        if not user or user.get("status") != "ativo" or require_team_id(user) != record["team_id"]:
            raise HTTPException(404, "Página indisponível.")
        if not owner or owner.get("status") != "ativo":
            raise HTTPException(404, "Página indisponível.")
        if record["workspace"] != "primary":
            account = await asyncio.to_thread(read_account_db, record["team_id"], "plataforma", {})
            if not any(item.get("id") == record["workspace"] and item.get("active", True) for item in account.get("workspaces", [])):
                raise HTTPException(404, "Página indisponível.")
        user = {**user, "permissions": effective_permissions(user)}
        projection = await project(user, purpose, record["resource_id"])
        if projection["version"] != record["resource_version"]:
            raise HTTPException(404, "Página indisponível. Solicite um link atualizado à equipe.")
        await asyncio.to_thread(consume, record)
        return projection["public"]
    finally:
        reset_request_context(context)


class ResolveLink(StrictModel):
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


@router.delete("/{link_id}")
async def revoke_link(link_id: str, user: dict = Depends(current_user)):
    await asyncio.to_thread(revoke, user, link_id)
    return {"revoked": True}


@router.post("/{purpose}/resolve")
async def resolve_link(purpose: Purpose, payload: ResolveLink, request: Request, response: Response):
    host = request.client.host if request.client else "unknown"
    await _limiter.check(hashlib.sha256(host.encode()).hexdigest())
    response.headers.update({"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
    try:
        return await resolve(payload.token, purpose)
    except HTTPException as exc:
        if exc.status_code in {401, 403}:
            raise HTTPException(404, "Página indisponível.") from exc
        raise
