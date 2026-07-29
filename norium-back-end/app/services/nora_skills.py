from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any


@dataclass(frozen=True)
class NoraSkill:
    id: str
    name: str
    description: str
    examples: tuple[str, ...]
    strong_patterns: tuple[str, ...]
    supporting_terms: tuple[str, ...]
    conflict_patterns: tuple[str, ...] = ()


@dataclass(frozen=True)
class SkillResolution:
    skill_id: str
    confidence: float
    score: float
    margin: float
    needs_semantic_fallback: bool
    matched_signals: tuple[str, ...]
    alternatives: tuple[dict[str, Any], ...]


SKILLS: tuple[NoraSkill, ...] = (
    NoraSkill(
        id="equipe",
        name="Equipe",
        description="Envia mensagens no chat interno e comunica atualizacoes ao time.",
        examples=(
            "avise a equipe que a tarefa foi concluida",
            "mande no chat do time um resumo das tarefas",
            "envie uma mensagem interna para todos",
        ),
        strong_patterns=(
            r"\bchat\s+(?:da|do)\s+(?:equipe|time)\b",
            r"\bchat\s+interno\b",
            r"\b(?:avise|avisar|notifique|notificar)\s+(?:a|o)?\s*(?:equipe|time)\b",
            r"\bmensagem\s+(?:interna|para\s+(?:a\s+)?equipe|para\s+o\s+time)\b",
        ),
        supporting_terms=("equipe", "time", "membros", "mensagem", "avisar", "notificar", "todos"),
    ),
    NoraSkill(
        id="automacoes",
        name="Automacoes",
        description="Cria, consulta, ativa, desativa e executa fluxos automatizados.",
        examples=(
            "crie uma automacao para avisar quando chegar e-mail",
            "sempre que uma tarefa vencer, avise a equipe",
            "execute a automacao de novos gastos",
        ),
        strong_patterns=(
            r"\bautoma(?:cao|coes)\b",
            r"\bautomatiz(?:ar|e|acao)\b",
            r"\bworkflow\b",
            r"\bgatilho\b",
            r"\b(?:sempre\s+que|quando)\b.+\b(?:enviar|envie|avisar|avise|notificar|notifique|criar|crie|registrar|registre|resumir|resuma|classificar|classifique)\b",
        ),
        supporting_terms=("fluxo", "executar", "rodar", "ativar", "desativar", "acao", "condicao"),
        conflict_patterns=(r"\bfluxo\s+de\s+caixa\b",),
    ),
    NoraSkill(
        id="brainstorm",
        name="Brainstorm",
        description="Cria e consulta sessoes colaborativas, organiza ideias e transforma ideias em proximos passos.",
        examples=(
            "crie um brainstorm para a campanha de lancamento",
            "abra a sessao de ideias do produto",
            "resuma o quadro e organize as ideias por tema",
        ),
        strong_patterns=(
            r"\bbrain\s*storm(?:ing)?\b",
            r"\bsessao\s+de\s+ideias\b",
            r"\bquadro\s+(?:de\s+)?ideias\b",
            r"\bmapa\s+mental\b",
        ),
        supporting_terms=("ideias", "post-its", "quadro", "votacao", "agrupar", "responsavel", "sessao"),
    ),
    NoraSkill(
        id="operacoes",
        name="Operacao corporativa",
        description="Consulta a base de conhecimento, prepara passagem de turno e verifica qualidade ou conflitos operacionais.",
        examples=(
            "consulte a politica de reembolso na base de conhecimento",
            "prepare a passagem de turno para o proximo operador",
            "verifique conflitos e problemas de qualidade dos dados",
        ),
        strong_patterns=(
            r"\bbase\s+de\s+conhecimento\b",
            r"\bpassagem\s+de\s+turno\b",
            r"\bqualidade\s+(?:dos|de)\s+dados\b",
            r"\b(?:detectar|verificar|liste|listar)\s+conflitos?\s+operacionais?\b",
            r"\b(?:portal\s+do\s+cliente|formularios?\s+publicos?|caixa\s+de\s+integracoes)\b",
            r"\b(?:explique|como\s+usar|como\s+funciona|para\s+que\s+serve)\b.+\b(?:central|controle|pendencias|notificacoes|relatorios|perfil|configuracoes|governanca|ajuda)\b",
        ),
        supporting_terms=(
            "politica",
            "manual",
            "documento",
            "fonte",
            "handoff",
            "duplicados",
            "incompletos",
            "credenciais",
            "explicar",
            "orientar",
            "como usar",
        ),
    ),
    NoraSkill(
        id="email",
        name="E-mails",
        description="Consulta, resume, redige, responde e envia e-mails pelo Gmail.",
        examples=(
            "leia minha caixa de entrada do e-mail",
            "envie um e-mail para cliente@empresa.com perguntando sobre a proposta",
            "resuma meus e-mails nao lidos",
        ),
        strong_patterns=(
            r"\b(?:e-?mail|emails|gmail)\b",
            r"\bcaixa\s+de\s+entrada\b",
            r"\b(?:destinatario|remetente|assunto|rascunho)\b",
            r"[\w.+-]+@[\w-]+\.[\w.-]+",
        ),
        supporting_terms=("ler", "leia", "listar", "resumir", "responda", "responder", "enviar", "redigir", "anexo"),
        conflict_patterns=(r"\bchat\s+(?:da|do)\s+(?:equipe|time)\b", r"\bmensagem\s+no\s+whatsapp\b"),
    ),
    NoraSkill(
        id="financeiro",
        name="Financeiro",
        description="Registra e consulta gastos, receitas, boletos e lancamentos financeiros.",
        examples=(
            "gastei 47 reais hoje no Pix comprando comida",
            "registre uma entrada de 500 reais",
            "mostre meus boletos e gastos pendentes",
        ),
        strong_patterns=(
            r"\b(?:financeir\w*|gasto\w*|gastei|despesa\w*|lancamento\w*|receita\w*|boleto\w*)\b",
            r"\b(?:paguei|recebi|comprei|comprando)\b",
            r"\b(?:pix|cartao|dinheiro|nota\s+fiscal|comprovante)\b",
            r"(?:r\$\s*)?\b\d+(?:[.,]\d{1,2})?\s*(?:reais|real)\b",
        ),
        supporting_terms=("saldo", "pagar", "pago", "entrada", "saida", "vencimento", "mercado", "comida"),
        conflict_patterns=(r"\bcaixa\s+de\s+entrada\b", r"\bentrada\s+(?:do|de)\s+(?:e-?mail|gmail)\b"),
    ),
    NoraSkill(
        id="tarefas",
        name="Tarefas",
        description="Cria projetos e tarefas, consulta o Kanban e altera prioridade, prazo ou status.",
        examples=(
            "crie uma tarefa urgente no projeto Operacao Norium",
            "mova a tarefa contrato para em revisao",
            "crie um projeto chamado Atendimento Premium",
        ),
        strong_patterns=(
            r"\b(?:tarefa\w*|kanban|projeto\w*|lista\s+de\s+tarefas)\b",
            r"\b(?:pendente|andamento|revisao|concluida|prioridade|vencida|atrasada)\b",
            r"\b(?:me\s+lembre|me\s+lembra|preciso\s+fazer)\b",
        ),
        supporting_terms=("criar", "crie", "mover", "concluir", "finalizar", "responsavel", "prazo", "etiqueta"),
        conflict_patterns=(r"\bquando\b.+\b(?:tarefa|projeto)\b.+\b(?:avisar|enviar|notificar)\b",),
    ),
    NoraSkill(
        id="agenda",
        name="Agenda",
        description="Consulta disponibilidade e cria, edita ou cancela eventos e compromissos.",
        examples=(
            "crie um evento na minha agenda amanha as 15h",
            "quais sao meus compromissos de hoje",
            "edite a reuniao comercial e mude para sexta-feira",
        ),
        strong_patterns=(
            r"\b(?:agenda|calendario|evento\w*|compromisso\w*|reuniao|reunioes)\b",
            r"\b(?:agendar|agende|marcar\s+(?:uma\s+)?(?:call|reuniao)|horario\s+livre)\b",
        ),
        supporting_terms=("hoje", "amanha", "data", "horario", "editar", "cancelar", "disponibilidade", "ocupado", "livre"),
    ),
)


