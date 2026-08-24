"""Preparacao segura de envios WhatsApp pedidos em linguagem natural.

Este modulo nao envia mensagens. Ele extrai uma intencao explicita, resolve o
destinatario somente contra dados do tenant autenticado e devolve um payload
deterministico para a Central de aprovacoes. O disparo acontece apenas no
executor de aprovacoes, depois da decisao humana.
"""

from __future__ import annotations

import asyncio
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Any

from app.core.tenant import read_user_db
from app.services.conversation_store import load_conversations


_SEND_VERBS = r"(?:mande|manda|mandar|envie|envia|enviar|dispare|disparar|responda|responder|fale|fala|diga|avise|avisar)"
_WHATSAPP_TERMS = r"(?:whats\s*app|zap|wpp)"
_CONTENT_MARKER = (
    r"(?:dizendo|falando|avisando|escrevendo)(?:\s+que)?|"
    r"com\s+(?:a\s+)?mensagem|com\s+(?:o\s+)?texto|mensagem\s*:|texto\s*:|que"
)
_JID_LIKE = re.compile(r"^[^\s@]+@(lid|g\.us|c\.us|s\.whatsapp\.net|newsletter|broadcast)$", re.I)
_PHONE_LIKE = re.compile(r"^\+?[0-9][0-9\s().-]{6,}$")


