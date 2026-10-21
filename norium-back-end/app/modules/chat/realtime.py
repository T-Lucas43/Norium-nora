"""Small invalidations over the app's existing authenticated private socket."""
from __future__ import annotations

import logging
import asyncio
from typing import Literal

logger = logging.getLogger(__name__)


async def publish_change(owner_id: str, area: Literal["conversations", "catalog", "status", "connection", "labels"] = "conversations",
                         revision: int | None = None) -> None:
    if not isinstance(owner_id, str) or not owner_id.strip():
        raise ValueError("WhatsApp events require an explicit owner")
    from app.modules.inbox.router import manager
    try:
        # No message, phone, attachment, participant or provider credential.
        await asyncio.wait_for(manager.broadcast(owner_id, {"type": "WHATSAPP_CONVERSATION_UPDATED", "ownerId": owner_id,
                                                            "area": area, "revision": revision}), timeout=1.5)
    except Exception:
        # A transient socket failure must not replay the original external effect.
        logger.warning("Atualização ao vivo do WhatsApp indisponível; a reserva fará a leitura.")
