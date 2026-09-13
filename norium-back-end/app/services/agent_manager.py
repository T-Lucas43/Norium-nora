from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from app.services.conversation_store import (
    EMPTY_HISTORY_MARKER,
    append_outgoing_message,
    build_conversation_history,
    is_empty_history,
    whatsapp_conversation_mutation_lock,
)
from app.services.nora import NoraIAService
from app.services.wapi_messaging import WapiMessagingService, MessagingUnavailable, WapiError

AgentStatus = Literal["ativo", "planejado"]


class AgentManager:
    def __init__(self) -> None:
        self.nora_service = NoraIAService()
        self.wapi_messaging = WapiMessagingService()
        self._agents: List[Dict[str, Any]] = [
            {
                "id": "mensagens",
                "nome": "Agente de Mensagens",
                "status": "ativo",
                "canais": ["whatsapp"],
                "descricao": "Gera rascunhos e envia respostas aprovadas no chat ativo.",
            },
            {
                "id": "agenda",
                "nome": "Agente de Agenda",
                "status": "ativo",
                "canais": ["whatsapp"],
                "descricao": "Consulta compromissos e cria eventos no Google Agenda com perguntas sequenciais.",
            },
            {
                "id": "tarefas",
                "nome": "Agente de Tarefas",
                "status": "ativo",
                "canais": ["norium", "whatsapp"],
                "descricao": "Cria, consulta e conclui tarefas do Kanban do Norium.",
            },
            {
                "id": "emails",
                "nome": "Agente de E-mails",
                "status": "ativo",
                "canais": ["gmail", "norium"],
                "descricao": "Consulta, resume e conduz envios pelo Gmail com confirmacao antes do disparo.",
            },
            {
                "id": "relatorios",
                "nome": "Agente de Relatorios",
                "status": "planejado",
                "canais": ["whatsapp"],
                "descricao": "Base reservada para metricas e analises operacionais.",
            },
        ]

    def list_agents(self) -> List[Dict[str, Any]]:
        return self._agents

    async def draft_message(
        self,
        conversa_id: str,
        *,
        user_id: str,
        instrucao: Optional[str] = None,
        tom_atendente: Optional[str] = None,
    ) -> Dict[str, Any]:
        history = await build_conversation_history(conversa_id, limit=30, user_id=user_id)
        empty_context = is_empty_history(history)

        if empty_context:
            return {
                "agent_id": "mensagens",
                "status": "sem_contexto",
                "empty_context": True,
                "draft": (
                    "Historico vazio no banco local. Eu ate queria fazer magia, mas sem mensagem real "
                    "o Agente de Mensagens fica oficialmente proibido de inventar novela."
                ),
                "history": EMPTY_HISTORY_MARKER,
            }

        prompt = (
            "Voce e o Agente de Mensagens da Nora. Gere um rascunho curto, humano e pronto para envio, "
            "mantendo o tom do atendente e sem inventar fatos fora do historico.\n\n"
            f"Tom desejado: {tom_atendente or 'profissional, direto e cordial'}\n"
            f"Instrucao extra do operador: {instrucao or 'responder ao cliente da forma mais util agora'}\n\n"
            f"Historico real:\n{history}\n\n"
            "Responda apenas com o texto do rascunho que poderia ser enviado ao cliente."
        )
        draft = await self.nora_service.perguntar_nora([{"role": "user", "content": prompt}], user_id=user_id)
        return {
            "agent_id": "mensagens",
            "status": "rascunho_gerado",
            "empty_context": False,
            "draft": draft,
            "history": history,
        }

    async def execute_message(
        self,
        conversa_id: str,
        texto: str,
        *,
        canal: Literal["whatsapp"] = "whatsapp",
        autorizado: bool = False,
        sender_label: Optional[str] = "Agente de Mensagens",
        user_id: str,
    ) -> Dict[str, Any]:
        if not autorizado:
            return {
                "agent_id": "mensagens",
                "status": "bloqueado_sem_autorizacao",
                "sent": False,
            }

        try:
            result = await self.wapi_messaging.send_text(user_id, conversa_id, texto)
        except (MessagingUnavailable, WapiError):
            result = {"sent": False}
        success = bool(result and result.get("sent") is True)

        if success:
            async with whatsapp_conversation_mutation_lock(user_id):
                await append_outgoing_message(
                    conversa_id,
                    texto,
                    channel=canal,
                    sender_label=sender_label,
                    status="enviado",
                    message_id=str(result.get("messageId") or "") or None,
                    user_id=user_id,
                )

        return {
            "agent_id": "mensagens",
            "status": "enviado" if success else "falha_gateway",
            "sent": success,
        }