def normalize_lookup(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or "").casefold())
    plain = "".join(char for char in normalized if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", plain).strip()


def is_whatsapp_send_request(text: str) -> bool:
    normalized = normalize_lookup(text)
    has_send = bool(re.search(rf"\b{_SEND_VERBS}\b", normalized, flags=re.I))
    has_channel = bool(re.search(rf"\b{_WHATSAPP_TERMS}\b", normalized, flags=re.I))
    natural_message = bool(
        re.search(
            rf"\b{_SEND_VERBS}\b.+\bmensagem\b.+\b(?:para|pra|pro|ao)\b",
            normalized,
            flags=re.I,
        )
    )
    return has_send and (has_channel or natural_message)


def _clean_recipient(value: str) -> str:
    cleaned = re.sub(rf"\b(?:pelo|no|via)\s+{_WHATSAPP_TERMS}\b", "", value, flags=re.I)
    cleaned = re.sub(
        r"^(?:(?:o|a|os|as)\s+)?(?:(?:contato|grupo|cliente)\s+)?",
        "",
        cleaned.strip(),
        flags=re.I,
    )
    return cleaned.strip(" \t\r\n.,;:!?\"'`“”‘’")[:180]


def _clean_message(value: str) -> str:
    cleaned = value.strip(" \t\r\n.,;:\"'`“”‘’")
    cleaned = re.sub(rf"\s+(?:pelo|no|via)\s+{_WHATSAPP_TERMS}\s*$", "", cleaned, flags=re.I)
    return cleaned.strip(" \t\r\n.,;:\"'`“”‘’")[:1200]


def extract_whatsapp_request(text: str) -> dict[str, str]:
    """Extrai destinatario e texto sem inventar conteudo ausente.

    Formas aceitas incluem, por exemplo:
    - ``mande no WhatsApp para Ana dizendo que chego as 18h``;
    - ``envie \"Bom dia\" para Equipe Comercial pelo WhatsApp``;
    - ``manda oi para Carlos no zap``.
    """

    original = re.sub(r"^\s*nora\s*[,;:-]?\s*", "", str(text or ""), flags=re.I).strip()
    if not original or not is_whatsapp_send_request(original):
        return {"recipient_query": "", "message_text": ""}

    quoted_matches = re.findall(r"[\"“”']([^\"“”']{1,1200})[\"“”']", original)
    quoted_message = _clean_message(quoted_matches[0]) if quoted_matches else ""

    target_match = re.search(
        rf"\b(?:para|pra|pro|ao)\s+(?P<recipient>.+?)"
        rf"(?=\s+(?:{_CONTENT_MARKER})\b|\s+(?:pelo|no|via)\s+{_WHATSAPP_TERMS}\b|\s*[:;]\s*|$)",
        original,
        flags=re.I | re.S,
    )
    recipient_query = _clean_recipient(target_match.group("recipient")) if target_match else ""

    message_text = quoted_message
    if not message_text:
        marker_match = re.search(rf"\b(?:{_CONTENT_MARKER})\b\s*[:,-]?\s*(.+)$", original, flags=re.I | re.S)
        if marker_match:
            message_text = _clean_message(marker_match.group(1))

    if not message_text and target_match:
        colon_tail = re.search(r"[:;]\s*(.+)$", original[target_match.end():], flags=re.S)
        if colon_tail:
            message_text = _clean_message(colon_tail.group(1))

    if not message_text and target_match:
        # Forma curta: ``manda oi para Ana no WhatsApp``. Tudo o que sobra
        # antes de ``para Ana`` depois de remover verbo/canal e a palavra
        # "mensagem" e o texto literal a revisar.
        prefix = original[: target_match.start()]
        prefix = re.sub(rf"^\s*{_SEND_VERBS}\b", "", prefix, flags=re.I).strip()
        prefix = re.sub(r"^(?:uma\s+)?mensagem\b", "", prefix, flags=re.I).strip()
        prefix = re.sub(rf"\b(?:pelo|no|via)\s+{_WHATSAPP_TERMS}\b", "", prefix, flags=re.I).strip()
        message_text = _clean_message(prefix)

    return {"recipient_query": recipient_query, "message_text": message_text}


def _identifier(record: dict[str, Any], fallback: str = "") -> str:
    value: Any = (
        record.get("id")
        or record.get("jid")
        or record.get("chatId")
        or record.get("phoneNumber")
        or record.get("phone")
        or record.get("number")
        or fallback
    )
    if isinstance(value, dict):
        value = value.get("serialized") or value.get("_serialized") or value.get("user") or ""
    return str(value or "").strip()


def _is_technical_name(value: str, identifier: str) -> bool:
    stripped = str(value or "").strip()
    return (
        not stripped
        or stripped == identifier
        or bool(_JID_LIKE.fullmatch(stripped))
        or bool(_PHONE_LIKE.fullmatch(stripped))
    )


def _record_names(record: dict[str, Any], identifier: str) -> list[str]:
    values = [
        record.get("contato"),
        record.get("name"),
        record.get("notify"),
        record.get("pushname"),
        record.get("pushName"),
        record.get("verifiedName"),
        record.get("subject"),
    ]
    metadata = record.get("metadados") if isinstance(record.get("metadados"), dict) else {}
    values.extend((metadata.get("notify"), metadata.get("verifiedName"), metadata.get("numeroCompleto")))
    names: list[str] = []
    for value in values:
        candidate = str(value or "").strip()
        if candidate and candidate not in names:
            names.append(candidate)
    if identifier and identifier not in names:
        names.append(identifier)
    return names


def _identity_aliases(record: dict[str, Any], identifier: str) -> set[str]:
    """Retorna somente aliases técnicos seguros para deduplicar destinatários.

    Nomes humanos não entram nesta chave: duas pessoas podem ter o mesmo nome.
    A ponte telefone/JID/LID vem dos campos e ``aliases`` já sincronizados no
    catálogo do próprio tenant.
    """
    aliases: set[str] = set()
    nested = record.get("contact") if isinstance(record.get("contact"), dict) else {}
    metadata = record.get("metadados") if isinstance(record.get("metadados"), dict) else {}
    for source in (record, nested, metadata):
        for key in (
            "id", "jid", "chatId", "phoneNumber", "phone", "number", "lid",
            "senderLid", "serialized", "user", "wid",
        ):
            value = source.get(key)
            if isinstance(value, dict):
                value = value.get("serialized") or value.get("_serialized") or value.get("user")
            candidate = str(value or "").strip().casefold()
            if candidate:
                aliases.add(candidate)
        raw_aliases = source.get("aliases")
        if isinstance(raw_aliases, (list, tuple, set)):
            aliases.update(str(value or "").strip().casefold() for value in raw_aliases if str(value or "").strip())
    if identifier:
        aliases.add(identifier.casefold())

    for alias in list(aliases):
        if alias.endswith(("@lid", "@g.us", "@newsletter", "@broadcast")):
            continue
        digits = re.sub(r"\D", "", alias.split("@", 1)[0])
        if digits:
            aliases.update({digits, f"{digits}@c.us", f"{digits}@s.whatsapp.net"})
    return aliases


def _preferred_identifier(identifiers: list[str]) -> str:
    def rank(value: str) -> tuple[int, int]:
        lowered = value.casefold()
        if lowered.endswith("@g.us"):
            return (5, len(value))
        if lowered.endswith(("@s.whatsapp.net", "@c.us")):
            return (4, len(value))
        if re.fullmatch(r"\+?\d{8,16}", value):
            return (3, len(value))
        if lowered.endswith("@lid"):
            return (2, len(value))
        return (1, len(value))

    return max((value for value in identifiers if value), key=rank, default="")


async def _load_catalog(user_id: str) -> dict[str, Any]:
    payload = await asyncio.to_thread(read_user_db, user_id, "whatsapp_catalog_cache", {})
    return payload if isinstance(payload, dict) else {}


async def whatsapp_recipient_records(user_id: str) -> list[dict[str, Any]]:
    conversations, catalog = await asyncio.gather(load_conversations(user_id), _load_catalog(user_id))
    raw_records: list[tuple[str, dict[str, Any]]] = [
        (str(conversation_id), conversation)
        for conversation_id, conversation in conversations.items()
        if isinstance(conversation, dict)
    ]
    for key in ("contacts", "chats"):
        raw_records.extend(
            ("", item) for item in (catalog.get(key) or []) if isinstance(item, dict)
        )

    prepared: list[dict[str, Any]] = []
    for fallback_id, record in raw_records:
        identifier = _identifier(record, fallback_id)
        lowered = identifier.casefold()
        if not identifier or lowered in {"status", "status@broadcast"} or lowered.endswith(("@newsletter", "@broadcast")):
            continue
        identity_aliases = _identity_aliases(record, identifier)
        names = _record_names(record, identifier)
        for alias in sorted(identity_aliases):
            if alias not in names:
                names.append(alias)
        prepared.append(
            {
                "identifier": identifier,
                "names": names,
                "identity_aliases": identity_aliases,
                "is_group": bool(record.get("esGrupo") or record.get("isGroup") or lowered.endswith("@g.us")),
            }
        )

    parents = list(range(len(prepared)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    alias_owner: dict[str, int] = {}
    for index, item in enumerate(prepared):
        for alias in item["identity_aliases"]:
            owner = alias_owner.get(alias)
            if owner is None:
                alias_owner[alias] = index
            else:
                union(index, owner)

    groups: dict[int, list[dict[str, Any]]] = {}
    for index, item in enumerate(prepared):
        groups.setdefault(find(index), []).append(item)

    merged: list[dict[str, Any]] = []
    for items in groups.values():
        identifiers = [str(item["identifier"]) for item in items]
        conversation_id = _preferred_identifier(identifiers)
        aliases: list[str] = []
        for item in items:
            for alias in item["names"]:
                if alias not in aliases:
                    aliases.append(alias)
        display_name = next(
            (
                name
                for name in aliases
                if all(not _is_technical_name(name, identifier) for identifier in identifiers)
            ),
            conversation_id,
        )
        merged.append(
            {
                "conversation_id": conversation_id,
                "display_name": display_name,
                "aliases": aliases,
                "is_group": any(bool(item["is_group"]) for item in items),
            }
        )

    return merged


def _recipient_match_score(query: str, record: dict[str, Any]) -> float:
    normalized_query = normalize_lookup(query)
    query_digits = re.sub(r"\D", "", query)
    if not normalized_query and not query_digits:
        return 0.0

    best = 0.0
    for alias in record.get("aliases") or []:
        raw_alias = str(alias or "")
        normalized_alias = normalize_lookup(raw_alias)
        alias_digits = re.sub(r"\D", "", raw_alias.split("@", 1)[0])
        if query_digits and len(query_digits) >= 8 and alias_digits == query_digits:
            best = max(best, 1.0)
        if normalized_alias == normalized_query:
            best = max(best, 1.0)
        elif len(normalized_query) >= 3 and (
            normalized_alias.startswith(normalized_query)
            or normalized_query.startswith(normalized_alias)
        ):
            best = max(best, 0.9)
        elif len(normalized_query) >= 4 and normalized_query in normalized_alias:
            best = max(best, 0.84)
        elif len(normalized_query) >= 5:
            best = max(best, SequenceMatcher(None, normalized_query, normalized_alias).ratio() * 0.78)
    return best


async def resolve_whatsapp_recipient(user_id: str, query: str) -> dict[str, Any]:
    records = await whatsapp_recipient_records(user_id)
    ranked = sorted(
        ((record, _recipient_match_score(query, record)) for record in records),
        key=lambda item: (-item[1], str(item[0].get("display_name") or "").casefold()),
    )
    matches = [(record, score) for record, score in ranked if score >= 0.84]
    if not matches:
        return {"status": "not_found", "query": query, "candidates": []}

    top_record, top_score = matches[0]
    competing = [record for record, score in matches[1:] if top_score - score < 0.08]
    if competing:
        candidates = [top_record, *competing][:5]
        return {
            "status": "ambiguous",
            "query": query,
            "candidates": [
                {
                    "conversation_id": item["conversation_id"],
                    "display_name": item["display_name"],
                    "is_group": item["is_group"],
                }
                for item in candidates
            ],
        }
    return {
        "status": "resolved",
        "conversation_id": top_record["conversation_id"],
        "display_name": top_record["display_name"],
        "is_group": top_record["is_group"],
    }


async def prepare_whatsapp_action(user_id: str, instruction: str) -> dict[str, Any]:
    extracted = extract_whatsapp_request(instruction)
    recipient_query = extracted["recipient_query"]
    message_text = extracted["message_text"]
    if not recipient_query:
        return {
            "status": "precisa_destinatario",
            "response": "Para quem devo enviar a mensagem no WhatsApp? Informe o nome salvo, grupo ou numero.",
        }
    if not message_text:
        return {
            "status": "precisa_mensagem",
            "response": f"Qual texto devo preparar para {recipient_query}? Nada sera enviado sem sua revisao.",
        }

    resolved = await resolve_whatsapp_recipient(user_id, recipient_query)
    if resolved["status"] == "not_found":
        return {
            "status": "destinatario_nao_encontrado",
            "response": (
                f"Nao encontrei '{recipient_query}' nos contatos e conversas sincronizados desta conta. "
                "Informe o nome salvo completo ou o numero com DDI e DDD."
            ),
        }
    if resolved["status"] == "ambiguous":
        names = ", ".join(str(item.get("display_name") or "") for item in resolved["candidates"])
        return {
            "status": "destinatario_ambiguo",
            "response": f"Encontrei mais de um destinatario compativel: {names}. Qual deles devo usar?",
            "candidates": resolved["candidates"],
        }

    return {
        "status": "pronto_para_aprovacao",
        "response": "Mensagem validada e pronta para revisao.",
        "action": {
            "conversationId": resolved["conversation_id"],
            "recipientName": resolved["display_name"],
            "isGroup": bool(resolved["is_group"]),
            "messageText": message_text,
        },
    }


__all__ = [
    "extract_whatsapp_request",
    "is_whatsapp_send_request",
    "normalize_lookup",
    "prepare_whatsapp_action",
    "resolve_whatsapp_recipient",
    "whatsapp_recipient_records",
]
