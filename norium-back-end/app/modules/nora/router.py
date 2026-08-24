"""Dominio da Nora extraido para separar orquestracao e agentes especializados."""

from __future__ import annotations

import asyncio
import time
import uuid
import json
import logging
import os
import re
import unicodedata
import base64
import binascii
from typing import Any, Literal, List

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import Field

from app.shared.schemas import StrictModel

from app.routers.agenda_router import agenda_agent
from app.routers.automacoes_router import handle_automation_agent
from app.routers.auth_router import current_user, effective_permissions
from app.routers.financeiro_router import handle_finance_agent
from app.routers.tarefas_router import handle_task_agent
from app.routers.team_chat_router import append_team_message_for_user
from app.services.agent_manager import AgentManager
from app.services.conversation_store import (
    EMPTY_HISTORY_MARKER,
    append_outgoing_message,
    build_conversation_history,
    is_empty_history,
    whatsapp_conversation_mutation_lock,
)

from app.services.email_agent import EmailAgent
from app.services.nora import NoraIAService
from app.services.nora_module_help import answer_module_help
from app.services.nora_skills import (
    SkillResolution,
    resolve_skill,
    semantic_routing_prompt,
    skill_catalog_payload,
)
from app.modules.operations.schemas import ApprovalCreate, NoraMemoryCreate
from app.modules.commercial.nora_agent import cancel_commercial_session, handle_commercial_agent
from app.modules.operations.service import (
    create_approval,
    get_operation_settings,
    list_nora_memory,
    save_nora_memory,
)
from app.modules.platform.service import conflict_scan, generate_handoff, quality_scan, query_knowledge
from app.services.task_store import list_tasks
from app.services.wapi_messaging import WapiMessagingService, MessagingUnavailable, WapiError
from app.services import wapi_binding as wb
from app.services.nora_whatsapp_action import (
    is_whatsapp_send_request,
    prepare_whatsapp_action,
    resolve_whatsapp_recipient,
)
from app.services.brainstorm_store import create_brainstorm_session, list_brainstorm_sessions
from app.modules.nora.orchestrator import build_compound_plan, is_compound_request

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/nora", tags=["Nora IA"])
nora_service = NoraIAService()
wapi_messaging = WapiMessagingService()
agent_manager = AgentManager()
email_agent = EmailAgent()
ELEVENLABS_DEFAULT_VOICE_ID = "KHmfNHtEjHhLK9eER20w"
ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
EDGE_TTS_DEFAULT_VOICE = "pt-BR-ThalitaMultilingualNeural"


