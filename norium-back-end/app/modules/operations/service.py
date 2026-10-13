from __future__ import annotations

import asyncio
import base64
import contextvars
from contextlib import AsyncExitStack
import hashlib
import hmac
import json
import logging
import os
import re
import uuid
import unicodedata
from datetime import date, datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from weakref import WeakKeyDictionary

from app.core.identity import require_team_id, require_user_id
from app.core.tenant import read_profile_db, get_data_root
from app.core.request_context import current_workspace_id
from fastapi import HTTPException
from app.modules.clients.repository import list_clients
from app.modules.inbox.router import manager, read_events, record_event
from app.modules.operations.repository import (
    APPROVAL_DB,
    AUDIT_DB,
    FOLLOWUP_DB,
    MEMORY_DB,
    RECEIPT_DB,
    SEND_DB,
    SETTINGS_DB,
    TEMPLATE_DB,
    delete_item,
    list_items,
    prepend_item,
    replace_item,
)
from app.modules.operations.schemas import (
    ApprovalCreate,
    ApprovalDecision,
    ApprovalUpdate,
    AuditCreate,
    FollowUpCreate,
    FollowUpUpdate,
    NoraMemoryCreate,
    OperationSettingsUpdate,
    OperationTemplateCreate,
    OperationTemplateUpdate,
    ReceiptCreate,
)
from app.services.finance_store import delete_lancamento, list_finance, restore_lancamento
from app.services.task_store import delete_task, list_tasks, restore_task


LOCAL_TZ = timezone(timedelta(hours=-3))
logger = logging.getLogger(__name__)
approval_decision_locks: dict[tuple[int, str, str], asyncio.Lock] = {}


def approval_decision_lock(user_id: str, approval_id: str) -> asyncio.Lock:
    loop_key = id(asyncio.get_running_loop())
    return approval_decision_locks.setdefault((loop_key, user_id, approval_id), asyncio.Lock())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def actor_payload(user: dict[str, Any]) -> dict[str, str]:
    return {
        "id": str(user.get("id") or ""),
        "name": str(user.get("nome") or user.get("email") or "Operador"),
        "email": str(user.get("email") or ""),
    }


def _memory_owner_id(user: dict[str, Any], scope: str) -> str:
    user_id = require_user_id(user)
    if scope == "team":
        return str(user.get("teamOwnerId") or user_id)
    return user_id


async def list_nora_memory(user: dict[str, Any]) -> list[dict[str, Any]]:
    user_id = require_user_id(user)
    team_id = str(user.get("teamOwnerId") or user_id)
    personal, team = await asyncio.gather(
        list_items(user_id, MEMORY_DB),
        list_items(team_id, MEMORY_DB),
    )
    items = [item for item in personal if item.get("scope") == "personal"]
    items.extend(item for item in team if item.get("scope") == "team")
    unique: dict[str, dict[str, Any]] = {str(item.get("id")): item for item in items}
    return sorted(unique.values(), key=lambda item: str(item.get("updatedAt") or ""), reverse=True)


def can_write_team_memory(user: dict[str, Any]) -> bool:
    """Memória da equipe entra no contexto de todos; só quem gerencia a equipe grava."""
    from app.routers.auth_router import can_manage_team

    return can_manage_team(user)


async def save_nora_memory(user: dict[str, Any], payload: NoraMemoryCreate) -> dict[str, Any]:
    if payload.scope == "team" and not can_write_team_memory(user):
        raise PermissionError("Somente quem gerencia a equipe pode salvar preferências para a equipe. Salve como pessoal.")
    owner_id = _memory_owner_id(user, payload.scope)
    items = await list_items(owner_id, MEMORY_DB)
    normalized_key = _search_text(payload.key).strip()
    current = next(
        (
            item for item in items
            if item.get("scope") == payload.scope
            and item.get("category") == payload.category
            and _search_text(item.get("key")).strip() == normalized_key
        ),
        None,
    )
    update = {
        **payload.model_dump(),
        "updatedAt": now_iso(),
        "updatedBy": actor_payload(user),
    }
    if current:
        item = await replace_item(owner_id, MEMORY_DB, str(current.get("id")), update)
    else:
        item = await prepend_item(
            owner_id,
            MEMORY_DB,
            {
                "id": f"memory_{uuid.uuid4().hex}",
                **update,
                "createdAt": now_iso(),
                "createdBy": actor_payload(user),
            },
        )
    assert item is not None
    await record_audit(
        user,
        AuditCreate(
            action="nora_memory_saved",
            source="nora",
            description=f"Preferencia registrada: {payload.key}",
            status="info",
            entityType="nora_memory",
            entityId=str(item.get("id")),
            metadata={"scope": payload.scope, "category": payload.category},
        ),
    )
    return item


async def remove_nora_memory(user: dict[str, Any], memory_id: str) -> bool:
    owners = {
        require_user_id(user),
        require_team_id(user),
    }
    for owner_id in owners:
        if await delete_item(owner_id, MEMORY_DB, memory_id):
            await record_audit(
                user,
                AuditCreate(
                    action="nora_memory_deleted",
                    source="nora",
                    description="Preferencia removida da memoria operacional.",
                    status="warning",
                    entityType="nora_memory",
                    entityId=memory_id,
                ),
            )
            return True
    return False


async def record_audit(user: dict[str, Any], payload: AuditCreate) -> dict[str, Any]:
    item = {
        "id": f"audit_{uuid.uuid4().hex}",
        **payload.model_dump(),
        "actor": actor_payload(user),
        "timestamp": now_iso(),
    }
    return await prepend_item(require_user_id(user), AUDIT_DB, item)


async def record_receipt(user: dict[str, Any], payload: ReceiptCreate) -> dict[str, Any]:
    user_id = require_user_id(user)
    item = {
        "id": f"receipt_{uuid.uuid4().hex}",
        **payload.model_dump(),
        "actor": actor_payload(user),
        "timestamp": now_iso(),
    }
    await prepend_item(user_id, RECEIPT_DB, item)
    await record_audit(
        user,
        AuditCreate(
            action=payload.action,
            source="receipt",
            description=payload.description or payload.title,
            status="success" if payload.status == "executed" else "error",
            entityType=payload.entityType,
            entityId=payload.entityId,
            metadata={"receiptId": item["id"], **payload.metadata},
        ),
    )
    return item


async def undo_receipt(user: dict[str, Any], receipt_id: str) -> dict[str, Any] | None:
    user_id = require_user_id(user)
    receipts = await list_items(user_id, RECEIPT_DB)
    receipt = next((item for item in receipts if str(item.get("id")) == receipt_id), None)
    if receipt is None:
        return None
    metadata = receipt.get("metadata") if isinstance(receipt.get("metadata"), dict) else {}
    if metadata.get("undoneAt"):
        return {"receipt": receipt, "result": metadata.get("undoResult"), "alreadyUndone": True}

    action = str(receipt.get("action") or "")
    entity_id = str(receipt.get("entityId") or "")
    previous = metadata.get("previous") if isinstance(metadata.get("previous"), dict) else {}
    result: dict[str, Any] | None = None
    if action == "task_created":
        if not delete_task(user_id, entity_id):
            raise ValueError("A tarefa ja foi removida ou nao esta mais acessivel.")
        result = {"action": "task_deleted", "entityId": entity_id}
    elif action in {"task_updated", "task_deleted"}:
        restored = restore_task(user_id, previous)
        if restored is None:
            raise ValueError("O comprovante nao possui um snapshot valido da tarefa.")
        result = {"action": "task_restored", "entityId": restored.get("id")}
    elif action == "finance_entry_created":
        if not delete_lancamento(user_id, entity_id):
            raise ValueError("O lancamento ja foi removido ou nao esta mais acessivel.")
        result = {"action": "finance_entry_deleted", "entityId": entity_id}
    elif action in {"finance_entry_updated", "finance_entry_deleted"}:
        restored = restore_lancamento(user_id, previous)
        if restored is None:
            raise ValueError("O comprovante nao possui um snapshot valido do lancamento.")
        result = {"action": "finance_entry_restored", "entityId": restored.get("id")}
    else:
        raise ValueError("Este comprovante nao oferece uma operacao reversivel.")

    updated_metadata = {**metadata, "undoneAt": now_iso(), "undoResult": result}
    updated = await replace_item(user_id, RECEIPT_DB, receipt_id, {"metadata": updated_metadata})
    await record_audit(
        user,
        AuditCreate(
            action="operation_undone",
            source="receipt",
            description=f'Operacao desfeita a partir de "{receipt.get("title") or action}".',
            status="warning",
            entityType=str(receipt.get("entityType") or "operation"),
            entityId=entity_id or None,
            metadata={"receiptId": receipt_id, "originalAction": action, "result": result},
        ),
    )
    return {"receipt": updated, "result": result, "alreadyUndone": False}


