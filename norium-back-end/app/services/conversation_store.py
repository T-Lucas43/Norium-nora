from __future__ import annotations

import asyncio
import json
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from app.core.tenant import get_user_db_path, read_json_file, write_json_file
from app.core.identity import require_user_id
from app.infrastructure.persistence import postgres_store
from app.services.whatsapp_provider import store_name, is_evolution

ChatChannel = Literal["whatsapp"]

BACKEND_ROOT = Path(__file__).resolve().parents[2]
JSON_FILE = BACKEND_ROOT / "conversas_db.json"

EMPTY_HISTORY_MARKER = "[Nenhuma mensagem recente registrada no sistema ainda]"
BRAZIL_TZ = ZoneInfo("America/Sao_Paulo")
whatsapp_conversation_mutation_locks: Dict[tuple[int, str], asyncio.Lock] = {}


def whatsapp_conversation_mutation_lock(user_id: str) -> asyncio.Lock:
    """Serializa read/modify/write do histórico WhatsApp por loop e tenant."""
    loop_key = id(asyncio.get_running_loop())
    return whatsapp_conversation_mutation_locks.setdefault((loop_key, user_id), asyncio.Lock())


def _now_payload() -> tuple[str, int]:
    agora = datetime.now(BRAZIL_TZ)
    return agora.strftime("%H:%M"), int(agora.timestamp())


def _json_file_for_user(user_id: str) -> Path:
    return Path(get_user_db_path(require_user_id({"id": user_id}), store_name("conversas")))


def _read_json_sync(user_id: str | None = None) -> Dict[str, Any]:
    json_file = _json_file_for_user(user_id)
    if postgres_store.configured() or postgres_store.required():
        payload = read_json_file(json_file, {})
        return payload if isinstance(payload, dict) else {}
    if not is_evolution() and not json_file.exists() and user_id == "lucas123" and JSON_FILE.exists():
        json_file.parent.mkdir(parents=True, exist_ok=True)
        try:
            json_file.write_text(JSON_FILE.read_text(encoding="utf-8"), encoding="utf-8")
        except Exception:
            pass
    if not json_file.exists():
        return {}

    try:
        with json_file.open("r", encoding="utf-8") as arquivo:
            data = json.load(arquivo)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_json_sync(data: Dict[str, Any], user_id: str | None = None) -> None:
    json_file = _json_file_for_user(user_id)
    if postgres_store.configured() or postgres_store.required():
        write_json_file(json_file, data)
        return
    json_file.parent.mkdir(parents=True, exist_ok=True)
    with json_file.open("w", encoding="utf-8") as arquivo:
        json.dump(data, arquivo, ensure_ascii=False, indent=4)


async def load_conversations(user_id: str | None = None) -> Dict[str, Any]:
    data = await asyncio.to_thread(_read_json_sync, user_id)
    return normalize_database(data)


async def save_conversations(data: Dict[str, Any], user_id: str | None = None) -> None:
    normalized = normalize_database(data)
    await asyncio.to_thread(_write_json_sync, normalized, user_id)


def normalize_database(data: Dict[str, Any]) -> Dict[str, Any]:
    normalized: Dict[str, Any] = {}
    for conversa_id, conversa in data.items():
        if isinstance(conversa, dict):
            normalized[conversa_id] = normalize_conversation(conversa_id, conversa)
    if is_evolution():
        from app.services.whatsapp_identity import coalesce
        return coalesce(normalized)
    return normalized