class MessageItem(StrictModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(min_length=1)


class ConversaPayload(StrictModel):
    messages: List[MessageItem]


class NoraNaturalPayload(StrictModel):
    message: str = Field(min_length=1, max_length=4000)
    messages: List[MessageItem] = Field(default_factory=list)
    user_id: str = "lucas123"
    agenda_session_id: str | None = None
    email_session_id: str | None = None
    commercial_session_id: str | None = None
    screen_context: str | None = Field(default=None, max_length=500)


class NoraVoicePayload(StrictModel):
    text: str = Field(min_length=1, max_length=1800)
    voice_id: str | None = Field(default=None, max_length=120)


class NoraTranscriptionPayload(StrictModel):
    audio_data_url: str = Field(min_length=32, max_length=21_000_000)
    mime_type: str = Field(default="audio/webm", max_length=100)


class NoraTelemetryPayload(StrictModel):
    response_id: str = Field(min_length=8, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    event: Literal[
        "first_visible_token",
        "first_audio",
        "playback_started",
        "completed",
        "cancelled",
    ]
    elapsed_ms: float = Field(ge=0, le=600_000)
    channel: Literal["text", "voice", "stream"] = "stream"


def sensitive_action_request(text: str, selected_skill: str) -> dict[str, str] | None:
    """Return an approval plan only for explicit, consequential execution requests."""
    normalized = normalizar_intencao(text)
    has_email = bool(re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text))
    rules: list[tuple[str, bool, str, str]] = [
        (
            "email",
            selected_skill == "email"
            and has_email
            and bool(re.search(r"\b(?:envie|enviar|mande|mandar|dispare|disparar)\b", normalized)),
            "Enviar e-mail pela Nora",
            "A Nora vai validar destinatario e conteudo, enviar pelo Gmail conectado e registrar um comprovante.",
        ),
        (
            "financeiro",
            selected_skill == "financeiro"
            and bool(re.search(r"\b(?:gastei|paguei|comprei|lancar|lance|registrar|registre)\b", normalized))
            and bool(re.search(r"(?:r\$\s*)?\d+(?:[.,]\d{1,2})?", normalized)),
            "Registrar lancamento financeiro",
            "A Nora vai validar valor e natureza do lancamento, gravar no financeiro e emitir um comprovante.",
        ),
        (
            "tarefas",
            selected_skill == "tarefas"
            and bool(re.search(r"\b(?:excluir|exclua|apagar|apague|remover|remova)\b", normalized))
            and bool(re.search(r"\b(?:tarefa|card)\b", normalized)),
            "Excluir tarefa",
            "A Nora vai localizar a tarefa informada, executar a exclusao e registrar o resultado na auditoria.",
        ),
        (
            "agenda",
            selected_skill == "agenda"
            and bool(re.search(r"\b(?:reagendar|remarcar|editar|alterar|cancelar|excluir|apagar)\b", normalized))
            and bool(re.search(r"\b(?:evento|agenda|reuniao|compromisso)\b", normalized)),
            "Alterar compromisso da agenda",
            "A Nora vai localizar o compromisso, aplicar a alteracao no Google Agenda e registrar o resultado.",
        ),
        (
            "automacoes",
            selected_skill == "automacoes"
            and bool(re.search(r"\b(?:executar|execute|rode|rodar|disparar|dispare)\b", normalized))
            and "automacao" in normalized,
            "Executar automacao",
            "A Nora vai localizar o fluxo, executar as acoes configuradas e registrar cada resultado.",
        ),
    ]
    for source, matched, title, description in rules:
        if matched:
            return {"source": source, "title": title, "description": description}
    return None


async def request_sensitive_approval(
    user: dict[str, Any],
    message: str,
    selected_skill: str,
    session_id: str | None,
    resolution: SkillResolution,
) -> dict[str, Any] | None:
    settings = await get_operation_settings(user)
    autonomy = str(settings.get("autonomy") or "balanced")
    request = sensitive_action_request(message, selected_skill)
    normalized = normalizar_intencao(message)
    execution_requested = bool(
        re.search(
            r"\b(?:crie|criar|adicione|adicionar|registre|registrar|envie|enviar|mande|mandar|"
            r"edite|editar|altere|alterar|mova|mover|conclua|concluir|execute|executar|"
            r"agende|agendar|marque|marcar|publique|publicar)\b",
            normalized,
        )
    )
    if request is None and autonomy == "confirm_all" and selected_skill != "geral" and execution_requested:
        skill_name = selected_skill.replace("_", " ").capitalize()
        request = {
            "source": selected_skill,
            "title": f"Executar acao de {skill_name}",
            "description": (
                "A Nora identificou uma solicitacao de execucao. "
                "Como o modo Confirmar todas as acoes esta ativo, ela aguardara sua aprovacao."
            ),
        }
    if request is None:
        return None
    approval = await create_approval(
        user,
        ApprovalCreate(
            title=request["title"],
            description=f'{request["description"]} Pedido original: {message}',
            action=f'nora_{request["source"]}_execute',
            source=request["source"],
            payload={"originalMessage": message, "sessionId": session_id, "skill": selected_skill},
            metadata={
                "requestedBy": "nora",
                "requiresExplicitDecision": True,
                "autonomy": autonomy,
            },
        ),
    )
    return resposta_agente(
        selected_skill,
        {
            "status": "aguardando_aprovacao",
            "response": (
                f'Preparei o plano para "{request["title"]}". '
                "A acao ainda nao foi executada. Revise, edite ou aprove na Central de aprovacoes."
            ),
            "approval": approval,
        },
        resolution=resolution,
    )


async def request_whatsapp_approval(
    user: dict[str, Any],
    message: str,
    resolution: SkillResolution,
) -> dict[str, Any]:
    """Prepara um envio exato e o submete a decisao humana; nunca envia aqui."""

    permissions = effective_permissions(user)
    if not permissions.get("chat") or not permissions.get("integracao_whatsapp"):
        return resposta_agente(
            "whatsapp",
            {
                "status": "sem_permissao",
                "response": "Sua conta nao tem permissao para enviar mensagens pelo WhatsApp.",
            },
            resolution=resolution,
        )

    resolved_user_id = tenant_id(user)
    binding = wb.get_binding(resolved_user_id)
    if not binding.exists or str(getattr(binding, "state", "")) != "connected":
        return resposta_agente(
            "whatsapp",
            {
                "status": "whatsapp_desconectado",
                "response": "Conecte o WhatsApp desta conta antes de pedir um envio pela Nora.",
            },
            resolution=resolution,
        )

    prepared = await prepare_whatsapp_action(resolved_user_id, message)
    if prepared.get("status") != "pronto_para_aprovacao":
        return resposta_agente("whatsapp", prepared, resolution=resolution)

    action = prepared.get("action") if isinstance(prepared.get("action"), dict) else {}
    conversation_id = str(action.get("conversationId") or "").strip()
    recipient_name = str(action.get("recipientName") or "").strip()
    message_text = str(action.get("messageText") or "").strip()
    if not conversation_id or not recipient_name or not message_text:
        return resposta_agente(
            "whatsapp",
            {
                "status": "validacao_falhou",
                "response": "Nao consegui validar destinatario e texto. Nada foi enviado.",
            },
            resolution=resolution,
        )

    approval = await create_approval(
        user,
        ApprovalCreate(
            title=f"Enviar mensagem no WhatsApp para {recipient_name}"[:180],
            # A Central já mostra o destinatário no título. A descrição é o
            # campo editável que representa exatamente o texto a enviar.
            description=message_text,
            action="nora_whatsapp_execute",
            source="whatsapp",
            payload={
                "originalMessage": message,
                "conversationId": conversation_id,
                "recipientName": recipient_name,
                "messageText": message_text,
                "isGroup": bool(action.get("isGroup")),
                "instanceId": str(getattr(binding, "instance_id", "")),
            },
            metadata={
                "requestedBy": "nora",
                "requiresExplicitDecision": True,
                "channel": "whatsapp",
            },
        ),
    )
    return resposta_agente(
        "whatsapp",
        {
            "status": "aguardando_aprovacao",
            "response": (
                f"Preparei a mensagem para {recipient_name}:\n\n{message_text}\n\n"
                "Nada foi enviado ainda. Revise e aprove ou rejeite na Central de aprovacoes."
            ),
            "approval": approval,
            "preview": {
                "conversationId": conversation_id,
                "recipientName": recipient_name,
                "messageText": message_text,
                "isGroup": bool(action.get("isGroup")),
            },
        },
        resolution=resolution,
    )


def memory_preference_request(text: str) -> dict[str, str] | None:
    normalized = normalizar_intencao(text)
    markers = ("lembre que", "lembre-se que", "eu prefiro", "prefiro que", "minha preferencia", "a partir de agora")
    if not any(marker in normalized for marker in markers):
        return None
    if "sempre que" in normalized and any(term in normalized for term in ("email", "tarefa", "agenda", "whatsapp", "automacao")):
        return None
    category = "communication" if any(term in normalized for term in ("email", "resposta", "tom", "formal", "mensagem")) else "process"
    scope = "team" if any(term in normalized for term in ("para a equipe", "para o time", "nossa equipe", "nosso time")) else "personal"
    concise_key = re.sub(r"\s+", " ", text).strip(" .")[:100]
    return {"key": concise_key, "value": text.strip(), "category": category, "scope": scope}


async def message_with_memory(user: dict[str, Any], text: str, categories: set[str]) -> str:
    memories = await list_nora_memory(user)
    selected = [item for item in memories if str(item.get("category")) in categories][:6]
    if not selected:
        return text
    preferences = "\n".join(f'- {item.get("value")}' for item in selected)
    return f"{text}\n\nPreferencias confirmadas pelo usuario, aplique sem inventar dados:\n{preferences}"


class NoraWhatsAppPayload(StrictModel):
    conversa_id: str = Field(min_length=1)
    texto_usuario: str = Field(min_length=1)
    enviar_direto_whatsapp: bool = False


class AgentDraftPayload(StrictModel):
    conversa_id: str = Field(min_length=1)
    instrucao: str | None = None
    tom_atendente: str | None = None


class AgentExecutePayload(StrictModel):
    conversa_id: str = Field(min_length=1)
    texto: str = Field(min_length=1)
    canal: Literal["whatsapp"] = "whatsapp"
    autorizado: bool = False


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def require_nora_permission(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    permissions = user.get("permissions") if isinstance(user.get("permissions"), dict) else {}
    if user.get("systemAdmin") or permissions.get("nora"):
        return user
    raise HTTPException(status_code=403, detail="A Nora nao esta liberada para esta conta.")


async def buscar_historico_whats(conversa_id: str, user_id: str = "lucas123") -> str:
    return await build_conversation_history(conversa_id, limit=12, user_id=user_id)


def parece_ordem_de_envio(texto: str) -> bool:
    normalizado = texto.lower()
    return any(verbo in normalizado for verbo in ("mande", "manda", "envie", "enviar", "responda", "responder"))


def limpar_texto_para_envio(texto: str) -> str:
    return texto.replace("**", "").replace("`", "").replace('"', "").strip()


def fallback_texto_de_envio(comando: str, conversa_id: str) -> str:
    texto = comando.strip()
    candidatos = [
        r"mensagem\s+de\s+(.+)",
        r"mensagem\s+dizendo\s+(.+)",
        r"dizendo\s+(.+)",
        r"fala\s+(.+)",
        r"responda\s+(.+)",
    ]
    extraido = ""
    for pattern in candidatos:
        match = re.search(pattern, texto, flags=re.IGNORECASE)
        if match:
            extraido = match.group(1)
            break

    conteudo = extraido or texto
    conteudo = re.split(r"\s+para\s+(?:o|a|os|as)?\s*(?:grupo|contato|cliente|pessoa)?", conteudo, maxsplit=1, flags=re.IGNORECASE)[0]
    conteudo = conteudo.strip(" .,!?:;")

    if conteudo.lower() == "boa tarde":
        return "Boa tarde, pessoal!" if conversa_id.endswith("-group") or "@g.us" in conversa_id else "Boa tarde!"
    if conteudo.lower() == "bom dia":
        return "Bom dia, pessoal!" if conversa_id.endswith("-group") or "@g.us" in conversa_id else "Bom dia!"
    if conteudo.lower() == "boa noite":
        return "Boa noite, pessoal!" if conversa_id.endswith("-group") or "@g.us" in conversa_id else "Boa noite!"

    return conteudo[:900] if conteudo else ""


def normalizar_intencao(texto: str) -> str:
    lowered = texto.lower().strip()
    return "".join(char for char in unicodedata.normalize("NFKD", lowered) if not unicodedata.combining(char))


def interrompe_sessao_ativa(texto: str) -> bool:
    """Detecta conversa geral que nao pode ser consumida como dado de um formulario ativo."""
    if mensagem_social_curta(texto):
        return True
    normalized = normalizar_intencao(texto)
    compact = re.sub(r"[^\w\s]", " ", normalized)
    compact = re.sub(r"\s+", " ", compact).strip()
    greetings = {
        "oi",
        "ola",
        "opa",
        "e ai",
        "bom dia",
        "boa tarde",
        "boa noite",
        "oi nora",
        "ola nora",
        "bom dia nora",
        "boa tarde nora",
        "boa noite nora",
        "tudo bem",
        "como voce esta",
    }
    if compact in greetings:
        return True
    return bool(
        re.search(
            r"\b(?:mudei\s+de\s+assunto|vamos\s+falar\s+de\s+outra\s+coisa|"
            r"outro\s+assunto|esqueca\s+isso|deixa\s+isso\s+pra\s+la|"
            r"recomece\s+do\s+zero|nova\s+conversa)\b",
            compact,
        )
    )


def mensagem_social_curta(texto: str) -> str | None:
    """Retorna a saudacao reconhecida sem deixar o classificador semantico acionar um agente."""
    compact = re.sub(r"[^\w\s]", " ", normalizar_intencao(texto))
    compact = re.sub(r"\s+", " ", compact).strip()
    match = re.fullmatch(
        r"(?:(?:eu\s+)?(?:so\s+)?(?:te\s+)?(?:dei|disse|falei)\s+)?"
        r"(bom\s+dia|boa\s+tarde|boa\s+noite|oi|ola|ol|opa|e\s+ai)"
        r"(?:\s+nora)?",
        compact,
    )
    return match.group(1) if match else None


def resposta_social_curta(saudacao: str, user: dict[str, Any]) -> str:
    first_name = str(user.get("nome") or "").strip().split(" ")[0]
    vocative = f", {first_name}" if first_name else ""
    if saudacao == "bom dia":
        return f"Bom dia{vocative}! Estou pronta. O que voce quer resolver primeiro?"
    if saudacao == "boa tarde":
        return f"Boa tarde{vocative}! Estou por aqui. Como posso ajudar?"
    if saudacao == "boa noite":
        return f"Boa noite{vocative}! Pode falar comigo normalmente. O que precisamos organizar?"
    return f"Oi{vocative}! Estou ouvindo. Pode me pedir algo em linguagem natural."


def contem_algum(texto: str, termos: list[str]) -> bool:
    return any(termo in texto for termo in termos)


def parece_valor_monetario(texto: str) -> bool:
    return bool(re.search(r"(?:r\$\s*)?\b\d+(?:[.,]\d{1,2})?\s*(?:reais|real)?\b", texto, flags=re.I))


def detectar_intencao_natural(texto: str) -> str:
    normalizado = normalizar_intencao(texto)
    equipe = [
        "chat da equipe",
        "cht da equipe",
        "chat interno",
        "mensagem interna",
        "mensagem no time",
        "mensagem para o time",
        "avisar o time",
        "avise o time",
        "avisar a equipe",
        "avise a equipe",
        "mandar mensagem no time",
        "mande uma mensagem no chat",
    ]
    if contem_algum(normalizado, equipe) or (
        "equipe" in normalizado and contem_algum(normalizado, ["mensagem", "avise", "avisar", "mande", "mandar", "enviar"])
    ):
        return "equipe"

    automacoes = [
        "automacao",
        "automacoes",
        "automatizar",
        "fluxo",
        "workflow",
        "gatilho",
        "executar automacao",
        "rodar automacao",
        "desativar automacao",
        "ativar automacao",
    ]
    if contem_algum(normalizado, automacoes):
        return "automacoes"

    financeiro = [
        "financeiro",
        "financas",
        "gasto",
        "gastei",
        "despesa",
        "lancamento",
        "lancar",
        "paguei",
        "pagar",
        "pago",
        "recebi",
        "receita",
        "entrada",
        "saida",
        "boleto",
        "boletos",
        "cpf",
        "pix",
        "cartao",
        "dinheiro",
        "comprei",
        "comprando",
        "compra",
        "mercado",
        "comida",
        "almoco",
        "jantar",
        "lanche",
        "restaurante",
        "nota fiscal",
        "comprovante",
    ]
    if contem_algum(normalizado, financeiro) or (
        parece_valor_monetario(normalizado)
        and contem_algum(normalizado, ["pix", "cartao", "dinheiro", "comprei", "paguei", "gastei", "mercado", "comida"])
    ):
        return "financeiro"

    email = [
        "gmail",
        "email",
        "e-mail",
        "caixa de entrada",
        "nao lido",
        "rascunho",
        "destinatario",
        "assunto",
        "enviar email",
        "mande email",
        "mandar email",
        "envie email",
        "redigir",
    ]
    if re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", texto) or contem_algum(normalizado, email):
        return "email"

    tarefas = [
        "tarefa",
        "tarefas",
        "kanban",
        "projeto",
        "lista de tarefas",
        "pendente",
        "concluir",
        "finalizar",
        "prioridade",
        "vencimento",
        "me lembre de",
        "me lembra de",
        "preciso fazer",
        "anotar para fazer",
    ]
    if contem_algum(normalizado, tarefas):
        return "tarefas"

    agenda = [
        "agenda",
        "agendar",
        "calendario",
        "calendario",
        "compromisso",
        "evento",
        "eventos",
        "reuniao",
        "marcar uma call",
        "marcar call",
        "horario livre",
        "estou livre",
        "ocupado",
    ]
    if contem_algum(normalizado, agenda):
        return "agenda"

    return "chat"


async def classificar_intencao_com_nora(
    texto: str,
    resolution: SkillResolution,
    context: str = "",
) -> tuple[str, float]:
    prompt = semantic_routing_prompt(texto, resolution, context)
    resposta = await nora_service.perguntar_nora([{"role": "user", "content": prompt}])
    match = re.search(r"\{.*\}", resposta, flags=re.S)
    if not match:
        return resolution.skill_id, resolution.confidence
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return resolution.skill_id, resolution.confidence
    intent = str(data.get("intent") or "").strip().lower()
    try:
        confidence = max(0.0, min(float(data.get("confidence") or 0.0), 1.0))
    except (TypeError, ValueError):
        confidence = 0.0
    valid = {"whatsapp", "comercial", "financeiro", "tarefas", "email", "agenda", "automacoes", "brainstorm", "operacoes", "equipe", "chat"}
    return (intent, confidence) if intent in valid else (resolution.skill_id, resolution.confidence)


def routing_payload(resolution: SkillResolution | None, selected_skill: str) -> dict[str, Any]:
    if resolution is None:
        return {"selected_skill": selected_skill, "source": "active_session"}
    return {
        "selected_skill": selected_skill,
        "deterministic_skill": resolution.skill_id,
        "confidence": resolution.confidence,
        "score": resolution.score,
        "margin": resolution.margin,
        "semantic_fallback": resolution.needs_semantic_fallback,
        "signals": list(resolution.matched_signals),
    }


def resposta_agente(
    intent: str,
    result: dict[str, Any],
    session_kind: str | None = None,
    resolution: SkillResolution | None = None,
) -> dict[str, Any]:
    response_text = result.get("response") or "O agente não retornou confirmação. Nenhuma execução foi assumida como concluída."
    return {
        "intent": intent,
        "skill": intent,
        "routing": routing_payload(resolution, intent),
        "session_kind": session_kind,
        "session_id": result.get("session_id"),
        "status": result.get("status"),
        "response": response_text,
        "speech_text": texto_para_voz(str(response_text)),
        "agent_result": result,
    }


def stats_tarefas_para_equipe(user_id: str) -> str:
    data = list_tasks(user_id, status="todas")
    stats = data.get("stats", {})
    tasks = data.get("tasks", [])
    responsaveis: dict[str, int] = {}
    for task in tasks:
        name = str(task.get("assigneeName") or task.get("responsibleName") or "Sem responsavel").strip()
        responsaveis[name] = responsaveis.get(name, 0) + 1
    responsavel_linha = ", ".join(f"{name}: {count}" for name, count in sorted(responsaveis.items())[:5])
    return (
        "Status das tarefas do time:\n"
        f"- Ativas: {stats.get('ativas', 0)}\n"
        f"- Pendentes: {stats.get('pendentes', 0)}\n"
        f"- Em execucao: {stats.get('andamento', 0)}\n"
        f"- Em revisao: {stats.get('revisao', 0)}\n"
        f"- Concluidas: {stats.get('concluidas', 0)}\n"
        f"- Vencidas: {stats.get('vencidas', 0)}\n"
        f"- Responsaveis: {responsavel_linha or 'nenhum responsavel definido'}"
    )


def extrair_texto_para_equipe(texto: str) -> str:
    cleaned = re.sub(
        r"^\s*(nora[, ]*)?(mande|manda|mandar|envie|enviar|avise|avisar)\s+(uma\s+)?mensagem\s+(no|para o|para a|pro|pra)?\s*(chat\s+)?(da\s+)?(equipe|time|chat interno)?\s*",
        "",
        texto,
        flags=re.I,
    ).strip(" .,:;-")
    cleaned = re.sub(r"^(mostrando|dizendo|falando|com)\s+", "", cleaned, flags=re.I).strip(" .,:;-")
    return cleaned[:1800]


async def handle_team_agent(user_id: str, texto: str, sender_name: str = "Nora") -> dict[str, Any]:
    normalizado = normalizar_intencao(texto)
    if "tarefa" in normalizado and contem_algum(normalizado, ["status", "resumo", "situacao", "andamento", "pendente", "concluida"]):
        body = stats_tarefas_para_equipe(user_id)
    else:
        body = extrair_texto_para_equipe(texto)
    if not body:
        return {
            "session_id": None,
            "status": "precisa_mensagem",
            "response": "Qual mensagem voce quer enviar para o chat da equipe?",
        }
    message = await append_team_message_for_user(
        user_id,
        body,
        sender_id="nora",
        sender_name=sender_name or "Nora",
        sender_avatar="nora",
        metadata={"action": "nora_team_message", "source": "nora"},
    )
    return {
        "session_id": None,
        "status": "enviado",
        "response": f"Enviei no chat da equipe:\n\n{body}",
        "message": message,
    }


def texto_para_voz(texto: str) -> str:
    value = re.sub(r"```[\s\S]*?```", " Inclui um trecho de codigo na tela. ", texto)
    value = re.sub(
        r"(?:^|\n)(?:\s*\|.*\|\s*\n?){2,}",
        "\nOrganizei os detalhes em uma tabela na tela.\n",
        value,
        flags=re.M,
    )
    value = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"Imagem: \1.", value)
    value = re.sub(r"\[([^\]]+)\]\((?:https?://|mailto:)[^)]+\)", r"\1", value)
    value = re.sub(r"https?://\S+", "um link disponivel na tela", value, flags=re.I)
    value = re.sub(r"`([^`]+)`", r"\1", value)
    value = re.sub(r"^\s{0,3}#{1,6}\s+", "", value, flags=re.M)
    value = re.sub(r"^\s*(?:[-*+] |\d+[.)]\s*)", "", value, flags=re.M)
    value = re.sub(r"R\$\s*(\d+(?:[.,]\d{1,2})?)", r"\1 reais", value, flags=re.I)
    value = re.sub(r"(\d+(?:[.,]\d+)?)\s*%", r"\1 por cento", value)
    pronunciations = {
        r"\bNorium\b": "Nórium",
        r"\bOAuth\b": "ô auth",
        r"\bWebSockets?\b": "uéb sóquete",
        r"\bAPIs?\b": "A P I",
        r"\bIA\b": "I A",
        r"\bHTTP\b": "H T T P",
        r"\bJSON\b": "jêison",
    }
    for pattern, replacement in pronunciations.items():
        value = re.sub(pattern, replacement, value, flags=re.I if pattern not in {r"\bIA\b", r"\bHTTP\b", r"\bJSON\b"} else 0)
    value = re.sub(r"[`*_#>|{}\[\]<>~]+", " ", value)
    value = re.sub(r"\s*\n+\s*", ". ", value)
    value = re.sub(r"\s+([,.;:!?])", r"\1", value)
    return re.sub(r"\s+", " ", value).strip()[:1800]


async def gerar_audio_elevenlabs(texto: str, voice_id: str | None = None) -> bytes:
    load_dotenv()
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="ELEVENLABS_API_KEY nao configurada no back-end.")

    selected_voice_id = (voice_id or os.getenv("ELEVENLABS_VOICE_ID") or ELEVENLABS_DEFAULT_VOICE_ID).strip()
    model_id = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip() or "eleven_multilingual_v2"
    language_code = os.getenv("ELEVENLABS_LANGUAGE_CODE", "pt").strip()
    clean_text = texto_para_voz(texto)
    if not clean_text:
        raise HTTPException(status_code=400, detail="Texto vazio para gerar voz.")
    voice_payload: dict[str, Any] = {
        "text": clean_text,
        "model_id": model_id,
        "voice_settings": {
            "stability": 0.45,
            "similarity_boost": 0.78,
            "style": 0.25,
            "use_speaker_boost": True,
        },
    }
    if language_code and model_id != "eleven_multilingual_v2":
        voice_payload["language_code"] = language_code

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                ELEVENLABS_TTS_URL.format(voice_id=selected_voice_id),
                params={"output_format": "mp3_44100_128"},
                headers={
                    "xi-api-key": api_key,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                },
                json=voice_payload,
            )
    except httpx.HTTPError as exc:
        logger.exception("Falha ao conectar na ElevenLabs.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao conectar ao provedor de voz.") from exc

    if response.status_code == 402:
        raise HTTPException(
            status_code=402,
            detail="A ElevenLabs recusou a geracao por falta de creditos, limite ou plano ativo.",
        )
    if response.status_code >= 400:
        logger.warning("ElevenLabs recusou a geracao de voz com status %s.", response.status_code)
        raise HTTPException(status_code=response.status_code, detail="O provedor recusou a geracao de voz.")
    return response.content