async def get_operation_settings(user: dict[str, Any]) -> dict[str, Any]:
    user_id = require_user_id(user)
    items = await list_items(user_id, SETTINGS_DB)
    current = next((item for item in items if item.get("id") == "preferences"), {})
    return {
        "id": "preferences",
        "autonomy": current.get("autonomy") or "balanced",
        "dailyBriefing": bool(current.get("dailyBriefing", True)),
        "smartReminders": bool(current.get("smartReminders", True)),
        "followUpHours": int(current.get("followUpHours") or 48),
        "updatedAt": current.get("updatedAt"),
    }


async def update_operation_settings(user: dict[str, Any], payload: OperationSettingsUpdate) -> dict[str, Any]:
    user_id = require_user_id(user)
    current = await get_operation_settings(user)
    update = {**current, **payload.model_dump(exclude_none=True), "updatedAt": now_iso()}
    saved = await replace_item(user_id, SETTINGS_DB, "preferences", update)
    if saved is None:
        saved = await prepend_item(user_id, SETTINGS_DB, update)
    await record_audit(
        user,
        AuditCreate(
            action="operation_settings_updated",
            source="control",
            description="Preferencias operacionais atualizadas.",
            status="info",
            entityType="settings",
            entityId="preferences",
            metadata=payload.model_dump(exclude_none=True),
        ),
    )
    return saved


async def create_template(user: dict[str, Any], payload: OperationTemplateCreate) -> dict[str, Any]:
    item = {
        "id": f"template_{uuid.uuid4().hex}",
        **payload.model_dump(),
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "createdBy": actor_payload(user),
    }
    await prepend_item(require_user_id(user), TEMPLATE_DB, item)
    await record_audit(
        user,
        AuditCreate(
            action="operation_template_created",
            source="control",
            description=f'Modelo "{payload.name}" criado.',
            status="success",
            entityType="template",
            entityId=item["id"],
            metadata={"kind": payload.kind},
        ),
    )
    return item


async def update_template(
    user: dict[str, Any],
    template_id: str,
    payload: OperationTemplateUpdate,
) -> dict[str, Any] | None:
    update = {**payload.model_dump(exclude_none=True), "updatedAt": now_iso()}
    return await replace_item(require_user_id(user), TEMPLATE_DB, template_id, update)


async def create_follow_up(user: dict[str, Any], payload: FollowUpCreate) -> dict[str, Any]:
    item = {
        "id": f"followup_{uuid.uuid4().hex}",
        **payload.model_dump(),
        "status": "open",
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "createdBy": actor_payload(user),
    }
    await prepend_item(require_user_id(user), FOLLOWUP_DB, item)
    return item


async def update_follow_up(
    user: dict[str, Any],
    follow_up_id: str,
    payload: FollowUpUpdate,
) -> dict[str, Any] | None:
    update = {**payload.model_dump(exclude_none=True), "updatedAt": now_iso()}
    if update.get("status") == "done":
        update["completedAt"] = now_iso()
    return await replace_item(require_user_id(user), FOLLOWUP_DB, follow_up_id, update)


APPROVAL_VERSION = 1
EMAIL_EXACT_VERSION = "nora-email-v1"
EMAIL_APPROVAL_TTL = timedelta(hours=24)
EMAIL_RECONCILE_WINDOW = timedelta(minutes=10)
EMAIL_SEND_RECIPIENT_CAP = 20
EMAIL_SEND_ATTACHMENT_CAP = 8


# Ações que só executam com aprovação vinculada ao conteúdo exato (digest obrigatório).
DIGEST_REQUIRED_ACTIONS = frozenset({"nora_finance_exact"})


