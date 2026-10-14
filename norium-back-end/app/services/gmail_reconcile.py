"""Busca somente-leitura em Enviados por cabeçalho de idempotência do Norium.

O Gmail não indexa cabeçalhos arbitrários na busca. Por isso a busca lista os
IDs enviados numa janela de tempo e confere o cabeçalho de cada mensagem pelos
metadados. Uma busca completa descreve a cobertura; ausência não prova que uma
mensagem nunca foi entregue, pois Enviados pode mudar e a indexação pode atrasar.
"""
from __future__ import annotations

from typing import Any

EMAIL_KEY_HEADER = "X-Norium-Email-Key"


def find_sent_by_key(
    service: Any,
    key: str,
    *,
    after_epoch: int,
    max_pages: int = 5,
    page_size: int = 100,
) -> dict[str, Any]:
    """Retorna {"found", "messageId", "complete", "scanned"} sem conteúdo da mensagem.

    ``service`` é um ``GmailService`` (ou dublê com a mesma interface).
    """
    key = str(key or "").strip()
    if not key:
        raise ValueError("email key required")
    query = f"after:{max(0, int(after_epoch))}"
    page_token: str | None = None
    scanned = 0
    complete = True
    for _ in range(max(1, max_pages)):
        listing = service.list_message_ids(folder="sent", query=query, page_token=page_token, max_results=page_size)
        items = listing.get("messages") or []
        if not isinstance(items, list):
            return {"found": False, "messageId": None, "complete": False, "scanned": scanned}
        for item in items:
            message_id = str((item or {}).get("id") or "")
            if not message_id:
                complete = False
                continue
            try:
                headers = message_headers(service, message_id)
            except Exception:
                complete = False
                continue
            scanned += 1
            if headers.get(EMAIL_KEY_HEADER.lower()) == key:
                return {"found": True, "messageId": message_id, "complete": True, "scanned": scanned}
        page_token = listing.get("nextPageToken")
        if not page_token:
            return {"found": False, "messageId": None, "complete": complete, "scanned": scanned}
    # Ainda havia páginas: cobertura incompleta.
    return {"found": False, "messageId": None, "complete": False, "scanned": scanned}


def message_headers(service: Any, message_id: str) -> dict[str, str]:
    """Lê apenas o cabeçalho de idempotência pelos metadados da mensagem."""
    if hasattr(service, "sent_message_headers"):
        raw = service.sent_message_headers(message_id)
    else:
        raw = service._service().users().messages().get(
            userId="me", id=message_id, format="metadata", metadataHeaders=[EMAIL_KEY_HEADER],
        ).execute()
    headers = ((raw or {}).get("payload") or {}).get("headers") or []
    return {str(h.get("name") or "").lower(): str(h.get("value") or "").strip() for h in headers if isinstance(h, dict)}