def gerar_audio_edge_tts_stream(texto: str):
    clean_text = texto_para_voz(texto)
    if not clean_text:
        raise HTTPException(status_code=400, detail="Texto vazio para gerar voz.")

    try:
        import edge_tts
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="edge-tts nao esta instalado no back-end.") from exc

    voice = os.getenv("EDGE_TTS_VOICE", EDGE_TTS_DEFAULT_VOICE).strip() or EDGE_TTS_DEFAULT_VOICE
    rate = os.getenv("EDGE_TTS_RATE", "-6%").strip() or "-6%"
    pitch = os.getenv("EDGE_TTS_PITCH", "+4Hz").strip() or "+4Hz"
    volume = os.getenv("EDGE_TTS_VOLUME", "+0%").strip() or "+0%"

    async def audio_stream():
        started_at = time.perf_counter()
        first_byte_at: float | None = None
        total_bytes = 0
        try:
            communicate = edge_tts.Communicate(clean_text, voice=voice, rate=rate, pitch=pitch, volume=volume)
            async for chunk in communicate.stream():
                if chunk.get("type") != "audio" or not chunk.get("data"):
                    continue
                audio_data = chunk["data"]
                if first_byte_at is None:
                    first_byte_at = time.perf_counter()
                    logger.info(
                        "nora_tts event=first_audio_chunk provider=edge-tts elapsed_ms=%.1f",
                        (first_byte_at - started_at) * 1000,
                    )
                total_bytes += len(audio_data)
                yield audio_data
        except asyncio.CancelledError:
            logger.info("nora_tts event=stream_cancelled provider=edge-tts bytes=%s", total_bytes)
            raise
        except Exception:
            logger.exception("Falha durante o streaming da voz neural Edge.")
            raise

        if first_byte_at is None:
            raise RuntimeError("A voz neural Edge nao retornou audio.")
        logger.info(
            "nora_tts event=stream_completed provider=edge-tts total_ms=%.1f bytes=%s",
            (time.perf_counter() - started_at) * 1000,
            total_bytes,
        )

    return audio_stream()


