"""Assignment and strictly internal notes. This module has no sending adapter."""
from __future__ import annotations

import time
import uuid
from fastapi import HTTPException

from app.modules.auth.router import effective_permissions
from .access import Access, assert_conversation
from . import repository

STATUSES = frozenset({"open", "waiting_customer", "resolved"})


def default_assignment(conversation_id: str) -> dict:
    if not conversation_id or len(conversation_id) > 180 or any(ord(c) < 32 for c in conversation_id):
        raise HTTPException(422, "Identificador de conversa inválido.")
    return {"conversationId": conversation_id, "assigneeKind": "none", "assigneeUserId": None,
            "status": "open", "version": 0, "generation": 0}


def _event(value: dict, conversation_id: str, actor_id: str, kind: str, payload: dict) -> dict:
    if len(value["events"]) >= 20000:
        raise HTTPException(409, "O histórico atingiu o limite desta caixa. Solicite manutenção ao administrador.")
    identifier = uuid.uuid4().hex
    row = {"id": identifier, "conversationId": conversation_id, "actorUserId": actor_id,
           "kind": kind, "payload": payload, "createdAt": time.time()}
    value["events"][identifier] = row
    return row


def _version(row: dict, expected: int) -> None:
    if type(expected) is not int or expected != row.get("version", 0):
        raise HTTPException(409, "O atendimento mudou. Atualize a conversa antes de continuar.")


def _save_assignment(value: dict, row: dict, actor: str) -> dict:
    identifier = row["conversationId"]
    if identifier not in value["assignments"] and len(value["assignments"]) >= 10000:
        raise HTTPException(409, "Limite de atendimentos desta caixa atingido.")
    row = {**row, "version": row["version"] + 1, "updatedBy": actor, "updatedAt": time.time()}
    value["assignments"][identifier] = row
    return row


def sharing(access: Access, *, enabled: bool, expected_revision: int, auto_assign_on_send: bool = True, auto_distribute: bool = False) -> dict:
    if any(type(value) is not bool for value in (enabled, auto_assign_on_send, auto_distribute)):
        raise HTTPException(422, "Configuração de compartilhamento inválida.")
    if access.actor_id != access.scope.owner_id:
        raise HTTPException(403, "Somente o dono pode compartilhar esta instância.")

    def operation(value):
        box = value["inbox"]
        if type(expected_revision) is not int or expected_revision != box.get("revision", 0):
            raise HTTPException(409, "A configuração mudou. Atualize a caixa.")
        box.update({"enabled": enabled, "autoAssignOnSend": auto_assign_on_send, "autoDistribute": auto_distribute,
                    "revision": expected_revision + 1, "updatedBy": access.actor_id, "updatedAt": time.time(),
                    "scope": {"tenantId": access.scope.tenant_id, "ownerId": access.scope.owner_id,
                              "workspaceId": access.scope.workspace_id, "bindingId": access.scope.binding_id}})
        return box
    return repository.mutate(access.scope, operation)


def record_outgoing(access: Access, conversation_id: str) -> dict | None:
    def operation(value):
        if value["inbox"].get("enabled") is not True:
            return None
        try:
            previous = assert_conversation(access, value, conversation_id)
        except HTTPException:
            # An authorized send may already have completed when reassigned.
            return None
        row = {**default_assignment(conversation_id), **previous}
        if row["assigneeKind"] == "none" and value["inbox"].get("autoAssignOnSend", True):
            row.update({"assigneeKind": "user", "assigneeUserId": access.actor_id,
                        "generation": row.get("generation", 0) + 1})
            _event(value, conversation_id, access.actor_id, "assigned", {"assigneeUserId": access.actor_id, "source": "manual_send"})
        _event(value, conversation_id, access.actor_id, "sent", {"source": "manual_send"})
        return _save_assignment(value, row, access.actor_id)
    return repository.mutate(access.scope, operation)


