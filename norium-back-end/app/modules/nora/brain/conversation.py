"""Read-only chat entry: bounded brain contracts, existing metered gateway.

No executor/worker activation and no business tools. The human authorized
explicit requests with <=12 minimized readable messages to configured Groq/OpenAI.
"""
from __future__ import annotations
import re

from fastapi import HTTPException
from app.core.ai_guardrails import minimize_for_ai
from app.core.request_context import current_workspace_id
from .contracts import Decision, PROFILES
from .policy import scope_for


async def answer_from_context(user: dict, prompt: str, gateway) -> Decision:
    scope = scope_for(user, current_workspace_id())
    if not (user.get("systemAdmin") or (user.get("permissions") or {}).get("nora")):
        raise HTTPException(403, "A Nora não está liberada para esta conta.")
    if gateway.provider not in {"groq", "openai"}:
        raise HTTPException(403, "Provedor não autorizado para o contexto do Chat.")
    safe = minimize_for_ai(prompt)
    if len(safe) > PROFILES["routine"].context:
        raise HTTPException(400, "Selecione um trecho menor da conversa.")
    text = await gateway.perguntar_nora([{ "role": "user", "content": safe }],
        user_id=scope.user, purpose="routine", max_tokens=1400)
    if re.search(r"\b(criei|enviei|apaguei|excluí|executei|cancelei|alterei|registrei|salvei)\b|\b(criad[oa]|enviad[oa]|excluíd[oa]|executad[oa]|cancelad[oa]|alterad[oa])\s+com sucesso\b", str(text or "").casefold()):
        text = "Este fluxo só prepara propostas. Revise o pedido para criar uma tarefa, agendar ou preparar uma aprovação de envio. Nenhuma ação foi executada aqui."
    return Decision(kind="answer", text=minimize_for_ai(str(text or "").strip())[:8000])