async def gerar_texto_de_envio_whatsapp(payload: NoraWhatsAppPayload, historico: str, empty_context: bool) -> str:
    fallback = fallback_texto_de_envio(payload.texto_usuario, payload.conversa_id)
    prompt = (
        "Transforme o comando do operador em UMA mensagem final para enviar no WhatsApp. "
        "Responda somente com o texto final, sem aspas, sem markdown e sem explicar nada.\n"
        "Regra anti-alucinacao: use apenas o comando explicito do operador e, se existir, o historico real abaixo. "
        "Se o historico estiver vazio, nao mencione fatos, pessoas ou combinados do historico.\n"
        "Se nao houver conteudo suficiente para uma mensagem segura, responda exatamente BLOQUEAR.\n\n"
        f"Comando do operador: {payload.texto_usuario}\n"
        f"Historico real: {historico if not empty_context else EMPTY_HISTORY_MARKER}\n"
        f"Fallback seguro caso o modelo fique verboso: {fallback}"
    )
    resposta = limpar_texto_para_envio(await nora_service.perguntar_nora([{"role": "user", "content": prompt}]))
    if not resposta or resposta.upper() == "BLOQUEAR" or "GROQ_API_KEY" in resposta:
        return fallback
    return resposta[:1200]


@router.post("/chat")
async def conversar_com_nora_generico(payload: ConversaPayload, _: dict[str, Any] = Depends(require_nora_permission)):
    try:
        mensagens_dict = [msg.model_dump() for msg in payload.messages]
        resposta = await nora_service.perguntar_nora(mensagens_dict)
        return {"response": resposta, "speech_text": texto_para_voz(resposta)}
    except Exception as exc:
        logger.exception("Falha na conversa generica da Nora.")
        raise HTTPException(status_code=500, detail="A Nora falhou temporariamente.") from exc


