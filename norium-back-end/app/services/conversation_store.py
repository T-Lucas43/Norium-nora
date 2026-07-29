from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from app.core.tenant import get_user_db_path

ChatChannel = Literal["whatsapp", "telegram"]

BACKEND_ROOT = Path(__file__).resolve().parents[2]
JSON_FILE = BACKEND_ROOT / "conversas_db.json"

EMPTY_HISTORY_MARKER = "[Nenhuma mensagem recente registrada no sistema ainda]"


def _now_payload() -> tuple[str, int]:
    agora = datetime.now()
    return agora.strftime("%H:%M"), int(agora.timestamp())


def _json_file_for_user(user_id: str) -> Path:
    return Path(get_user_db_path(user_id, "conversas"))


def _read_json_sync(user_id: str = "lucas123") -> Dict[str, Any]:
    json_file = _json_file_for_user(user_id)
    if not json_file.exists() and user_id == "lucas123" and JSON_FILE.exists():
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


def _write_json_sync(data: Dict[str, Any], user_id: str = "lucas123") -> None:
    json_file = _json_file_for_user(user_id)
    json_file.parent.mkdir(parents=True, exist_ok=True)
    with json_file.open("w", encoding="utf-8") as arquivo:
        json.dump(data, arquivo, ensure_ascii=False, indent=4)


async def load_conversations(user_id: str = "lucas123") -> Dict[str, Any]:
    data = await asyncio.to_thread(_read_json_sync, user_id)
    return normalize_database(data)


async def save_conversations(data: Dict[str, Any], user_id: str = "lucas123") -> None:
    normalized = normalize_database(data)
    await asyncio.to_thread(_write_json_sync, normalized, user_id)


