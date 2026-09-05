from __future__ import annotations

import asyncio
import os
import uuid
import unicodedata
from datetime import date, datetime, timedelta, timezone
from typing import Any

from app.core.tenant import read_profile_db
from app.modules.clients.repository import list_clients
from app.modules.inbox.router import manager, read_events, record_event
from app.modules.operations.repository import (
    APPROVAL_DB,
    AUDIT_DB,
    FOLLOWUP_DB,
    MEMORY_DB,
    RECEIPT_DB,
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
    user_id = str(user.get("id") or "lucas123")
    if scope == "team":
        return str(user.get("teamOwnerId") or user_id)
    return user_id


async def list_nora_memory(user: dict[str, Any]) -> list[dict[str, Any]]:
    user_id = str(user.get("id") or "lucas123")
    team_id = str(user.get("teamOwnerId") or user_id)
    personal, team = await asyncio.gather(
        list_items(user_id, MEMORY_DB),
        list_items(team_id, MEMORY_DB),
    )
    items = [item for item in personal if item.get("scope") == "personal"]
    items.extend(item for item in team if item.get("scope") == "team")
    unique: dict[str, dict[str, Any]] = {str(item.get("id")): item for item in items}
    return sorted(unique.values(), key=lambda item: str(item.get("updatedAt") or ""), reverse=True)


async def save_nora_memory(user: dict[str, Any], payload: NoraMemoryCreate) -> dict[str, Any]:
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
        str(user.get("id") or "lucas123"),
        str(user.get("teamOwnerId") or user.get("id") or "lucas123"),
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
    return await prepend_item(str(user.get("id") or "lucas123"), AUDIT_DB, item)


async def record_receipt(user: dict[str, Any], payload: ReceiptCreate) -> dict[str, Any]:
    user_id = str(user.get("id") or "lucas123")
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
    user_id = str(user.get("id") or "lucas123")
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
    user_id = str(user.get("id") or "lucas123")
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
    user_id = str(user.get("id") or "lucas123")
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
    await prepend_item(str(user.get("id") or "lucas123"), TEMPLATE_DB, item)
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
    return await replace_item(str(user.get("id") or "lucas123"), TEMPLATE_DB, template_id, update)


async def create_follow_up(user: dict[str, Any], payload: FollowUpCreate) -> dict[str, Any]:
    item = {
        "id": f"followup_{uuid.uuid4().hex}",
        **payload.model_dump(),
        "status": "open",
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "createdBy": actor_payload(user),
    }
    await prepend_item(str(user.get("id") or "lucas123"), FOLLOWUP_DB, item)
    return item


async def update_follow_up(
    user: dict[str, Any],
    follow_up_id: str,
    payload: FollowUpUpdate,
) -> dict[str, Any] | None:
    update = {**payload.model_dump(exclude_none=True), "updatedAt": now_iso()}
    if update.get("status") == "done":
        update["completedAt"] = now_iso()
    return await replace_item(str(user.get("id") or "lucas123"), FOLLOWUP_DB, follow_up_id, update)


async def create_approval(user: dict[str, Any], payload: ApprovalCreate) -> dict[str, Any]:
    user_id = str(user.get("id") or "lucas123")
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
    )
    await manager.broadcast(
        user_id,
        {
            "type": "SYSTEM_NOTIFICATION",
            "notification": {
                "title": "Aprovacao necessaria",
                "description": payload.title,
                "severity": "warning",
                "metadata": {"approvalId": item["id"]},
            },
        },
    )
    return item


async def decide_approval(
    user: dict[str, Any],
    approval_id: str,
    payload: ApprovalDecision,
) -> dict[str, Any] | None:
    user_id = str(user.get("id") or "lucas123")
    async with approval_decision_lock(user_id, approval_id):
        return await _decide_approval_unlocked(user, approval_id, payload)


async def _decide_approval_unlocked(
    user: dict[str, Any],
    approval_id: str,
    payload: ApprovalDecision,
) -> dict[str, Any] | None:
    user_id = str(user.get("id") or "lucas123")
    current_items = await list_items(user_id, APPROVAL_DB)
    current = next((item for item in current_items if str(item.get("id")) == approval_id), None)
    if current is None:
        return None
    # A decisão é uma transição única. Retry, duplo clique e duas requisições
    # concorrentes recebem o estado já persistido e nunca repetem a execução.
    if str(current.get("status") or "") != "pending":
        return current

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
            },
        ) or approval
    return approval


async def execute_approved_action(user: dict[str, Any], approval: dict[str, Any]) -> dict[str, Any]:
    """Execute the exact agent request captured before approval and persist proof."""
    user_id = str(user.get("id") or "lucas123")
    payload = approval.get("payload") if isinstance(approval.get("payload"), dict) else {}
    message = str(payload.get("originalMessage") or "").strip()
    source = str(approval.get("source") or "").casefold()
    result: dict[str, Any]

    try:
        if not message:
            raise ValueError("A solicitacao aprovada nao possui a instrucao original.")
        if source == "financeiro":
            from app.routers.financeiro_router import handle_finance_agent

            result = await handle_finance_agent(user_id, message)
        elif source == "tarefas":
            from app.routers.tarefas_router import handle_task_agent

            result = await handle_task_agent(user_id, message)
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
        return {"ok": ok, "result": result, "receipt": receipt}
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


async def edit_approval(
    user: dict[str, Any],
    approval_id: str,
    payload: ApprovalUpdate,
) -> dict[str, Any] | None:
    user_id = str(user.get("id") or "lucas123")
    current_items = await list_items(user_id, APPROVAL_DB)
    current = next((item for item in current_items if str(item.get("id")) == approval_id), None)
    if current is None or current.get("status") != "pending":
        return None
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
        f'{summary.get("pendingApprovals", 0)} aprovacao(oes) pendente(s)',
    ]
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
    user_id = str(user.get("id") or "lucas123")
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
    user_id = str(user.get("id") or "lucas123")
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
    integrations = integration_health(user_id, events, audits)
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