@router.post("/natural")
async def conversar_com_nora_natural(payload: NoraNaturalPayload, user: dict[str, Any] = Depends(require_nora_permission)):
    resolved_user_id = tenant_id(user)
    texto = payload.message.strip()
    resolution = resolve_skill(texto)

    try:
        if interrompe_sessao_ativa(texto):
            agenda_agent.cancel_session(payload.agenda_session_id)
            email_agent.cancel_session(payload.email_session_id)
            cancel_commercial_session(payload.commercial_session_id)
            payload.agenda_session_id = None
            payload.email_session_id = None
            payload.commercial_session_id = None

        memory_request = memory_preference_request(texto)
        if memory_request is not None:
            memory = await save_nora_memory(user, NoraMemoryCreate(**memory_request))
            return resposta_agente(
                "chat",
                {
                    "status": "memoria_salva",
                    "response": (
                        "Preferencia registrada na minha memoria operacional. "
                        "Voce pode revisar ou remover esse dado no Controle operacional."
                    ),
                    "memory": memory,
                },
                resolution=resolution,
            )

        social_greeting = mensagem_social_curta(texto)
        if social_greeting:
            social_response = resposta_social_curta(social_greeting, user)
            return {
                "intent": "chat",
                "skill": "chat",
                "routing": routing_payload(resolution, "chat"),
                "session_kind": None,
                "session_id": None,
                "status": "chat",
                "response": social_response,
                "speech_text": texto_para_voz(social_response),
            }

        module_help = answer_module_help(texto)
        if module_help is not None:
            return resposta_agente("operacoes", module_help, resolution=resolution)

        if not payload.email_session_id and not payload.agenda_session_id and is_compound_request(texto):
            steps = build_compound_plan(texto)
            if any(str(step.get("agent") or "") == "whatsapp" for step in steps):
                response = (
                    "Pedidos compostos com WhatsApp nao sao executados nem agrupados em uma aprovacao generica. "
                    "Envie primeiro o pedido individual de WhatsApp; assim a Central exibira destinatario e texto "
                    "exatos para sua revisao. Depois, envie as demais etapas."
                )
                return {
                    "intent": "whatsapp",
                    "skill": "whatsapp",
                    "routing": routing_payload(resolution, "whatsapp"),
                    "session_kind": None,
                    "session_id": None,
                    "status": "requer_aprovacao_individual",
                    "response": response,
                    "speech_text": texto_para_voz(response),
                }
            approval = await create_approval(
                user,
                ApprovalCreate(
                    title="Executar plano composto da Nora",
                    description=(
                        f"A Nora separou o pedido em {len(steps)} etapas. "
                        "Revise o plano antes de autorizar a execucao."
                    ),
                    action="nora_compound_execute",
                    source="compound",
                    payload={"originalMessage": texto, "steps": steps},
                    metadata={
                        "requestedBy": "nora",
                        "requiresExplicitDecision": True,
                        "agents": [step["agent"] for step in steps],
                    },
                ),
            )
            plan_lines = "\n".join(
                f"{index}. {step['agent'].capitalize()}: {step['instruction']}"
                for index, step in enumerate(steps, start=1)
            )
            plan_response = (
                "Entendi o pedido completo e montei este plano:\n\n"
                f"{plan_lines}\n\n"
                "Nada foi executado ainda. Revise e aprove na Central de pendencias."
            )
            return {
                "intent": "compound",
                "skill": "compound",
                "routing": {
                    **routing_payload(resolution, "compound"),
                    "agents": [step["agent"] for step in steps],
                },
                "session_kind": None,
                "session_id": None,
                "status": "aguardando_aprovacao",
                "response": plan_response,
                "speech_text": (
                    f"Montei um plano com {len(steps)} etapas e deixei os detalhes na tela. "
                    "Nada foi executado. Revise e aprove na Central de pendências."
                ),
                "agent_result": {"approval": approval, "steps": steps},
            }

        if payload.email_session_id and resolution.skill_id in {"email", "chat"}:
            approval_response = await request_sensitive_approval(
                user, texto, "email", payload.email_session_id, resolution,
            )
            if approval_response is not None:
                return approval_response
            email_message = await message_with_memory(user, texto, {"communication", "client", "process"})
            result = await email_agent.handle(message=email_message, session_id=payload.email_session_id, user_id=resolved_user_id)
            return resposta_agente("email", result, "email")

        if payload.agenda_session_id and resolution.skill_id in {"agenda", "chat"}:
            approval_response = await request_sensitive_approval(
                user, texto, "agenda", payload.agenda_session_id, resolution,
            )
            if approval_response is not None:
                return approval_response
            result = agenda_agent.handle(message=texto, session_id=payload.agenda_session_id, user_id=resolved_user_id)
            return resposta_agente("agenda", result, "agenda")

        if payload.commercial_session_id and resolution.skill_id in {"comercial", "chat"}:
            result = await handle_commercial_agent(user, texto, payload.commercial_session_id)
            return resposta_agente("comercial", result, "commercial", resolution)

        intent = resolution.skill_id
        recent_context = "\n".join(
            f"{message.role}: {message.content}" for message in payload.messages[-4:]
        )
        semantic_enabled = os.getenv("NORA_INTENT_LLM", "1").strip() != "0"
        if resolution.needs_semantic_fallback and semantic_enabled and len(texto.split()) >= 2:
            semantic_intent, semantic_confidence = await classificar_intencao_com_nora(
                texto,
                resolution,
                recent_context,
            )
            if semantic_confidence >= 0.55:
                intent = semantic_intent

        # O canal explicito tem precedencia sobre o assunto da mensagem. Sem
        # "WhatsApp/zap/wpp", a forma curta "mande uma mensagem para Ana" so
        # assume WhatsApp quando o roteador nao identificou outro modulo. Isso
        # preserva "avise a equipe" no chat interno e pedidos de e-mail.
        explicit_whatsapp = bool(re.search(r"\b(?:whats\s*app|zap|wpp)\b", normalizar_intencao(texto)))
        team_target = bool(re.search(r"\b(?:equipe|time|chat interno)\b", normalizar_intencao(texto)))
        weak_generic_route = intent == "chat" or (
            resolution.score <= 2.5
            and not team_target
            and intent not in {"email", "automacoes"}
        )
        if is_whatsapp_send_request(texto) and (explicit_whatsapp or weak_generic_route):
            intent = "whatsapp"

        if intent == "whatsapp":
            return await request_whatsapp_approval(user, texto, resolution)

        approval_response = await request_sensitive_approval(
            user,
            texto,
            intent,
            payload.email_session_id if intent == "email" else payload.agenda_session_id if intent == "agenda" else None,
            resolution,
        )
        if approval_response is not None:
            return approval_response

        if intent == "financeiro":
            finance_message = await message_with_memory(user, texto, {"finance", "process", "general"})
            result = await handle_finance_agent(resolved_user_id, finance_message)
            return resposta_agente("financeiro", result, resolution=resolution)

        if intent == "tarefas":
            result = await handle_task_agent(resolved_user_id, texto)
            return resposta_agente("tarefas", result, resolution=resolution)

        if intent == "comercial":
            result = await handle_commercial_agent(user, texto, payload.commercial_session_id)
            return resposta_agente("comercial", result, "commercial", resolution)

        if intent == "email":
            email_message = await message_with_memory(user, texto, {"communication", "client", "process"})
            result = await email_agent.handle(message=email_message, session_id=None, user_id=resolved_user_id)
            return resposta_agente("email", result, "email", resolution)

        if intent == "agenda":
            result = agenda_agent.handle(message=texto, session_id=None, user_id=resolved_user_id)
            return resposta_agente("agenda", result, "agenda", resolution)

        if intent == "equipe":
            team_message = await message_with_memory(user, texto, {"communication", "process", "general"})
            result = await handle_team_agent(resolved_user_id, team_message, str(user.get("nome") or "Nora"))
            return resposta_agente("equipe", result, resolution=resolution)

        if intent == "automacoes":
            automation_message = await message_with_memory(user, texto, {"process", "general"})
            result = await handle_automation_agent(resolved_user_id, automation_message, str(user.get("nome") or "Nora"))
            return resposta_agente("automacoes", result, resolution=resolution)

        if intent == "brainstorm":
            normalized = normalizar_intencao(texto)
            collaboration_id = str(user.get("teamOwnerId") or resolved_user_id)
            if any(term in normalized for term in ("criar", "crie", "nova sessao", "novo brainstorm")):
                title_match = re.search(r"(?:brain\s*storm|sessao\s+de\s+ideias)(?:\s+(?:para|sobre|chamado|chamada))?\s+(.+)", texto, flags=re.I)
                title = title_match.group(1).strip(" .") if title_match else ""
                if not title:
                    return resposta_agente(
                        "brainstorm",
                        {"status": "precisa_dados", "response": "Qual é o tema ou título da sessão de brainstorm? Também posso registrar o objetivo e o responsável."},
                        resolution=resolution,
                    )
                session = await create_brainstorm_session(
                    collaboration_id,
                    {"title": title[:160], "objective": "Criada pela Nora a partir de linguagem natural.", "template": "livre", "durationMinutes": 15},
                    user,
                )
                return resposta_agente(
                    "brainstorm",
                    {"status": "criada", "response": f"Executado: criei a sessão de brainstorm '{session['title']}'. Responsável: {session['responsibleName']}.", "session": session},
                    resolution=resolution,
                )
            sessions = await list_brainstorm_sessions(collaboration_id)
            if not sessions:
                return resposta_agente("brainstorm", {"status": "vazio", "response": "Não há sessões de brainstorm registradas para esta equipe."}, resolution=resolution)
            summary = "\n".join(f"- {item.get('title')} — responsável: {item.get('responsibleName')} — {item.get('nodeCount', 0)} ideias" for item in sessions[:8])
            return resposta_agente("brainstorm", {"status": "consulta", "response": f"Sessões de brainstorm da equipe:\n{summary}"}, resolution=resolution)

        if intent == "operacoes":
            normalized = normalizar_intencao(texto)
            if any(term in normalized for term in ("passagem de turno", "passar o turno", "resumo do turno", "handoff")):
                result = await generate_handoff(user)
            elif any(
                term in normalized
                for term in (
                    "conflito",
                    "sobreposicao",
                    "sobrecarga",
                    "pagamento repetido",
                    "pagamentos repetidos",
                    "duplicidade de pagamento",
                )
            ):
                result = await conflict_scan(user)
            elif any(
                term in normalized
                for term in (
                    "qualidade dos dados",
                    "dados incompletos",
                    "contatos duplicados",
                    "anexos orfaos",
                    "referencias quebradas",
                    "cadastros incompletos",
                )
            ):
                result = await quality_scan(user)
            else:
                result = await query_knowledge(user, texto, 5)
            return resposta_agente("operacoes", result, resolution=resolution)

        mensagens_dict = [msg.model_dump() for msg in payload.messages[-6:]]
        mensagens_dict.append({"role": "user", "content": await message_with_memory(user, texto, {"communication", "client", "project", "process", "general"})})
        resposta = await nora_service.perguntar_nora(mensagens_dict, payload.screen_context)
        return {
            "intent": "chat",
            "skill": "chat",
            "routing": routing_payload(resolution, "chat"),
            "session_kind": None,
            "session_id": None,
            "status": "chat",
            "response": resposta,
            "speech_text": texto_para_voz(resposta),
        }
    except Exception as exc:
        logger.exception("Falha na orquestracao natural da Nora.")
        raise HTTPException(status_code=500, detail="A Nora falhou temporariamente.") from exc