def normalize_skill_text(value: str) -> str:
    lowered = value.lower().strip()
    normalized = unicodedata.normalize("NFKD", lowered)
    return "".join(char for char in normalized if not unicodedata.combining(char))


def _pattern_hits(text: str, patterns: tuple[str, ...]) -> list[str]:
    return [pattern for pattern in patterns if re.search(pattern, text, flags=re.I | re.S)]


def _term_hits(text: str, terms: tuple[str, ...]) -> list[str]:
    exact = [term for term in terms if re.search(rf"(?<!\w){re.escape(term)}(?!\w)", text, flags=re.I)]
    words = re.findall(r"[a-z0-9@.-]+", text)
    fuzzy: list[str] = []
    for term in terms:
        if term in exact or " " in term or len(term) < 5:
            continue
        if any(SequenceMatcher(None, word, term).ratio() >= 0.82 for word in words if abs(len(word) - len(term)) <= 2):
            fuzzy.append(term)
    return [*exact, *fuzzy]


def _score_skill(skill: NoraSkill, text: str) -> tuple[float, tuple[str, ...]]:
    strong = _pattern_hits(text, skill.strong_patterns)
    supporting = _term_hits(text, skill.supporting_terms)
    conflicts = _pattern_hits(text, skill.conflict_patterns)
    score = (len(strong) * 5.0) + (min(len(supporting), 4) * 1.25) - (len(conflicts) * 6.0)

    if skill.id == "equipe" and re.search(r"\b(?:equipe|time)\b", text) and re.search(r"\b(?:mande|envie|avise|avisar|notifique|mensagem)\b", text):
        score += 7.0
    if skill.id == "automacoes" and re.search(r"\b(?:sempre\s+que|quando|ao\s+receber|ao\s+criar)\b", text) and re.search(r"\b(?:enviar|envie|avisar|avise|notificar|notifique|criar|crie|registrar|registre|resumir|resuma|classificar|classifique)\b", text):
        score += 12.0
    if skill.id == "email" and re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text):
        score += 8.0
    if skill.id == "email" and "caixa de entrada" in text:
        score += 8.0
    if skill.id == "financeiro" and re.search(r"\b(?:gastei|paguei|recebi|comprei|comprando)\b", text) and re.search(r"(?:r\$\s*)?\d+(?:[.,]\d{1,2})?", text):
        score += 8.0
    if skill.id == "tarefas" and re.search(r"\b(?:criar|crie|mover|concluir|finalizar)\b", text) and re.search(r"\b(?:tarefa|projeto|kanban)\b", text):
        score += 5.0
    if skill.id == "agenda" and re.search(r"\b(?:criar|crie|agendar|agende|marcar|editar|cancelar)\b", text) and re.search(r"\b(?:evento|agenda|reuniao|compromisso)\b", text):
        score += 5.0
    if skill.id == "brainstorm" and re.search(r"\b(?:criar|crie|abrir|abra|resumir|organizar|agrupar)\b", text) and re.search(r"\b(?:brain\s*storm|ideias|mapa\s+mental|quadro)\b", text):
        score += 7.0

    signals = tuple([f"forte:{item}" for item in strong] + [f"apoio:{item}" for item in supporting])
    return max(score, 0.0), signals