def normalize_conversation(conversa_id: str, conversa: Dict[str, Any]) -> Dict[str, Any]:
    channel = _normalize_channel(conversa.get("canal") or conversa.get("channel"))
    contato = str(conversa.get("contato") or conversa.get("nome") or conversa_id)
    metadados = conversa.get("metadados") if isinstance(conversa.get("metadados"), dict) else {}
    photo_url = conversa.get("photoUrl") or metadados.get("photoUrl")

    metadados_normalizados = {
        "numeroCompleto": metadados.get("numeroCompleto") or conversa_id,
        "username": metadados.get("username"),
        "bioRecado": metadados.get("bioRecado"),
        "verifiedName": metadados.get("verifiedName"),
        "notify": metadados.get("notify"),
        "isBusiness": bool(metadados.get("isBusiness", False)),
        "isMyContact": bool(metadados.get("isMyContact", False)),
        "isBlocked": bool(metadados.get("isBlocked", False)),
        "statusOnline": bool(metadados.get("statusOnline", False)),
        "photoUrl": photo_url,
        # A URL da W-API expira e o instante precisa sobreviver à normalização;
        # sem isso cada leitura do catálogo tentava baixar a mesma foto outra
        # vez, multiplicando latência e rate-limit.
        "photoFetchedAt": metadados.get("photoFetchedAt"),
        "participantes": _normalize_participants(metadados.get("participantes")),
        "participantesCount": int(
            metadados.get("participantesCount")
            or len(metadados.get("participantes") or [])
        ),
        "descricaoGrupo": metadados.get("descricaoGrupo") or "",
        "criadoPor": metadados.get("criadoPor"),
        "criadoEm": metadados.get("criadoEm"),
        "inviteLink": metadados.get("inviteLink"),
        "isCommunity": bool(metadados.get("isCommunity", False)),
        "recentlyCreatedAt": metadados.get("recentlyCreatedAt"),
        "historicoSincronizadoEm": metadados.get("historicoSincronizadoEm"),
        "historicoCursor": metadados.get("historicoCursor"),
        "historicoTemMais": bool(metadados.get("historicoTemMais", False)),
        "historicoSchema": metadados.get("historicoSchema"),
        "historicoProximaPagina": metadados.get("historicoProximaPagina"),
        "historicoAte": metadados.get("historicoAte"),
        "historicoVinculo": metadados.get("historicoVinculo"),
        **({"evolutionCatalog": True} if metadados.get("evolutionCatalog") is True else {}),
        **({"identityAliases": [value for value in metadados["identityAliases"][:32] if isinstance(value, str)]}
           if isinstance(metadados.get("identityAliases"), list) else {}),
    }

    mensagens_raw = conversa.get("mensagens")
    mensagens = [
        normalize_message(mensagem, channel)
        for mensagem in mensagens_raw
        if isinstance(mensagem, dict)
    ] if isinstance(mensagens_raw, list) else []

    latest_message = mensagens[-1] if mensagens else None
    normalized = {
        "id": conversa.get("id") or conversa_id,
        "contato": contato,
        "canal": channel,
        "channel": channel,
        "ultimoTexto": conversa.get("ultimoTexto") or _last_text(mensagens),
        "horario": conversa.get("horario") or (mensagens[-1]["horario"] if mensagens else ""),
        "timestampUltimaMsg": int(conversa.get("timestampUltimaMsg") or _last_timestamp(mensagens)),
        "ultimaMensagemMinha": bool(
            conversa.get("ultimaMensagemMinha")
            if conversa.get("ultimaMensagemMinha") is not None
            else latest_message and latest_message.get("remetente") == "usuario"
        ),
        "statusUltimaMensagem": conversa.get("statusUltimaMensagem")
        or (latest_message.get("status") if latest_message and latest_message.get("remetente") == "usuario" else None),
        "ultimoRemetenteNome": conversa.get("ultimoRemetenteNome")
        or (latest_message.get("remetenteNome") if latest_message and latest_message.get("remetente") != "usuario" else None),
        "lida": bool(conversa.get("lida", True)),
        "naoLidasCount": int(conversa.get("naoLidasCount") or 0),
        "fixada": bool(conversa.get("fixada", False)),
        "favorita": bool(conversa.get("favorita", False)),
        "silenciada": bool(conversa.get("silenciada", False)),
        "arquivada": bool(conversa.get("arquivada", False)),
        "esGrupo": bool(conversa.get("esGrupo", _looks_like_group(conversa_id))),
        "mensagens": mensagens,
        "metadados": metadados_normalizados,
        "photoUrl": photo_url,
    }
    return normalized