@router.post("/natural/stream")
async def conversar_com_nora_natural_stream(
    payload: NoraNaturalPayload,
    request: Request,
    user: dict[str, Any] = Depends(require_nora_permission),
):
    """Streama a resposta da Nora token a token quando a mensagem e conversa geral.

    So assume o caminho de streaming quando a mensagem nao ativa nenhum agente
    especializado (sessao de agenda/email, pedido composto, memoria, saudacao,
    ajuda de modulo). Nesses outros casos devolve {"redirect": true} e o
    frontend refaz a chamada em /natural, que ja trata cada um desses fluxos
    com o resultado estruturado (nao apenas texto) que cada agente precisa.
    """
    request_started = time.perf_counter()
    response_id = uuid.uuid4().hex
    texto = payload.message.strip()

    has_active_session = bool(
        payload.email_session_id or payload.agenda_session_id or payload.commercial_session_id
    )
    needs_structured_flow = (
        has_active_session
        or memory_preference_request(texto) is not None
        or mensagem_social_curta(texto) is not None
        or answer_module_help(texto) is not None
        or is_compound_request(texto)
    )

    resolution = resolve_skill(texto)
    if not needs_structured_flow and resolution.skill_id == "chat":
        base_messages = [msg.model_dump() for msg in payload.messages[-6:]]

        def encode_event(event_type: str, payload_data: dict[str, Any]) -> str:
            data = {"type": event_type, "response_id": response_id, **payload_data}
            return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        async def event_stream():
            first_token_at: float | None = None
            first_token_sent_at: float | None = None
            try:
                yield encode_event("status", {"state": "thinking"})
                context_started = time.perf_counter()
                user_message = await message_with_memory(
                    user,
                    texto,
                    {"communication", "client", "project", "process", "general"},
                )
                mensagens_dict = [*base_messages, {"role": "user", "content": user_message}]
                context_ready = time.perf_counter()
                yield encode_event(
                    "status",
                    {
                        "state": "streaming",
                        "context_ms": round((context_ready - context_started) * 1000, 1),
                    },
                )

                async for delta in nora_service.perguntar_nora_stream(mensagens_dict, payload.screen_context):
                    if await request.is_disconnected():
                        logger.info("nora_latency response_id=%s event=cancelled", response_id)
                        return
                    now = time.perf_counter()
                    if first_token_at is None:
                        first_token_at = now
                    event = encode_event("delta", {"delta": delta})
                    if first_token_sent_at is None:
                        first_token_sent_at = time.perf_counter()
                    yield event

                completed_at = time.perf_counter()
                metrics = {
                    "context_ms": round((context_ready - context_started) * 1000, 1),
                    "ttft_ms": round(((first_token_at or completed_at) - request_started) * 1000, 1),
                    "first_token_send_ms": round(((first_token_sent_at or completed_at) - request_started) * 1000, 1),
                    "total_ms": round((completed_at - request_started) * 1000, 1),
                }
                logger.info(
                    "nora_latency response_id=%s event=completed context_ms=%s ttft_ms=%s first_token_send_ms=%s total_ms=%s",
                    response_id,
                    metrics["context_ms"],
                    metrics["ttft_ms"],
                    metrics["first_token_send_ms"],
                    metrics["total_ms"],
                )
                yield encode_event("done", {"metrics": metrics})
            except asyncio.CancelledError:
                logger.info("nora_latency response_id=%s event=cancelled", response_id)
                raise

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
                "X-Norium-Response-Id": response_id,
            },
        )

    return JSONResponse({"redirect": True})


