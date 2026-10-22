"""Bounded reads of the existing private gateway database, never session data."""
from __future__ import annotations

from fastapi import HTTPException
from app.services import evolution_data


def _instance(user_id: str, instance: str) -> None:
    if not user_id or instance != evolution_data.instance_name(user_id) or instance not in evolution_data.owned_names(user_id):
        raise HTTPException(404, "Histórico indisponível.")


def page(user_id: str, instance: str, conversation_id: str, *, before: int | None, before_id: str | None, limit: int) -> dict:
    _instance(user_id, instance)
    if (not conversation_id or len(conversation_id) > 180 or type(limit) is not int or not 1 <= limit <= 100
            or (before is not None and (type(before) is not int or before < 1))
            or (before_id is not None and (not isinstance(before_id, str) or len(before_id) > 180))):
        raise ValueError("Invalid bounded history request")
    with evolution_data._database() as db:
        db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        if before is None:
            rows = db.execute('''SELECT m.key,m.message,m."messageTimestamp",m."messageType",m."pushName",m.participant,m.status
                FROM "Message" m JOIN "Instance" i ON i.id=m."instanceId"
                WHERE i.name=%s AND (m.key->>'remoteJid'=%s OR m.key->>'remoteJidAlt'=%s)
                AND m.key->>'id' IS NOT NULL AND COALESCE(m."messageType",'')<>'reactionMessage'
                ORDER BY m."messageTimestamp" DESC,(m.key->>'id') COLLATE "C" DESC LIMIT %s''',
                (instance, conversation_id, conversation_id, limit + 1)).fetchall()
        elif before_id is None:
            rows = db.execute('''SELECT m.key,m.message,m."messageTimestamp",m."messageType",m."pushName",m.participant,m.status
                FROM "Message" m JOIN "Instance" i ON i.id=m."instanceId"
                WHERE i.name=%s AND (m.key->>'remoteJid'=%s OR m.key->>'remoteJidAlt'=%s)
                AND m.key->>'id' IS NOT NULL AND m."messageTimestamp"<%s AND COALESCE(m."messageType",'')<>'reactionMessage'
                ORDER BY m."messageTimestamp" DESC,(m.key->>'id') COLLATE "C" DESC LIMIT %s''',
                (instance, conversation_id, conversation_id, before, limit + 1)).fetchall()
        else:
            rows = db.execute('''SELECT m.key,m.message,m."messageTimestamp",m."messageType",m."pushName",m.participant,m.status
                FROM "Message" m JOIN "Instance" i ON i.id=m."instanceId"
                WHERE i.name=%s AND (m.key->>'remoteJid'=%s OR m.key->>'remoteJidAlt'=%s)
                AND m.key->>'id' IS NOT NULL AND COALESCE(m."messageType",'')<>'reactionMessage'
                AND (m."messageTimestamp"<%s OR (m."messageTimestamp"=%s AND (m.key->>'id') COLLATE "C"<%s COLLATE "C"))
                ORDER BY m."messageTimestamp" DESC,(m.key->>'id') COLLATE "C" DESC LIMIT %s''',
                (instance, conversation_id, conversation_id, before, before, before_id, limit + 1)).fetchall()
    return {"records": [dict(row) for row in rows[:limit]], "hasMore": len(rows) > limit}


def reference(user_id: str, instance: str, message_id: str, conversation_id: str | None = None) -> dict | None:
    _instance(user_id, instance)
    if not message_id or len(message_id) > 180:
        raise ValueError("Invalid message identifier")
    with evolution_data._database() as db:
        db.execute("SET TRANSACTION READ ONLY")
        if conversation_id is not None:
            rows = db.execute('''SELECT m.key,m.message,m."messageTimestamp",m."messageType",m."pushName",m.participant,m.status
                FROM "Message" m JOIN "Instance" i ON i.id=m."instanceId"
                WHERE i.name=%s AND m.key->>'id'=%s AND (m.key->>'remoteJid'=%s OR m.key->>'remoteJidAlt'=%s) LIMIT 2''',
                (instance, message_id, conversation_id, conversation_id)).fetchall()
        else:
            rows = db.execute('''SELECT m.key,m.message,m."messageTimestamp",m."messageType",m."pushName",m.participant,m.status
                FROM "Message" m JOIN "Instance" i ON i.id=m."instanceId"
                WHERE i.name=%s AND m.key->>'id'=%s LIMIT 2''', (instance, message_id)).fetchall()
    # Ambiguous IDs must never choose a different conversation implicitly.
    if len(rows) != 1:
        return None
    return dict(rows[0])
