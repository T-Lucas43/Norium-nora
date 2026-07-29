from __future__ import annotations

import re
import unicodedata
from typing import Any

from app.routers.agenda_router import agenda_agent
from app.routers.automacoes_router import handle_automation_agent
from app.routers.financeiro_router import handle_finance_agent
from app.routers.tarefas_router import handle_task_agent
from app.routers.team_chat_router import append_team_message_for_user
from app.services.email_agent import EmailAgent


SUPPORTED_AGENTS = ("financeiro", "tarefas", "email", "agenda", "automacoes", "equipe")

AGENT_SIGNALS: dict[str, tuple[str, ...]] = {
    "financeiro": (
        "gasto",
        "gastei",
        "despesa",
        "lancamento",
        "paguei",
        "pagamento",
        "recebi",
        "receita",
        "boleto",
        "pix",
        "cartao",
        "comprei",
    ),
    "tarefas": (
        "tarefa",
        "tarefas",
        "kanban",
        "projeto",
        "card",
        "prioridade",
        "vencimento",
        "revisar",
    ),
    "email": (
        "email",
        "e-mail",
        "gmail",
        "caixa de entrada",
        "destinatario",
        "assunto",
        "responda",
    ),
    "agenda": (
        "agenda",
        "agendar",
        "calendario",
        "compromisso",
        "evento",
        "reuniao",
        "call",
        "lembre",
    ),
    "automacoes": (
        "automacao",
        "automatizar",
        "fluxo",
        "workflow",
        "gatilho",
    ),
    "equipe": (
        "equipe",
        "time",
        "chat interno",
        "chat da equipe",
        "avisar o time",
        "avise o time",
    ),
}


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value.casefold())
    return "".join(character for character in normalized if not unicodedata.combining(character))


def candidate_agents(message: str) -> list[str]:
    normalized = normalize_text(message)
    matches = [
        agent
        for agent, signals in AGENT_SIGNALS.items()
        if any(signal in normalized for signal in signals)
    ]
    if re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", message) and "email" not in matches:
        matches.append("email")
    return [agent for agent in SUPPORTED_AGENTS if agent in matches]


def is_compound_request(message: str) -> bool:
    agents = candidate_agents(message)
    if len(agents) < 2:
        return False
    normalized = normalize_text(message)
    action_verbs = re.findall(
        r"\b(?:crie|criar|registre|registrar|lance|lancar|envie|enviar|responda|"
        r"agende|agendar|marque|marcar|avise|avisar|execute|executar|automatize|"
        r"me lembre|lembre|adicione|adicionar)\b",
        normalized,
    )
    return len(action_verbs) >= 2 or any(
        connector in normalized
        for connector in (" e depois ", " e tambem ", " alem disso ", ";", "\n")
    )


def _split_clauses(message: str) -> list[str]:
    prepared = re.sub(
        r"\s+(?:e\s+depois|e\s+tambem|alem\s+disso|depois\s+disso|em\s+seguida)\s+",
        " || ",
        message,
        flags=re.I,
    )
    prepared = re.sub(
        r"\s+e\s+(?=(?:crie|criar|registre|registrar|lance|lancar|envie|enviar|"
        r"responda|agende|agendar|marque|marcar|avise|avisar|execute|executar|"
        r"automatize|me\s+lembre|adicione|adicionar)\b)",
        " || ",
        prepared,
        flags=re.I,
    )
    prepared = re.sub(
        r",\s*(?=(?:crie|registre|lance|envie|responda|agende|marque|avise|execute|automatize|me lembre)\b)",
        " || ",
        prepared,
        flags=re.I,
    )
    return [clause.strip(" .,:;-") for clause in re.split(r"\s*\|\|\s*|[;\n]+", prepared) if clause.strip()]


def build_compound_plan(message: str) -> list[dict[str, Any]]:
    clauses = _split_clauses(message)
    steps: list[dict[str, Any]] = []
    covered: set[str] = set()

    for clause in clauses:
        matches = candidate_agents(clause)
        if not matches:
            continue
        agent = matches[0]
        steps.append(
            {
                "id": f"step_{len(steps) + 1}",
                "agent": agent,
                "instruction": clause,
                "status": "planned",
            }
        )
        covered.add(agent)

    for agent in candidate_agents(message):
        if agent in covered:
            continue
        steps.append(
            {
                "id": f"step_{len(steps) + 1}",
                "agent": agent,
                "instruction": message,
                "status": "planned",
            }
        )
    return steps


async def _execute_team_step(user: dict[str, Any], instruction: str) -> dict[str, Any]:
    normalized = normalize_text(instruction)
    content = re.sub(
        r"^\s*(?:nora[, ]*)?(?:avise|avisar|mande|mandar|envie|enviar)\s+"
        r"(?:uma\s+mensagem\s+)?(?:no|para\s+o|para\s+a|pro|pra)?\s*"
        r"(?:chat\s+)?(?:da\s+)?(?:equipe|time)?\s*",
        "",
        instruction,
        flags=re.I,
    ).strip(" .,:;-")
    if not content or content == normalized:
        content = instruction.strip()
    item = await append_team_message_for_user(
        str(user.get("id") or "lucas123"),
        content[:1800],
        sender_id="nora",
        sender_name="Nora",
        sender_avatar="nora",
        metadata={"action": "nora_compound_team_message", "source": "nora"},
    )
    return {"status": "enviado", "response": "Mensagem enviada ao chat da equipe.", "message": item}


async def execute_agent_step(user: dict[str, Any], step: dict[str, Any]) -> dict[str, Any]:
    user_id = str(user.get("id") or "lucas123")
    agent = str(step.get("agent") or "")
    instruction = str(step.get("instruction") or "").strip()
    if not instruction:
        return {"status": "precisa_dados", "response": "A etapa nao possui uma instrucao valida."}
    if agent == "financeiro":
        return await handle_finance_agent(user_id, instruction)
    if agent == "tarefas":
        return await handle_task_agent(user_id, instruction)
    if agent == "email":
        return await EmailAgent().handle(message=instruction, session_id=None, user_id=user_id)
    if agent == "agenda":
        return agenda_agent.handle(message=instruction, session_id=None, user_id=user_id)
    if agent == "automacoes":
        return await handle_automation_agent(user_id, instruction, str(user.get("nome") or "Nora"))
    if agent == "equipe":
        return await _execute_team_step(user, instruction)
    return {"status": "nao_suportado", "response": f"Agente nao suportado: {agent}."}


async def execute_compound_plan(
    user: dict[str, Any],
    steps: list[dict[str, Any]],
) -> dict[str, Any]:
    executed: list[dict[str, Any]] = []
    for step in steps:
        result = await execute_agent_step(user, step)
        status = str(result.get("status") or "").casefold()
        ok = not (
            status.startswith(("precisa", "aguardando", "nao_", "falha"))
            or status in {"ajuda", "consulta", "resumo", "sem_alteracao"}
        )
        executed.append({**step, "status": "executed" if ok else "blocked", "result": result})
        if not ok:
            return {
                "status": "partial" if any(item["status"] == "executed" for item in executed) else "needs_data",
                "ok": False,
                "steps": executed,
                "response": (
                    f"A etapa {len(executed)} precisa de atencao antes de continuar: "
                    f"{result.get('response') or 'faltam dados para executar com seguranca.'}"
                ),
            }
    return {
        "status": "executed",
        "ok": True,
        "steps": executed,
        "response": f"Plano concluido com {len(executed)} acao(oes) verificadas.",
    }