def normalize_database(data: Dict[str, Any]) -> Dict[str, Any]:
    normalized: Dict[str, Any] = {}
    for conversa_id, conversa in data.items():
        if isinstance(conversa, dict):
            normalized[conversa_id] = normalize_conversation(conversa_id, conversa)
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
        "statusOnline": bool(metadados.get("statusOnline", False)),
        "photoUrl": photo_url,
        "participantes": _normalize_participants(metadados.get("participantes")),
        "descricaoGrupo": metadados.get("descricaoGrupo") or "",
        "criadoPor": metadados.get("criadoPor"),
    }

    mensagens_raw = conversa.get("mensagens")
    mensagens = [
        normalize_message(mensagem, channel)
        for mensagem in mensagens_raw
        if isinstance(mensagem, dict)
    ] if isinstance(mensagens_raw, list) else []

    normalized = {
        "id": conversa.get("id") or conversa_id,
        "contato": contato,
        "canal": channel,
        "channel": channel,
        "ultimoTexto": conversa.get("ultimoTexto") or _last_text(mensagens),
        "horario": conversa.get("horario") or (mensagens[-1]["horario"] if mensagens else ""),
        "timestampUltimaMsg": int(conversa.get("timestampUltimaMsg") or _last_timestamp(mensagens)),
        "lida": bool(conversa.get("lida", True)),
        "naoLidasCount": int(conversa.get("naoLidasCount") or 0),
        "fixada": bool(conversa.get("fixada", False)),
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
    if status not in {"enviado", "entregue", "lido", None}:
        status = None

    timestamp = mensagem.get("timestamp")
    try:
        timestamp_normalizado = int(timestamp) if timestamp is not None else int(datetime.now().timestamp())
    except (TypeError, ValueError):
        timestamp_normalizado = int(datetime.now().timestamp())

    return {
        "id": str(mensagem.get("id") or f"msg_{timestamp_normalizado}"),
        "remetente": "usuario" if mensagem.get("remetente") == "usuario" else "contato",
        "remetenteNome": mensagem.get("remetenteNome"),
        "texto": texto if texto is not None else "",
        "tipo": tipo,
        "arquivoUrl": mensagem.get("arquivoUrl"),
        "arquivoMime": mensagem.get("arquivoMime"),
        "duracaoAudio": mensagem.get("duracaoAudio"),
        "nomeArquivo": mensagem.get("nomeArquivo"),
        "horario": mensagem.get("horario") or datetime.now().strftime("%H:%M"),
        "timestamp": timestamp_normalizado,
        "status": status,
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
    hora, timestamp = _now_payload()
    return normalize_conversation(
        conversa_id,
        {
            "id": conversa_id,
            "contato": contato or conversa_id,
            "canal": channel,
            "channel": channel,
            "ultimoTexto": "Sincronizado",
            "horario": hora,
            "timestampUltimaMsg": timestamp,
            "lida": True,
            "naoLidasCount": 0,
            "fixada": False,
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


async def append_message(conversa_id: str, mensagem: Dict[str, Any], *, contato: Optional[str] = None, channel: ChatChannel = "whatsapp", user_id: str = "lucas123") -> Dict[str, Any]:
    db = await load_conversations(user_id)
    conversa = db.get(conversa_id) or new_conversation(conversa_id, contato=contato, channel=channel)
    normalized_message = normalize_message(mensagem, _normalize_channel(conversa.get("canal") or channel))
    conversa["mensagens"].append(normalized_message)
    conversa["ultimoTexto"] = normalized_message.get("texto") or _label_for_message(normalized_message)
    conversa["horario"] = normalized_message.get("horario")
    conversa["timestampUltimaMsg"] = normalized_message.get("timestamp")
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
    user_id: str = "lucas123",
) -> Dict[str, Any]:
    hora, timestamp = _now_payload()
    prefix = f"[{sender_label}]: " if sender_label else ""
    return await append_message(
        conversa_id,
        {
            "id": f"out_{timestamp}",
            "remetente": "usuario",
            "texto": f"{prefix}{texto}",
            "tipo": "texto",
            "horario": hora,
            "timestamp": timestamp,
            "status": status,
            "canal": channel,
            "channel": channel,
        },
        channel=channel,
        user_id=user_id,
    )


async def delete_message(conversa_id: str, mensagem_id: str, user_id: str = "lucas123") -> bool:
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


async def delete_conversation(conversa_id: str, user_id: str = "lucas123") -> bool:
    db = await load_conversations(user_id)
    if conversa_id not in db:
        return False
    del db[conversa_id]
    await save_conversations(db, user_id)
    return True


async def modify_conversation(conversa_id: str, field: str, value: Any, user_id: str = "lucas123") -> bool:
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


async def build_conversation_history(conversa_id: str, limit: int = 25, user_id: str = "lucas123") -> str:
    db = await load_conversations(user_id)
    conversa = db.get(conversa_id)
    mensagens = conversa.get("mensagens", []) if conversa else []
    if not conversa or not mensagens:
        return EMPTY_HISTORY_MARKER

    linhas = []
    for mensagem in mensagens[-limit:]:
        if mensagem.get("remetente") == "usuario":
            remetente = "Voce (Atendente)"
        else:
            remetente = mensagem.get("remetenteNome") or conversa.get("contato") or "Contato"
        texto = mensagem.get("texto") or _label_for_message(mensagem)
        canal = mensagem.get("channel") or mensagem.get("canal") or conversa.get("canal") or "whatsapp"
        linhas.append(f"[{mensagem.get('horario', '--:--')}] [{canal}] {remetente}: {texto}")

    return "\n".join(linhas) if linhas else EMPTY_HISTORY_MARKER


def is_empty_history(history: str) -> bool:
    return not history.strip() or EMPTY_HISTORY_MARKER in history


def _normalize_channel(value: Any) -> ChatChannel:
    return "telegram" if value == "telegram" else "whatsapp"


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
        participants.append(
            {
                "id": str(item.get("id") or phone),
                "phone": str(phone),
                "name": item.get("name") or item.get("pushname") or item.get("shortName"),
                "isAdmin": bool(item.get("isAdmin") or item.get("admin")),
                "isSuperAdmin": bool(item.get("isSuperAdmin") or item.get("superAdmin")),
            }
        )
    return participants


def _last_text(mensagens: List[Dict[str, Any]]) -> str:
    if not mensagens:
        return "Nenhuma mensagem"
    return mensagens[-1].get("texto") or _label_for_message(mensagens[-1])


def _last_timestamp(mensagens: List[Dict[str, Any]]) -> int:
    if not mensagens:
        return int(datetime.now().timestamp())
    return int(mensagens[-1].get("timestamp") or datetime.now().timestamp())


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
