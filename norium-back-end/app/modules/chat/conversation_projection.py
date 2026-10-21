"""Bounded conversation-list projection without transporting message history."""
from __future__ import annotations

from typing import Any


def list_page(runtime: Any, database: dict, catalog: dict, *, offset: int, limit: int, search: str = "") -> dict:
    names, photos, _ = runtime.build_contact_indexes([*(catalog.get("contacts") or []), *(catalog.get("chats") or [])])
    conversations = {identifier: row for identifier, row in database.items()
                     if not identifier.lower().endswith("@newsletter")}
    for raw in (catalog.get("chats") or [])[:50000]:
        if not isinstance(raw, dict):
            continue
        identifier = runtime._contact_primary_id(raw)
        if not identifier or identifier.endswith(("@newsletter", "@broadcast")) or identifier in conversations:
            continue
        group = identifier.endswith("@g.us") or raw.get("isGroup") is True
        name = runtime._lookup_contact_index(names, identifier) or raw.get("subject") or raw.get("name") or identifier
        row = runtime.new_conversation(identifier, contato=str(name), channel="whatsapp", is_group=group)
        runtime.sync_catalog_messages(row, raw)
        photo = runtime._lookup_contact_index(photos, identifier)
        if photo:
            row["photoUrl"] = photo
            row.setdefault("metadados", {})["photoUrl"] = photo
        conversations[identifier] = row
    query = search.strip().casefold()
    items = []
    for identifier, row in conversations.items():
        if query and not any(query in str(value or "").casefold() for value in [
            identifier, row.get("contato"), row.get("ultimoTexto"), (row.get("metadados") or {}).get("numeroCompleto"),
            *(message.get("texto") for message in row.get("mensagens", []) if isinstance(message, dict)),
        ]):
            continue
        item = runtime.normalize_conversation(identifier, {**row, "mensagens": []})
        items.append(item)
    items.sort(key=lambda item: (not item.get("fixada", False), -int(item.get("timestampUltimaMsg") or 0), str(item.get("contato") or ""), item["id"]))
    updates = catalog.get("conversationUpdates") or {}
    cursor = max([0, *(int(value or 0) for value in updates.values()), *(int(item.get("timestampUltimaMsg") or 0) for item in items)])
    return {"items": items[offset:offset + limit], "total": len(items),
            "nextOffset": offset + limit if offset + limit < len(items) else None, "cursor": cursor, "hasMore": False}