@router.post("/telemetry", status_code=204)
async def record_nora_telemetry(
    payload: NoraTelemetryPayload,
    _: dict[str, Any] = Depends(require_nora_permission),
) -> Response:
    logger.info(
        "nora_client_latency response_id=%s event=%s elapsed_ms=%.1f channel=%s",
        payload.response_id,
        payload.event,
        payload.elapsed_ms,
        payload.channel,
    )
    return Response(status_code=204)


@router.post("/voz")
async def gerar_voz_nora(payload: NoraVoicePayload, _: dict[str, Any] = Depends(require_nora_permission)):
    load_dotenv()
    tts_started = time.perf_counter()
    provider = os.getenv("NORA_TTS_PROVIDER", "edge").strip().lower()
    if provider in {"edge", "edge-tts", "microsoft"}:
        audio_stream = gerar_audio_edge_tts_stream(payload.text)
        return StreamingResponse(
            audio_stream,
            media_type="audio/mpeg",
            headers={
                "Cache-Control": "no-cache, no-store, no-transform",
                "Content-Disposition": "inline",
                "X-Accel-Buffering": "no",
                "X-Norium-Audio-Mode": "progressive",
                "X-Norium-Voice-Provider": "edge-tts",
                "X-Norium-Voice-Id": os.getenv("EDGE_TTS_VOICE", EDGE_TTS_DEFAULT_VOICE),
            },
        )

    audio = await gerar_audio_elevenlabs(payload.text, payload.voice_id)
    elapsed_ms = round((time.perf_counter() - tts_started) * 1000, 1)
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Norium-Voice-Provider": "elevenlabs",
            "X-Norium-Voice-Id": payload.voice_id or os.getenv("ELEVENLABS_VOICE_ID") or ELEVENLABS_DEFAULT_VOICE_ID,
            "Server-Timing": f"tts;dur={elapsed_ms}",
        },
    )


