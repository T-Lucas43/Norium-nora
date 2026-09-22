"""Pedidos à Nora sobre PDFs autorizados: resumo, pergunta e proposta derivada.

Caminho 100% determinístico, sem chamada a modelo e sem ferramentas: extração
e busca locais sobre PDFs do próprio tenant. O conteúdo do PDF é dado não
confiável — aparece apenas como trechos citados na resposta; nunca é
interpretado como instrução, nunca alimenta classificação de intenção e nunca
aciona agentes ou ferramentas. Este módulo não importa o roteador da Nora nem
qualquer agente: só serviços determinísticos de plataforma, comercial e
clientes.
"""

from __future__ import annotations

import asyncio
import re
import time
import unicodedata
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from app.modules.clients.repository import list_clients
from app.modules.commercial.repository import read_store
from app.modules.commercial.schemas import ProposalFromPdfRequest
from app.modules.commercial.service import (
    build_proposal_from_pdf_plan,
    collaboration_tenant_id,
    create_proposal_from_knowledge_pdf,
    ensure_pdf_creation_audit,
)
from app.modules.platform.pdf_text import find_accent_insensitive
from app.modules.platform.service import (
    list_collection,
    load_pdf_pages_for_user,
    query_knowledge_pdf,
)

MAX_SUMMARY_PAGES = 20
SUMMARY_BUDGET_CHARS = 4000

_PDF_WORDS = ("pdf", "documento", "arquivo", "anexo", "conhecimento")
_PROPOSAL_WORDS = ("proposta", "propostas", "minuta")
_CREATE_HINTS = (
    "mudando", "alterando", "trocando", "mude", "altere", "troque",
    "mudar", "alterar", "trocar", "apenas", "somente", "com base", "a partir",
    "crie", "criar", "gere", "gerar", "nova", "novo", "outra", "outro",
)
_QUESTION_HINTS = (
    "qual", "quais", "quanto", "quanta", "quantos", "quando", "onde", "como",
    "clausula", "valor", "prazo", "condicao", "artigo", "secao", "pagina",
    "multa", "vigencia", "rescisao", "pagamento", "?",
)
# Palavras de estrutura documental: pergunta fraca (sem "pdf" e sem título
# integral) só vira consulta ao PDF quando fala a língua do documento — assim
# "qual o valor da proposta?" continua no agente comercial.
_DOC_STRUCTURE_WORDS = (
    "clausula", "artigo", "secao", "pagina", "paragrafo", "inciso", "alinea",
    "capitulo",
)
_STOPWORDS = frozenset(
    """
    qual quais quanto quanta quantos quando onde como que e de do da dos das
    o a os as um uma este esta esse essa deste desse desta dessa no na nos nas
    ao pelo pela me meu minha sobre pdf documento arquivo anexo conhecimento
    diga fala fale mostre mostra traz traga leia lei la ai tem possui diz
    """.split()
)


def _norm(text: str) -> str:
    lowered = unicodedata.normalize("NFKD", str(text or "").lower())
    return "".join(char for char in lowered if not unicodedata.combining(char))


async def _pdf_documents(user: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in await list_collection(user, "knowledge")
        if item.get("sourceType") == "pdf"
    ]