def received(scope: repository.Scope, conversation_id: str, *, message_id: str, timestamp: int, online_assignees: tuple[str, ...] = (), aliases=()) -> dict | None:
    if not message_id or type(timestamp) is not int or timestamp < 1:
        raise ValueError("Incoming attendance requires a real message boundary")
    def operation(value):
        if value["inbox"].get("enabled") is not True:
            return None
        candidates = [value["assignments"][alias] for alias in dict.fromkeys([conversation_id, *aliases]) if alias in value["assignments"]]
        prior = next((row for row in candidates if row.get("assigneeKind", "none") != "none"), candidates[0] if candidates else {})
        row = {**default_assignment(conversation_id), **prior}
        if row.get("lastInboundId") == message_id or timestamp < row.get("lastInboundAt", 0):
            return None
        row.update({"lastInboundId": message_id, "lastInboundAt": timestamp})
        row["generation"] = row.get("generation", 0) + 1
        # History imports must never distribute an old conversation as new.
        candidates = sorted(set(online_assignees))
        if (not prior and value["inbox"].get("autoDistribute") is True
                and candidates and abs(time.time() - timestamp) <= 180):
            previous = value["inbox"].get("lastDistributedTo", "")
            target = next((identifier for identifier in candidates if identifier > previous), candidates[0])
            row.update({"assigneeKind": "user", "assigneeUserId": target})
            value["inbox"]["lastDistributedTo"] = target
            _event(value, conversation_id, "system-whatsapp", "assigned", {"assigneeUserId": target, "source": "round_robin"})
        if row["status"] != "open" and timestamp >= int(row.get("statusChangedAt", 0)):
            previous = row["status"]
            row.update({"status": "open", "statusChangedAt": time.time()})
            _event(value, conversation_id, "system-whatsapp", "status", {"before": previous, "status": "open", "source": "customer_reply"})
        return _save_assignment(value, row, "system-whatsapp")
    return repository.mutate(scope, operation)


def apply_assignment(value: dict, access: Access, conversation_id: str, *, expected_version: int, changes: dict) -> dict:
    if not changes or set(changes) - {"assigneeKind", "assigneeUserId", "status"}:
        raise HTTPException(422, "Alteração de atendimento inválida.")
    previous = assert_conversation(access, value, conversation_id)
    row = {**default_assignment(conversation_id), **previous, "conversationId": conversation_id}
    _version(row, expected_version)
    before = dict(row)
    if "assigneeUserId" in changes or "assigneeKind" in changes:
        kind = changes.get("assigneeKind", "user" if changes.get("assigneeUserId") else "none")
        target = changes.get("assigneeUserId")
        if kind not in {"none", "user"} or (kind == "none" and target is not None):
            raise HTTPException(422, "Responsável inválido. Atendente Nora ainda indisponível.")
        if kind == "user" and target not in {member["id"] for member in access.roster}:
            raise HTTPException(422, "Escolha um membro com acesso ao atendimento.")
        if not access.manager and target not in {None, access.actor_id}:
            raise HTTPException(403, "Somente gestores podem reatribuir atendimentos.")
        row.update({"assigneeKind": kind, "assigneeUserId": target if kind == "user" else None})
    if "status" in changes:
        if changes["status"] not in STATUSES:
            raise HTTPException(422, "Estado de atendimento inválido.")
        row["status"] = changes["status"]
    if all(row.get(key) == before.get(key) for key in ("assigneeKind", "assigneeUserId", "status")):
        return row
    # Human takeover invalidates all preparation tied to an old assignment.
    row["generation"] = row.get("generation", 0) + 1
    if row["status"] != before["status"]:
        row["statusChangedAt"] = time.time()
        _event(value, conversation_id, access.actor_id, "status", {"before": before["status"], "status": row["status"]})
    if (row["assigneeKind"], row["assigneeUserId"]) != (before["assigneeKind"], before["assigneeUserId"]):
        _event(value, conversation_id, access.actor_id, "assigned" if row["assigneeKind"] == "user" else "unassigned",
               {"assigneeUserId": row["assigneeUserId"], "assigneeKind": row["assigneeKind"]})
    result = _save_assignment(value, row, access.actor_id)
    # One human decision applies to every attested identity of the same chat.
    # Notes/events remain on their original IDs; no contribution is erased.
    for alias in (access.identity_aliases or {}).get(conversation_id, ()):
        if alias != conversation_id and alias in value["assignments"]:
            value["assignments"][alias] = {**result, "conversationId": alias}
    return result


