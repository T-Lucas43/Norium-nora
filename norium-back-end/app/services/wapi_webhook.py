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

_STATUS_BROADCAST_JID = "status@broadcast"
_STATUS_IDENTIFIER_ALIASES = {
    _STATUS_BROADCAST_JID,
    "status",
    "statuses",
    "broadcast",
    "status_v3",
    "status-v3",
}
_STATUS_FLAG_KEYS = (
    "isStatus",
    "isStatusMsg",
    "isStatusMessage",
    "isStatusV3",
    "statusBroadcast",
    "isStatusBroadcast",
)
_WRAPPER_KEYS = ("data", "payload", "body", "eventData", "messageData")
_IDENTIFIER_KEYS = (
    "id",
    "chatId",
    "chatJid",
    "phone",
    "phoneNumber",
    "from",
    "to",
    "remoteJid",
    "remoteJidAlt",
    "jid",
    "wid",
)
_IDENTIFIER_CONTAINER_KEYS = (
    *_WRAPPER_KEYS,
    "chat",
    "key",
    "message",
    "msg",
    "info",
    "sender",
    "recipient",
    "source",
)


def _is_true(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() in {"1", "true", "yes"})


def _payload_layers(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Retorna envelopes conhecidos do webhook, do externo ao mais interno."""
    layers: list[dict[str, Any]] = []
    queue: list[dict[str, Any]] = [data]
    seen: set[int] = set()
    while queue:
        current = queue.pop(0)
        marker = id(current)
        if marker in seen:
            continue
        seen.add(marker)
        layers.append(current)
        for key in _WRAPPER_KEYS:
            nested = current.get(key)
            if isinstance(nested, dict):
                queue.append(nested)
    return layers


def _payload(data: dict[str, Any]) -> dict[str, Any]:
    """Achata envelopes opcionais sem perder metadados externos."""
    flattened: dict[str, Any] = {}
    for layer in _payload_layers(data):
        flattened.update(layer)
    return flattened


def _identifier_token(value: Any) -> str:
    """Normaliza JID string ou objeto Wid/Baileys para comparação segura."""
    if isinstance(value, dict):
        serialized = value.get("_serialized") or value.get("serialized")
        if serialized:
            return str(serialized).strip()
        user = str(value.get("user") or "").strip()
        server = str(value.get("server") or "").strip()
        if user and server:
            return f"{user}@{server}"
        for key in _IDENTIFIER_KEYS:
            nested = value.get(key)
            if nested is value:
                continue
            token = _identifier_token(nested)
            if token:
                return token
        return ""
    return str(value or "").strip()


def _is_status_identifier(value: Any) -> bool:
    return _identifier_token(value).lower() in _STATUS_IDENTIFIER_ALIASES


def instance_id(data: dict[str, Any]) -> str:
    """Obtém a instância mesmo quando o gateway adiciona envelopes."""
    for layer in _payload_layers(data):
        value = _first(layer, "instanceId", "instanceID", "connectionKey", "instance")
        if isinstance(value, dict):
            value = _first(value, "id", "instanceId", "connectionKey")
        token = str(value or "").strip()
        if token:
            return token
    return ""


def is_outgoing_delivery(data: dict[str, Any]) -> bool:
    """Identifica o webhook oficial "Ao enviar".

    Há payloads reais/legados em que ``webhookDelivery`` chega com
    ``fromMe:false``. O tipo do callback é a fonte confiável: todo conteúdo
    entregue por esse endpoint representa uma mensagem enviada pela conta
    conectada, seja pelo celular, WhatsApp Web ou API.
    """
    payload = _payload(data)
    raw = str(payload.get("event") or payload.get("type") or "").strip().lower()
    return "delivery" in raw or raw in {"webhooksent", "sentcallback"}


def message_from_me(data: dict[str, Any]) -> bool:
    """Lê ``fromMe`` nos formatos plano/Baileys e corrige delivery legado."""
    payload = _payload(data)
    if is_outgoing_delivery(payload):
        return True
    candidates: list[Any] = [
        _first(payload, "fromMe", "isFromMe", "keyFromMe"),
    ]
    for container in (
        payload.get("key"),
        payload.get("message"),
        payload.get("message", {}).get("key") if isinstance(payload.get("message"), dict) else None,
    ):
        if isinstance(container, dict):
            candidates.append(_first(container, "fromMe", "isFromMe", "keyFromMe"))
    return any(_is_true(value) for value in candidates)


def is_status_broadcast(data: dict[str, Any]) -> bool:
    """Detecta publicações do Status do WhatsApp, não status de entrega.

    A W-API pode expor o marcador como JID direto, dentro de ``chat``/``key``
    (formato Baileys) ou como flag booleana. Não considera o campo genérico
    ``status``, pois ele também representa ACK/entrega de mensagens normais.
    """
    queue: list[dict[str, Any]] = [data]
    seen: set[int] = set()
    while queue:
        container = queue.pop(0)
        marker = id(container)
        if marker in seen:
            continue
        seen.add(marker)
        for key in _STATUS_FLAG_KEYS:
            marker_value = container.get(key)
            if _is_true(marker_value) or _is_status_identifier(marker_value):
                return True
        if any(_is_status_identifier(container.get(key)) for key in _IDENTIFIER_KEYS):
            return True
        for key in _IDENTIFIER_CONTAINER_KEYS:
            nested = container.get(key)
            if isinstance(nested, dict):
                queue.append(nested)
    return False


def status_broadcast_payloads(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Expande um pseudo-chat de catálogo em publicações individuais de Status."""
    payload = _payload(data)
    record_is_status = is_status_broadcast(data)
    messages: list[dict[str, Any]] = []
    for key in ("messages", "msgs"):
        value = payload.get(key)
        if isinstance(value, list):
            messages.extend(item for item in value if isinstance(item, dict))
    last_message = payload.get("lastMessage")
    if isinstance(last_message, dict):
        messages.append(last_message)

    if record_is_status and messages:
        base = {
            key: value
            for key, value in payload.items()
            if key not in {"messages", "msgs", "lastMessage"}
        }
        return [
            {**base, **message, "chatId": _STATUS_BROADCAST_JID}
            for message in messages
        ]
    if record_is_status:
        return [payload]
    return [message for message in messages if is_status_broadcast(message)]


def classify_event(data: dict[str, Any]) -> str:
    """Mapeia o campo de evento da W-API para uma classe interna (tolerante)."""
    payload = _payload(data)
    raw = str(payload.get("event") or payload.get("type") or "").strip().lower()
    if not raw:
        # Sem nome de evento: se traz conteúdo de mensagem, trata como recebido.
        return EVENT_RECEIVED if _first(payload, "msgcontent", "message", "text", "body") is not None else EVENT_UNKNOWN
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
    for layer in _payload_layers(data):
        direct = _first(layer, "messageId", "eventId", "zaid")
        if direct:
            return str(direct)
        for container_key in ("key", "message", "msg", "info"):
            container = layer.get(container_key)
            if not isinstance(container, dict):
                continue
            key = container.get("key") if isinstance(container.get("key"), dict) else container
            nested = _first(key, "messageId", "eventId", "zaid", "id")
            if nested and not _is_status_identifier(nested):
                return str(nested)
        direct_id = layer.get("id")
        if direct_id and not isinstance(direct_id, dict) and not _is_status_identifier(direct_id):
            return str(direct_id)
    return ""


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
    payload = _payload(data)
    message_id = event_id(data)
    status = map_status(
        str(_first(payload, "status", "ack", "state") or "")
    )
    return message_id, status


def extract_chat_status_update(data: dict[str, Any]) -> tuple[str, bool | None, int | None]:
    """Extrai a leitura/contador de um evento de status do chat.

    A W-API possui um webhook separado para atualizações do chat. Como versões
    diferentes do gateway usam nomes de campos distintos, o parser aceita os
    formatos plano, ``chat`` e ``data`` sem confundir ``READ`` de uma mensagem
    enviada (que traz ``messageId``) com a leitura da conversa no celular.
    """
    payload = _payload(data)
    chat = payload.get("chat") if isinstance(payload.get("chat"), dict) else {}
    key = payload.get("key") if isinstance(payload.get("key"), dict) else {}
    chat_id = _identifier_token(
        _first(payload, "chatId", "phone", "remoteJid", "remoteJidAlt", "jid")
        or _first(chat, "id", "chatId", "phone", "remoteJid", "remoteJidAlt", "jid")
        or _first(key, "remoteJid", "remoteJidAlt", "chatId", "phone")
    )
    if not chat_id or is_status_broadcast({"chatId": chat_id}):
        return "", None, None

    unread_raw = (
        _first(payload, "unreadCount", "unreadMessages", "unread")
    )
    try:
        unread_count = max(0, int(unread_raw)) if unread_raw is not None else None
    except (TypeError, ValueError):
        unread_count = None

    explicit_read = _first(payload, "isRead", "read", "viewed")
    read: bool | None = None
    if explicit_read is not None:
        read = _is_true(explicit_read)
    elif unread_count is not None:
        read = unread_count == 0
    else:
        raw_state = str(_first(payload, "chatStatus", "state", "status") or "").strip().lower()
        if raw_state in {"read", "viewed", "seen", "opened", "read_all", "read-all"}:
            read = True
        elif raw_state in {"unread", "unseen", "new_message", "new-message"}:
            read = False
    return chat_id, read, unread_count


def adapt_status_broadcast(data: dict[str, Any]) -> dict[str, Any] | None:
    """Normaliza uma publicação de Status para o feed separado do Norium."""
    if not is_status_broadcast(data):
        return None
    payload = _payload(data)
    sender = payload.get("sender") if isinstance(payload.get("sender"), dict) else {}
    key = payload.get("key") if isinstance(payload.get("key"), dict) else {}
    message_node = payload.get("message") if isinstance(payload.get("message"), dict) else {}
    if not key and isinstance(message_node.get("key"), dict):
        key = message_node["key"]
    texto, tipo, midia_meta, _reaction_target = _extract_content(payload)
    if tipo is None:
        return None
    contact_id = _identifier_token(
        sender.get("phoneNumber")
        or sender.get("phone")
        or sender.get("id")
        or sender.get("jid")
        or sender.get("lid")
        or _first(payload, "participant", "senderId", "author", "keyParticipant")
        or _first(key, "participant", "senderId", "author")
    )
    if not contact_id:
        return None
    timestamp = _first(payload, "moment", "momment", "timestamp", "messageTimestamp", "t")
    try:
        timestamp_int = int(float(timestamp or 0))
        if timestamp_int > 10_000_000_000:
            timestamp_int //= 1000
    except (TypeError, ValueError):
        timestamp_int = 0
    photo_url = sender.get("profilePicture") or sender.get("profilePictureUrl") or sender.get("photoUrl")
    content = payload.get("msgContent") if isinstance(payload.get("msgContent"), dict) else {}
    extended = content.get("extendedTextMessage") if isinstance(content.get("extendedTextMessage"), dict) else {}
    raw_color = payload.get("backgroundColor") or payload.get("color") or extended.get("backgroundArgb")
    if isinstance(raw_color, int):
        color: str | None = f"#{raw_color & 0xFFFFFF:06x}"
    elif isinstance(raw_color, str) and raw_color.startswith("#"):
        color = raw_color
    else:
        color = None
    return {
        "id": event_id(data),
        "contactId": contact_id,
        "contactName": str(
            sender.get("notify")
            or sender.get("pushName")
            or sender.get("name")
            or _first(payload, "senderName", "pushName", "notifyName")
            or contact_id
        ),
        "photoUrl": photo_url if isinstance(photo_url, str) and photo_url.startswith("http") else None,
        "fromMe": message_from_me(payload),
        "timestamp": timestamp_int,
        "texto": texto,
        "tipo": tipo,
        "midiaMeta": midia_meta,
        "color": color,
    }


def adapt_incoming(data: dict[str, Any]) -> dict[str, Any] | None:
    """Normaliza um evento de mensagem recebida para o modelo do Norium.

    Retorna ``None`` quando não há telefone/chat identificável.
    """
    if is_status_broadcast(data):
        return None

    payload = _payload(data)
    key = payload.get("key") if isinstance(payload.get("key"), dict) else {}
    message_node = payload.get("message") if isinstance(payload.get("message"), dict) else {}
    if not key and isinstance(message_node.get("key"), dict):
        key = message_node["key"]
    chat_id = _identifier_token(
        _first(payload, "chatId", "phone", "from", "remoteJid", "remoteJidAlt", "jid")
        or _first(key, "remoteJid", "remoteJidAlt", "chatId", "phone", "jid")
    )
    chat = payload.get("chat") if isinstance(payload.get("chat"), dict) else None
    if not chat_id and chat:
        chat_id = _identifier_token(chat.get("id") or chat.get("phone"))
    if not chat_id:
        return None

    sender = payload.get("sender") if isinstance(payload.get("sender"), dict) else {}
    from_me = message_from_me(payload)
    is_group = _is_true(_first(payload, "isGroup", "isGroupMsg")) or chat_id.endswith("@g.us")
    sender_name = str(
        _first(payload, "senderName", "pushName", "notifyName", "notify", "verifiedName")
        or sender.get("notify")
        or sender.get("pushName")
        or sender.get("verifiedName")
        or sender.get("name")
        or chat_id
    )
    # O payload do grupo NÃO traz o nome (subject) — só id e foto. Deixamos vazio
    # para o handler resolver o subject via group-metadata; individual usa o nome
    # do próprio contato (pushName).
    chat_name = "" if is_group else sender_name

    # Timestamp em segundos: campo real "moment".
    timestamp = _first(payload, "moment", "momment", "timestamp", "messageTimestamp", "t")
    try:
        timestamp_int = int(float(timestamp)) if timestamp is not None else 0
        if timestamp_int > 10_000_000_000:
            timestamp_int //= 1000
    except (TypeError, ValueError):
        timestamp_int = 0

    texto, tipo, midia_meta, reaction_target = _extract_content(payload)
    # Conteúdo não exibível (protocolo, enquete, apenas contextInfo) → ignora,
    # para não criar "mensagens em branco".
    if tipo is None and not reaction_target:
        return None

    # Foto de perfil vem no proprio webhook (chat/sender.profilePicture).
    photo_url = (chat.get("profilePicture") if chat else None) or sender.get("profilePicture")

    return {
        "messageId": event_id(data),
        "chatId": chat_id,
        "fromMe": from_me,
        "isGroup": is_group,
        "senderName": sender_name,
        "chatName": chat_name,
        "senderId": _identifier_token(
            sender.get("id") if sender else _first(payload, "senderId", "participant", "keyParticipant")
        ) or None,
        "photoUrl": photo_url if isinstance(photo_url, str) and photo_url.startswith("http") else None,
        "timestamp": timestamp_int,
        "texto": texto,
        "tipo": tipo or "texto",
        "midiaMeta": midia_meta,
        "reactionTargetId": reaction_target,
        "status": map_status(str(_first(payload, "status") or "")) or None,
    }


# msgContent.<key>Message -> (tipo interno, type para download-media)
_MEDIA_TYPES = {
    "imageMessage": ("midia", "image"),
    "videoMessage": ("midia", "video"),
    "audioMessage": ("audio", "audio"),
    "documentMessage": ("documento", "document"),
    "stickerMessage": ("sticker", "sticker"),
    "image": ("midia", "image"),
    "photo": ("midia", "image"),
    "video": ("midia", "video"),
    "audio": ("audio", "audio"),
    "ptt": ("audio", "audio"),
    "document": ("documento", "document"),
    "sticker": ("sticker", "sticker"),
}

_FLAT_MEDIA_TYPES = {
    "image": ("midia", "image"),
    "photo": ("midia", "image"),
    "video": ("midia", "video"),
    "audio": ("audio", "audio"),
    "ptt": ("audio", "audio"),
    "document": ("documento", "document"),
    "sticker": ("sticker", "sticker"),
}


def _media_meta(node: dict[str, Any], dtype: str, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    """Preserva o discriminador mesmo quando o catálogo não traz a chave completa.

    Webhooks ao vivo normalmente incluem ``mediaKey`` + ``directPath``. O
    catálogo da W-API também pode devolver registros planos, às vezes só com
    uma URL/miniatura. Manter o metadado impede que uma mídia seja reclassificada
    como texto e permite que a rota de download use o melhor fallback disponível.
    """
    merged = dict(fallback or {})
    merged.update(node)
    media_key = str(_first(merged, "mediaKey", "media_key") or "")
    direct_path = str(_first(merged, "directPath", "direct_path") or "")
    meta: dict[str, Any] = {
        "mediaKey": media_key,
        "directPath": direct_path,
        "type": dtype,
        "mimetype": str(_first(merged, "mimetype", "mimeType", "mime") or ""),
    }
    # Esses campos também precisam sobreviver quando mediaKey/directPath estão
    # presentes: se o link decriptado expirar ou o endpoint de download falhar,
    # ainda podemos usar um fileLink alternativo ou a miniatura de uma imagem.
    for source_field in (
        "fileLink", "downloadUrl", "mediaUrl", "fileUrl",
        f"{dtype}Url", "url", "URL",
    ):
        candidate = _first(merged, source_field)
        if isinstance(candidate, str) and candidate.startswith(("https://", "data:")):
            meta["sourceUrl"] = candidate
            meta["sourceField"] = source_field.lower()
            break
    thumbnail = _first(merged, "jpegThumbnail", "thumbnail", "thumbnailData", "thumbnailUrl")
    if isinstance(thumbnail, str) and thumbnail and len(thumbnail) <= 4_000_000:
        meta["thumbnail"] = thumbnail
    return meta


def _flat_media_descriptor(data: dict[str, Any]) -> tuple[str, str] | None:
    """Lê ``type/messageType`` do catálogo sem confundir ``type=chat``."""
    for key in ("messageType", "mediaType", "kind", "type"):
        raw = _first(data, key)
        if not isinstance(raw, str):
            continue
        normalized = raw.strip().lower().replace("_message", "").replace("-message", "")
        if normalized.endswith("message"):
            normalized = normalized[:-7]
        if normalized in _FLAT_MEDIA_TYPES:
            return _FLAT_MEDIA_TYPES[normalized]
    return None


def _extract_flat_media(data: dict[str, Any]) -> tuple[str, str | None, dict[str, Any] | None, str | None] | None:
    descriptor = _flat_media_descriptor(data)
    if descriptor is None:
        return None
    tipo, dtype = descriptor
    nested = _first(data, dtype, f"{dtype}Message")
    node = nested if isinstance(nested, dict) else data
    caption = _first(node, "caption", "message", "text", "body", "content")
    if not isinstance(caption, str):
        caption = _first(data, "caption", "body", "text", "content")
    return (
        caption if isinstance(caption, str) else "",
        tipo,
        _media_meta(node, dtype, data),
        None,
    )


def _extract_content(data: dict[str, Any]) -> tuple[str, str | None, dict[str, Any] | None, str | None]:
    """Retorna (texto, tipo, midia_meta, reaction_target_id).

    - ``reaction_target_id`` != None: é uma reação recebida (atualiza a msg alvo).
    - ``tipo`` == None: conteúdo não exibível (protocolo/enquete/etc.) → ignorar.
    """
    content = data.get("msgContent")
    if not isinstance(content, dict):
        wrapped = data.get("data")
        if isinstance(wrapped, dict):
            flattened = {key: value for key, value in data.items() if key != "data"}
            flattened.update(wrapped)
            return _extract_content(flattened)
        message = data.get("message")
        if isinstance(message, dict):
            # Alguns adaptadores mantêm o conteúdo Baileys dentro de
            # ``message`` em vez de ``msgContent``.
            return _extract_content({**data, "msgContent": message})
    if isinstance(content, dict):
        nested_message = _first(content, "message")
        if isinstance(nested_message, dict):
            return _extract_content({**data, "msgContent": nested_message})
        # Reação recebida: {reactionMessage: {key:{id,...}, text}}
        reaction = _first(content, "reactionMessage")
        if isinstance(reaction, dict):
            key = reaction.get("key") if isinstance(reaction.get("key"), dict) else {}
            return (reaction.get("text") or ""), "reaction", None, str(key.get("id") or "")
        conversation = _first(content, "conversation")
        if isinstance(conversation, str):
            return conversation, "texto", None, None
        ext = _first(content, "extendedTextMessage")
        if isinstance(ext, dict) and isinstance(ext.get("text"), str):
            return ext["text"], "texto", None, None
        for media_key, (tipo, dtype) in _MEDIA_TYPES.items():
            node = _first(content, media_key)
            if isinstance(node, dict):
                caption = _first(node, "caption", "message", "text", "body", "content")
                if not isinstance(caption, str) or not caption.strip():
                    # Em alguns envelopes a W-API mantém a legenda no nível do
                    # evento (``caption``/``body``) e a mídia dentro de
                    # ``msgContent``. Ela pertence à mesma publicação de Status
                    # e não deve virar uma mensagem de texto separada.
                    outer_caption = _first(data, "caption", "body", "text", "content")
                    if isinstance(outer_caption, dict):
                        outer_caption = _first(outer_caption, "message", "body", "text")
                    caption = outer_caption if isinstance(outer_caption, str) else ""
                meta = _media_meta(node, dtype, data)
                return (caption if isinstance(caption, str) else ""), tipo, meta, None
        for loc_key, tipo in (("locationMessage", "localizacao"), ("contactMessage", "contato")):
            if isinstance(_first(content, loc_key), dict):
                return "", tipo, None, None
        flat_media = _extract_flat_media(data)
        if flat_media is not None:
            return flat_media
        # msgContent presente, mas sem conteúdo exibível reconhecido → ignora.
        return "", None, None, None
    flat_media = _extract_flat_media(data)
    if flat_media is not None:
        return flat_media
    for key in ("text", "body", "message", "caption", "content"):
        value = data.get(key)
        if isinstance(value, str):
            return value, "texto", None, None
    return "", "texto", None, None


def _first(data: dict[str, Any], *keys: str) -> Any:
    """Primeiro valor não-nulo entre chaves (case-insensitive no primeiro nível)."""
    lowered = {str(k).lower(): v for k, v in data.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value is not None:
            return value
    return None
