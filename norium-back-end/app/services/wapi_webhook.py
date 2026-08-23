"""Adaptador e classificação de eventos de webhook da W-API.

Funções puras (sem I/O) para manter o router fino e testável. Convertem o
payload da W-API no modelo interno do Norium.

IMPORTANTE — MAPEAMENTO NÃO VERIFICADO: a coleção Postman oficial não documenta
o corpo dos webhooks e os logs da instância de teste estavam vazios. Os nomes de
campos abaixo seguem a convenção conhecida da W-API e são lidos de forma
tolerante (vários apelidos por campo). Confirmar com UMA amostra real de webhook
(configurando a URL de recebimento para um coletor público e enviando uma
mensagem) antes de considerar produção.
"""

from __future__ import annotations

from typing import Any


# Classes de evento internas.
EVENT_RECEIVED = "received"
EVENT_STATUS = "status"
EVENT_CONNECTED = "connected"
EVENT_DISCONNECTED = "disconnected"
EVENT_PRESENCE = "presence"
EVENT_UNKNOWN = "unknown"


def classify_event(data: dict[str, Any]) -> str:
    """Mapeia o campo de evento da W-API para uma classe interna (tolerante)."""
    raw = str(data.get("event") or data.get("type") or "").strip().lower()
    if not raw:
        # Sem nome de evento: se traz conteúdo de mensagem, trata como recebido.
        return EVENT_RECEIVED if _first(data, "msgcontent", "message", "text", "body") is not None else EVENT_UNKNOWN
    if "disconnect" in raw:
        return EVENT_DISCONNECTED
    if "connect" in raw:
        return EVENT_CONNECTED
    if "presence" in raw:
        return EVENT_PRESENCE
    if "status" in raw or "ack" in raw or ("sent" in raw and "callback" in raw) or "delivery" in raw:
        return EVENT_STATUS
    if "receiv" in raw or "message" in raw:
        return EVENT_RECEIVED
    return EVENT_UNKNOWN


def event_id(data: dict[str, Any]) -> str:
    """Identificador para deduplicação (id da mensagem/evento)."""
    return str(_first(data, "messageId", "id", "eventId", "zaid") or "")


# Mapeia os status da W-API para o vocabulário interno aceito por
# normalize_message ({enviado, entregue, lido, reproduzido, erro}). Chaves em
# minúsculas; nomes exatos da W-API NÃO VERIFICADOS — ampliar com amostra real.
_STATUS_MAP = {
    "sent": "enviado",
    "server_ack": "enviado",
    "sentcallback": "enviado",
    "pending": "pendente",
    "delivered": "entregue",
    "delivery": "entregue",
    "delivery_ack": "entregue",
    "received": "entregue",
    "read": "lido",
    "read_ack": "lido",
    "viewed": "lido",
    "played": "reproduzido",
    "played_ack": "reproduzido",
    "error": "erro",
    "failed": "erro",
}


def map_status(raw: str) -> str:
    """Converte um status da W-API para o vocabulário interno (ou '' se desconhecido)."""
    return _STATUS_MAP.get(str(raw or "").strip().lower().replace("-", "_"), "")


def extract_status_update(data: dict[str, Any]) -> tuple[str, str]:
    """Retorna (message_id, status_interno) para eventos de status/entrega."""
    message_id = str(_first(data, "messageId", "id") or "")
    status = map_status(str(_first(data, "status", "ack", "state") or ""))
    return message_id, status


def adapt_incoming(data: dict[str, Any]) -> dict[str, Any] | None:
    """Normaliza um evento de mensagem recebida para o modelo do Norium.

    Retorna ``None`` quando não há telefone/chat identificável.
    """
    chat_id = _first(data, "chatId", "phone", "from")
    chat = data.get("chat") if isinstance(data.get("chat"), dict) else None
    if not chat_id and chat:
        chat_id = chat.get("id") or chat.get("phone")
    if not chat_id:
        return None

    sender = data.get("sender") if isinstance(data.get("sender"), dict) else {}
    from_me = bool(_first(data, "fromMe", "isFromMe") or False)
    is_group = bool(_first(data, "isGroup", "isGroupMsg") or (str(chat_id).endswith("@g.us")))
    sender_name = str(
        _first(data, "senderName", "pushName", "notifyName", "chatName", "name")
        or sender.get("pushName")
        or sender.get("name")
        or chat_id
    )
    chat_name = str(_first(data, "chatName", "name") or (chat.get("name") if chat else None) or sender_name)

    # Timestamp: W-API usa "momment" (grafia própria) em segundos.
    timestamp = _first(data, "momment", "moment", "timestamp", "messageTimestamp", "t")
    try:
        timestamp_int = int(timestamp) if timestamp is not None else 0
    except (TypeError, ValueError):
        timestamp_int = 0

    texto, tipo = _extract_text_and_type(data)

    return {
        "messageId": str(_first(data, "messageId", "id", "zaid") or ""),
        "chatId": str(chat_id),
        "fromMe": from_me,
        "isGroup": is_group,
        "senderName": sender_name,
        "chatName": chat_name,
        "senderId": sender.get("id") if sender else _first(data, "senderId", "participant"),
        "timestamp": timestamp_int,
        "texto": texto,
        "tipo": tipo,
        "status": str(_first(data, "status") or "") or None,
    }


def _extract_text_and_type(data: dict[str, Any]) -> tuple[str, str]:
    content = data.get("msgContent")
    if isinstance(content, dict):
        if isinstance(content.get("conversation"), str):
            return content["conversation"], "texto"
        ext = content.get("extendedTextMessage")
        if isinstance(ext, dict) and isinstance(ext.get("text"), str):
            return ext["text"], "texto"
        for key, tipo in (
            ("imageMessage", "midia"),
            ("videoMessage", "midia"),
            ("audioMessage", "audio"),
            ("documentMessage", "documento"),
            ("stickerMessage", "sticker"),
            ("locationMessage", "localizacao"),
            ("contactMessage", "contato"),
        ):
            node = content.get(key)
            if isinstance(node, dict):
                caption = node.get("caption")
                return (caption if isinstance(caption, str) else ""), tipo
    # Fallbacks simples.
    for key in ("text", "body", "message", "caption"):
        value = data.get(key)
        if isinstance(value, str):
            return value, "texto"
    return "", "texto"


def _first(data: dict[str, Any], *keys: str) -> Any:
    """Primeiro valor não-nulo entre chaves (case-insensitive no primeiro nível)."""
    lowered = {str(k).lower(): v for k, v in data.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value is not None:
            return value
    return None
