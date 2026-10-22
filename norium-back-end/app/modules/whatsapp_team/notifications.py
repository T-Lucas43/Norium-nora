"""Generic private notices. Never publish note text, a phone or customer name."""
from __future__ import annotations

import asyncio
import logging
from . import access, context, repository

logger = logging.getLogger(__name__)


async def emit(grant: access.Access, value: dict, conversation_id: str, invalidate: set[str] | None = None) -> set[str]:
    from app.modules.inbox.router import manager
    deliveries = []
    allowed = set()
    for member in grant.roster:
        actor = access.Access(member, grant.owner, grant.scope, grant.roster)
        try:
            access.assert_conversation(actor, value, conversation_id)
        except Exception:
            if actor.actor_id not in (invalidate or set()):
                continue
        else:
            allowed.add(actor.actor_id)
        deliveries.append(manager.broadcast(actor.actor_id, {"type": "WHATSAPP_CONVERSATION_UPDATED",
                           "ownerId": actor.actor_id, "inboxId": grant.scope.inbox_id, "area": "attendance"}))
    if deliveries:
        try:
            await asyncio.wait_for(asyncio.gather(*deliveries, return_exceptions=True), timeout=2)
        except Exception:
            logger.warning("Aviso ao vivo indisponível; a reserva atualizará o atendimento.")
    return allowed


async def changed(user: dict, inbox_id: str, conversation_id: str, *, recipients: set[str] | None = None, note_id: str | None = None, invalidate: set[str] | None = None) -> None:
    try:
        grant, value, _ = await context.authorized(user, inbox_id, conversation_id)
        allowed = await emit(grant, value, conversation_id, invalidate)
        notified = (recipients or set()) & allowed - {grant.actor_id}
        if notified:
            from app.modules.team.router import append_team_message_for_user, record_team_event
            reference = context.conversation_ref(inbox_id, conversation_id)
            link = "/app?screen=chat&inbox=" + inbox_id + "&attendance=" + reference
            metadata = {"action": "whatsapp_internal_mention" if note_id else "whatsapp_assignment",
                        "messageId": "whatsapp:" + (note_id or reference + ":" + str(value["assignments"].get(conversation_id, {}).get("version", 0))),
                        "inboxId": inbox_id, "attendanceRef": reference, "link": link}
            await record_team_event(grant.scope.tenant_id, "Atendimento WhatsApp", "Há uma atualização interna para você.", metadata, user_ids=notified)
            if note_id:
                await append_team_message_for_user(grant.scope.owner_id, "Você foi mencionado em uma nota interna. Abra o WhatsApp da equipe para conferir.",
                                                   sender_id="system-whatsapp", sender_name="WhatsApp da equipe", sender_avatar="",
                                                   metadata=metadata, recipient_ids=notified, event_key="whatsapp:" + note_id)
    except Exception:
        # A committed internal note is not retried as an external WhatsApp send.
        logger.warning("Aviso interno de atendimento indisponível; consulte o histórico da caixa.")