def approval_digest(
    action: str,
    source: str,
    title: str,
    description: str,
    payload: dict[str, Any],
    workspace: str,
    user_id: str,
    version: str = EMAIL_EXACT_VERSION,
) -> str:
    """Bind an approval to its exact action, content, target, tool, workspace and version."""
    canonical = json.dumps(
        {
            "action": action,
            "source": source,
            "title": title,
            "description": description,
            "payload": payload,
            "workspace": workspace,
            "userId": user_id,
            "version": version,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _parse_expiry(value: Any) -> datetime | None:
    """Parse expiresAt; malformed values fail closed (treated as expired)."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return datetime.now(timezone.utc) - timedelta(seconds=1)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


async def _enforce_approval_binding(
    user: dict[str, Any],
    user_id: str,
    current: dict[str, Any],
    payload: ApprovalDecision,
) -> None:
    """Deny-by-default guards: expiry, workspace and exact-digest binding.

    Only approvals execute, so only they require exactness. Deny and cancel
    never execute anything and are always permitted on pending items.
    """
    if payload.decision != "approved":
        return
    approval_id = str(current.get("id"))
    expiry = _parse_expiry(current.get("expiresAt"))
    if expiry is not None and expiry <= datetime.now(timezone.utc):
        await replace_item(user_id, APPROVAL_DB, approval_id, {"status": "expired", "updatedAt": now_iso()})
        await record_audit(
            user,
            AuditCreate(
                action="approval_expired",
                source=str(current.get("source") or "operacao"),
                description=str(current.get("title") or "Aprovacao"),
                status="warning",
                entityType="approval",
                entityId=approval_id,
            ),
        )
        raise ValueError("Esta aprovação expirou. Gere uma nova prévia no chat para continuar.")
    metadata = current.get("metadata") if isinstance(current.get("metadata"), dict) else {}
    bound_workspace = str(metadata.get("workspace") or "").strip()
    if bound_workspace and bound_workspace != current_workspace_id():
        raise ValueError("Esta aprovação pertence a outro ambiente de trabalho.")
    digest = str(current.get("digest") or "").strip()
    if not digest and str(current.get("action") or "") in DIGEST_REQUIRED_ACTIONS:
        raise ValueError("Esta aprovação não está vinculada ao conteúdo exato. Gere uma nova prévia para aprovar.")
    if digest and not hmac.compare_digest(str(payload.expectedDigest or ""), digest):
        raise ValueError("O conteúdo mudou após a preparação. Gere uma nova prévia para aprovar o conteúdo exato.")


async def create_approval(user: dict[str, Any], payload: ApprovalCreate) -> dict[str, Any]:
    user_id = require_user_id(user)
    item = {
        "id": f"approval_{uuid.uuid4().hex}",
        **payload.model_dump(),
        "status": "pending",
        "requestedBy": actor_payload(user),
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "decidedAt": None,
        "decidedBy": None,
        "decisionNote": "",
    }
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    metadata.setdefault("workspace", current_workspace_id())
    metadata.setdefault("approvalVersion", APPROVAL_VERSION)
    item["metadata"] = metadata
    await prepend_item(user_id, APPROVAL_DB, item)
    await record_audit(
        user,
        AuditCreate(
            action="approval_requested",
            source=payload.source,
            description=payload.title,
            status="warning",
            entityType="approval",
            entityId=item["id"],
            metadata={"requestedAction": payload.action},
        ),
    )
    await record_event(
        source="sistema",
        title="Nova aprovacao pendente",
        description=payload.title,
        metadata={"userId": user_id, "action": "approval_requested", "approvalId": item["id"]},
        event_id=f"sistema_{user_id}_approval_{item['id']}_requested",
    )
    await manager.broadcast(
        user_id,
        {
            "type": "SYSTEM_NOTIFICATION",
            "notification": {
                "title": "Aprovacao necessaria",
                "description": payload.title,
                "severity": "warning",
                "id": f"notification_approval_requested_{item['id']}",
                "metadata": {"approvalId": item["id"], "action": "approval_requested"},
            },
        },
    )
    return item


async def decide_approval(
    user: dict[str, Any],
    approval_id: str,
    payload: ApprovalDecision,
) -> dict[str, Any] | None:
    user_id = require_user_id(user)
    async with approval_decision_lock(user_id, approval_id):
        return await _decide_approval_unlocked(user, approval_id, payload)


async def _decide_approval_unlocked(
    user: dict[str, Any],
    approval_id: str,
    payload: ApprovalDecision,
) -> dict[str, Any] | None:
    user_id = require_user_id(user)
    current_items = await list_items(user_id, APPROVAL_DB)
    current = next((item for item in current_items if str(item.get("id")) == approval_id), None)
    if current is None:
        return None
    # A decisão é uma transição única. Retry, duplo clique e duas requisições
    # concorrentes recebem o estado já persistido e nunca repetem a execução.
    if str(current.get("status") or "") != "pending":
        return current

    await _enforce_approval_binding(user, user_id, current, payload)
    approved = payload.decision == "approved"
    should_execute = approved and str(current.get("action") or "") != "manual_review"
    approval = await replace_item(
        user_id,
        APPROVAL_DB,
        approval_id,
        {
            "status": "executing" if should_execute else payload.decision,
            "updatedAt": now_iso(),
            "decidedAt": now_iso(),
            "decidedBy": actor_payload(user),
            "decisionNote": payload.note,
        },
    )
    if approval is None:
        return None

    await record_audit(
        user,
        AuditCreate(
            action=f"approval_{payload.decision}",
            source=str(approval.get("source") or "operacao"),
            description=str(approval.get("title") or "Aprovacao"),
            status="success" if approved else "warning",
            entityType="approval",
            entityId=approval_id,
            metadata={"note": payload.note, "requestedAction": approval.get("action")},
        ),
    )
    await record_event(
        source="sistema",
        title="Aprovacao concluida",
        description=f'{approval.get("title")}: {payload.decision}.',
        metadata={"userId": user_id, "action": "approval_decided", "approvalId": approval_id},
        event_id=f"sistema_{user_id}_approval_{approval_id}_decided",
    )
    if should_execute:
        execution = await execute_approved_action(user, approval)
        execution_status = "executed" if execution.get("ok") else "failed"
        approval = await replace_item(
            user_id,
            APPROVAL_DB,
            approval_id,
            {
                "status": execution_status,
                "updatedAt": now_iso(),
                "execution": execution.get("result"),
                "executionError": execution.get("error"),
            "executionUncertain": bool(execution.get("uncertain")),
            },
        ) or approval
    return approval


async def execute_approved_action(user: dict[str, Any], approval: dict[str, Any]) -> dict[str, Any]:
    """Execute the exact agent request captured before approval and persist proof."""
    user_id = require_user_id(user)
    payload = approval.get("payload") if isinstance(approval.get("payload"), dict) else {}
    message = str(payload.get("originalMessage") or "").strip()
    source = str(approval.get("source") or "").casefold()
    result: dict[str, Any]

    finance_exact = payload.get("financeExact") if isinstance(payload.get("financeExact"), dict) else None
    try:
        if (
            not message
            and not (source == "email" and isinstance(payload.get("emailExact"), dict))
            and not (source == "financeiro" and finance_exact)
        ):
            raise ValueError("A solicitacao aprovada nao possui a instrucao original.")
        if source == "email" and isinstance(payload.get("emailExact"), dict):
            # Exact sends execute only the digest-bound payload captured at
            # preview time; they never re-run the agent from a message.
            result = await _execute_exact_email(user, approval)
        elif source == "financeiro" and finance_exact:
            # Exclusão/alteração aprovada: executa só o id aprovado, nunca reinterpreta texto.
            from app.modules.finance.router import execute_finance_exact

            owner_id = _verify_finance_exact_binding(user, approval)
            result = await execute_finance_exact(owner_id, finance_exact)
        elif source == "financeiro":
            from app.routers.financeiro_router import handle_finance_agent

            result = await handle_finance_agent(user_id, message, user=user)
        elif source == "tarefas":
            from app.routers.tarefas_router import handle_task_agent

            result = await handle_task_agent(user_id, message)
        elif source == "email_exact_handled_above":  # unreachable: exact email is dispatched before the agent branches
            result = await _execute_exact_email(user, approval)
        elif source == "email":
            from app.services.email_agent import EmailAgent

            result = await EmailAgent().handle(
                message=message,
                session_id=payload.get("sessionId"),
                user_id=user_id,
            )
        elif source == "agenda":
            from app.routers.agenda_router import agenda_agent

            result = agenda_agent.handle(
                message=message,
                session_id=payload.get("sessionId"),
                user_id=user_id,
            )
        elif source == "automacoes":
            from app.routers.automacoes_router import handle_automation_agent

            result = await handle_automation_agent(user_id, message, str(user.get("nome") or "Nora"))
        elif source == "whatsapp":
            from app.routers.auth_router import effective_permissions
            from app.services.agent_manager import AgentManager
            from app.services import wapi_binding as wb

            permissions = effective_permissions(user)
            if not permissions.get("chat") or not permissions.get("integracao_whatsapp"):
                raise PermissionError("A conta nao possui permissao para enviar mensagens pelo WhatsApp.")

            conversation_id = str(payload.get("conversationId") or "").strip()
            recipient_name = str(payload.get("recipientName") or conversation_id).strip()
            message_text = str(payload.get("messageText") or "").strip()
            expected_instance_id = str(payload.get("instanceId") or "").strip()
            if not conversation_id:
                raise ValueError("A aprovacao do WhatsApp nao possui destinatario validado.")
            if not message_text or len(message_text) > 1200:
                raise ValueError("A aprovacao do WhatsApp nao possui uma mensagem valida.")
            try:
                current_binding = wb.get_owned_binding(user_id)
            except wb.InstanceOwnershipError:
                current_binding = wb.InstanceBinding()
            if (
                not expected_instance_id
                or not current_binding.exists
                or current_binding.state != "connected"
                or current_binding.instance_id != expected_instance_id
            ):
                raise ValueError(
                    "A conexao do WhatsApp mudou ou foi desconectada depois da preparacao. "
                    "Prepare uma nova aprovacao antes de enviar."
                )

            send_result = await AgentManager().execute_message(
                conversation_id,
                message_text,
                canal="whatsapp",
                autorizado=True,
                sender_label=None,
                user_id=user_id,
            )
            sent = bool(send_result.get("sent"))
            result = {
                **send_result,
                "status": "enviado" if sent else "falha_gateway",
                "response": (
                    f"Mensagem enviada no WhatsApp para {recipient_name}."
                    if sent
                    else f"O WhatsApp nao confirmou o envio para {recipient_name}."
                ),
                "conversationId": conversation_id,
                "recipientName": recipient_name,
            }
        elif source == "compound":
            from app.modules.nora.orchestrator import execute_compound_plan

            steps = payload.get("steps") if isinstance(payload.get("steps"), list) else []
            if not steps:
                raise ValueError("O plano aprovado nao possui etapas executaveis.")
            if any(str(step.get("agent") or "") == "whatsapp" for step in steps if isinstance(step, dict)):
                raise ValueError(
                    "Planos compostos com WhatsApp exigem uma aprovacao individual com destinatario e texto exatos."
                )
            result = await execute_compound_plan(user, steps)
        else:
            raise ValueError(f"Agente de aprovacao nao suportado: {source or 'indefinido'}.")

        status = str(result.get("status") or "").casefold()
        not_executed = status.startswith(("precisa", "aguardando", "nao_", "falha")) or status in {
            "ajuda",
            "consulta",
            "resumo",
            "sem_alteracao",
        }
        ok = not not_executed
        description = str(result.get("response") or approval.get("description") or approval.get("title") or "")
        receipt = await record_receipt(
            user,
            ReceiptCreate(
                action=str(approval.get("action") or "approved_action"),
                title=str(approval.get("title") or "Acao aprovada"),
                description=description,
                status="executed" if ok else "failed",
                entityType=source or "operation",
                entityId=str(
                    (result.get("task") or result.get("lancamento") or result.get("automation") or result.get("event") or {}).get("id")
                    or approval.get("id")
                ),
                metadata={"approvalId": approval.get("id"), "agentStatus": result.get("status")},
            ),
        )
        return {"ok": ok, "result": result, "receipt": receipt, "uncertain": bool(result.get("uncertain"))}
    except Exception as exc:
        await record_receipt(
            user,
            ReceiptCreate(
                action=str(approval.get("action") or "approved_action"),
                title=str(approval.get("title") or "Acao aprovada"),
                description=str(exc),
                status="failed",
                entityType=source or "operation",
                entityId=str(approval.get("id") or ""),
                metadata={"approvalId": approval.get("id")},
            ),
        )
        return {"ok": False, "error": str(exc), "result": None}


def _valid_email_address(value: Any) -> str | None:
    text = str(value or "").strip()
    if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", text):
        return text
    return None


def _normalize_exact_recipients(values: Any) -> list[str]:
    items = values if isinstance(values, list) else []
    cleaned = [address for raw in items if (address := _valid_email_address(raw))]
    return cleaned[:EMAIL_SEND_RECIPIENT_CAP]


def _normalize_exact_attachments(values: Any) -> list[dict[str, Any]]:
    items = values if isinstance(values, list) else []
    normalized: list[dict[str, str]] = []
    for entry in items[:EMAIL_SEND_ATTACHMENT_CAP]:
        if not isinstance(entry, dict):
            continue
        file_id = str(entry.get("fileId") or "").strip()
        sha256 = str(entry.get("sha256") or "").strip().lower()
        if not file_id or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            continue
        try:
            size = max(0, int(entry.get("size") or 0))
        except (TypeError, ValueError):
            size = 0
        normalized.append({
            "fileId": file_id[:80],
            "fileName": str(entry.get("fileName") or "anexo")[:180],
            "mimeType": str(entry.get("mimeType") or "application/octet-stream")[:120],
            "size": size,
            "sha256": sha256,
        })
    return normalized


def _normalize_exact_email(exact: dict[str, Any]) -> dict[str, Any]:
    recipients = _normalize_exact_recipients(exact.get("to"))
    if not recipients:
        raise ValueError("Informe ao menos um destinatário válido.")
    body = str(exact.get("body") or "").strip()
    if not body:
        raise ValueError("O corpo do e-mail não pode ficar vazio.")
    return {
        "to": recipients,
        "cc": _normalize_exact_recipients(exact.get("cc")),
        "bcc": _normalize_exact_recipients(exact.get("bcc")),
        "subject": str(exact.get("subject") or "(sem assunto)").strip()[:180] or "(sem assunto)",
        "body": body[:12000],
        "attachments": _normalize_exact_attachments(exact.get("attachments")),
    }


async def create_exact_email_approval(
    user: dict[str, Any],
    exact: dict[str, Any],
    session_id: str | None,
) -> dict[str, Any]:
    """Create a digest-bound approval authorizing one exact Gmail send."""
    user_id = require_user_id(user)
    workspace = current_workspace_id()
    email_exact = _normalize_exact_email(exact)
    recipients = email_exact["to"]
    payload = {
        "kind": "nora_email_exact",
        "sessionId": session_id,
        "idempotencyKey": f"email_{uuid.uuid4().hex}",
        "emailExact": email_exact,
    }
    extra = f" +{len(recipients) - 3}" if len(recipients) > 3 else ""
    title = f"Enviar e-mail para {', '.join(recipients[:3])}{extra}"[:180]
    attachment_names = ", ".join(item["fileName"] for item in email_exact["attachments"][:4])
    description = (
        f"Para: {', '.join(recipients)}\n"
        + (f"Cc: {', '.join(email_exact['cc'])}\n" if email_exact["cc"] else "")
        + (f"Cco: {', '.join(email_exact['bcc'])}\n" if email_exact["bcc"] else "")
        + f"Assunto: {email_exact['subject']}\n"
        + (f"Anexos: {attachment_names}\n" if attachment_names else "")
        + email_exact["body"][:700]
    )[:1200]
    expires_at = (datetime.now(timezone.utc) + EMAIL_APPROVAL_TTL).isoformat()
    digest = approval_digest("nora_email_send_exact", "email", title, description, payload, workspace, user_id)
    return await create_approval(
        user,
        ApprovalCreate(
            title=title,
            description=description,
            action="nora_email_send_exact",
            source="email",
            payload=payload,
            metadata={
                "requestedBy": "nora",
                "requiresExplicitDecision": True,
                "tool": "gmail",
                "version": EMAIL_EXACT_VERSION,
            },
            expiresAt=expires_at,
            digest=digest,
        ),
    )


FINANCE_EXACT_VERSION = "nora-finance-v1"
FINANCE_APPROVAL_TTL = timedelta(hours=24)


async def create_exact_finance_approval(
    user: dict[str, Any],
    owner_id: str,
    exact: dict[str, Any],
    title: str,
    description: str,
) -> dict[str, Any]:
    """Aprovação vinculada a uma exclusão/alteração financeira exata (id + estado do item na prévia)."""
    approver_id = str(user.get("id") or "").strip()
    if not approver_id or not str(owner_id or "").strip():
        raise PermissionError("Usuário não identificado para preparar a aprovação.")
    if str(owner_id).strip() != approver_id:
        raise PermissionError("Esta aprovação financeira pertence a outro usuário. Nada foi alterado.")
    workspace = current_workspace_id()
    payload = {"kind": "nora_finance_exact", "ownerId": str(owner_id), "financeExact": exact}
    expires_at = (datetime.now(timezone.utc) + FINANCE_APPROVAL_TTL).isoformat()
    digest = approval_digest(
        "nora_finance_exact", "financeiro", title, description, payload, workspace, approver_id, FINANCE_EXACT_VERSION
    )
    return await create_approval(
        user,
        ApprovalCreate(
            title=title,
            description=description,
            action="nora_finance_exact",
            source="financeiro",
            payload=payload,
            metadata={
                "requestedBy": "nora",
                "requiresExplicitDecision": True,
                "tool": "financeiro",
                "version": FINANCE_EXACT_VERSION,
            },
            expiresAt=expires_at,
            digest=digest,
        ),
    )


def _verify_finance_exact_binding(user: dict[str, Any], approval: dict[str, Any]) -> str:
    """Recusa execução financeira sem digest válido, de outro ambiente ou de outro dono."""
    user_id = require_user_id(user)
    from app.routers.auth_router import effective_permissions

    if not effective_permissions(user).get("gastos"):
        raise PermissionError("A conta não possui permissão para alterar dados financeiros. Nada foi alterado.")
    payload = approval.get("payload") if isinstance(approval.get("payload"), dict) else {}
    metadata = approval.get("metadata") if isinstance(approval.get("metadata"), dict) else {}
    stored = str(approval.get("digest") or "").strip()
    if str(approval.get("action") or "") != "nora_finance_exact" or not stored:
        raise PermissionError("Aprovação financeira sem vínculo com o conteúdo exato. Nada foi alterado.")
    owner_id = str(payload.get("ownerId") or "").strip()
    if not owner_id or owner_id != user_id:
        raise PermissionError("Esta aprovação financeira pertence a outro usuário. Nada foi alterado.")
    workspace = str(metadata.get("workspace") or "").strip()
    if not workspace or workspace != current_workspace_id():
        raise PermissionError("Esta aprovação financeira pertence a outra empresa. Nada foi alterado.")
    expected = approval_digest(
        "nora_finance_exact",
        "financeiro",
        str(approval.get("title") or ""),
        str(approval.get("description") or ""),
        payload,
        workspace,
        user_id,
        FINANCE_EXACT_VERSION,
    )
    if not hmac.compare_digest(expected, stored):
        raise PermissionError("A aprovação financeira não confere com a prévia aprovada. Nada foi alterado.")
    return owner_id


def _safe_timestamp(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _send_error_is_definitive(exc: Exception) -> bool:
    """Validation and 4xx failures will not succeed on retry; anything else is uncertain."""
    from app.services.gmail_service import GmailConfigError

    if isinstance(exc, (GmailConfigError, ValueError)):
        return True
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "resp", None), "status", None)
    try:
        code = int(status) if status is not None else None
    except (TypeError, ValueError):
        return False
    return code is not None and code < 500


async def _record_send_attempt(
    user_id: str,
    key: str,
    approval_id: str,
    digest: str,
    status: str,
    gmail_id: str | None = None,
    detail: str = "",
) -> dict[str, Any]:
    entry = {
        "key": key,
        "approvalId": approval_id,
        "digest": digest,
        "status": status,
        "gmailId": gmail_id,
        "detail": str(detail or "")[:300],
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    await prepend_item(user_id, SEND_DB, entry)
    return entry


async def _find_send_attempt(user_id: str, key: str) -> dict[str, Any] | None:
    entries = await list_items(user_id, SEND_DB)
    return next((entry for entry in entries if str(entry.get("key")) == key), None)


async def _execute_exact_email(user: dict[str, Any], approval: dict[str, Any]) -> dict[str, Any]:
    """Execute the exact send bound to an approval; never retries or guesses."""
    from app.services.gmail_service import GmailService
    from app.services.nora_files import owned_bytes

    user_id = require_user_id(user)
    approval_payload = approval.get("payload") if isinstance(approval.get("payload"), dict) else {}
    exact = approval_payload.get("emailExact") if isinstance(approval_payload.get("emailExact"), dict) else {}
    key = str(approval_payload.get("idempotencyKey") or "").strip()
    recipients = _normalize_exact_recipients(exact.get("to"))
    subject = str(exact.get("subject") or "(sem assunto)")[:180]
    body = str(exact.get("body") or "")
    if not recipients or not body.strip() or not key:
        return {
            "status": "falha_validacao",
            "response": "A prévia aprovada está incompleta. Gere uma nova prévia no chat.",
        }
    replay = await _find_send_attempt(user_id, key)
    if replay is not None and replay.get("status") == "confirmed":
        return {
            "status": "enviado",
            "response": f"E-mail já enviado para {', '.join(recipients)} (registro {key}). Nada foi duplicado.",
            "gmailId": replay.get("gmailId"),
            "idempotencyKey": key,
            "replayed": True,
        }
    try:
        gmail_status = GmailService(user_id).status()
    except Exception:
        logger.warning("email_send_status_failed")
        gmail_status = {"connected": False}
    if not gmail_status.get("connected"):
        await _record_send_attempt(user_id, key, str(approval.get("id")), str(approval.get("digest") or ""), "failed", detail="gmail_desconectado")
        return {
            "status": "falha_conexao",
            "response": "O Gmail não está conectado. Conecte em Configurações > Integrações e gere uma nova prévia. Nada foi enviado.",
        }
    attachments: list[dict[str, Any]] = []
    try:
        for entry in _normalize_exact_attachments(exact.get("attachments")):
            _record, file_bytes = owned_bytes(user_id, entry["fileId"])
            if hashlib.sha256(file_bytes).hexdigest() != entry["sha256"] or len(file_bytes) != entry["size"]:
                raise ValueError(f"O anexo {entry['fileName']} mudou após a prévia.")
            data_url = f"data:{entry['mimeType']};base64,{base64.b64encode(file_bytes).decode('ascii')}"
            attachments.append({"fileName": entry["fileName"], "mimeType": entry["mimeType"], "dataUrl": data_url})
    except Exception as exc:
        await _record_send_attempt(user_id, key, str(approval.get("id")), str(approval.get("digest") or ""), "failed", detail="anexo_invalido")
        logger.warning("email_send_attachment_failed")
        return {
            "status": "falha_validacao",
            "response": "Não consegui validar os anexos da prévia (arquivo ausente ou alterado). Gere uma nova prévia. Nada foi enviado.",
        }
    try:
        sent = GmailService(user_id).send_message(
            to=recipients,
            subject=subject,
            body=body[:12000],
            cc=_normalize_exact_recipients(exact.get("cc")) or None,
            bcc=_normalize_exact_recipients(exact.get("bcc")) or None,
            attachments=attachments or None,
            extra_headers={"X-Norium-Email-Key": key},
        )
    except Exception as exc:
        if _send_error_is_definitive(exc):
            await _record_send_attempt(user_id, key, str(approval.get("id")), str(approval.get("digest") or ""), "failed", detail="provedor_recusou")
            logger.warning("email_send_rejected")
            return {
                "status": "falha_envio",
                "response": "O Gmail recusou o envio. Confira destinatários e anexos e gere uma nova prévia. Nada foi repetido automaticamente.",
            }
        await _record_send_attempt(user_id, key, str(approval.get("id")), str(approval.get("digest") or ""), "unknown", detail="resultado_incerto")
        logger.warning("email_send_uncertain")
        return {
            "status": "falha_incerta",
            "uncertain": True,
            "response": (
                "Não consegui confirmar se o e-mail foi enviado (falha de comunicação após a tentativa). "
                "Nada será repetido automaticamente: use Verificar envio para reconciliar antes de tentar de novo."
            ),
        }
    gmail_id = sent.get("message", {}).get("id") if isinstance(sent.get("message"), dict) else None
    try:
        await _record_send_attempt(user_id, key, str(approval.get("id")), str(approval.get("digest") or ""), "confirmed", gmail_id=gmail_id)
    except Exception:
        logger.warning("email_send_receipt_failed")
        return {
            "status": "falha_incerta",
            "uncertain": True,
            "response": "O envio foi aceito, mas não consegui registrar o comprovante. Use Verificar envio para confirmar antes de tentar de novo.",
        }
    return {
        "status": "enviado",
        "response": f"E-mail enviado para {', '.join(recipients)} com assunto “{subject}”.",
        "gmailId": gmail_id,
        "idempotencyKey": key,
    }


async def reconcile_email_send(user: dict[str, Any], approval_id: str) -> dict[str, Any]:
    """Check the sent folder for an uncertain send; read-only, never resends."""
    from app.services.gmail_service import GmailService

    user_id = require_user_id(user)
    items = await list_items(user_id, APPROVAL_DB)
    current = next((item for item in items if str(item.get("id")) == approval_id), None)
    if current is None:
        return {"reconciled": False, "reason": "approval_not_found"}
    approval_payload = current.get("payload") if isinstance(current.get("payload"), dict) else {}
    exact = approval_payload.get("emailExact") if isinstance(approval_payload.get("emailExact"), dict) else {}
    if not exact:
        raise ValueError("Esta aprovação não é um envio de e-mail.")
    if not current.get("executionUncertain"):
        raise ValueError("Este envio não precisa de reconciliação.")
    recipients = _normalize_exact_recipients(exact.get("to"))
    subject = str(exact.get("subject") or "")
    if not recipients or not subject:
        raise ValueError("A prévia aprovada está incompleta.")
    try:
        created_at = datetime.fromisoformat(str(current.get("createdAt") or "").replace("Z", "+00:00"))
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        created_at = datetime.now(timezone.utc) - timedelta(hours=1)
    earliest = int((created_at - timedelta(minutes=5)).timestamp())
    try:
        listing = GmailService(user_id).list_messages(folder="sent", query=f"to:{recipients[0]} subject:({subject})", max_results=5)
    except Exception:
        logger.warning("email_reconcile_unavailable")
        return {
            "reconciled": False,
            "reason": "provider_unavailable",
            "guidance": "Não consegui consultar a caixa de enviados agora. Tente verificar de novo em instantes.",
        }
    messages = listing.get("messages") if isinstance(listing.get("messages"), list) else []
    match = next(
        (
            message
            for message in messages
            if isinstance(message, dict)
            and str(message.get("subject") or "") == subject
            and recipients[0].lower() in str(message.get("to") or "").lower()
            and _safe_timestamp(message.get("timestamp")) >= earliest
        ),
        None,
    )
    if match is None:
        await record_audit(
            user,
            AuditCreate(
                action="email_reconcile_checked",
                source="email",
                description=str(current.get("title") or "Envio de e-mail"),
                status="warning",
                entityType="approval",
                entityId=approval_id,
            ),
        )
        return {
            "reconciled": False,
            "reason": "not_found",
            "guidance": "Nenhum e-mail correspondente na caixa de enviados. Se precisar, gere um novo envio no chat; nada foi repetido.",
        }
    gmail_id = str(match.get("id") or "")
    key = str(approval_payload.get("idempotencyKey") or "")
    execution = {
        "status": "enviado",
        "response": f"E-mail confirmado na caixa de enviados para {', '.join(recipients)} (reconciliado).",
        "gmailId": gmail_id,
        "idempotencyKey": key,
        "reconciled": True,
    }
    await replace_item(user_id, APPROVAL_DB, approval_id, {"status": "executed", "updatedAt": now_iso(), "execution": execution, "executionError": "", "executionUncertain": False})
    if key:
        await _record_send_attempt(user_id, key, approval_id, str(current.get("digest") or ""), "confirmed", gmail_id=gmail_id, detail="reconciliado")
    receipt = await record_receipt(
        user,
        ReceiptCreate(
            action="nora_email_send_exact",
            title=str(current.get("title") or "Envio de e-mail"),
            description="Envio confirmado por reconciliação da caixa de enviados.",
            status="executed",
            entityType="email",
            entityId=approval_id,
            metadata={"approvalId": approval_id, "reconciled": True},
        ),
    )
    await record_audit(
        user,
        AuditCreate(
            action="email_reconciled",
            source="email",
            description=str(current.get("title") or "Envio de e-mail"),
            status="success",
            entityType="approval",
            entityId=approval_id,
        ),
    )
    updated = next((item for item in await list_items(user_id, APPROVAL_DB) if str(item.get("id")) == approval_id), current)
    return {"reconciled": True, "item": updated, "receipt": receipt, "gmailId": gmail_id}


async def finalize_email_agent_result(
    user: dict[str, Any],
    agent: Any | None,
    result: dict[str, Any],
    surface: str = "chat",
) -> dict[str, Any]:
    """Turn email-agent outcomes into approval actions; nothing sends here."""
    status = str(result.get("status") or "")
    session_id = result.get("session_id")
    if status == "cancelado":
        cancel_id = result.get("cancelApprovalId")
        if cancel_id:
            try:
                current = await decide_approval(user, str(cancel_id), ApprovalDecision(decision="cancelled", note="Rascunho cancelado no chat."))
                if current is None:
                    raise ValueError("Aprovação não encontrada.")
                if current.get("status") != "cancelled":
                    return {**result, "status": "aprovacao_concluida", "response": "O rascunho foi encerrado, mas este pedido já teve uma decisão ou tentativa de envio. Confira o resultado em Operações; envios incertos precisam de verificação.", "approval": current}
            except Exception:
                logger.warning("email_cancel_approval_failed")
                return {**result, "status": "falha_cancelamento", "response": "Não consegui revogar o cartão de aprovação. Verifique a Central de aprovações antes de continuar; não preparei outro envio."}
        return result
    if status != "pronto_para_aprovacao":
        invalidate_id = result.get("invalidateApprovalId")
        if invalidate_id:
            user_id = require_user_id(user)
            async with approval_decision_lock(user_id, str(invalidate_id)):
                current = next((item for item in await list_items(user_id, APPROVAL_DB) if item.get("id") == invalidate_id), None)
                if current is None:
                    raise ValueError("Não encontrei a aprovação para editar este rascunho.")
                _verify_email_preview_binding(user_id, current, session_id)
                await _decide_approval_unlocked(user, str(invalidate_id), ApprovalDecision(decision="cancelled", note="Rascunho em edição no chat."))
        return result
    user_id = require_user_id(user)
    sessions = getattr(agent, "sessions", None)
    linked = sessions.get(session_id) if isinstance(sessions, dict) else None
    # One transient draft prepares one persistent approval in this process.
    # Persisted sessionId lookup also prevents a replay from creating another key.
    async with AsyncExitStack() as stack:
        await stack.enter_async_context(approval_decision_lock(user_id, f"email-preview:{current_workspace_id()}:{session_id}"))
        if linked is not None and hasattr(linked, "lock"):
            await stack.enter_async_context(linked.lock)
        return await _finalize_email_ready(user, agent, linked, result, surface)


def _verify_email_preview_binding(user_id: str, current: dict[str, Any], session_id: str) -> None:
    metadata = current.get("metadata") if isinstance(current.get("metadata"), dict) else {}
    payload = current.get("payload") if isinstance(current.get("payload"), dict) else {}
    requested_by = current.get("requestedBy") if isinstance(current.get("requestedBy"), dict) else {}
    workspace = current_workspace_id()
    if (
        current.get("action") != "nora_email_send_exact"
        or current.get("source") != "email"
        or payload.get("kind") != "nora_email_exact"
        or payload.get("sessionId") != session_id
        or requested_by.get("id") != user_id
        or metadata.get("workspace") != workspace
        or metadata.get("version") != EMAIL_EXACT_VERSION
    ):
        raise ValueError("Esta aprovação não pertence ao rascunho neste ambiente.")
    expected = approval_digest("nora_email_send_exact", "email", current.get("title") or "", current.get("description") or "", payload, workspace, user_id)
    if not hmac.compare_digest(str(current.get("digest") or ""), expected):
        raise ValueError("A aprovação foi alterada. Inicie um novo pedido para revisar o conteúdo exato.")


async def _finalize_email_ready(user: dict[str, Any], agent: Any | None, linked: Any | None, result: dict[str, Any], surface: str) -> dict[str, Any]:
    session_id = result.get("session_id")
    user_id = require_user_id(user)
    try:
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("O rascunho não possui uma sessão válida. Inicie um novo pedido.")
        exact = _normalize_exact_email(result.get("emailExact") or {})
        if agent is not None and (
            linked is None or linked.cancelled or linked.user_id != user_id
            or linked.workspace_id != current_workspace_id()
            or linked.awaiting != "confirmacao"
            or _normalize_exact_email(agent._exact_payload(linked)) != exact
        ):
            raise ValueError("O rascunho mudou ou foi cancelado. Revise a prévia atual antes de aprovar.")
        items = await list_items(user_id, APPROVAL_DB)
        approval_id = (linked.fields.get("_approval_id") if linked else None) or result.get("supersedes")
        current = next((item for item in items if str(item.get("id")) == str(approval_id)), None) if approval_id else next((item for item in items if (item.get("payload") or {}).get("sessionId") == session_id and item.get("action") == "nora_email_send_exact"), None)
        if approval_id and current is None:
            raise ValueError("Não encontrei a aprovação deste rascunho. Inicie um novo pedido.")
        approval = None
        if current:
            # Serialize replacement with the actual decision/send of the old card.
            async with approval_decision_lock(user_id, str(current["id"])):
                current = next(item for item in await list_items(user_id, APPROVAL_DB) if item.get("id") == current["id"])
                _verify_email_preview_binding(user_id, current, session_id)
                expiry = _parse_expiry(current.get("expiresAt"))
                if expiry is None or expiry <= datetime.now(timezone.utc):
                    raise ValueError("Esta aprovação expirou. Inicie um novo pedido para revisar a prévia.")
                if current.get("status") == "pending":
                    if current["payload"]["emailExact"] == exact:
                        approval = current
                    else:
                        await _decide_approval_unlocked(user, str(current["id"]), ApprovalDecision(decision="cancelled", note="Substituída por nova prévia do chat."))
                elif current.get("status") == "cancelled" and current.get("decisionNote") == "Rascunho em edição no chat.":
                    pass  # Editing revoked the old card before collecting new data.
                else:
                    return {
                        "session_id": session_id, "status": "aprovacao_concluida",
                        "response": "Este pedido já tem uma decisão ou tentativa de envio registrada. Confira o resultado em Operações; para envio incerto, use Verificar envio. Nenhum novo envio foi preparado.",
                        "fields": result.get("fields"), "preview": result.get("preview"), "approval": current,
                    }
        if approval is None:
            approval = await create_exact_email_approval(user, exact, session_id)
    except ValueError as exc:
        return {
            "session_id": session_id,
            "status": "falha_validacao",
            "response": f"{exc} Revise a prévia no chat.",
            "fields": result.get("fields"),
            "preview": result.get("preview"),
        }
    if linked is not None:
        linked.fields["_approval_id"] = approval["id"]
    if surface == "mail":
        response = "Prévia pronta. Aprove em Operações > Central de aprovações para enviar, ou peça um ajuste no chat."
    else:
        response = "Prévia pronta. Confira o cartão de aprovação abaixo e use Permitir para enviar, ou peça um ajuste."
    return {
        "session_id": session_id,
        "status": "aguardando_aprovacao",
        "response": response,
        "fields": result.get("fields"),
        "preview": result.get("preview"),
        "approval": approval,
    }


async def edit_approval(
    user: dict[str, Any],
    approval_id: str,
    payload: ApprovalUpdate,
) -> dict[str, Any] | None:
    user_id = require_user_id(user)
    current_items = await list_items(user_id, APPROVAL_DB)
    current = next((item for item in current_items if str(item.get("id")) == approval_id), None)
    if current is None or current.get("status") != "pending":
        return None
    if str(current.get("digest") or "").strip():
        raise ValueError("Esta aprovação está vinculada ao conteúdo exato. Edite pelo chat para gerar uma nova prévia.")
    update: dict[str, Any] = {
        "title": payload.title,
        "description": payload.description,
        "updatedAt": now_iso(),
    }
    if (
        str(current.get("source") or "").casefold() == "whatsapp"
        and str(current.get("action") or "") == "nora_whatsapp_execute"
    ):
        message_text = payload.description.strip()
        if not message_text:
            raise ValueError("A mensagem do WhatsApp nao pode ficar vazia.")
        current_payload = current.get("payload") if isinstance(current.get("payload"), dict) else {}
        # Somente o texto é editável nesta tela. O destino validado permanece
        # imutável e continua vindo do payload original da aprovação.
        update["payload"] = {**current_payload, "messageText": message_text}
        recipient_name = str(current_payload.get("recipientName") or current_payload.get("conversationId") or "destinatario").strip()
        update["title"] = f"Enviar mensagem no WhatsApp para {recipient_name}"[:180]
    approval = await replace_item(
        user_id,
        APPROVAL_DB,
        approval_id,
        update,
    )
    if approval is not None:
        await record_audit(
            user,
            AuditCreate(
                action="approval_edited",
                source=str(approval.get("source") or "operacao"),
                description=payload.title,
                status="info",
                entityType="approval",
                entityId=approval_id,
            ),
        )
    return approval


def _token_connected(profile: dict[str, Any], section: str) -> bool:
    token = profile.get(section)
    return isinstance(token, dict) and bool(token.get("refresh_token") or token.get("token"))


def _last_event_by_source(events: list[dict[str, Any]], source: str) -> str | None:
    return next((str(event.get("timestamp")) for event in events if event.get("source") == source), None)


_integration_reads: dict[tuple[int, str, str, str], asyncio.Task] = {}
_integration_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="integration-health")
_integration_slots: WeakKeyDictionary = WeakKeyDictionary()


async def _load_integration_health(user_id: str, events: list[dict[str, Any]], audits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    loop = asyncio.get_running_loop()
    slots = _integration_slots.setdefault(loop, asyncio.Semaphore(2))
    # Locked W-API reads must never exhaust the default pool used by JSON stores.
    # Acquire before submission so waiting accounts don't fill an executor queue.
    async with slots:
        context = contextvars.copy_context()
        return await loop.run_in_executor(_integration_executor, context.run, integration_health, user_id, events, audits)


async def read_integration_health(user_id: str, events: list[dict[str, Any]], audits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # The W-API ownership store may wait on a process/SQLite lock. Keep that wait
    # off the event loop and reuse unfinished work when the browser retries.
    key = (id(asyncio.get_running_loop()), str(get_data_root()), user_id, current_workspace_id())
    task = _integration_reads.get(key)
    if task is None or task.done():
        task = asyncio.create_task(_load_integration_health(user_id, events, audits))
        _integration_reads[key] = task
        def finished(completed: asyncio.Task) -> None:
            if _integration_reads.get(key) is completed:
                _integration_reads.pop(key, None)
            if not completed.cancelled():
                completed.exception()
        task.add_done_callback(finished)
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=8)
    except TimeoutError:
        raise HTTPException(status_code=504, detail="A verificação das integrações ainda está em andamento. Tente atualizar esta seção.") from None


def integration_health(user_id: str, events: list[dict[str, Any]], audits: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    profile = read_profile_db(user_id, {})
    gmail_connected = _token_connected(profile, "gmailToken")
    calendar_connected = _token_connected(profile, "calendarToken") and not bool(profile.get("calendarTokenRevoked"))
    from app.services import wapi_binding as _wapi_binding

    # Conectado quando a conta tem uma instancia W-API vinculada e conectada.
    try:
        whatsapp_configured = (
            _wapi_binding.get_owned_binding(user_id).state == "connected"
        )
    except _wapi_binding.InstanceOwnershipError:
        whatsapp_configured = False

    audits = audits or []

    def failure_count(source: str) -> int:
        return len([
            item for item in audits
            if str(item.get("source") or "").casefold() == source.casefold()
            and str(item.get("status") or "") == "error"
        ])

    return [
        {
            "id": "gmail",
            "name": "Gmail",
            "status": "online" if gmail_connected else "attention",
            "connected": gmail_connected,
            "lastSync": (profile.get("gmailSync") or {}).get("lastSync") or _last_event_by_source(events, "gmail"),
            "detail": "Conta sincronizada" if gmail_connected else "Conecte sua conta do Google",
            "permissions": ["Ler", "Enviar", "Modificar"] if gmail_connected else [],
            "failures": failure_count("gmail"),
        },
        {
            "id": "calendar",
            "name": "Google Agenda",
            "status": "online" if calendar_connected else "attention",
            "connected": calendar_connected,
            "lastSync": _last_event_by_source(events, "calendar"),
            "detail": "Agenda sincronizada" if calendar_connected else "Autorizacao necessaria",
            "permissions": ["Ler eventos", "Criar e editar"] if calendar_connected else [],
            "failures": failure_count("calendar"),
        },
        {
            "id": "whatsapp",
            "name": "WhatsApp",
            "status": "online" if whatsapp_configured else "attention",
            "connected": whatsapp_configured,
            "lastSync": _last_event_by_source(events, "whatsapp"),
            "detail": "API privada configurada" if whatsapp_configured else "API privada nao configurada",
            "permissions": ["Mensagens", "Midias"] if whatsapp_configured else [],
            "failures": failure_count("whatsapp"),
        },
        {
            "id": "local",
            "name": "Modulos internos",
            "status": "online",
            "connected": True,
            "lastSync": now_iso(),
            "detail": "Tarefas, financeiro e automacoes ativos",
            "permissions": ["Dados locais do usuario"],
            "failures": failure_count("local"),
        },
    ]


def _today_calendar_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    today = datetime.now(LOCAL_TZ).date()
    items: list[dict[str, Any]] = []
    for event in events:
        if event.get("source") != "calendar":
            continue
        metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
        candidate = metadata.get("start") or metadata.get("startDate") or event.get("timestamp")
        try:
            parsed = datetime.fromisoformat(str(candidate).replace("Z", "+00:00")).astimezone(LOCAL_TZ).date()
        except (TypeError, ValueError):
            continue
        if parsed == today:
            items.append(event)
    return items[:10]


def _proactive_alerts(
    tasks: list[dict[str, Any]],
    finance: dict[str, Any],
    events: list[dict[str, Any]],
    integrations: list[dict[str, Any]],
    audits: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    today = datetime.now(LOCAL_TZ).date()
    overdue = []
    for task in tasks:
        due_value = task.get("dueDate")
        if not due_value or str(task.get("status")) in {"concluida", "concluido"}:
            continue
        try:
            if date.fromisoformat(str(due_value)[:10]) < today:
                overdue.append(task)
        except ValueError:
            continue
    if overdue:
        alerts.append({
            "id": "alert_overdue_tasks",
            "kind": "tasks",
            "severity": "warning",
            "title": f"{len(overdue)} tarefa(s) vencida(s)",
            "description": f'Prioridade inicial: {overdue[0].get("title")}.',
            "tab": "Tarefas",
        })

    finance_reminders = finance.get("lembretes") or []
    overdue_reminders = [
        reminder for reminder in finance_reminders
        if int(reminder.get("daysUntil") or 0) < 0
    ]
    if overdue_reminders:
        first = overdue_reminders[0]
        overdue_days = abs(int(first.get("daysUntil") or 0))
        alerts.append({
            "id": "alert_finance_overdue",
            "kind": "finance",
            "severity": "error",
            "title": f"{len(overdue_reminders)} pagamento(s) vencido(s)",
            "description": f'{first.get("title") or "Pagamento"} venceu ha {overdue_days} dia(s).',
            "tab": "Gastos",
        })

    upcoming_reminders = [
        reminder for reminder in finance_reminders
        if 0 <= int(reminder.get("daysUntil") or 0) <= 1
    ]
    if upcoming_reminders:
        first = upcoming_reminders[0]
        alerts.append({
            "id": "alert_finance_due",
            "kind": "finance",
            "severity": "warning",
            "title": f"{len(upcoming_reminders)} pagamento(s) proximo(s)",
            "description": f'{first.get("title") or "Pagamento"} vence em {first.get("daysUntil", 0)} dia(s).',
            "tab": "Gastos",
        })

    important_mail = []
    for event in events:
        if event.get("source") != "gmail":
            continue
        metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
        labels = " ".join(str(value) for value in metadata.get("labels", [])).casefold()
        unread = bool(metadata.get("unread") or metadata.get("isUnread") or "unread" in labels)
        important = bool(metadata.get("important") or "important" in labels or "importante" in _search_text(event.get("title")))
        if unread and important:
            important_mail.append(event)
    if important_mail:
        alerts.append({
            "id": "alert_important_mail",
            "kind": "email",
            "severity": "info",
            "title": f"{len(important_mail)} e-mail(s) importante(s) sem leitura",
            "description": str(important_mail[0].get("title") or "Abra a caixa de entrada para revisar."),
            "tab": "E-mails",
        })

    unhealthy = [item for item in integrations if item.get("status") != "online"]
    if unhealthy:
        alerts.append({
            "id": "alert_integrations",
            "kind": "integration",
            "severity": "error",
            "title": f"{len(unhealthy)} integracao(oes) precisam de atencao",
            "description": ", ".join(str(item.get("name")) for item in unhealthy[:3]),
            "tab": "Controle",
        })

    automation_failures = [
        item for item in audits
        if str(item.get("source") or "").casefold() in {"automacao", "automacoes", "automation"}
        and str(item.get("status") or "") == "error"
    ]
    if automation_failures:
        alerts.append({
            "id": "alert_automation_failures",
            "kind": "automation",
            "severity": "error",
            "title": f"{len(automation_failures)} falha(s) em automacoes",
            "description": str(automation_failures[0].get("description") or "Revise o historico do fluxo."),
            "tab": "Automações",
        })
    return alerts


def _daily_briefing(summary: dict[str, int], alerts: list[dict[str, Any]]) -> dict[str, Any]:
    hour = datetime.now(LOCAL_TZ).hour
    greeting = "Bom dia" if hour < 12 else "Boa tarde" if hour < 18 else "Boa noite"
    highlights = [
        f'{summary.get("todayEvents", 0)} compromisso(s) hoje',
        f'{summary.get("activeTasks", 0)} tarefa(s) ativa(s)',
    ]
    if "pendingApprovals" in summary:
        highlights.append(f'{summary["pendingApprovals"]} aprovacao(oes) pendente(s)')
    return {
        "greeting": greeting,
        "title": "Seu resumo operacional esta pronto",
        "description": "; ".join(highlights) + ".",
        "priority": alerts[0] if alerts else None,
        "generatedAt": now_iso(),
    }


def _search_text(value: Any) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(character for character in normalized if not unicodedata.combining(character)).casefold()


def _matches(query: str, *values: Any) -> bool:
    return query in " ".join(_search_text(value) for value in values)


async def global_search(user: dict[str, Any], query: str, limit: int = 20) -> dict[str, Any]:
    """Search tenant-owned operational data without exposing another user's records."""
    user_id = require_user_id(user)
    normalized_query = _search_text(query).strip()
    if len(normalized_query) < 2:
        return {"query": query, "items": [], "total": 0}

    events, approvals, receipts, templates, follow_ups = await asyncio.gather(
        read_events(user_id),
        list_items(user_id, APPROVAL_DB),
        list_items(user_id, RECEIPT_DB),
        list_items(user_id, TEMPLATE_DB),
        list_items(user_id, FOLLOWUP_DB),
    )
    tasks = list_tasks(user_id, status="todas").get("tasks") or []
    finance = list_finance(user_id).get("lancamentos") or []
    clients = list_clients(user_id)
    memory = await list_nora_memory(user)
    try:
        from app.routers.automacoes_router import read_store

        automations = read_store(user_id).get("automations") or []
    except Exception:
        automations = []
    results: list[dict[str, Any]] = []

    def append_result(
        *,
        item_id: Any,
        kind: str,
        title: Any,
        description: Any,
        tab: str,
        timestamp: Any = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        if not _matches(normalized_query, title, description, kind, *(metadata or {}).values()):
            return
        results.append(
            {
                "id": str(item_id or f"search_{len(results)}"),
                "kind": kind,
                "title": str(title or "Sem titulo"),
                "description": str(description or ""),
                "tab": tab,
                "timestamp": timestamp,
                "metadata": metadata or {},
            }
        )

    for task in tasks:
        append_result(
            item_id=task.get("id"),
            kind="Tarefa",
            title=task.get("title"),
            description=task.get("description") or task.get("status"),
            tab="Tarefas",
            timestamp=task.get("updatedAt") or task.get("createdAt") or task.get("dueDate"),
            metadata={"projectId": task.get("projectId"), "status": task.get("status"), "priority": task.get("priority")},
        )

    for entry in finance:
        append_result(
            item_id=entry.get("id"),
            kind="Financeiro",
            title=entry.get("title"),
            description=entry.get("description") or entry.get("category"),
            tab="Gastos",
            timestamp=entry.get("updatedAt") or entry.get("createdAt") or entry.get("dueDate"),
            metadata={"type": entry.get("type"), "status": entry.get("status"), "category": entry.get("category")},
        )

    for automation in automations:
        append_result(
            item_id=automation.get("id"),
            kind="Automacao",
            title=automation.get("name"),
            description=automation.get("description") or automation.get("category"),
            tab="Automações",
            timestamp=automation.get("updatedAt") or automation.get("createdAt"),
            metadata={"status": automation.get("status"), "trigger": automation.get("trigger"), "version": automation.get("version")},
        )

    for client in clients:
        append_result(
            item_id=client.get("id"),
            kind="Cliente",
            title=client.get("name"),
            description=client.get("company") or client.get("email") or client.get("phone"),
            tab="Clientes",
            timestamp=client.get("updatedAt") or client.get("createdAt"),
            metadata={
                "status": client.get("status"),
                "stage": client.get("stage"),
                "ownerName": client.get("ownerName"),
                "segment": client.get("segment"),
            },
        )

    for template in templates:
        append_result(
            item_id=template.get("id"),
            kind="Modelo",
            title=template.get("name"),
            description=template.get("content"),
            tab="Controle",
            timestamp=template.get("updatedAt") or template.get("createdAt"),
            metadata={"category": template.get("category")},
        )

    for follow_up in follow_ups:
        append_result(
            item_id=follow_up.get("id"),
            kind="Acompanhamento",
            title=follow_up.get("title"),
            description=follow_up.get("description"),
            tab="Controle",
            timestamp=follow_up.get("updatedAt") or follow_up.get("createdAt") or follow_up.get("dueAt"),
            metadata={"status": follow_up.get("status"), "relatedType": follow_up.get("relatedType")},
        )

    for preference in memory:
        append_result(
            item_id=preference.get("id"),
            kind="Memoria da Nora",
            title=preference.get("key"),
            description=preference.get("value"),
            tab="Controle",
            timestamp=preference.get("updatedAt") or preference.get("createdAt"),
            metadata={"scope": preference.get("scope"), "category": preference.get("category")},
        )

    source_tabs = {
        "gmail": "E-mails",
        "whatsapp": "Chat",
        "calendar": "Agenda",
        "kanban": "Tarefas",
        "financeiro": "Gastos",
        "equipe": "Equipe",
        "automacoes": "Automações",
        "brainstorm": "Brainstorm",
        "relatorios": "Relatorios",
        "sistema": "Controle",
    }
    for event in events:
        source = str(event.get("source") or "sistema")
        append_result(
            item_id=event.get("id"),
            kind="Atividade",
            title=event.get("title"),
            description=event.get("description"),
            tab=source_tabs.get(source, "Central"),
            timestamp=event.get("timestamp"),
            metadata={"source": source, **(event.get("metadata") if isinstance(event.get("metadata"), dict) else {})},
        )

    for approval in approvals:
        append_result(
            item_id=approval.get("id"),
            kind="Aprovacao",
            title=approval.get("title"),
            description=approval.get("description") or approval.get("action"),
            tab="Controle",
            timestamp=approval.get("updatedAt") or approval.get("createdAt"),
            metadata={"status": approval.get("status"), "source": approval.get("source")},
        )

    for receipt in receipts:
        append_result(
            item_id=receipt.get("id"),
            kind="Comprovante",
            title=receipt.get("title"),
            description=receipt.get("description") or receipt.get("action"),
            tab="Controle",
            timestamp=receipt.get("timestamp"),
            metadata={"status": receipt.get("status"), "entityType": receipt.get("entityType")},
        )

    def sort_key(item: dict[str, Any]) -> str:
        return str(item.get("timestamp") or "")

    results.sort(key=sort_key, reverse=True)
    return {"query": query, "items": results[:limit], "total": len(results)}


async def operations_overview(user: dict[str, Any]) -> dict[str, Any]:
    user_id = require_user_id(user)
    events, approvals, audits, receipts, templates, follow_ups, tasks, finance, memory, settings = await asyncio.gather(
        read_events(user_id),
        list_items(user_id, APPROVAL_DB),
        list_items(user_id, AUDIT_DB),
        list_items(user_id, RECEIPT_DB),
        list_items(user_id, TEMPLATE_DB),
        list_items(user_id, FOLLOWUP_DB),
        asyncio.to_thread(list_tasks, user_id, status="todas"),
        asyncio.to_thread(list_finance, user_id),
        list_nora_memory(user),
        get_operation_settings(user),
    )
    task_stats = tasks.get("stats") if isinstance(tasks.get("stats"), dict) else {}
    finance_summary = finance.get("resumo") if isinstance(finance.get("resumo"), dict) else {}

    pending_approvals = [item for item in approvals if item.get("status") == "pending"]
    integrations = await read_integration_health(user_id, events, audits)
    today_events = _today_calendar_events(events)
    summary = {
        "pendingApprovals": len(pending_approvals),
        "activeTasks": int(task_stats.get("ativas") or 0),
        "overdueTasks": int(task_stats.get("vencidas") or 0),
        "todayEvents": len(today_events),
        "financialReminders": len(finance.get("lembretes") or []),
        "unhealthyIntegrations": len([item for item in integrations if item.get("status") != "online"]),
    }
    alerts = _proactive_alerts(tasks.get("tasks") or [], finance, events, integrations, audits)
    return {
        "generatedAt": now_iso(),
        "summary": summary,
        "briefing": _daily_briefing(summary, alerts),
        "alerts": alerts,
        "myDay": {
            "tasks": (tasks.get("tasks") or [])[:8],
            "calendar": today_events,
            "financialReminders": (finance.get("lembretes") or [])[:8],
            "financeSummary": finance_summary,
        },
        "approvals": approvals[:50],
        "audit": audits[:80],
        "receipts": receipts[:50],
        "integrations": integrations,
        "memory": memory[:30],
        "templates": templates[:100],
        "followUps": follow_ups[:100],
        "settings": settings,
    }
