"""Resolve contact identities only from this actor's local WhatsApp catalog.

No provider request, conversation creation, name inference or permission grant.
Explicit provider aliases join phone/JID/LID representations inside one actor.
"""
from __future__ import annotations

from fastapi import HTTPException

from app.core.identity import require_user_id


def identity(value: object) -> str:
    if not isinstance(value, str):
        return ""
    value = value.strip().casefold()
    if not value or len(value) > 180 or any(ord(character) < 32 for character in value):
        return ""
    return value


async def contact_alias_index(user: dict) -> dict[str, frozenset[str]]:
    from app.modules.chat.router import _contact_aliases, load_whatsapp_catalog_cache
    from app.services.conversation_store import load_conversations

    actor = require_user_id(user)
    cache = await load_whatsapp_catalog_cache(actor)
    conversations = await load_conversations(actor)
    cached = [cache.get(key) for key in ("contacts", "chats") if isinstance(cache.get(key), list)]
    if sum(len(rows) for rows in cached) + len(conversations) > 50_000:
        raise HTTPException(413, "O catálogo local excede o limite de contatos desta operação.")
    records = [row for rows in cached for row in rows if isinstance(row, dict)]
    records.extend({"id": identifier, "phone": (row.get("metadados") or {}).get("numeroCompleto")}
                   for identifier, row in conversations.items() if not row.get("esGrupo"))
    if len(records) > 50_000:
        raise HTTPException(413, "O catálogo local excede o limite de contatos desta operação.")
    parent: dict[str, str] = {}

    def root(key: str) -> str:
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    for record in records:
        aliases = {identity(value) for value in _contact_aliases(record)}
        extra = record.get("aliases") if isinstance(record.get("aliases"), list) else []
        if len(extra) > 64:
            raise HTTPException(409, "Há identidades ambíguas no catálogo. Revise a sincronização dos contatos.")
        aliases.update(identity(value) for value in extra if isinstance(value, str))
        aliases.discard("")
        if len(aliases) > 64:
            raise HTTPException(409, "Há identidades ambíguas no catálogo. Revise a sincronização dos contatos.")
        if not aliases or record.get("isGroup") or record.get("esGrupo") or any(
            value.endswith(("@g.us", "@newsletter", "@broadcast")) for value in aliases
        ):
            continue
        for value in aliases:
            parent.setdefault(value, value)
        if len(parent) > 300_000:
            raise HTTPException(413, "O catálogo local excede o limite de identidades desta operação.")
        first = root(min(aliases))
        for value in aliases:
            other = root(value)
            if other != first:
                parent[other] = first
    groups: dict[str, set[str]] = {}
    for value in parent:
        groups.setdefault(root(value), set()).add(value)
    index: dict[str, frozenset[str]] = {}
    for aliases in groups.values():
        if len(aliases) > 64:
            raise HTTPException(409, "Há identidades ambíguas no catálogo. Revise a sincronização dos contatos.")
        group = frozenset(aliases)
        for alias in group:
            index[alias] = group
    return index


def canonical(aliases: frozenset[str]) -> str:
    phones = [value for value in aliases if value.isascii() and value.isdecimal() and 8 <= len(value) <= 20]
    return min(phones or aliases)


def aliases_for(index: dict[str, frozenset[str]], identifier: str) -> frozenset[str]:
    key = identity(identifier)
    return index.get(key, frozenset({key}))