def update_assignment(access: Access, conversation_id: str, *, expected_version: int, changes: dict) -> dict:
    return repository.mutate(access.scope, lambda value: apply_assignment(value, access, conversation_id, expected_version=expected_version, changes=changes))


def create_note(access: Access, conversation_id: str, *, body: str, mentions: list[str]) -> dict:
    body = str(body).strip()
    if not body or len(body) > 8000 or len(mentions) > 20:
        raise HTTPException(422, "A nota deve ter entre 1 e 8.000 caracteres e até 20 menções.")
    members = {row["id"] for row in access.roster}
    if any(identifier not in members for identifier in mentions):
        raise HTTPException(422, "Mencione somente membros com acesso à caixa.")

    def operation(value):
        assignment = assert_conversation(access, value, conversation_id)
        # A mention never grants read access to an assigned conversation.
        permitted = {member["id"] for member in access.roster
                     if member["id"] == access.scope.owner_id or member["id"] == assignment.get("assigneeUserId")
                     or assignment.get("assigneeKind", "none") == "none"
                     or effective_permissions(member).get("whatsapp.ver_todas")}
        if not set(mentions) <= permitted:
            raise HTTPException(403, "Um dos mencionados não pode acessar este atendimento.")
        if len(value["notes"]) >= 10000:
            raise HTTPException(409, "Limite de notas desta caixa atingido.")
        identifier = uuid.uuid4().hex
        row = {"id": identifier, "conversationId": conversation_id, "authorUserId": access.actor_id,
               "body": body, "mentions": sorted(set(mentions)), "createdAt": time.time(),
               "editedAt": None, "deletedAt": None, "version": 1}
        value["notes"][identifier] = row
        _event(value, conversation_id, access.actor_id, "note", {"noteId": identifier})
        return row
    return repository.mutate(access.scope, operation)


def change_note(access: Access, conversation_id: str, note_id: str, *, expected_version: int, body: str | None) -> dict:
    if body is not None and (not body.strip() or len(body) > 8000):
        raise HTTPException(422, "A nota deve ter entre 1 e 8.000 caracteres.")

    def operation(value):
        assert_conversation(access, value, conversation_id)
        row = value["notes"].get(note_id)
        identities = {conversation_id, *((access.identity_aliases or {}).get(conversation_id) or ())}
        if not row or row.get("conversationId") not in identities or row.get("deletedAt") is not None:
            raise HTTPException(404, "Nota indisponível.")
        if row["authorUserId"] != access.actor_id and not access.manager:
            raise HTTPException(403, "Somente o autor ou gestor pode alterar a nota.")
        _version(row, expected_version)
        row.update({"body": body.strip() if body is not None else "", "version": row["version"] + 1,
                    "editedAt": time.time(), "updatedBy": access.actor_id})
        if body is None:
            row.update({"deletedAt": time.time(), "mentions": []})
        _event(value, conversation_id, access.actor_id, "note", {"noteId": note_id, "operation": "edited" if body is not None else "deleted"})
        return row
    return repository.mutate(access.scope, operation)


def page(value: dict, conversation_id: str, kind: str, *, before: tuple[float, str] | None = None, limit: int = 50) -> dict:
    if kind not in {"events", "notes"} or not 1 <= limit <= 100:
        raise HTTPException(422, "Página inválida.")
    identities = {conversation_id, *(value.get("_identityAliases", {}).get(conversation_id) or ())}
    rows = [row for row in value[kind].values() if row.get("conversationId") in identities
            and (kind != "notes" or row.get("deletedAt") is None)
            and (before is None or (row["createdAt"], row["id"]) < before)]
    rows.sort(key=lambda row: (row["createdAt"], row["id"]), reverse=True)
    items = rows[:limit]
    return {"items": items, "hasMore": len(rows) > limit,
            "cursor": [items[-1]["createdAt"], items[-1]["id"]] if items and len(rows) > limit else None}
