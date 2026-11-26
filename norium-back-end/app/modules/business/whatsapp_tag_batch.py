"""Contact labels use the business registry, not a second conversation registry."""
from __future__ import annotations

from fastapi import HTTPException
from app.core.identity import require_user_id
from .store import path_for, require_room
from .whatsapp_contacts import canonical, identity
from app.modules.chat.bulk_store import atomic_document


def change(owner: dict, binding: str, actor_id: str, groups: list[frozenset[str]], changes: list[dict], *, grant=None, ids=()):
    from .router import active_tag, now
    unique = {canonical(group): group for group in groups}
    if not unique or any(not group or not identifier for identifier, group in unique.items()):
        raise HTTPException(422, "Selecione contatos válidos.")
    owner_id = require_user_id(owner)

    def operation(links, dependencies):
        definitions = {row["id"] for row in dependencies[0]["items"]
                       if active_tag(row) and row.get("scope") in {"contact", "conversation"}}
        if any(item["tagId"] not in definitions for item in changes):
            raise HTTPException(404, "Uma etiqueta não existe ou foi arquivada. Atualize a seleção.")
        alias_map = {alias: identifier for identifier, aliases in unique.items() for alias in aliases}
        removed = {item["tagId"] for item in changes if not item["apply"]}
        retained, present = [], set()
        for row in links["items"]:
            identifier = alias_map.get(identity(row.get("conversationId"))) if row.get("conversationOwnerId") == owner_id and row.get("bindingKey") == binding else None
            if identifier is not None:
                if row.get("tagId") in removed:
                    continue
                present.add((identifier, row.get("tagId")))
            retained.append(row)
        links["items"] = retained
        for item in changes:
            if not item["apply"]:
                continue
            for identifier in unique:
                if (identifier, item["tagId"]) in present:
                    continue
                require_room(links["items"], 50_000)
                links["items"].append({"conversationOwnerId": owner_id, "conversationId": identifier,
                                       "tagId": item["tagId"], "bindingKey": binding,
                                       "createdBy": actor_id, "createdAt": now()})
        return {"updated": len(unique)}
    return atomic_document(path_for(owner, "tag_links"), {"schemaVersion": 1, "items": []}, operation,
                           reads=[(path_for(owner, "tags"), {"schemaVersion": 1, "items": []})], grant=grant, ids=ids)
