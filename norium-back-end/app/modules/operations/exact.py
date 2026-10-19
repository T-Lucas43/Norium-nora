"""Common preparation contract backed by the existing exact send executors.

This module never sends. Decisions, durable intents and reconciliation remain in
the registered email/WhatsApp paths used by Central and Controle.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.core.identity import require_user_id
from app.core.request_context import current_workspace_id
from app.modules.auth.router import current_user
from app.modules.operations.repository import APPROVAL_DB, list_items
from app.shared.schemas import StrictModel

router = APIRouter(prefix="/api/operacao/exact", tags=["Aprovações exatas"])
_preparation_locks = [asyncio.Lock() for _ in range(64)]
REGISTERED_KINDS = frozenset({"email.send", "whatsapp.send"})


class ExactOperation(StrictModel):
    kind: Literal["email.send", "whatsapp.send"]
    target: str = Field(min_length=1, max_length=240)
    payload: dict = Field(default_factory=dict)
    idempotencyKey: str = Field(min_length=16, max_length=120, pattern=r"^[a-zA-Z0-9_.:-]+$")


async def create_exact_operation_approval(user: dict, kind: str, target: str, payload: dict,
                                          *, idempotency_key: str) -> dict:
    from app.modules.operations import service
    if kind not in REGISTERED_KINDS:
        raise HTTPException(422, "Não existe executor registrado para esta operação.")
    actor, workspace = require_user_id(user), current_workspace_id()
    canonical = json.dumps({"kind": kind, "target": target, "payload": payload},
                           sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
    if len(canonical.encode("utf-8")) > 96_000:
        raise HTTPException(413, "A prévia excede o limite. Anexe arquivos pelo fluxo de uploads.")
    content_digest = hashlib.sha256(canonical.encode()).hexdigest()
    operation_key = hashlib.sha256(json.dumps([actor, workspace, kind, idempotency_key], separators=(",", ":")).encode()).hexdigest()
    async with _preparation_locks[int(operation_key[:8], 16) % len(_preparation_locks)]:
        for current in await list_items(actor, APPROVAL_DB):
            metadata = current.get("metadata") or {}
            if metadata.get("exactOperationKey") != operation_key:
                continue
            if metadata.get("exactContentDigest") != content_digest:
                raise HTTPException(409, "O conteúdo mudou. Prepare uma nova operação para revisar.")
            return current
        metadata = {"exactOperationKey": operation_key, "exactContentDigest": content_digest,
                    "registeredKind": kind, "executorVersion": 1}
        if kind == "email.send":
            exact = service._normalize_exact_email(payload)
            if len(exact["to"]) != 1 or exact["to"][0].casefold() != target.strip().casefold():
                raise HTTPException(422, "O destinatário da operação deve corresponder à prévia exata.")
            return await service.create_exact_email_approval(user, exact, None, operation_metadata=metadata)
        if str(payload.get("conversationId") or "").strip() != target.strip():
            raise HTTPException(422, "A conversa da operação deve corresponder à prévia exata.")
        prepared = await service.prepare_exact_whatsapp_approval(user, payload, requested_by="business")
        prepared.metadata.update(metadata)
        return await service.create_approval(user, prepared)


@router.post("/prepare", status_code=201)
async def prepare(payload: ExactOperation, user: dict = Depends(current_user)):
    try:
        approval = await create_exact_operation_approval(user, payload.kind, payload.target,
            payload.payload, idempotency_key=payload.idempotencyKey)
        return {"approval": approval, "requiresExplicitDecision": True}
    except PermissionError as exc:
        raise HTTPException(403, "Sua conta não pode preparar este envio.") from exc
    except ValueError as exc:
        raise HTTPException(422, "Confira destinatário, conteúdo, anexos e conexão antes de preparar o envio.") from exc