def normalize_message(mensagem: Dict[str, Any], channel: ChatChannel) -> Dict[str, Any]:
    texto = mensagem.get("texto")
    tipo = mensagem.get("tipo") or "texto"
    status = mensagem.get("status")
    if status not in {"erro", "pendente", "enviado", "entregue", "lido", "reproduzido", None}:
        status = None

    timestamp = mensagem.get("timestamp")
    try:
        timestamp_normalizado = int(timestamp) if timestamp is not None else int(datetime.now(BRAZIL_TZ).timestamp())
    except (TypeError, ValueError):
        timestamp_normalizado = int(datetime.now(BRAZIL_TZ).timestamp())

    return {
        "id": str(mensagem.get("id") or f"msg_{timestamp_normalizado}"),
        "remetente": "usuario" if mensagem.get("remetente") == "usuario" else "contato",
        "remetenteNome": mensagem.get("remetenteNome"),
        "remetenteId": mensagem.get("remetenteId"),
        "texto": texto if texto is not None else "",
        "tipo": tipo,
        "arquivoUrl": mensagem.get("arquivoUrl"),
        "arquivoMime": mensagem.get("arquivoMime"),
        "duracaoAudio": mensagem.get("duracaoAudio"),
        "nomeArquivo": mensagem.get("nomeArquivo"),
        "horario": mensagem.get("horario") or datetime.now(BRAZIL_TZ).strftime("%H:%M"),
        "timestamp": timestamp_normalizado,
        "status": status,
        "reacoes": _normalize_reactions(mensagem.get("reacoes") or mensagem.get("reactions")),
        "citada": mensagem.get("citada") if isinstance(mensagem.get("citada"), dict) else None,
        "midiaMeta": mensagem.get("midiaMeta") if isinstance(mensagem.get("midiaMeta"), dict) else None,
        "editada": bool(mensagem.get("editada", False)),
        "editadoEm": mensagem.get("editadoEm"),
        "encaminhada": bool(mensagem.get("encaminhada", False)),
        "visualizacaoUnica": bool(mensagem.get("visualizacaoUnica") or mensagem.get("viewOnce") or mensagem.get("view_once")),
        "canal": channel,
        "channel": channel,
    }


def new_conversation(
    conversa_id: str,
    contato: Optional[str] = None,
    channel: ChatChannel = "whatsapp",
    *,
    is_group: Optional[bool] = None,
    photo_url: Optional[str] = None,
    participantes: Optional[List[Dict[str, Any]]] = None,
    descricao_grupo: str = "",
) -> Dict[str, Any]:
    return normalize_conversation(
        conversa_id,
        {
            "id": conversa_id,
            "contato": contato or conversa_id,
            "canal": channel,
            "channel": channel,
            "ultimoTexto": "",
            "horario": "",
            "timestampUltimaMsg": 0,
            "lida": True,
            "naoLidasCount": 0,
            "fixada": False,
            "favorita": False,
            "silenciada": False,
            "arquivada": False,
            "esGrupo": _looks_like_group(conversa_id) if is_group is None else is_group,
            "mensagens": [],
            "metadados": {
                "numeroCompleto": conversa_id,
                "statusOnline": True,
                "photoUrl": photo_url,
                "participantes": participantes or [],
                "descricaoGrupo": descricao_grupo,
            },
        },
    )