def rank_skills(message: str) -> list[dict[str, Any]]:
    text = normalize_skill_text(message)
    ranked: list[dict[str, Any]] = []
    for skill in SKILLS:
        score, signals = _score_skill(skill, text)
        ranked.append(
            {
                "skill_id": skill.id,
                "name": skill.name,
                "score": round(score, 3),
                "signals": list(signals),
            }
        )
    ranked.sort(key=lambda item: (-float(item["score"]), str(item["skill_id"])))
    return ranked


def resolve_skill(message: str) -> SkillResolution:
    ranked = rank_skills(message)
    top = ranked[0] if ranked else {"skill_id": "chat", "score": 0.0, "signals": []}
    second_score = float(ranked[1]["score"]) if len(ranked) > 1 else 0.0
    top_score = float(top["score"])
    margin_score = max(top_score - second_score, 0.0)

    if top_score <= 0:
        return SkillResolution(
            skill_id="chat",
            confidence=0.35,
            score=0.0,
            margin=0.0,
            needs_semantic_fallback=True,
            matched_signals=(),
            alternatives=tuple(ranked[:3]),
        )

    confidence = min(0.99, 0.42 + (top_score / 24.0) + (margin_score / 32.0))
    margin = min(1.0, margin_score / max(top_score, 1.0))
    needs_semantic = confidence < 0.74 or margin < 0.22
    return SkillResolution(
        skill_id=str(top["skill_id"]),
        confidence=round(confidence, 3),
        score=round(top_score, 3),
        margin=round(margin, 3),
        needs_semantic_fallback=needs_semantic,
        matched_signals=tuple(str(item) for item in top.get("signals", [])),
        alternatives=tuple(ranked[:3]),
    )