@router.post("/transcrever")
async def transcrever_voz_nora(
    payload: NoraTranscriptionPayload,
    _: dict[str, Any] = Depends(require_nora_permission),
):
    """Fallback de reconhecimento de voz quando a API nativa do navegador falhar."""
    load_dotenv()
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="Transcricao de voz nao configurada no servidor.")

    encoded = payload.audio_data_url.split(",", 1)[-1].strip()
    try:
        audio_bytes = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=400, detail="Audio invalido para transcricao.") from exc
    if not audio_bytes or len(audio_bytes) > 15_000_000:
        raise HTTPException(status_code=413, detail="O audio deve ter no maximo 15 MB.")

    extension = "ogg" if "ogg" in payload.mime_type else "mp4" if "mp4" in payload.mime_type else "webm"
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": (f"nora-voice.{extension}", audio_bytes, payload.mime_type)},
                data={
                    "model": os.getenv("NORA_STT_MODEL", "whisper-large-v3-turbo"),
                    "language": "pt",
                    "response_format": "json",
                    "temperature": "0",
                },
            )
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="O provedor de transcricao nao respondeu corretamente.")
        transcript = str(response.json().get("text") or "").strip()
        if not transcript:
            raise HTTPException(status_code=422, detail="Nao foi possivel identificar fala no audio.")
        return {"text": transcript, "language": "pt-BR", "provider": "groq"}
    except HTTPException:
        raise
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Falha temporaria ao transcrever a voz.") from exc


@router.post("/chat-whatsapp")
async def conversar_nora_whatsapp(payload: NoraWhatsAppPayload, user: dict[str, Any] = Depends(require_nora_permission)):
    resolved_user_id = tenant_id(user)
    historico_whats = await buscar_historico_whats(payload.conversa_id, resolved_user_id)
    empty_context = is_empty_history(historico_whats)

    if payload.enviar_direto_whatsapp:
        permissions = effective_permissions(user)
        if not permissions.get("chat") or not permissions.get("integracao_whatsapp"):
            raise HTTPException(status_code=403, detail="Sua conta nao pode enviar mensagens pelo WhatsApp.")
        binding = wb.get_binding(resolved_user_id)
        if not binding.exists or str(getattr(binding, "state", "")) != "connected":
            raise HTTPException(status_code=409, detail="WhatsApp nao esta conectado nesta conta.")
        if empty_context and not parece_ordem_de_envio(payload.texto_usuario):
            return {
                "response": "Nao ha historico real suficiente para preparar este envio com seguranca.",
                "whatsapp_enviado": False,
                "status": "validacao_falhou",
                "blocked_reason": "historico_vazio",
            }

        recipient = await resolve_whatsapp_recipient(resolved_user_id, payload.conversa_id)
        if recipient.get("status") != "resolved":
            return {
                "response": "Nao consegui validar esta conversa entre os contatos do seu WhatsApp. Nada foi enviado.",
                "whatsapp_enviado": False,
                "status": "validacao_falhou",
                "blocked_reason": "destinatario_nao_validado",
            }
        texto_envio = await gerar_texto_de_envio_whatsapp(payload, historico_whats, empty_context)
        if not texto_envio:
            return {
                "response": "Nao consegui extrair um texto seguro para revisao. Nada foi enviado.",
                "whatsapp_enviado": False,
                "status": "validacao_falhou",
                "blocked_reason": "texto_envio_vazio",
            }

        conversation_id = str(recipient.get("conversation_id") or "").strip()
        recipient_name = str(recipient.get("display_name") or conversation_id).strip()
        approval = await create_approval(
            user,
            ApprovalCreate(
                title=f"Enviar mensagem no WhatsApp para {recipient_name}"[:180],
                description=texto_envio,
                action="nora_whatsapp_execute",
                source="whatsapp",
                payload={
                    "originalMessage": payload.texto_usuario,
                    "conversationId": conversation_id,
                    "recipientName": recipient_name,
                    "messageText": texto_envio,
                    "isGroup": bool(recipient.get("is_group")),
                    "instanceId": str(getattr(binding, "instance_id", "")),
                },
                metadata={
                    "requestedBy": "nora_chat_whatsapp",
                    "requiresExplicitDecision": True,
                    "channel": "whatsapp",
                },
            ),
        )
        return {
            "response": (
                f"Preparei a mensagem para {recipient_name}:\n\n{texto_envio}\n\n"
                "Nada foi enviado. Revise e aprove na Central de aprovacoes."
            ),
            "whatsapp_enviado": False,
            "status": "aguardando_aprovacao",
            "approval": approval,
            "preview": {
                "conversationId": conversation_id,
                "recipientName": recipient_name,
                "messageText": texto_envio,
            },
        }

    prompt_contexto = (
        f"Historico extraido em tempo real do banco local para a conversa '{payload.conversa_id}':\n\n"
        f"{historico_whats or EMPTY_HISTORY_MARKER}\n\n"
        f"Comando ou pergunta do usuario: '{payload.texto_usuario}'.\n"
        "Regra dura: se o historico acima estiver vazio ou marcado como sem mensagens recentes, "
        "explique esse vazio com o humor da Nora e nao invente nomes, fatos, combinados ou contexto."
    )

    resposta_ia = await nora_service.perguntar_nora([{"role": "user", "content": prompt_contexto}])

    return {"response": resposta_ia, "whatsapp_enviado": False}


@router.get("/resumir-conversa")
async def resumir_conversa(conversa_id: str = Query(..., description="ID da conversa do WhatsApp"), user: dict[str, Any] = Depends(require_nora_permission)):
    historico_whats = await buscar_historico_whats(conversa_id, tenant_id(user))
    if is_empty_history(historico_whats):
        return {
            "resumo": (
                "O banco local nao tem mensagens recentes para essa conversa. Resumo cirurgico do nada: "
                "zero fatos, zero combinados, zero motivo para a Nora inventar fanfic."
            ),
            "empty_context": True,
        }

    prompt_resumo = [
        {
            "role": "user",
            "content": (
                "Faca uma analise sarcastica, sincera, bem-humorada e precisa em topicos rapidos. "
                "Explique o que o cliente quer, o que ja foi combinado, riscos e proxima melhor resposta. "
                f"Use apenas este historico real:\n\n{historico_whats}"
            ),
        }
    ]
    resumo = await nora_service.perguntar_nora(prompt_resumo)
    return {"resumo": resumo, "empty_context": False}


@router.get("/agentes")
async def listar_agentes_nora(_: dict[str, Any] = Depends(require_nora_permission)):
    return {"agents": agent_manager.list_agents()}


@router.get("/skills")
async def listar_skills_nora(_: dict[str, Any] = Depends(require_nora_permission)):
    return {"skills": skill_catalog_payload()}


@router.post("/agentes/mensagens/rascunho")
async def gerar_rascunho_agente_mensagens(payload: AgentDraftPayload, user: dict[str, Any] = Depends(require_nora_permission)):
    return await agent_manager.draft_message(
        payload.conversa_id,
        user_id=tenant_id(user),
        instrucao=payload.instrucao,
        tom_atendente=payload.tom_atendente,
    )


@router.post("/agentes/mensagens/enviar")
async def enviar_rascunho_agente_mensagens(payload: AgentExecutePayload, user: dict[str, Any] = Depends(require_nora_permission)):
    resolved_user_id = tenant_id(user)
    result = await agent_manager.execute_message(
        payload.conversa_id,
        payload.texto,
        canal=payload.canal,
        autorizado=payload.autorizado,
        user_id=resolved_user_id,
    )
    if result.get("status") == "bloqueado_sem_autorizacao":
        raise HTTPException(status_code=403, detail="Envio bloqueado: autorizacao explicita ausente.")
    if result.get("status") == "falha_gateway":
        raise HTTPException(status_code=502, detail="A API do WhatsApp recusou o envio do agente.")
    return result