async def append_message(conversa_id: str, mensagem: Dict[str, Any], *, contato: Optional[str] = None, channel: ChatChannel = "whatsapp", user_id: str | None = None) -> Dict[str, Any]:
    db = await load_conversations(user_id)
    conversa = db.get(conversa_id) or new_conversation(conversa_id, contato=contato, channel=channel)
    normalized_message = normalize_message(mensagem, _normalize_channel(conversa.get("canal") or channel))
    conversa["mensagens"].append(normalized_message)
    conversa["ultimoTexto"] = normalized_message.get("texto") or _label_for_message(normalized_message)
    conversa["horario"] = normalized_message.get("horario")
    conversa["timestampUltimaMsg"] = normalized_message.get("timestamp")
    conversa["ultimaMensagemMinha"] = normalized_message.get("remetente") == "usuario"
    conversa["statusUltimaMensagem"] = normalized_message.get("status") if conversa["ultimaMensagemMinha"] else None
    conversa["ultimoRemetenteNome"] = normalized_message.get("remetenteNome") if not conversa["ultimaMensagemMinha"] else None
    db[conversa_id] = normalize_conversation(conversa_id, conversa)
    await save_conversations(db, user_id)
    return db[conversa_id]


async def append_outgoing_message(
    conversa_id: str,
    texto: str,
    *,
    channel: ChatChannel = "whatsapp",
    sender_label: Optional[str] = None,
    status: Literal["enviado", "entregue", "lido"] = "enviado",
    message_id: Optional[str] = None,
    citada: Optional[Dict[str, Any]] = None,
    user_id: str | None = None,
) -> Dict[str, Any]:
    hora, timestamp = _now_payload()
    prefix = f"[{sender_label}]: " if sender_label else ""
    return await append_message(
        conversa_id,
        {
            "id": message_id or f"out_{timestamp}",
            "remetente": "usuario",
            "texto": f"{prefix}{texto}",
            "tipo": "texto",
            "horario": hora,
            "timestamp": timestamp,
            "status": status,
            "citada": citada,
            "canal": channel,
            "channel": channel,
        },
        channel=channel,
        user_id=user_id,
    )


async def delete_message(conversa_id: str, mensagem_id: str, user_id: str | None = None) -> bool:
    db = await load_conversations(user_id)
    conversa = db.get(conversa_id)
    if not conversa:
        return False

    mensagens = conversa.get("mensagens", [])
    filtradas = [mensagem for mensagem in mensagens if mensagem.get("id") != mensagem_id]
    if len(filtradas) == len(mensagens):
        return False

    conversa["mensagens"] = filtradas
    if filtradas:
        ultima = filtradas[-1]
        conversa["ultimoTexto"] = ultima.get("texto") or _label_for_message(ultima)
        conversa["horario"] = ultima.get("horario") or conversa.get("horario")
        conversa["timestampUltimaMsg"] = ultima.get("timestamp") or conversa.get("timestampUltimaMsg", 0)
    else:
        conversa["ultimoTexto"] = "Nenhuma mensagem"
        conversa["naoLidasCount"] = 0
    db[conversa_id] = normalize_conversation(conversa_id, conversa)
    await save_conversations(db, user_id)
    return True


async def delete_conversation(conversa_id: str, user_id: str | None = None) -> bool:
    db = await load_conversations(user_id)
    if conversa_id not in db:
        return False
    del db[conversa_id]
    await save_conversations(db, user_id)
    return True


async def modify_conversation(conversa_id: str, field: str, value: Any, user_id: str | None = None) -> bool:
    db = await load_conversations(user_id)
    conversa = db.get(conversa_id)
    if not conversa:
        return False

    if field == "lida" and value is True:
        conversa["naoLidasCount"] = 0

    conversa[field] = value
    db[conversa_id] = normalize_conversation(conversa_id, conversa)
    await save_conversations(db, user_id)
    return True


