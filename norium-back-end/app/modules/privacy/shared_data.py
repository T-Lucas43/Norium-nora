"""Dados do membro em stores compartilhados; nunca exclui o workspace do dono."""
from __future__ import annotations

import copy
from typing import Any

from app.core.tenant import get_data_root, safe_tenant_id, write_json_file
from app.infrastructure.persistence import files
from app.infrastructure.storage_limits import upload_candidates
from app.modules.privacy.storage_catalog import personal_documents


def business_contributions(payload: dict, user_id: str, *, purge: bool = False, personal_views: bool = False) -> list[dict]:
    result = []
    retained = []
    for row in payload.get("items", []):
        if not isinstance(row, dict):
            continue
        fields = [key for key in ("createdBy", "updatedBy") if row.get(key) == user_id]
        history = [{"until": entry.get("until")} for entry in row.get("priceHistory", [])
                   if isinstance(entry, dict) and entry.get("changedBy") == user_id]
        owns_relation = any(row.get(key) == user_id for key in ("clientOwnerId", "resourceOwnerId", "conversationOwnerId"))
        if fields or history or owns_relation:
            result.append({"kind": "business_contribution", "recordId": row.get("id"),
                           "fields": fields, "createdAt": row.get("createdAt"), "priceHistory": history,
                           "ownsRelation": owns_relation})
        if purge:
            if owns_relation or (personal_views and row.get("createdBy") == user_id):
                continue
            for key in fields:
                row[key] = "deleted"
            for entry in row.get("priceHistory", []):
                if isinstance(entry, dict) and entry.get("changedBy") == user_id:
                    entry["changedBy"] = "deleted"
        retained.append(row)
    if purge:
        payload["items"] = retained
    return result


def personal_team_messages(user: dict[str, Any], *, purge: bool = False) -> tuple[list[dict], list]:
    user_id, owner_id = str(user["id"]), str(user.get("teamOwnerId") or "")
    if not owner_id or owner_id == user_id:
        return [], []
    result, attachments = [], []
    for key, payload in personal_documents(owner_id):
        if "/business_" in key and isinstance(payload, dict):
            from app.modules.business.store import mutate_path
            personal_views = key.endswith("/business_team_views_db.json")
            if purge:
                contributions = mutate_path(get_data_root() / key, lambda document: business_contributions(document, user_id, purge=True, personal_views=personal_views))
            else:
                contributions = business_contributions(payload, user_id)
            result.extend(contributions)
            continue
        if not key.endswith("/team_chat_db.json") or not isinstance(payload, dict):
            continue
        changed = False
        for field in ("chatPresence", "chatNotifications", "pinnedThreadsByUser"):
            preferences = payload.get(field, {}).get(user_id)
            if preferences is not None:
                result.append({"kind": field, "value": copy.deepcopy(preferences)})
                if purge:
                    payload[field].pop(user_id, None); changed = True
        for field, owner_field in (("chatScheduled", "authorId"), ("chatReminders", "userId")):
            for row in list(payload.get(field, [])):
                if str(row.get(owner_field) or "") != user_id: continue
                result.append({"kind": field, "value": copy.deepcopy(row)})
                for attachment in row.get("message", {}).get("attachments", []):
                    for path in upload_candidates(get_data_root() / "team_chat_uploads", str(attachment.get("storedName") or ""), attachment.get("storageKey")):
                        if files.exists(path):
                            attachments.append(path)
                            if purge: files.delete(path)
                if purge:
                    payload[field].remove(row); changed = True
        for message in payload.get("messages", []):
            if isinstance(message, dict):
                metadata = message.get("metadata") or {}
                for option in (metadata.get("poll") or {}).get("options", []):
                    if user_id in option.get("userIds", []):
                        result.append({"kind": "pollVote", "messageId": message.get("id"), "optionId": option.get("id")})
                        if purge:
                            option["userIds"].remove(user_id); changed = True
            if not isinstance(message, dict) or str(message.get("senderId") or "") != user_id:
                continue
            result.append(copy.deepcopy(message))
            for attachment in message.get("attachments", []):
                if not isinstance(attachment, dict):
                    continue
                for path in upload_candidates(get_data_root() / "team_chat_uploads", str(attachment.get("storedName") or ""), attachment.get("storageKey")):
                    if files.exists(path):
                        attachments.append(path)
                        if purge:
                            files.delete(path)
            if purge:
                # Preserve thread and audit structure with an anonymous tombstone.
                message.update({"senderId": "deleted", "senderName": "Conta excluida",
                                "senderAvatar": "", "text": "", "attachments": [],
                                "resourceRefs": [],
                                "metadata": {"privacyDeleted": True}})
                changed = True
        if changed:
            write_json_file(get_data_root() / key, payload)
    return result, attachments