def skill_catalog_payload() -> list[dict[str, Any]]:
    return [
        {
            "id": skill.id,
            "name": skill.name,
            "description": skill.description,
            "examples": list(skill.examples),
        }
        for skill in SKILLS
    ]


def semantic_routing_prompt(message: str, resolution: SkillResolution, context: str = "") -> str:
    catalog = "\n".join(
        f"- {skill.id}: {skill.description} Exemplos: {' | '.join(skill.examples)}"
        for skill in SKILLS
    )
    catalog += (
        "\n- chat: Conversa geral da Nora quando a mensagem nao pede nenhuma acao das skills acima. "
        "Cobre small talk, curiosidades, perguntas genericas, piadas e pedidos de ajuda sem citar um "
        "modulo especifico do Norium. Exemplos: me conte uma curiosidade sobre o espaco | "
        "voce pode contar uma piada | qual e a capital da Australia | explique o que eu posso fazer "
        "nesta tela (sem citar um modulo especifico)"
    )
    alternatives = ", ".join(
        f"{item.get('skill_id')}={item.get('score')}" for item in resolution.alternatives
    )
    return (
        "Voce e o roteador de skills da Nora. Escolha a skill que representa a ACAO principal pedida pelo usuario. "
        "Diferencie o canal de destino do assunto: 'avise a equipe sobre tarefas' usa equipe; "
        "'quando chegar e-mail crie tarefa' usa automacoes; 'caixa de entrada' usa email, nunca financeiro. "
        "Se a mensagem nao pedir nenhuma acao das skills especificas e for so conversa, pergunta geral ou "
        "curiosidade, use chat -- nao chute uma skill especifica so porque ela existe na lista. "
        "Responda SOMENTE JSON valido: "
        '{"intent":"equipe|automacoes|brainstorm|operacoes|email|financeiro|tarefas|agenda|chat","confidence":0.0,"reason":"curto"}.\n\n'
        f"Skills disponiveis:\n{catalog}\n\n"
        f"Ranking deterministico: {alternatives}\n"
        f"Contexto recente: {context[-1200:] if context else 'nenhum'}\n"
        f"Mensagem atual: {message}"
    )
