"""Merge only identities explicitly linked by this account's provider records.

Names, text and numeric similarity are never evidence of identity. Original
aliases remain on the record for history, references and assignment checks.
"""
from __future__ import annotations

import re
from copy import deepcopy


def token(value):
    if not isinstance(value, str):
        return ""
    value = value.strip().lower()
    match = re.fullmatch(r"(\d{7,16})(?::\d+)?@(s\.whatsapp\.net|c\.us)", value)
    if match:
        return match[1] + "@s.whatsapp.net"
    if re.fullmatch(r"\+?\d{7,16}", value):
        return value.lstrip("+") + "@s.whatsapp.net"
    return value if re.fullmatch(r"[a-z0-9_-]+@(lid|g\.us|newsletter|broadcast)", value) else ""


def record_aliases(record):
    values = [record.get(key) for key in ("id", "phone", "phoneNumber", "number", "jid", "remoteJid", "remoteJidAlt", "lid", "senderLid")]
    metadata = record.get("metadados") or {}
    values += [metadata.get("numeroCompleto"), *(metadata.get("identityAliases") or [])]
    aliases = {token(value) for value in values if token(value)}
    # A group/channel is a resource, never an alias of its sender/owner.
    special = {value for value in aliases if value.endswith(("@g.us", "@newsletter", "@broadcast"))}
    return {token(record.get("id") or record.get("remoteJid"))} & special if special else aliases


class Conversations(dict):
    def __init__(self, values, aliases):
        super().__init__(values)
        self.aliases = aliases

    def canonical(self, key):
        return self.aliases.get(token(key), key)

    def get(self, key, default=None):
        return super().get(self.canonical(key), default)

    def __getitem__(self, key):
        return super().__getitem__(self.canonical(key))

    def __contains__(self, key):
        return super().__contains__(self.canonical(key))

    def __setitem__(self, key, value):
        return super().__setitem__(self.canonical(key), value)


def coalesce(database, records=()):
    parent = {}
    def find(key):
        parent.setdefault(key, key)
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key
    for record in [*records, *({**row, "id": key} for key, row in database.items())]:
        if not isinstance(record, dict):
            continue
        aliases = sorted(record_aliases(record))
        for alias in aliases:
            parent[find(alias)] = find(aliases[0])
    components = {}
    for alias in list(parent):
        components.setdefault(find(alias), set()).add(alias)
    mapping = {}
    for members in components.values():
        phones = sorted(value for value in members if value.endswith("@s.whatsapp.net"))
        # Conflicting phone evidence must not combine unrelated recipients.
        if len(phones) > 1:
            continue
        canonical = phones[0] if phones else min(members)
        for alias in members:
            mapping[alias] = canonical
    members_by_canonical = {}
    for alias, canonical in mapping.items():
        members_by_canonical.setdefault(canonical, set()).add(alias)
    buckets = {}
    for key, row in database.items():
        canonical = mapping.get(token(key), key)
        buckets.setdefault(canonical, []).append((key, row))
    output = {}
    for canonical, entries in buckets.items():
        entries.sort(key=lambda pair: (int(pair[1].get("timestampUltimaMsg") or 0), pair[0] == canonical))
        result = deepcopy(entries[-1][1])
        # Unknown/legacy non-JID identifiers stay byte-for-byte compatible.
        if token(canonical):
            result["id"] = canonical
            aliases = {key for key, _ in entries}
            aliases.update(members_by_canonical.get(canonical, ()))
            result.setdefault("metadados", {})["identityAliases"] = sorted(aliases)[:32]
        messages = {}
        for _, row in entries:
            for message in row.get("mensagens") or []:
                identifier = str(message.get("id") or "")
                if not identifier:
                    continue
                previous = messages.get(identifier, {})
                merged = {**previous, **{key: value for key, value in message.items() if value not in (None, "", [], {})}}
                if "reacoes" in message:
                    merged["reacoes"] = deepcopy(message["reacoes"])
                ranks = {"erro": 0, "pendente": 1, "enviado": 2, "entregue": 3, "lido": 4, "reproduzido": 5}
                merged["status"] = max((previous.get("status"), message.get("status")), key=lambda value: ranks.get(value, -1))
                messages[identifier] = merged
        result["mensagens"] = sorted(messages.values(), key=lambda value: (int(value.get("timestamp") or 0), str(value.get("id"))))
        for field in ("fixada", "favorita", "silenciada", "arquivada"):
            result[field] = any(row.get(field) for _, row in entries)
        result["naoLidasCount"] = max(int(row.get("naoLidasCount") or 0) for _, row in entries)
        result["lida"] = all(row.get("lida", True) for _, row in entries)
        output[canonical] = result
    return Conversations(output, mapping)