async def build_conversation_history(conversa_id: str, limit: int = 25, user_id: str | None = None) -> str:
    if is_evolution():
        from app.modules.chat import router as chat
        from app.modules.chat import message_state
        db = await chat.load_conversations(user_id)
        state = await asyncio.to_thread(message_state.snapshot, chat, user_id)
    else:
        db = await load_conversations(user_id)
        state = None
    conversa = db.get(conversa_id)
    mensagens = conversa.get("mensagens", []) if conversa else []
    if state is not None:
        mensagens = message_state.apply(state, str((conversa or {}).get("id") or conversa_id), mensagens)
    mensagens = [row for row in mensagens if not row.get("visualizacaoUnica")]
    if not conversa or not mensagens:
        return EMPTY_HISTORY_MARKER

    linhas = []
    for mensagem in mensagens[-min(limit, 12):]:
        if mensagem.get("remetente") == "usuario":
            remetente = "Voce (Atendente)"
        else:
            remetente = mensagem.get("remetenteNome") or conversa.get("contato") or "Contato"
        texto = str(mensagem.get("texto") or _label_for_message(mensagem))[:600]
        canal = mensagem.get("channel") or mensagem.get("canal") or conversa.get("canal") or "whatsapp"
        linhas.append(f"[{mensagem.get('horario', '--:--')}] [{canal}] {remetente}: {texto}")

    return "\n".join(linhas) if linhas else EMPTY_HISTORY_MARKER


def is_empty_history(history: str) -> bool:
    return not history.strip() or EMPTY_HISTORY_MARKER in history


def _normalize_channel(value: Any) -> ChatChannel:
    return "whatsapp"


def _looks_like_group(conversa_id: str) -> bool:
    lowered = conversa_id.lower()
    return "@g.us" in lowered or lowered.endswith("-group")


def _normalize_participants(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []

    participants = []
    for item in value:
        if not isinstance(item, dict):
            continue
        phone = item.get("phone") or item.get("id") or item.get("jid")
        if not phone:
            continue
        raw_admin = item.get("admin")
        if isinstance(raw_admin, bool):
            admin_role = "admin" if raw_admin else None
        else:
            admin_role = str(raw_admin or "").strip().lower() or None
        participants.append(
            {
                "id": str(item.get("id") or phone),
                "phone": str(phone),
                "name": item.get("name") or item.get("pushname") or item.get("shortName"),
                "photoUrl": item.get("photoUrl") or item.get("pic"),
                "admin": admin_role,
                "isAdmin": bool(item.get("isAdmin") or admin_role in {"admin", "superadmin", "owner"}),
                "isSuperAdmin": bool(
                    item.get("isSuperAdmin")
                    or item.get("superAdmin")
                    or admin_role in {"superadmin", "owner"}
                ),
            }
        )
    return participants


def _normalize_reactions(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    reactions: List[Dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        emoji = str(item.get("emoji") or item.get("aggregateEmoji") or "").strip()
        if not emoji:
            continue
        senders = item.get("senders") if isinstance(item.get("senders"), list) else []
        reactions.append(
            {
                "emoji": emoji[:16],
                "count": max(1, int(item.get("count") or len(senders) or 1)),
                "fromMe": bool(item.get("fromMe") or item.get("hasReactionByMe")),
                "senders": [str(sender) for sender in senders if sender],
            }
        )
    return reactions


def _last_text(mensagens: List[Dict[str, Any]]) -> str:
    if not mensagens:
        return ""
    return mensagens[-1].get("texto") or _label_for_message(mensagens[-1])


def _last_timestamp(mensagens: List[Dict[str, Any]]) -> int:
    if not mensagens:
        return 0
    return int(mensagens[-1].get("timestamp") or datetime.now(BRAZIL_TZ).timestamp())


def _label_for_message(mensagem: Dict[str, Any]) -> str:
    tipo = mensagem.get("tipo")
    if tipo == "audio":
        return "[Audio]"
    if tipo == "documento":
        return "[Documento]"
    if tipo == "sticker":
        return "[Figurinha]"
    if tipo == "midia":
        mime = mensagem.get("arquivoMime") or ""
        return "[Video]" if str(mime).startswith("video/") else "[Imagem]"
    return "Mensagem"