def _split_matches(
    texto: str, documents: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Separa menções inequívocas (título integral) de menções fracas (palavra)."""
    strong: list[dict[str, Any]] = []
    weak: list[tuple[int, dict[str, Any]]] = []
    for doc in documents:
        title = str(doc.get("title") or "").strip()
        if not title:
            continue
        if find_accent_insensitive(texto, title) is not None:
            strong.append(doc)
            continue
        words = {word for word in _norm(title).split() if len(word) >= 5}
        hits = [word for word in words if find_accent_insensitive(texto, word) is not None]
        if hits:
            weak.append((len(hits), doc))
    weak.sort(key=lambda item: -item[0])
    return strong, [doc for _, doc in weak]


def _describe_documents(documents: list[dict[str, Any]]) -> str:
    names = [str(doc.get("title") or "sem título") for doc in documents[:8]]
    return "PDFs autorizados: " + "; ".join(f'"{name}"' for name in names) + "."


def _ask_which(
    documents: list[dict[str, Any]], matches: list[dict[str, Any]], purpose: str
) -> dict[str, Any]:
    if not documents:
        response = "Não encontrei nenhum PDF autorizado na base de conhecimento para " + purpose + "."
    elif len(matches) > 1:
        response = (
            "Encontrei mais de um PDF para " + purpose + ". Diga qual deles: "
            + _describe_documents(matches)
        )
    else:
        response = (
            "Não identifiquei qual PDF usar para " + purpose + ". " + _describe_documents(documents)
        )
    return {"intent": "operacoes", "status": "precisa_dados", "response": response}


def _strip_query_words(texto: str, document: dict[str, Any]) -> str:
    title_words = set(_norm(str(document.get("title") or "")).split())
    kept: list[str] = []
    for raw in re.split(r"\s+", str(texto or "")):
        word = _norm(raw).strip(" .,;:!?()\"'").strip()
        if not word or word in _STOPWORDS or word in title_words:
            continue
        kept.append(raw.strip(" .,;:!?()\"'"))
    return " ".join(kept)


def _page_selection(cleaned: str, per_page: int) -> tuple[str, bool]:
    """Seleciona trecho inicial e final quando a página excede o orçamento.

    Devolve (trecho, integral): integral só quando a página coube por inteiro.
    """
    if len(cleaned) <= per_page:
        return cleaned, True
    head = cleaned[: int(per_page * 0.6)].rsplit(" ", 1)[0]
    tail = cleaned[-max(1, per_page - int(per_page * 0.6)) :].split(" ", 1)[-1]
    return head + " […] " + tail, False


async def _summarize_pdf(user: dict[str, Any], document: dict[str, Any]) -> dict[str, Any]:
    doc_id = str(document.get("id"))
    _doc, pages = await load_pdf_pages_for_user(user, doc_id)
    total = len(pages)
    shown = min(total, MAX_SUMMARY_PAGES)
    per_page = max(120, min(400, SUMMARY_BUDGET_CHARS // max(1, shown)))
    chunks: list[str] = []
    citations: list[dict[str, Any]] = []
    fully_covered = 0
    for number in range(1, shown + 1):
        cleaned = re.sub(r"\s+", " ", pages[number - 1]).strip()
        excerpt, integral = _page_selection(cleaned, per_page)
        fully_covered += 1 if integral else 0
        chunks.append("p. " + str(number) + ": " + excerpt)
        citations.append({"page": number, "excerpt": excerpt})
    title = str(document.get("title") or "documento")
    complete = shown >= total and fully_covered >= shown
    if complete:
        coverage = "Li as " + str(total) + " páginas integralmente."
    elif shown < total:
        coverage = (
            "Seleção de trechos de " + str(shown) + " das " + str(total) + " páginas "
            "(não é leitura integral); " + str(fully_covered) + " cobertas por inteiro. "
            "Peça uma página ou um ponto específico para continuar."
        )
    else:
        coverage = (
            "Seleção de trechos iniciais e finais de cada página (não é leitura "
            "integral); " + str(fully_covered) + " de " + str(total)
            + " páginas cobertas por inteiro."
        )
    response = title + ": " + coverage + " Trechos por página:\n\n" + "\n\n".join(chunks)
    return {
        "intent": "operacoes",
        "status": "consulta",
        "response": response,
        "document": {"id": doc_id, "title": title, "pageCount": total},
        "coverage": {
            "pagesTotal": total,
            "pagesSummarized": shown,
            "pagesFullyCovered": fully_covered,
            "complete": complete,
        },
        "citations": citations,
        "modelTokensUsed": 0,
    }


async def _answer_pdf_question(
    user: dict[str, Any], document: dict[str, Any], texto: str
) -> dict[str, Any]:
    doc_id = str(document.get("id"))
    query = _strip_query_words(texto, document)
    if len(query) < 3:
        return {
            "intent": "operacoes",
            "status": "precisa_dados",
            "response": (
                "O que quer saber sobre o PDF \"" + str(document.get("title"))
                + "\"? Diga o ponto (valor, prazo, cláusula) com as suas palavras."
            ),
        }
    result = await query_knowledge_pdf(user, doc_id, query, 5)
    return {
        "intent": "operacoes",
        "status": "consulta",
        "response": result.get("answer", ""),
        "document": {"id": doc_id, "title": document.get("title")},
        "citations": result.get("excerpts", []),
        "conflicts": result.get("conflicts", []),
        "grounded": result.get("grounded", False),
        "modelTokensUsed": 0,
    }


_CHANGE_VERB = r"(?:mudando|alterando|trocando|mude|altere|troque|mudar|alterar|trocar)"

_DEMONSTRATIVE_FILLER = frozenset(
    "este esta esse essa isto isso o a os as um uma meu minha desse desta "
    "deste neste nesta naquele naquela pdf documento arquivo anexo conhecimento "
    "resuma resumir resumo sintetize sintese sumario leia lei mostre mostra "
    "traga traz diga fala fale consulte consultar busque buscar encontre por "
    "favor aqui agora mim"
    .split()
)


def _is_pure_demonstrative(normalized: str) -> bool:
    """Verdadeiro quando a mensagem só tem demonstrativos e ação genérica.

    Qualquer nome ou qualificador extra ("inexistente", "contrato X") é
    referência explícita: sem correspondência, pede-se correção da fonte em
    vez de usar outro arquivo.
    """
    tokens = [tok.strip(" .,;:!?()\"'") for tok in normalized.split()]
    return bool(tokens) and all(tok in _DEMONSTRATIVE_FILLER for tok in tokens)


def _clean_field_label(label: str) -> str:
    return re.sub(
        r"\s+(da|de|do|na|no)\s+(proposta|minuta|pdf|documento|contrato)$",
        "",
        label.strip(" .,;:"),
        flags=re.IGNORECASE,
    ).strip()


def _clean_field_value(value: str) -> str:
    value = re.sub(r"\s+para\s+(o|a)?\s*cliente\s+.*$", "", value.strip(" .,;:"), flags=re.IGNORECASE)
    return value.strip()


def _parse_single_change(segment: str) -> tuple[str | None, str | None]:
    match = re.match(
        r"(?:o|a|os|as|um|uma)?\s*(.+?)\s+(?:para|por|pelo|pela)\s+(.+)",
        segment.strip(),
        flags=re.IGNORECASE,
    )
    if not match:
        return None, None
    label = _clean_field_label(match.group(1))
    value = _clean_field_value(match.group(2))
    if len(label) < 2 or len(value) < 1:
        return None, None
    return label, value


def _parse_field_changes(texto: str) -> list[tuple[str, str]]:
    """Extrai uma ou mais trocas (campo, novo valor) sem misturar valores.

    "mude o prazo para 15 dias e o valor para R$ 20.000" vira dois pares.
    Qualquer trecho não interpretável invalida tudo: pede-se esclarecimento
    em vez de adivinhar. A vírgula decimal ("20.000,00") não separa trocas.
    """
    head = re.search(
        _CHANGE_VERB + r"\s+(?:apenas\s+|somente\s+|s[oó]\s+)?(.*)$",
        str(texto or ""),
        flags=re.IGNORECASE,
    )
    if not head:
        return []
    segments = [seg for seg in re.split(r"\s+e\s+|;\s*|,(?!\d)", head.group(1)) if seg.strip()]
    if not segments:
        return []
    pairs: list[tuple[str, str]] = []
    for segment in segments:
        label, value = _parse_single_change(segment)
        if not label or not value:
            return []
        pairs.append((label, value))
    return pairs


def _delimited_present(normalized_text: str, raw_value: Any) -> bool:
    """Diz se o valor aparece no texto com fronteira nos dois lados.

    Normaliza acentos/caixa e exige delimitador (início/fim ou caractere não
    alfanumérico) antes e depois do valor integral — "Ana" não casa com
    "semana", mas casa com "para a Ana,". E-mail exige o endereço literal.
    """
    candidate = re.sub(r"\s+", " ", _norm(str(raw_value or ""))).strip(" .,;:!?()\"'")
    if len(candidate) < 2:
        return False
    return (
        re.search(
            r"(?:^|[^a-z0-9])" + re.escape(candidate) + r"(?:[^a-z0-9]|$)",
            normalized_text,
        )
        is not None
    )


def _match_client(tenant: str, texto: str) -> dict[str, Any] | None:
    """Seleciona o cliente somente com identificação inequívoca.

    Nome, empresa ou e-mail precisam aparecer delimitados no pedido. Sem um
    único candidato seguro (zero ou dois ou mais), devolve None para pedir o
    cliente em vez de adivinhar.
    """
    normalized = re.sub(r"\s+", " ", _norm(texto))
    matches = [
        item
        for item in list_clients(tenant)
        if any(
            _delimited_present(normalized, token)
            for token in (item.get("name"), item.get("company"), item.get("email"))
        )
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def _client_options(tenant: str) -> str:
    clients = list_clients(tenant)
    if not clients:
        return "Ainda não há clientes cadastrados. Cadastre o cliente na tela Clientes e tente novamente."
    names = [
        str(item.get("name") or item.get("company") or item.get("email") or "Cliente")
        for item in clients[:8]
    ]
    return "Clientes disponíveis: " + ", ".join(names) + "."


# Máquina de estados da confirmação de proposta a partir de PDF.
#
#   awaiting_confirm --confirm--> creating --ok--> created       (terminal)
#   awaiting_confirm --confirm--> creating --audit-fail--> created(retry recupera)
#   awaiting_confirm --confirm--> creating --422--> awaiting_confirm
#   awaiting_confirm --cancel--> cancelled                       (terminal)
#   awaiting_confirm --adjust--> awaiting_confirm                (mesma operação)
#   awaiting_confirm --denied/unrelated--> awaiting_confirm      (sem mudança)
#
# O primeiro pedido identifica PDF/cliente/alterações, valida a viabilidade
# com o plano puro e devolve `confirmar` sem persistir nada. Só a confirmação
# afirmativa e inequívoca cria o rascunho. Depois do resultado terminal a
# conversa volta ao roteamento normal: a prévia é descartada e resta apenas
# um registro mínimo para reconhecer a repetição explícita da confirmação.
#
# Identidade: cada prévia recebe um `operation_id` (nonce seguro do servidor,
# nunca do usuário nem do PDF). A chave de idempotência É esse identificador,
# gravada em `metadata.pdfIdempotencyKey`: confirmações concorrentes e retry
# da mesma operação compartilham a chave; uma nova prévia — mesmo com conteúdo
# idêntico — recebe outro id e pode criar outro rascunho.
#
# Serialização: todas as transições do mesmo usuário passam por UMA trava por
# usuário (`_locked_user`); dentro dela, a transição só vale se a prévia ainda
# for a operação ativa (mesmo objeto e `operation_id`). Cancelar/ajustar nunca
# informam que impediram uma criação já decidida: com a trava, eles aguardam o
# terminal e respondem o resultado real.
#
# Premissas honestas: prévia, travas e retry vivem só na memória do worker e a
# topologia oficial fixa um worker e uma réplica (gate de release). Sem
# operação atômica no armazenamento compartilhado não há garantia entre
# réplicas — fora de escopo nesta rodada. A criação persistida continua
# idempotente por worker porque todo confirmar/retry reconfere o
# armazenamento pela chave antes de criar.
STAGE_AWAITING_CONFIRM = "awaiting_confirm"
STAGE_CREATING = "creating"
STAGE_CREATED = "created"
STAGE_CANCELLED = "cancelled"

_PENDING_TTL_SECONDS = 30 * 60
_COMPLETED_TTL_SECONDS = 30 * 60
_MAX_PREVIEWS = 512
_MAX_COMPLETED = 512
_MAX_USER_LOCKS = 512


@dataclass
class _PdfPreview:
    """Prévia validada aguardando confirmação afirmativa e inequívoca."""

    stage: str
    user_id: str
    document_id: str
    document_title: str
    client_id: str
    client_name: str
    changes: list[tuple[str, str]]
    changed_fields: list[str]
    warnings: list[str]
    verified: bool
    page_count: int
    operation_id: str
    created_at: float
    tenant: str = ""
    team_owner: str = ""


@dataclass
class _CompletedDraft:
    """Registro mínimo pós-terminal: só identifica o rascunho criado."""

    idempotency_key: str
    proposal_id: str
    completed_at: float
    tenant: str = ""
    team_owner: str = ""
    user_id: str = ""


# Chave estável do estado temporário: (collaboration_tenant_id(user), user_id).
# O teamOwnerId NÃO faz parte da chave: ele é guardado como snapshot no estado
# e revalidado em toda transição. Quando o contexto diverge, a entrada antiga
# é removida definitivamente (nunca apenas escondida), de modo que voltar ao
# contexto anterior não revive prévia nem retry. Toda transição é serializada
# pela trava da chave estável e fail-closed, sem expor dados do contexto antigo.
_ContextKey = tuple[str, str]
_pdf_previews: dict[_ContextKey, _PdfPreview] = {}
_completed_drafts: dict[_ContextKey, _CompletedDraft] = {}
_user_locks: dict[_ContextKey, asyncio.Lock] = {}
_user_lock_waiters: dict[_ContextKey, int] = {}

# Decisão explícita sobre a mensagem com prévia pendente. Ordem fixa:
# interrogativa > negação > "?" > cancelamento fechado > confirmação fechada
# (sem menção a PDF) > ajuste > assunto alheio.
_DECISION_CANCEL = "cancel"
_DECISION_DENIED = "denied"
_DECISION_CONFIRM = "confirm"
_DECISION_ADJUST = "adjust"
_DECISION_UNRELATED = "unrelated"

_NEGATION = re.compile(r"\b(nao|nunca|jamais|nem|tampouco)\b")
_QUESTION_OPENERS = (
    "como ", "qual ", "quais ", "quanto ", "quanta ", "quantos ",
    "quando ", "onde ", "por que ", "porque ", "o que ",
)
# Forma interrogativa sem "?" (detectada antes de remover pontuação):
# "voce pode..." / "poderia criar..." nunca confirmam, mesmo sem "?".
_INTERROGATIVE_OPENERS = _QUESTION_OPENERS + (
    "voce ", "vcs ", "poderia ", "poderiam ", "posso ", "consigo ",
    "tem como ", "e possivel ", "seria ",
)
_CANCEL_VERBS = ("cancelar", "cancele", "cancelo", "desistir", "desisto", "parar")
_CREATION_VERBS = (
    "criar", "crie", "crio", "gerar", "gere",
    "confirmar", "confirmo", "confirme", "confirmado",
)
_APPROVE_VERBS = ("aprovar", "aprovo", "aprovado", "aprovada")
_ADJUST_VERBS = (
    "mudando", "alterando", "trocando", "mude", "altere", "troque",
    "mudar", "alterar", "trocar",
)
_PROPOSAL_NOUNS = ("proposta", "rascunho", "previa", "minuta")
# Respostas curtas aceitas como confirmação direta da prévia em tela:
# somente comandos específicos. Afirmativas genéricas (`sim`, `ok`) nunca
# confirmam sozinhas — depois que uma mensagem alheia passou pelo roteamento,
# um `sim` genérico não pode reativar e confirmar a proposta antiga.
_WHOLE_CONFIRM = frozenset({
    "confirmar", "confirmo", "confirmado", "confirme",
    "pode criar", "pode gerar", "pode confirmar",
})
# Gramática afirmativa fechada e ancorada: o verbo precisa governar
# diretamente o rascunho atual (determinante + substantivo da proposta).
# Co-ocorrência global ("gere um resumo da proposta", "crie uma tarefa para
# revisar a proposta") NÃO confirma. Lista pequena e ancorada (^...$).
_CONFIRM_BARE = re.compile(
    r"^(?:por favor,?\s+)?(?:confirmar|confirmo|confirmado|confirme)"
    r"(?:\s+por favor)?$"
)
_CONFIRM_PODE_BARE = re.compile(
    r"^(?:por favor,?\s+)?pode\s+(?:criar|gerar|confirmar)(?:\s+por favor)?$"
)
_CONFIRM_PODE_DET = re.compile(
    r"^(?:por favor,?\s+)?pode\s+(?:criar|gerar|confirmar)\s+"
    r"(?:esta|este|esse|essa|o|a|os|as|um|uma|meu|minha)\s+"
    r"(?:proposta|propostas|rascunho|previa|minuta)(?:\s+por favor)?$"
)
_CONFIRM_VERB_DET = re.compile(
    r"^(?:por favor,?\s+)?(?:confirmo|confirmar|confirme|confirmado|aprovo|aprovar)\s+"
    r"(?:esta|este|esse|essa|o|a|os|as|um|uma|meu|minha)\s+"
    r"(?:proposta|propostas|rascunho|previa|minuta)(?:\s+por favor)?$"
)
_CONFIRM_IMPERATIVE_DET = re.compile(
    r"^(?:por favor,?\s+)?(?:crie|gere)\s+"
    r"(?:esta|este|esse|essa|o|a|os|as|um|uma|meu|minha)\s+"
    r"(?:proposta|propostas|rascunho|previa|minuta)(?:\s+por favor)?$"
)
_CONFIRM_PREFIX = re.compile(r"^(?:sim|ok|certo|fechado|entao)\s*,\s*")
_CONFIRM_PLEASE_PREFIX = re.compile(r"^(?:por favor,?\s+)+")
_PLEASE_PREFIX = _CONFIRM_PLEASE_PREFIX
# Gramática fechada e ancorada do cancelamento: somente comandos explícitos
# referentes à operação atual. Perguntas ("Isso vai cancelar?") e intenção
# cruzada ("crie uma tarefa para cancelar a reunião") NÃO cancelam.
_WHOLE_CANCEL = frozenset({
    "cancelar", "cancele", "cancelo", "desistir", "desisto", "parar",
})
_CANCEL_BARE = re.compile(
    r"^(?:por favor,?\s+)?(?:cancelar|cancele|cancelo|desistir|desisto|parar)"
    r"(?:\s+por favor)?$"
)
_CANCEL_DET = re.compile(
    r"^(?:por favor,?\s+)?(?:cancelar|cancele|cancelo|desistir|desisto|parar)\s+"
    r"(?:esta|este|esse|essa|o|a|os|as|um|uma|meu|minha)\s+"
    r"(?:proposta|propostas|rascunho|previa|minuta)(?:\s+por favor)?$"
)


def _is_closed_cancel(whole: str) -> bool:
    """Cancelamento explícito e ancorado da operação atual."""
    if whole in _WHOLE_CANCEL:
        return True
    core = _PLEASE_PREFIX.sub("", whole)
    if not core:
        return False
    return bool(
        _CANCEL_BARE.match(core)
        or _CANCEL_DET.match(core)
    )


def _strip_confirm_wrapper(whole: str) -> str:
    """Remove invólucro externo sem abrir a gramática central.

    Só remove "por favor" e UMA abertura afirmativa seguida de vírgula
    ("sim, ..."). "sim, gere um resumo" continua sem confirmar porque o
    restante ("gere um resumo") não casa com nenhum padrão ancorado.
    """
    text = _CONFIRM_PLEASE_PREFIX.sub("", whole)
    text = _CONFIRM_PREFIX.sub("", text)
    return _CONFIRM_PLEASE_PREFIX.sub("", text)


def _is_closed_confirm(whole: str) -> bool:
    """Confirmação afirmativa, inequívoca e ancorada do rascunho atual."""
    if whole in _WHOLE_CONFIRM:
        return True
    core = _strip_confirm_wrapper(whole)
    if not core:
        return False
    return bool(
        _CONFIRM_BARE.match(core)
        or _CONFIRM_PODE_BARE.match(core)
        or _CONFIRM_PODE_DET.match(core)
        or _CONFIRM_VERB_DET.match(core)
        or _CONFIRM_IMPERATIVE_DET.match(core)
    )


def _user_key(user: dict[str, Any]) -> str:
    return str(user.get("id") or "")


def _tenant_of(user: dict[str, Any]) -> str:
    return collaboration_tenant_id(user)


def _team_owner_of(user: dict[str, Any]) -> str:
    return str(user.get("teamOwnerId") or "")


def _context_key(user: dict[str, Any]) -> _ContextKey:
    """Chave estável (tenant, usuário) do estado temporário."""
    return (_tenant_of(user), _user_key(user))


def _preview_tenant_ok(user: dict[str, Any], preview: _PdfPreview) -> bool:
    return (
        preview.tenant == _tenant_of(user)
        and preview.team_owner == _team_owner_of(user)
        and preview.user_id == _user_key(user)
    )


def _completed_tenant_ok(user: dict[str, Any], completed: _CompletedDraft) -> bool:
    return (
        completed.tenant == _tenant_of(user)
        and completed.team_owner == _team_owner_of(user)
    )


def _tenant_mismatch_response() -> dict[str, Any]:
    """Fail-closed sem expor título, cliente, alterações ou resultado antigo."""
    return {
        "intent": "comercial",
        "status": "precisa_dados",
        "response": (
            "O contexto de colaboração mudou e a prévia anterior não está "
            "mais válida neste contexto. Refaça o pedido a partir do PDF "
            "autorizado neste contexto."
        ),
    }


def _invalidate_user_state(user: dict[str, Any]) -> None:
    """Remove definitivamente prévia e concluído do usuário.

    Usado quando o snapshot de contexto (teamOwnerId) diverge do atual: o
    estado antigo nunca pode ser revivido voltando ao contexto anterior.
    Não expõe nem consulta nada do contexto antigo.
    """
    key = _context_key(user)
    _pdf_previews.pop(key, None)
    _completed_drafts.pop(key, None)


def _invalidate_locked(user: dict[str, Any]) -> None:
    """Invalida prévia e concluído assumindo a trava estável já detida.

    Nunca chamar fora de `_locked_user`: fora da trava nenhum helper pode
    remover ou substituir `_pdf_previews` ou `_completed_drafts`.
    """
    key = _context_key(user)
    _pdf_previews.pop(key, None)
    _completed_drafts.pop(key, None)


def _get_preview_locked(user: dict[str, Any]) -> _PdfPreview | None:
    """Localiza a prévia assumindo a trava estável já detida.

    Revalida o snapshot (`teamOwnerId`); mismatch invalida dentro da trava
    sem expor dados. Com a trava detida nunca expira aqui: o chamador decide
    via `_is_current_operation_locked` e delega ao terminal quando preciso.
    """
    key = _context_key(user)
    preview = _pdf_previews.get(key)
    if preview is None:
        return None
    if not _preview_tenant_ok(user, preview):
        _invalidate_locked(user)
        return None
    return preview


def _get_completed_locked(user: dict[str, Any]) -> _CompletedDraft | None:
    """Localiza o concluído assumindo a trava estável já detida.

    Revalida o snapshot; mismatch invalida dentro da trava sem expor dados
    e sem consultar a proposta antiga com o tenant novo.
    """
    key = _context_key(user)
    completed = _completed_drafts.get(key)
    if completed is None:
        return None
    if not _completed_tenant_ok(user, completed):
        _invalidate_locked(user)
        return None
    return completed


def _set_completed_locked(user: dict[str, Any], key: str, proposal_id: str) -> None:
    """Publica o estado terminal assumindo a trava estável já detida."""
    context = _context_key(user)
    _completed_drafts[context] = _CompletedDraft(
        idempotency_key=key,
        proposal_id=proposal_id,
        completed_at=time.time(),
        tenant=_tenant_of(user),
        team_owner=_team_owner_of(user),
        user_id=_user_key(user),
    )


def _clear_locked(user: dict[str, Any]) -> None:
    """Descarta prévia e retry assumindo a trava estável já detida."""
    context = _context_key(user)
    _pdf_previews.pop(context, None)
    _completed_drafts.pop(context, None)


def _pop_preview_if_current_locked(key: _ContextKey, preview: _PdfPreview) -> None:
    """Remove a prévia somente se ainda for a operação ativa (sob trava)."""
    if _pdf_previews.get(key) is preview:
        _pdf_previews.pop(key, None)


def _restore_preview_after_failure_locked(
    user: dict[str, Any], preview: _PdfPreview, context: _ContextKey
) -> bool:
    """Restaura `awaiting_confirm` assumindo a trava estável já detida."""
    if not _preview_tenant_ok(user, preview):
        return False
    current = _pdf_previews.get(context)
    if current is not preview or current.operation_id != preview.operation_id:
        return False
    preview.stage = STAGE_AWAITING_CONFIRM
    preview.created_at = time.time()
    return True


def _is_current_operation_locked(user: dict[str, Any], preview: _PdfPreview) -> bool:
    """Diz se a prévia é a operação ativa, assumindo a trava já detida.

    Nunca remove nada: com a trava detida o TTL não expira aqui — a decisão
    de delegar ao terminal cabe ao chamador.
    """
    if not _preview_tenant_ok(user, preview):
        return False
    key = _context_key(user)
    current = _pdf_previews.get(key)
    if current is not preview or current.operation_id != preview.operation_id:
        return False
    if current.stage != STAGE_CREATING and time.time() - current.created_at > _PENDING_TTL_SECONDS:
        return False
    return True


def _restore_preview_after_failure(
    user: dict[str, Any], preview: _PdfPreview, context: _ContextKey
) -> bool:
    """Restaura `awaiting_confirm` com lease renovado, sem duplicar nada.

    Só restaura quando a prévia continua sendo a operação atual (mesmo objeto
    e mesmo `operation_id`, com o tenant ainda válido): nunca ressuscita uma
    operação já substituída. Preserva alterações, cliente, documento e
    `operation_id`; não cria proposta nem auditoria. Devolve True se restaurou.
    """
    if not _preview_tenant_ok(user, preview):
        return False
    current = _pdf_previews.get(context)
    if current is not preview or current.operation_id != preview.operation_id:
        return False
    preview.stage = STAGE_AWAITING_CONFIRM
    preview.created_at = time.time()
    return True


def _lock_held_or_waiting(key: _ContextKey) -> bool:
    lock = _user_locks.get(key)
    if lock is not None and lock.locked():
        return True
    return _user_lock_waiters.get(key, 0) > 0


def _whole_message(normalized: str) -> str:
    return re.sub(r"\s+", " ", normalized).strip(" .,;:!?()\"'")


def _has_token(normalized: str, word: str) -> bool:
    return (
        re.search(r"(?:^|[^a-z0-9])" + re.escape(word) + r"(?:[^a-z0-9]|$)", normalized)
        is not None
    )


def _clauses(normalized: str) -> list[str]:
    return [part.strip() for part in re.split(r"[,;.!?]+", normalized) if part.strip()]


def _classify_pending_message(texto: str) -> str:
    """Classifica a mensagem diante de uma prévia pendente (gramática fechada).

    Só confirma a resposta afirmativa e inequívoca do rascunho atual, por
    padrões ancorados (^...$) em que o verbo governa diretamente a proposta:
    `confirmar`, `pode criar`, `pode criar esta proposta`, `pode criar o
    rascunho`, `confirmo esta proposta` e formas equivalentes da lista
    fechada. "?" preservado bloqueia a confirmação: pergunta nunca confirma,
    mesmo contendo frase afirmativa sem o "?". Forma interrogativa
    ("voce ...", "poderia ...", "como ...") também bloqueia. Co-ocorrência
    global de verbo + substantivo ("gere um resumo da proposta", "crie uma
    tarefa para revisar a proposta") NÃO confirma. Negação na mesma oração
    ("não criar ainda") segura a prévia. Menção a PDF/documento suprime a
    confirmação (pode ser outro pedido). O cancelamento usa gramática fechada
    análoga (`cancelar`, `cancele o rascunho`); perguntas e intenção cruzada
    ("Isso vai cancelar?", "crie uma tarefa para cancelar a reunião") NÃO
    cancelam. Trechos do PDF nunca passam por aqui — só a mensagem do usuário.
    """
    raw_has_question = "?" in str(texto or "")
    normalized = re.sub(r"\s+", " ", _norm(texto))
    whole = _whole_message(normalized)
    if whole.startswith(_INTERROGATIVE_OPENERS):
        return _DECISION_UNRELATED
    parts = _clauses(normalized)
    scoped_verbs = (*_CANCEL_VERBS, *_CREATION_VERBS, *_APPROVE_VERBS, *_ADJUST_VERBS)
    negated = any(
        _NEGATION.search(part) is not None
        and any(_has_token(part, verb) for verb in scoped_verbs)
        for part in parts
    )
    if negated:
        return _DECISION_DENIED
    if raw_has_question:
        return _DECISION_UNRELATED
    if _is_closed_cancel(whole):
        return _DECISION_CANCEL
    # Menção a PDF/documento indica outro pedido (ex.: "crie outra proposta
    # com base no PDF Y"): nunca confirma a prévia atual — fail-closed, pois
    # criar é irreversível e a prévia segue intacta para repetir "confirmar".
    pdf_mentioned = any(word in normalized for word in _PDF_WORDS)
    if not pdf_mentioned and _is_closed_confirm(whole):
        return _DECISION_CONFIRM
    if _parse_field_changes(texto):
        return _DECISION_ADJUST
    return _DECISION_UNRELATED


def _is_retry_confirm(texto: str) -> bool:
    """Diz se a mensagem repete explicitamente a confirmação, sem abrir pedido novo.

    Usado após o terminal, quando não há prévia: evita que um pedido novo
    ("crie outra proposta com base no PDF Y...") seja lido como retry e
    devolva o rascunho antigo em vez de começar outra prévia. Usa a mesma
    gramática fechada da confirmação; pergunta nunca é retry.
    """
    if "?" in str(texto or ""):
        return False
    normalized = re.sub(r"\s+", " ", _norm(texto))
    whole = _whole_message(normalized)
    if whole.startswith(_INTERROGATIVE_OPENERS):
        return False
    if _NEGATION.search(normalized) is not None:
        return False
    if any(word in normalized for word in _PDF_WORDS):
        return False
    if _parse_field_changes(texto):
        return False
    return _is_closed_confirm(whole)


def _new_operation_id() -> str:
    """Nonce seguro do servidor que identifica UMA operação de confirmação.

    Conteúdo idêntico em outra prévia recebe outro id — a chave nunca conflui
    pedidos legítimos distintos. Nunca usa horário sozinho nem dado do usuário.
    """
    return uuid.uuid4().hex


def _preview_is_active(key: _ContextKey, preview: _PdfPreview) -> bool:
    """Operação ativa: em `creating` ou com trava detida/aguardantes."""
    if preview.stage == STAGE_CREATING:
        return True
    return _lock_held_or_waiting(key)


def _sweep_pdf_request_state(now: float | None = None) -> None:
    """Limpeza oportunista e limitada, sem tarefa de background.

    Nunca remove prévia em `creating`, estado com trava detida, nem estado
    com holders/waiters. O teto prefere expirados e `awaiting_confirm` mais
    antigos; se todos os excedentes estiverem ativos, ultrapassa o teto
    temporariamente. A operação ativa só sai no terminal.
    """
    moment = time.time() if now is None else now
    for key in [
        key for key, preview in _pdf_previews.items()
        if moment - preview.created_at > _PENDING_TTL_SECONDS
        and preview.stage != STAGE_CREATING
        and not _lock_held_or_waiting(key)
    ]:
        _pdf_previews.pop(key, None)
    for key in [
        key for key, completed in _completed_drafts.items()
        if moment - completed.completed_at > _COMPLETED_TTL_SECONDS
        and not _lock_held_or_waiting(key)
    ]:
        _completed_drafts.pop(key, None)

    def _preview_victim_order(item: tuple[_ContextKey, _PdfPreview]) -> tuple[int, float]:
        key, preview = item
        expired = 0 if moment - preview.created_at > _PENDING_TTL_SECONDS else 1
        return (expired, preview.created_at)

    while len(_pdf_previews) > _MAX_PREVIEWS:
        candidates = [
            (key, preview) for key, preview in _pdf_previews.items()
            if not _preview_is_active(key, preview)
        ]
        if not candidates:
            break
        victim = min(candidates, key=_preview_victim_order)[0]
        _pdf_previews.pop(victim, None)
    while len(_completed_drafts) > _MAX_COMPLETED:
        candidates = [
            (key, completed) for key, completed in _completed_drafts.items()
            if not _lock_held_or_waiting(key)
        ]
        if not candidates:
            break
        victim = min(candidates, key=lambda item: item[1].completed_at)[0]
        _completed_drafts.pop(victim, None)
    for key in [
        key for key, lock in _user_locks.items()
        if not lock.locked()
        and _user_lock_waiters.get(key, 0) <= 0
        and key not in _pdf_previews
        and key not in _completed_drafts
    ]:
        _user_locks.pop(key, None)
    while len(_user_locks) > _MAX_USER_LOCKS:
        idle = next(
            (
                key for key, lock in _user_locks.items()
                if not lock.locked()
                and _user_lock_waiters.get(key, 0) <= 0
                and key not in _pdf_previews
                and key not in _completed_drafts
            ),
            None,
        )
        if idle is None:
            break
        _user_locks.pop(idle, None)


@asynccontextmanager
async def _locked_user(key: _ContextKey):
    """Uma trava por contexto (tenant, usuário) para todas as transições.

    A contagem de aguardantes é atualizada sem `await` no meio (atômica no
    loop), então a limpeza nunca remove uma trava com alguém aguardando — e
    nunca se adquire esta trava recursivamente: as variantes `*_locked`
    presumem que o chamador já a detém.
    """
    _sweep_pdf_request_state()
    _user_lock_waiters[key] = _user_lock_waiters.get(key, 0) + 1
    lock = _user_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _user_locks[key] = lock
    try:
        async with lock:
            yield lock
    finally:
        remaining = _user_lock_waiters.get(key, 1) - 1
        if remaining <= 0:
            _user_lock_waiters.pop(key, None)
        else:
            _user_lock_waiters[key] = remaining
        if (
            not lock.locked()
            and _user_lock_waiters.get(key, 0) <= 0
            and key not in _pdf_previews
            and key not in _completed_drafts
        ):
            _user_locks.pop(key, None)


def _find_proposal_by_idempotency_key(tenant_id: str, key: str) -> dict[str, Any] | None:
    """Localiza no armazenamento o rascunho já criado para a chave."""
    proposals = read_store(tenant_id).get("proposals", [])
    for item in proposals:
        if not isinstance(item, dict):
            continue
        metadata = item.get("metadata")
        if isinstance(metadata, dict) and str(metadata.get("pdfIdempotencyKey") or "") == key:
            return item
    return None


def _stored_result(proposal: dict[str, Any]) -> dict[str, Any]:
    """Reconstrói o resultado a partir da proposta armazenada (retry)."""
    metadata = proposal.get("metadata") if isinstance(proposal.get("metadata"), dict) else {}
    return {
        "proposal": proposal,
        "source": {
            "documentId": metadata.get("sourcePdfDocumentId"),
            "title": metadata.get("sourcePdfTitle"),
            "pageCount": metadata.get("sourcePdfPages"),
            "sourceUrl": None,
        },
        "changedFields": list(metadata.get("changedFields") or []),
        "warnings": list(metadata.get("pdfWarnings") or []),
        "verified": bool(metadata.get("pdfVerified", False)),
    }


def _get_preview(user: dict[str, Any]) -> _PdfPreview | None:
    _sweep_pdf_request_state()
    key = _context_key(user)
    preview = _pdf_previews.get(key)
    if preview is None:
        return None
    if not _preview_tenant_ok(user, preview):
        _invalidate_user_state(user)
        return None
    if time.time() - preview.created_at > _PENDING_TTL_SECONDS:
        if preview.stage == STAGE_CREATING or _lock_held_or_waiting(key):
            return preview
        _pdf_previews.pop(key, None)
        return None
    return preview


def _get_completed(user: dict[str, Any]) -> _CompletedDraft | None:
    _sweep_pdf_request_state()
    key = _context_key(user)
    completed = _completed_drafts.get(key)
    if completed is None:
        return None
    if not _completed_tenant_ok(user, completed):
        _invalidate_user_state(user)
        return None
    if time.time() - completed.completed_at > _COMPLETED_TTL_SECONDS:
        if _lock_held_or_waiting(key):
            return completed
        _completed_drafts.pop(key, None)
        return None
    return completed


def _set_completed(user: dict[str, Any], key: str, proposal_id: str) -> None:
    _sweep_pdf_request_state()
    context = _context_key(user)
    _completed_drafts[context] = _CompletedDraft(
        idempotency_key=key,
        proposal_id=proposal_id,
        completed_at=time.time(),
        tenant=_tenant_of(user),
        team_owner=_team_owner_of(user),
        user_id=_user_key(user),
    )


def _clear_conversation(user: dict[str, Any]) -> None:
    """Terminal: descarta prévia e retry; o chat volta ao roteamento normal."""
    context = _context_key(user)
    _pdf_previews.pop(context, None)
    _completed_drafts.pop(context, None)


def _preview_response(preview: _PdfPreview, *, updated: bool = False) -> dict[str, Any]:
    detail = "; ".join(f"{label} → {value}" for label, value in preview.changes)
    return {
        "intent": "comercial",
        "status": "confirmar",
        "response": (
            ("Prévia atualizada" if updated else "Preparei a prévia")
            + " a partir do PDF \"" + preview.document_title + "\" para "
            + preview.client_name + ". Campos a alterar: " + detail + ". "
            "Diga \"confirmar\" para criar o rascunho privado ou \"cancelar\" "
            "para desistir. Nada foi criado ainda."
        ),
        "preview": {
            "documentId": preview.document_id,
            "documentTitle": preview.document_title,
            "clientId": preview.client_id,
            "clientName": preview.client_name,
            "changes": [{"field": label, "value": value} for label, value in preview.changes],
            "changedFields": list(preview.changed_fields),
            "warnings": list(preview.warnings),
            "verified": preview.verified,
        },
        "modelTokensUsed": 0,
    }


def _hold_preview_response(preview: _PdfPreview) -> dict[str, Any]:
    """Prévia mantida após negação: nada criado, nada cancelado."""
    return {
        "intent": "comercial",
        "status": "confirmar",
        "response": (
            "Entendi — não criei nada. A prévia a partir do PDF \""
            + preview.document_title + "\" continua valendo. Diga \"confirmar\" "
            "para criar o rascunho privado, \"cancelar\" para desistir ou "
            "informe um ajuste como campo e novo valor."
        ),
        "preview": {
            "documentId": preview.document_id,
            "documentTitle": preview.document_title,
            "clientId": preview.client_id,
            "clientName": preview.client_name,
            "changes": [{"field": label, "value": value} for label, value in preview.changes],
            "changedFields": list(preview.changed_fields),
            "warnings": list(preview.warnings),
            "verified": preview.verified,
        },
        "modelTokensUsed": 0,
    }


def _created_response(proposal: dict[str, Any], result: dict[str, Any], document_title: str) -> dict[str, Any]:
    lines = [
        "Criei o rascunho privado \"" + str(proposal.get("title")) + "\" a partir do PDF \""
        + str(document_title) + "\" (" + str(result["source"]["pageCount"]) + " páginas).",
        "Campos alterados: " + ", ".join(result["changedFields"]) + ".",
    ]
    if result.get("warnings"):
        lines.append("Avisos: " + " ".join(result["warnings"]))
    if not result.get("verified"):
        lines.append("Confira o rascunho antes de usar: a verificação contra a fonte apontou divergência.")
    lines.append("Nada foi publicado, enviado ou encaminhado para assinatura.")
    return {
        "intent": "comercial",
        "status": "criada",
        "response": " ".join(lines),
        "proposal": proposal,
        "changedFields": result["changedFields"],
        "warnings": result["warnings"],
        "verified": result["verified"],
        "modelTokensUsed": 0,
    }


def _preview_payload(
    document: dict[str, Any], client: dict[str, Any], texto: str
) -> ProposalFromPdfRequest:
    return ProposalFromPdfRequest(
        documentId=str(document.get("id")),
        clientId=str(client.get("id")),
        fieldOverrides=dict(_parse_field_changes(texto)),
    )


async def _prepare_proposal_from_pdf_request(
    user: dict[str, Any], document: dict[str, Any], texto: str
) -> dict[str, Any]:
    """Primeiro pedido: identifica, valida e devolve prévia, sem persistir.

    Serializado pela mesma trava de contexto da confirmação: preparação
    (plano com awaits) e publicação ocorrem dentro de `_locked_user`. Um novo
    pedido válido substitui a prévia anterior SOMENTE após validado com
    sucesso (novo `operation_id`); preparação inválida preserva a prévia
    válida existente. Antes de publicar, revalida que tenant/usuário seguem
    sendo o contexto esperado. Não há dois estados ativos por contexto.
    """
    expected_context = _context_key(user)
    expected_tenant = _tenant_of(user)
    async with _locked_user(expected_context):
        if _context_key(user) != expected_context or _tenant_of(user) != expected_tenant:
            _invalidate_locked(user)
            return _tenant_mismatch_response()
        doc_id = str(document.get("id"))
        changes = _parse_field_changes(texto)
        if not changes:
            return {
                "intent": "comercial",
                "status": "precisa_dados",
                "response": (
                    "Para criar a proposta a partir do PDF \"" + str(document.get("title"))
                    + "\", diga o campo e o novo valor — por exemplo: "
                    "\"crie outra proposta mudando apenas o prazo para 15 dias\"."
                ),
            }
        tenant = collaboration_tenant_id(user)
        client = _match_client(tenant, texto)
        if client is None:
            return {
                "intent": "comercial",
                "status": "precisa_dados",
                "response": (
                    "Para qual cliente crio a proposta? " + _client_options(tenant)
                ),
            }
        try:
            plan = await build_proposal_from_pdf_plan(
                user, doc_id, _preview_payload(document, client, texto)
            )
        except HTTPException as exc:
            return {
                "intent": "comercial",
                "status": "precisa_dados",
                "response": str(exc.detail),
            }
        if _context_key(user) != expected_context or _tenant_of(user) != expected_tenant:
            _invalidate_locked(user)
            return _tenant_mismatch_response()
        preview = _PdfPreview(
            stage=STAGE_AWAITING_CONFIRM,
            user_id=_user_key(user),
            document_id=doc_id,
            document_title=str(document.get("title")),
            client_id=str(client.get("id")),
            client_name=str(client.get("name") or client.get("company") or client.get("email")),
            changes=changes,
            changed_fields=list(plan["changed_fields"]),
            warnings=list(plan["warnings"]),
            verified=bool(plan["verified"]),
            page_count=len(plan["pages"]),
            operation_id=_new_operation_id(),
            created_at=time.time(),
            tenant=_tenant_of(user),
            team_owner=_team_owner_of(user),
        )
        _pdf_previews[expected_context] = preview
        return _preview_response(preview)


def _is_current_operation(user: dict[str, Any], preview: _PdfPreview) -> bool:
    """Confere se a prévia continua sendo a operação ativa do contexto.

    Vale somente para o mesmo objeto, mesmo `operation_id`, mesmo tenant e
    dentro do TTL (`creating` nunca expira aqui — só sai no terminal).
    Chamada sempre dentro da trava do contexto.
    """
    key = _context_key(user)
    if not _preview_tenant_ok(user, preview):
        return False
    current = _pdf_previews.get(key)
    if current is not preview or current.operation_id != preview.operation_id:
        return False
    if current.stage != STAGE_CREATING and time.time() - current.created_at > _PENDING_TTL_SECONDS:
        if not _lock_held_or_waiting(key):
            _pdf_previews.pop(key, None)
        return False
    return True


def _is_active_preview(user: dict[str, Any], preview: _PdfPreview) -> bool:
    """Operação ativa E ainda em `awaiting_confirm` (editável)."""
    return _is_current_operation(user, preview) and preview.stage == STAGE_AWAITING_CONFIRM


def _is_active_preview_locked(user: dict[str, Any], preview: _PdfPreview) -> bool:
    """Operação ativa e editável, assumindo a trava estável já detida."""
    return _is_current_operation_locked(user, preview) and preview.stage == STAGE_AWAITING_CONFIRM


def _stale_preview_response() -> dict[str, Any]:
    return {
        "intent": "comercial",
        "status": "precisa_dados",
        "response": (
            "A prévia não está mais ativa (a proposta já foi criada ou a "
            "conversa foi encerrada). Refaça o pedido a partir do PDF para "
            "gerar uma nova prévia."
        ),
    }


def _processing_response() -> dict[str, Any]:
    return {
        "intent": "comercial",
        "status": "confirmar",
        "response": (
            "A criação já está em andamento. Aguarde o resultado antes de "
            "enviar outro comando para esta proposta."
        ),
    }


def _pop_preview_if_current(key: _ContextKey, preview: _PdfPreview) -> None:
    if _pdf_previews.get(key) is preview:
        _pdf_previews.pop(key, None)


async def _adjust_locked(
    user: dict[str, Any], preview: _PdfPreview, texto: str
) -> dict[str, Any] | None:
    """Ajuste sob a trava do contexto, sem sair de `awaiting_confirm`.

    Captura cópia imutável dos campos antes dos awaits, revalida pelo plano
    puro e só escreve se a prévia continuar sendo a operação ativa (mesmo
    objeto, id, estágio e tenant). A chave da operação não muda no ajuste:
    é a mesma operação refinada. Plano inválido mantém a última prévia válida.
    """
    if not _preview_tenant_ok(user, preview):
        _invalidate_locked(user)
        return _tenant_mismatch_response()
    if not _is_active_preview_locked(user, preview):
        return _processing_response()
    changes = list(_parse_field_changes(texto))
    if not changes:
        return None
    document_id = preview.document_id
    client_id = preview.client_id
    tenant = collaboration_tenant_id(user)
    client = next(
        (item for item in list_clients(tenant) if str(item.get("id")) == client_id),
        None,
    )
    if client is None:
        return {
            "intent": "comercial",
            "status": "precisa_dados",
            "response": "Não encontrei mais o cliente da prévia. Diga para qual cliente crio a proposta.",
        }
    try:
        plan = await build_proposal_from_pdf_plan(
            user,
            document_id,
            ProposalFromPdfRequest(
                documentId=document_id,
                clientId=client_id,
                fieldOverrides=dict(changes),
            ),
        )
    except HTTPException as exc:
        return {
            "intent": "comercial",
            "status": "precisa_dados",
            "response": str(exc.detail),
        }
    if not _preview_tenant_ok(user, preview):
        _invalidate_locked(user)
        return _tenant_mismatch_response()
    if not _is_active_preview_locked(user, preview):
        return _stale_preview_response()
    preview.changes = changes
    preview.changed_fields = list(plan["changed_fields"])
    preview.warnings = list(plan["warnings"])
    preview.verified = bool(plan["verified"])
    preview.page_count = len(plan["pages"])
    preview.created_at = time.time()
    return _preview_response(preview, updated=True)


async def _confirm_locked(
    user: dict[str, Any], preview: _PdfPreview
) -> dict[str, Any]:
    """Confirmação sob a trava do contexto: cria o rascunho uma única vez.

    Revalida o tenant antes de transitar; mismatch fail-closed sem expor
    dados e sem procurar a proposta antiga com o tenant novo. Só transita a
    partir de operação ativa (`awaiting_confirm`, ou `creating` quando um
    titular anterior morreu sem concluir — o lookup resolve). Captura cópia
    imutável dos campos antes dos awaits; a identidade (chave =
    `operation_id`) é salva no `metadata` antes da auditoria; falha de
    auditoria registra o terminal e o retry recupera sem duplicar. Nunca
    adquire outra trava aqui (a do contexto já está detida).
    """
    context = _context_key(user)
    if not _preview_tenant_ok(user, preview):
        _invalidate_locked(user)
        return _tenant_mismatch_response()
    if preview.stage not in (STAGE_AWAITING_CONFIRM, STAGE_CREATING):
        return _processing_response()
    key = preview.operation_id
    document_id = preview.document_id
    client_id = preview.client_id
    changes = tuple(preview.changes)
    document_title = preview.document_title
    preview.stage = STAGE_CREATING
    tenant = collaboration_tenant_id(user)
    try:
        existing = await asyncio.to_thread(_find_proposal_by_idempotency_key, tenant, key)
        if existing is not None:
            stored = _stored_result(existing)
            await ensure_pdf_creation_audit(user, stored)
            _pop_preview_if_current_locked(context, preview)
            _set_completed_locked(user, key, str(existing.get("id")))
            return _created_response(existing, stored, document_title)
        try:
            result = await create_proposal_from_knowledge_pdf(
                user,
                document_id,
                ProposalFromPdfRequest(
                    documentId=document_id,
                    clientId=client_id,
                    fieldOverrides=dict(changes),
                ),
                idempotency_key=key,
            )
        except HTTPException as exc:
            _restore_preview_after_failure_locked(user, preview, context)
            return {
                "intent": "comercial",
                "status": "precisa_dados",
                "response": str(exc.detail),
            }
        proposal = result["proposal"]
        _pop_preview_if_current_locked(context, preview)
        _set_completed_locked(user, key, str(proposal.get("id")))
        try:
            await ensure_pdf_creation_audit(user, result)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail="Rascunho criado, mas não consegui registrar a auditoria. "
                "Repita a confirmação para concluir sem duplicar.",
            ) from exc
        return _created_response(proposal, result, document_title)
    except HTTPException:
        raise
    except asyncio.CancelledError:
        # Cancelamento da coroutine (BaseException): restaura com lease
        # renovado somente se ainda for a operação atual e sem terminal
        # registrado, para permitir retry com o mesmo operation_id; se a
        # proposta já foi persistida, o retry a localiza pela chave e nunca
        # duplica. Relança sempre; nada pode ficar eternamente em creating.
        if _completed_drafts.get(context) is None:
            _restore_preview_after_failure_locked(user, preview, context)
        raise
    except Exception:
        _restore_preview_after_failure_locked(user, preview, context)
        raise


def _proposal_gone_response() -> dict[str, Any]:
    return {
        "intent": "comercial",
        "status": "precisa_dados",
        "response": (
            "Aquele rascunho não existe mais. Refaça o pedido a partir "
            "do PDF para gerar uma nova prévia."
        ),
    }


def _stored_title(proposal: dict[str, Any]) -> str:
    metadata = proposal.get("metadata") if isinstance(proposal.get("metadata"), dict) else {}
    return str(metadata.get("sourcePdfTitle") or "documento")


async def _retry_locked(
    user: dict[str, Any], completed: _CompletedDraft
) -> dict[str, Any]:
    """Repetição explícita da confirmação, sob a trava: nunca cria de novo.

    Revalida o tenant; mismatch fail-closed sem expor resultado antigo e sem
    procurar a proposta antiga com o tenant novo. Reconhece pela chave da
    operação no armazenamento; se a auditoria ficou pendente, conclui sem
    duplicar. Se o rascunho sumiu, orienta a refazer o pedido.
    """
    if not _completed_tenant_ok(user, completed):
        _invalidate_locked(user)
        return _tenant_mismatch_response()
    key = completed.idempotency_key
    tenant = collaboration_tenant_id(user)
    existing = await asyncio.to_thread(_find_proposal_by_idempotency_key, tenant, key)
    if existing is None:
        _completed_drafts.pop(_context_key(user), None)
        return _proposal_gone_response()
    stored = _stored_result(existing)
    await ensure_pdf_creation_audit(user, stored)
    _set_completed_locked(user, key, str(existing.get("id")))
    return _created_response(existing, stored, _stored_title(existing))


async def _already_created_locked(
    user: dict[str, Any], completed: _CompletedDraft
) -> dict[str, Any]:
    """Cancelamento que chegou depois do terminal: informa o resultado real.

    Revalida o tenant; mismatch fail-closed sem expor resultado antigo e sem
    procurar a proposta antiga com o tenant novo. Nunca afirma que impediu a
    criação — a proposta existe e é devolvida.
    """
    if not _completed_tenant_ok(user, completed):
        _invalidate_locked(user)
        return _tenant_mismatch_response()
    key = completed.idempotency_key
    tenant = collaboration_tenant_id(user)
    existing = await asyncio.to_thread(_find_proposal_by_idempotency_key, tenant, key)
    if existing is None:
        _completed_drafts.pop(_context_key(user), None)
        return _proposal_gone_response()
    stored = _stored_result(existing)
    await ensure_pdf_creation_audit(user, stored)
    _set_completed_locked(user, key, str(existing.get("id")))
    created = _created_response(existing, stored, _stored_title(existing))
    created["response"] = (
        "A proposta já havia sido criada e o cancelamento não a desfez. "
        + created["response"]
    )
    return created


async def _resolve_terminal_locked(
    user: dict[str, Any], decision: str, texto: str
) -> dict[str, Any] | None:
    """Sem prévia ativa, sob a trava: terminal responde, resto libera (None)."""
    completed = _completed_drafts.get(_context_key(user))
    if completed is None:
        return None
    if not _completed_tenant_ok(user, completed):
        if decision == _DECISION_CANCEL or _is_retry_confirm(texto):
            _invalidate_locked(user)
            return _tenant_mismatch_response()
        _invalidate_locked(user)
        return None
    if decision == _DECISION_CANCEL:
        return await _already_created_locked(user, completed)
    if _is_retry_confirm(texto):
        return await _retry_locked(user, completed)
    return None


def _cancel_locked(user: dict[str, Any], preview: _PdfPreview) -> dict[str, Any]:
    """Cancelamento sob a trava, só a partir de `awaiting_confirm`.

    Revalida o tenant; mismatch fail-closed sem expor dados. Em `creating`,
    o resultado é desconhecido para quem cancela: devolve estado de
    processamento em vez de afirmar que impediu a criação.
    """
    if not _preview_tenant_ok(user, preview):
        _invalidate_locked(user)
        return _tenant_mismatch_response()
    if preview.stage != STAGE_AWAITING_CONFIRM:
        return _processing_response()
    document_title = preview.document_title
    _clear_locked(user)
    return {
        "intent": "comercial",
        "status": "cancelado",
        "response": (
            "Criação cancelada. Nenhuma proposta foi criada a partir do PDF \""
            + document_title + "\"."
        ),
    }


async def _continue_pending_proposal_locked(
    user: dict[str, Any], preview: _PdfPreview, texto: str, decision: str
) -> dict[str, Any] | None:
    """Segundo turno em diante, assumindo a trava estável já detida.

    Localiza, revalida, invalida e transita dentro da mesma trava: nunca
    consulta nem remove estado fora dela. Assunto alheio devolve None sem
    perder a prévia.
    """
    if not _preview_tenant_ok(user, preview):
        _invalidate_locked(user)
        return _tenant_mismatch_response()
    if not _is_current_operation_locked(user, preview):
        return await _resolve_terminal_locked(user, decision, texto)
    if decision == _DECISION_CANCEL:
        return _cancel_locked(user, preview)
    if decision == _DECISION_DENIED:
        return _hold_preview_response(preview)
    if decision == _DECISION_CONFIRM:
        return await _confirm_locked(user, preview)
    if decision == _DECISION_ADJUST:
        return await _adjust_locked(user, preview, texto)
    return None


async def _continue_pending_proposal(
    user: dict[str, Any], preview: _PdfPreview, texto: str
) -> dict[str, Any] | None:
    """Segundo turno em diante, serializado pela trava do contexto.

    Revalida tenant e operação ativa antes de transitar; mismatch fail-closed
    sem expor dados. Se outra transição venceu a corrida, delega ao terminal
    (que responde o resultado real) ou libera o roteamento. Assunto alheio
    devolve None para o roteamento normal, sem perder a prévia.
    """
    decision = _classify_pending_message(texto)
    context = _context_key(user)
    async with _locked_user(context):
        # Reconsulta dentro da trava: a prévia recebida pode estar obsoleta
        # (outra transição pode ter vencido a corrida fora da trava).
        current = _pdf_previews.get(context)
        if current is None:
            return await _resolve_terminal_locked(user, decision, texto)
        if current is not preview or current.operation_id != preview.operation_id:
            if not _preview_tenant_ok(user, current):
                _invalidate_locked(user)
                return _tenant_mismatch_response()
            return await _continue_pending_proposal_locked(user, current, texto, decision)
        return await _continue_pending_proposal_locked(user, preview, texto, decision)


async def maybe_handle_pdf_request(user: dict[str, Any], texto: str) -> dict[str, Any] | None:
    """Atende pedidos sobre PDFs ou devolve None para seguir o fluxo normal.

    Só assume pedidos que citam PDF/documento/arquivo, que nomeiam um PDF
    autorizado, ou que pedem proposta com mudança explícita. Todo o resto
    retorna None para preservar os agentes existentes. A repetição explícita
    da confirmação após o terminal usa o registro mínimo de retry.

    Concorrência: todo o tratamento de estado temporário (localizar prévia
    e concluído, revalidar `teamOwnerId`, invalidar divergente, decidir a
    transição, iniciar confirmação/cancelamento/ajuste/retry e publicar o
    terminal) ocorre sob a mesma `_locked_user` da chave estável
    `(collaboration_tenant_id, user_id)`. Nenhum helper chamado fora da trava
    remove ou substitui `_pdf_previews` ou `_completed_drafts`; a trava é
    liberada antes do roteamento comum quando não há estado temporário, sem
    aquisição recursiva, segunda trava, espera ocupada, sleep ou estado
    global adicional.
    """
    stable = _context_key(user)
    async with _locked_user(stable):
        # Consulta direta dentro da trava: localizar prévia e concluído,
        # revalidar snapshot, invalidar divergente e executar a transição.
        preview = _pdf_previews.get(stable)
        if preview is not None:
            decision = _classify_pending_message(texto)
            result = await _continue_pending_proposal_locked(user, preview, texto, decision)
            # Com prévia, assunto alheio ou terminal sem resposta devolve None
            # direto (preserva a prévia, sem tentar novo pedido na mesma chamada).
            return result
        completed = _completed_drafts.get(stable)
        if completed is not None:
            decision = _classify_pending_message(texto)
            needs_terminal = decision == _DECISION_CANCEL or _is_retry_confirm(texto)
            if not _completed_tenant_ok(user, completed):
                if needs_terminal:
                    _invalidate_locked(user)
                    return _tenant_mismatch_response()
                # Mismatch com mensagem alheia: invalida definitivamente dentro
                # da trava e libera para o roteamento comum fora dela, sem
                # expor título, cliente, documento ou proposta do contexto antigo.
                _invalidate_locked(user)
            elif needs_terminal:
                intercepted = await _resolve_terminal_locked(user, decision, texto)
                if intercepted is not None:
                    return intercepted
            # Sem resposta terminal (mensagem alheia com snapshot válido,
            # mismatch já invalidado acima, ou corrida sem concluído): sai da
            # trava e segue para o roteamento comum abaixo, preservando o retry
            # válido quando houver.
    # Sem prévia e sem terminal interceptado: roteamento comum fora da trava.
    normalized = _norm(texto)
    has_pdf_word = any(word in normalized for word in _PDF_WORDS)
    wants_proposal = any(word in normalized for word in _PROPOSAL_WORDS) and any(
        hint in normalized for hint in _CREATE_HINTS
    )
    wants_summary = "resum" in normalized or "sintese" in normalized or "sumario" in normalized
    if not has_pdf_word and not wants_proposal and not wants_summary:
        if not any(hint in normalized for hint in _QUESTION_HINTS):
            return None
    documents = await _pdf_documents(user)
    structure_word = any(word in normalized for word in _DOC_STRUCTURE_WORDS)
    if not documents:
        if has_pdf_word:
            return {
                "intent": "operacoes",
                "status": "precisa_dados",
                "response": (
                    "Não há PDFs autorizados na base de conhecimento para atender. "
                    "Envie um PDF em Conhecimento e tente novamente."
                ),
            }
        return None
    strong, weak = _split_matches(texto, documents)
    if strong:
        candidates = list(strong)
    elif has_pdf_word:
        candidates = list(weak)
    elif len(weak) == 1 and structure_word:
        candidates = list(weak)
    else:
        candidates = []
    if (
        not candidates
        and has_pdf_word
        and len(documents) == 1
        and _is_pure_demonstrative(normalized)
    ):
        candidates = list(documents)
    mentioned = bool(strong) or bool(weak)
    if wants_summary:
        if len(candidates) == 1:
            return await _summarize_pdf(user, candidates[0])
        if has_pdf_word or mentioned:
            return _ask_which(documents, candidates, "resumir")
        return None
    if wants_proposal:
        if len(candidates) == 1:
            return await _prepare_proposal_from_pdf_request(user, candidates[0], texto)
        if has_pdf_word or mentioned:
            return _ask_which(documents, candidates, "usar como base da proposta")
        return None
    question_about_doc = any(hint in normalized for hint in _QUESTION_HINTS)
    weak_single = not strong and len(weak) == 1
    if len(candidates) == 1 and (
        has_pdf_word
        or (bool(strong) and question_about_doc)
        or (weak_single and (has_pdf_word or structure_word))
    ):
        return await _answer_pdf_question(user, candidates[0], texto)
    if has_pdf_word:
        return _ask_which(documents, candidates, "consultar")
    return None
