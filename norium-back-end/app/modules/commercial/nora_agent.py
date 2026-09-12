from __future__ import annotations

import base64
import os
import re
import unicodedata
import uuid
from datetime import date, timedelta
from typing import Any

from app.modules.clients.repository import list_clients
from app.modules.commercial.schemas import (
    Branding,
    NoraAnalysisRequest,
    ProposalBriefRequest,
    ProposalCreate,
    SignerInput,
    SmartDocumentRequest,
)
from app.modules.commercial.service import (
    analyze_with_nora,
    cancel_contract,
    collaboration_tenant_id,
    create_contract,
    create_proposal,
    create_smart_document,
    delete_contract,
    delete_proposal,
    generate_proposal_draft,
    list_commercial_data,
    send_for_signature,
    signature_links,
    standard_templates,
    submit_proposal,
)
from app.services.brainstorm_store import list_brainstorm_sessions
from app.modules.commercial.pdf_export import build_commercial_pdf
from app.services.nora_files import owned_file, save_bytes


_sessions: dict[str, dict[str, Any]] = {}


def _normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", (value or "").lower())
    return "".join(character for character in normalized if not unicodedata.combining(character))


def _contains_any(value: str, terms: tuple[str, ...]) -> bool:
    return any(term in value for term in terms)


def _find_client(tenant_id: str, message: str) -> dict[str, Any] | None:
    normalized = _normalize(message)
    clients = list_clients(tenant_id)
    matches = [
        item
        for item in clients
        if any(
            token and _normalize(str(token)) in normalized
            for token in (item.get("name"), item.get("company"), item.get("email"))
        )
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def _client_options(tenant_id: str) -> str:
    clients = list_clients(tenant_id)
    if not clients:
        return "Ainda não há clientes cadastrados. Cadastre o cliente na tela Clientes e tente novamente."
    names = [str(item.get("name") or item.get("company") or item.get("email") or "Cliente") for item in clients[:8]]
    return "Clientes disponíveis: " + ", ".join(names) + "."


def _infer_category(value: str) -> str:
    normalized = _normalize(value)
    rules = (
        ("desenvolvimento", ("software", "site", "aplicativo", "app", "sistema", "plataforma", "e-commerce", "integracao")),
        ("marketing", ("marketing", "campanha", "trafego", "midia", "conteudo", "redes sociais", "comunicacao")),
        ("manutencao", ("manutencao", "suporte", "corretiva", "preventiva", "sla")),
        ("design", ("design", "identidade visual", "branding", "interface", "ux", "ui")),
        ("recorrente", ("mensal", "recorrente", "assinatura", "retainer", "continuo")),
        ("consultoria", ("consultoria", "diagnostico", "assessoria", "planejamento", "estrategia")),
    )
    return next((category for category, terms in rules if _contains_any(normalized, terms)), "consultoria")


def _extract_amount(value: str) -> float:
    match = re.search(r"(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)", value, flags=re.I)
    if not match:
        return 0
    raw = match.group(1)
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return 0


def _extract_valid_until(value: str) -> str:
    match = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", value)
    if match:
        day, month, year = (int(part) for part in match.groups())
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            pass
    days_match = re.search(r"\b(\d{1,3})\s+dias?\b", _normalize(value))
    days = int(days_match.group(1)) if days_match else 15
    return (date.today() + timedelta(days=max(1, min(days, 365)))).isoformat()


def _is_document_creation(value: str) -> bool:
    return _contains_any(
        value,
        (
            "criar", "crie", "gere", "gerar", "fazer", "monte", "produza", "quero um", "quero uma",
        ),
    ) and _contains_any(
        value,
        (
            "documento", "proposta", "contrato", "curriculo", "cv", "carta", "relatorio", "ata",
            "plano", "orcamento", "recibo", "fatura", "politica", "termo", "declaracao", "certificado",
            "briefing", "manual", "checklist", "roteiro", "descricao de vaga", "pauta",
        ),
    )


def is_document_creation_request(value: str) -> bool:
    """Sinal publico para o roteador preservar anexos de documentos."""

    return _is_document_creation(_normalize(value))


def _has_useful_document_brief(value: str) -> bool:
    normalized = _normalize(value)
    stripped = re.sub(
        r"\b(?:nora|por favor|quero|preciso|criar|crie|gere|gerar|fazer|monte|produza|um|uma|novo|nova|documento|"
        r"proposta|contrato|curriculo|cv|carta|relatorio|ata|plano|orcamento|recibo|fatura|politica|termo|"
        r"declaracao|certificado|briefing|manual|checklist|roteiro)\b",
        " ",
        normalized,
    )
    return len([token for token in stripped.split() if len(token) > 2]) >= 2


def _document_template(message: str, has_photo: bool = False) -> dict[str, Any]:
    normalized = _normalize(message)
    templates = standard_templates()
    if _contains_any(normalized, ("curriculo", "curriculum", " cv ", "resume")):
        preferred = (
            "standard_resume_foto_clean"
            if has_photo or "foto" in normalized
            else "standard_resume_duas_colunas"
            if "coluna" in normalized
            else "standard_resume_linha_tempo"
            if _contains_any(normalized, ("linha do tempo", "cronologico"))
            else "standard_resume_competencias"
            if _contains_any(normalized, ("competencia", "transicao", "sem experiencia"))
            else "standard_resume_ats"
        )
        match = next((item for item in templates if item.get("id") == preferred), None)
        if match:
            return match

    desired_type = next(
        (
            document_type
            for document_type, terms in (
                ("proposal", ("proposta",)), ("contract", ("contrato",)), ("resume", ("curriculo", "cv")),
                ("budget", ("orcamento", "cotacao")), ("report", ("relatorio",)), ("letter", ("carta", "comunicado")),
                ("meeting", ("ata", "pauta")), ("plan", ("plano",)), ("term", ("termo", "declaracao", "autorizacao")),
                ("receipt", ("recibo",)), ("invoice", ("fatura",)), ("certificate", ("certificado",)),
                ("policy", ("politica", "manual", "procedimento", "checklist")), ("hr", ("vaga", "onboarding", "feedback")),
                ("marketing", ("briefing", "persona", "midia kit")), ("academic", ("pesquisa academica", "plano de aula", "fichamento")),
            )
            if _contains_any(normalized, terms)
        ),
        "custom",
    )
    candidates = [item for item in templates if str(item.get("documentType") or "") == desired_type]
    if not candidates:
        candidates = templates

    def score(item: dict[str, Any]) -> tuple[int, int]:
        tokens = {
            _normalize(str(token))
            for token in [item.get("name"), item.get("category"), *(item.get("keywords") or [])]
            if str(token or "").strip()
        }
        points = sum(4 if token and token in normalized else 0 for token in tokens)
        for word in set(normalized.split()):
            if len(word) >= 5 and any(word in token for token in tokens):
                points += 1
        return points, 1 if item.get("featured") else 0

    return max(candidates, key=score)


def _document_palette(message: str) -> tuple[str, str, str]:
    normalized = _normalize(message)
    hex_colors = re.findall(r"#[0-9a-fA-F]{6}\b", message)
    if hex_colors:
        return hex_colors[0], hex_colors[1] if len(hex_colors) > 1 else hex_colors[0], "#0F172A"
    palettes = (
        (("verde", "esmeralda"), ("#14532D", "#10B981", "#052E16")),
        (("roxo", "violeta"), ("#4C1D95", "#8B5CF6", "#1E1B4B")),
        (("rosa", "pink"), ("#9D174D", "#EC4899", "#500724")),
        (("laranja",), ("#9A3412", "#F97316", "#431407")),
        (("vermelho",), ("#991B1B", "#EF4444", "#450A0A")),
        (("preto", "grafite"), ("#111827", "#64748B", "#020617")),
        (("azul", "ciano"), ("#1E3A8A", "#2563EB", "#0F172A")),
    )
    return next((palette for terms, palette in palettes if _contains_any(normalized, terms)), ("#1E293B", "#3B82F6", "#0F172A"))


def _attached_photo(user_id: str, attachment_ids: list[str]) -> str:
    for file_id in attachment_ids:
        record, path = owned_file(user_id, file_id)
        mime_type = str(record.get("mimeType") or "")
        if not mime_type.startswith("image/"):
            continue
        content = path.read_bytes()
        if len(content) > 1_450_000:
            raise ValueError("A foto do currículo deve ter até 1,4 MB. Envie uma imagem menor para eu incorporá-la ao documento.")
        return f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}"
    return ""


async def _create_document_from_chat(
    user: dict[str, Any],
    message: str,
    template: dict[str, Any],
    attachment_ids: list[str],
) -> dict[str, Any]:
    try:
        photo_data_url = _attached_photo(str(user.get("id") or "lucas123"), attachment_ids)
    except ValueError as exc:
        return _response("precisa_dados", str(exc))
    primary, secondary, text = _document_palette(message)
    client = _find_client(collaboration_tenant_id(user), message)
    amount = _extract_amount(message) if template.get("documentType") in {"proposal", "budget", "invoice", "receipt"} else 0
    document, artifact = await create_smart_document(
        user,
        SmartDocumentRequest(
            templateId=str(template["id"]),
            clientId=str(client.get("id") or "") if client else "",
            brief=message.strip(),
            amount=amount,
            validUntil=_extract_valid_until(message) if template.get("documentType") == "proposal" else None,
            photoDataUrl=photo_data_url,
            primaryColor=primary,
            secondaryColor=secondary,
            textColor=text,
        ),
    )
    label = str(template.get("name") or "Documento")
    return _response(
        "criada",
        f"Criei “{document['title']}” usando o modelo {label}. O PDF está abaixo e a opção Editar abre diretamente a versão completa em Documentos.",
        None,
        document=document,
        proposal=document,
        files=[artifact],
    )


def _find_named_document(items: list[dict[str, Any]], message: str) -> dict[str, Any] | None:
    normalized = _normalize(message)
    exact_candidates = [
        item
        for item in items
        if _normalize(str(item.get("title") or "")) and _normalize(str(item.get("title") or "")) in normalized
    ]
    if exact_candidates:
        return exact_candidates[0]
    return items[0] if items else None


def _find_named_brainstorm(items: list[dict[str, Any]], message: str) -> dict[str, Any] | None:
    normalized = _normalize(message)
    matches = [
        item
        for item in items
        if _normalize(str(item.get("title") or ""))
        and _normalize(str(item.get("title") or "")) in normalized
    ]
    if matches:
        return matches[0]
    return items[0] if len(items) == 1 else None


def _brainstorm_options(items: list[dict[str, Any]]) -> str:
    if not items:
        return "Não há sessões de Brainstorm disponíveis para vincular."
    titles = [str(item.get("title") or "Brainstorm sem título") for item in items[:8]]
    return "Brainstorms disponíveis: " + ", ".join(titles) + "."


def cancel_commercial_session(session_id: str | None) -> None:
    if session_id:
        _sessions.pop(session_id, None)


def _response(
    status: str,
    response: str,
    session_id: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "status": status,
        "response": response,
        "session_id": session_id,
        **extra,
    }


async def _proposal_preview(user: dict[str, Any], session_id: str, state: dict[str, Any]) -> dict[str, Any]:
    payload = ProposalBriefRequest(
        clientId=str(state["client"]["id"]),
        brainstormId=state.get("brainstormId"),
        title=str(state.get("title") or ""),
        objective=str(state["objective"]),
        scopeNotes=str(state["scope"]),
        team=str(state.get("team") or ""),
        deadline=str(state.get("deadline") or ""),
        deliverablesNotes=str(state.get("deliverables") or ""),
        exclusions=str(state.get("exclusions") or ""),
        notes="\n\n".join(part for part in (str(state.get("notes") or ""), str(state.get("companyResearch") or "")) if part),
        amount=float(state.get("amount") or 0),
        currency="BRL",
        tone="consultive",
    )
    draft = await generate_proposal_draft(user, payload)
    state["draft"] = draft
    state["stage"] = "confirm"
    return _response(
        "confirmar",
        (
            f"Preparei a proposta “{draft['title']}” para {draft['client']['name']}. "
            f"Categoria: {state['category']}. Valor: R$ {state['amount']:,.2f}. "
            f"Validade: {state['validUntil']}. "
            "Diga “confirmar” para criar o documento editável ou informe o ajuste desejado."
        ).replace(",", "_").replace(".", ",").replace("_", "."),
        session_id,
        draft=draft,
        templateId=f"standard_proposal_{state['category']}",
    )


async def _persist_proposal(user: dict[str, Any], session_id: str, state: dict[str, Any]) -> dict[str, Any]:
    draft = state.get("draft")
    if not isinstance(draft, dict):
        return await _proposal_preview(user, session_id, state)
    template_id = f"standard_proposal_{state['category']}"
    template = next(
        (item for item in standard_templates() if item["id"] == template_id),
        None,
    )
    draft_html = str(draft.get("contentHtml") or "<p></p>")
    template_html = str((template or {}).get("contentHtml") or "{{NORA_CONTENT}}")
    content_html = (
        template_html.replace("{{NORA_CONTENT}}", draft_html)
        if "{{NORA_CONTENT}}" in template_html
        else f"{template_html}{draft_html}"
    )
    client = state["client"]
    signers = []
    if str(client.get("email") or "").strip():
        signers.append(
            SignerInput(
                name=str(client.get("name") or client.get("company") or "Cliente"),
                email=str(client["email"]),
                role="client",
                order=1,
            )
        )
    proposal = await create_proposal(
        user,
        ProposalCreate(
            clientId=str(client["id"]),
            brainstormId=state.get("brainstormId"),
            title=str(draft.get("title") or state.get("title") or "Proposta comercial"),
            contentHtml=content_html,
            scopeSummary=str(draft.get("scopeSummary") or state["objective"]),
            amount=float(state.get("amount") or 0),
            currency="BRL",
            validUntil=str(state["validUntil"]),
            branding=Branding(),
            signers=signers,
            deliverables=draft.get("deliverables") or [],
            metadata={
                "createdByNora": True,
                "templateId": template_id,
                "templateCategory": state["category"],
                "brainstormLinkedByRequest": bool(state.get("brainstormId")),
            },
        ),
    )
    pdf_bytes, pdf_name = build_commercial_pdf(proposal, "proposal")
    artifact = save_bytes(
        str(user.get("id") or "lucas123"),
        pdf_bytes,
        pdf_name,
        "application/pdf",
        source="commercial:proposal",
        metadata={"editTarget": {"tab": "Documentos", "entityType": "proposal", "entityId": proposal["id"], "label": "Editar no Documentos"}},
    )
    _sessions.pop(session_id, None)
    return _response(
        "criada",
        (
            f"Proposta criada: “{proposal['title']}”. Ela está em rascunho e pronta para edição. "
            + (
                "O Brainstorm solicitado foi vinculado."
                if proposal.get("brainstormId")
                else "Nenhum Brainstorm foi vinculado."
            )
        ),
        None,
        proposal=proposal,
        files=[artifact],
    )


async def handle_commercial_agent(
    user: dict[str, Any],
    message: str,
    session_id: str | None = None,
    company_research: str | None = None,
    attachment_ids: list[str] | None = None,
) -> dict[str, Any]:
    tenant_id = collaboration_tenant_id(user)
    normalized = _normalize(message)
    state = _sessions.get(session_id or "")
    attachment_ids = list(attachment_ids or [])
    if state is not None and company_research:
        state["companyResearch"] = company_research[:12_000]

    if state:
        if _contains_any(normalized, ("cancelar", "cancele", "desistir", "parar")):
            cancel_commercial_session(session_id)
            return _response("cancelado", "Criação da proposta cancelada. Nenhum documento foi criado.")

        stage = str(state.get("stage") or "client")
        if stage == "document_brief":
            template = next(
                (item for item in standard_templates() if str(item.get("id") or "") == str(state.get("templateId") or "")),
                _document_template(f"{state.get('initialMessage') or ''} {message}", bool(attachment_ids)),
            )
            combined = "\n".join(part for part in (str(state.get("initialMessage") or ""), message.strip()) if part)
            combined_attachments = [*state.get("attachmentIds", []), *attachment_ids]
            _sessions.pop(str(session_id), None)
            return await _create_document_from_chat(user, combined, template, list(dict.fromkeys(combined_attachments)))
        if stage == "brainstorm":
            brainstorms = await list_brainstorm_sessions(tenant_id)
            brainstorm = _find_named_brainstorm(brainstorms, message)
            if not brainstorm:
                return _response(
                    "precisa_dados",
                    "Não identifiquei a sessão. Informe o título do Brainstorm que deseja vincular. "
                    + _brainstorm_options(brainstorms),
                    session_id,
                )
            state["brainstormId"] = str(brainstorm["id"])
            client = state.get("client")
            state["stage"] = "objective" if client else "client"
            if client:
                return _response(
                    "precisa_dados",
                    (
                        f'Brainstorm vinculado: “{brainstorm.get("title")}”. '
                        f'Cliente selecionado: {client.get("name") or client.get("company")}. '
                        "Qual é o objetivo principal da proposta?"
                    ),
                    session_id,
                )
            return _response(
                "precisa_dados",
                f'Brainstorm vinculado: “{brainstorm.get("title")}”. Para qual cliente devo preparar a proposta? '
                + _client_options(tenant_id),
                session_id,
            )

        if stage == "client":
            client = _find_client(tenant_id, message)
            if not client:
                return _response(
                    "precisa_dados",
                    "Não encontrei esse cliente. Informe o nome, a empresa ou o e-mail exatamente como está no cadastro. "
                    + _client_options(tenant_id),
                    session_id,
                )
            state["client"] = client
            state["stage"] = "objective"
            return _response(
                "precisa_dados",
                f"Cliente selecionado: {client.get('name') or client.get('company')}. Qual é o objetivo principal da proposta?",
                session_id,
            )

        if stage == "objective":
            if len(message.strip()) < 10:
                return _response("precisa_dados", "Explique o objetivo em uma frase um pouco mais completa.", session_id)
            state["objective"] = message.strip()
            state["stage"] = "scope"
            return _response(
                "precisa_dados",
                "O que está incluído no escopo? Pode escrever de forma simples; eu organizo entregas, responsabilidades e limites.",
                session_id,
            )

        if stage == "scope":
            if len(message.strip()) < 10:
                return _response("precisa_dados", "Detalhe um pouco mais o que será entregue.", session_id)
            state["scope"] = message.strip()
            state["category"] = _infer_category(f"{state['objective']} {state['scope']}")
            state["stage"] = "commercial"
            return _response(
                "precisa_dados",
                (
                    "Informe o valor e a validade da proposta. Exemplo: “R$ 8.500, válida por 20 dias”. "
                    "Se ainda não houver valor, diga “sem valor definido”."
                ),
                session_id,
            )

        if stage == "commercial":
            state["amount"] = _extract_amount(message)
            state["validUntil"] = _extract_valid_until(message)
            return await _proposal_preview(user, str(session_id), state)

        if stage == "confirm":
            if _contains_any(normalized, ("confirmar", "confirme", "gerar", "criar", "pode criar", "pode gerar")):
                return await _persist_proposal(user, str(session_id), state)
            state["notes"] = "Ajuste solicitado antes da geração: " + message.strip()
            state.pop("draft", None)
            return await _proposal_preview(user, str(session_id), state)

    if _is_document_creation(normalized):
        template = _document_template(message, bool(attachment_ids))
        if _has_useful_document_brief(message):
            return await _create_document_from_chat(user, message, template, attachment_ids)
        new_session_id = f"commercial_{uuid.uuid4().hex}"
        _sessions[new_session_id] = {
            "stage": "document_brief",
            "templateId": str(template.get("id") or ""),
            "initialMessage": message.strip(),
            "attachmentIds": attachment_ids,
        }
        document_type = str(template.get("documentType") or "custom")
        hint = (
            "Em uma única mensagem, envie nome, objetivo profissional ou vaga e as experiências/formação que quiser incluir. Você também pode anexar uma foto e indicar uma cor; o restante ficará como ‘A definir’."
            if document_type == "resume"
            else "Em uma única mensagem, diga qual cliente ou público, o objetivo e o conteúdo principal. Valor, prazo e detalhes são opcionais; o que faltar ficará como ‘A definir’."
        )
        return _response("precisa_dados", hint, new_session_id, template={"id": template.get("id"), "name": template.get("name")})

    data = await list_commercial_data(user)
    proposals = data["proposals"]
    contracts = data["contracts"]

    if _contains_any(normalized, ("listar", "liste", "mostrar", "mostre", "quais", "minha proposta", "minhas propostas", "meu contrato", "meus contratos")):
        if "contrat" in normalized:
            if not contracts:
                return _response("vazio", "Você ainda não possui contratos.")
            lines = "\n".join(f"- {item['title']} — {item['status']}" for item in contracts[:10])
            return _response("consulta", f"Contratos recentes:\n{lines}", contracts=contracts[:10])
        if "proposta" in normalized:
            if not proposals:
                return _response("vazio", "Você ainda não possui propostas.")
            lines = "\n".join(f"- {item['title']} — {item['status']}" for item in proposals[:10])
            return _response("consulta", f"Propostas recentes:\n{lines}", proposals=proposals[:10])

    if "excluir" in normalized and "proposta" in normalized:
        proposal = _find_named_document(proposals, message)
        if not proposal:
            return _response("nao_encontrada", "Não encontrei uma proposta para excluir.")
        if not _contains_any(normalized, ("confirmo", "confirmar exclusao", "excluir definitivamente")):
            return _response(
                "precisa_confirmacao",
                f"Confirme com “excluir definitivamente a proposta {proposal['title']}”. Esta ação não pode ser desfeita.",
                proposal=proposal,
            )
        removed = await delete_proposal(user, str(proposal["id"]))
        return _response("excluida", f"Proposta excluída: “{removed['title']}”.", proposal=removed)

    if "contrato" in normalized and _contains_any(normalized, ("cancelar", "cancele", "cancelamento")):
        contract = _find_named_document(contracts, message)
        if not contract:
            return _response("nao_encontrado", "Não encontrei o contrato que deve ser cancelado.")
        if not _contains_any(normalized, ("confirmo", "confirmar cancelamento", "cancelar definitivamente")):
            return _response(
                "precisa_confirmacao",
                f"Confirme com “cancelar definitivamente o contrato {contract['title']}”. O documento será preservado no histórico.",
                contract=contract,
            )
        cancelled = await cancel_contract(user, str(contract["id"]))
        return _response("cancelado", f"Contrato cancelado e preservado no histórico: “{cancelled['title']}”.", contract=cancelled)

    if "excluir" in normalized and "contrato" in normalized:
        contract = _find_named_document(contracts, message)
        if not contract:
            return _response("nao_encontrado", "Não encontrei a minuta que deve ser excluída.")
        if contract.get("status") != "draft":
            return _response("nao_permitido", "Somente minutas podem ser excluídas. Para contratos enviados ou assinados, peça o cancelamento para preservar o histórico.", contract=contract)
        if not _contains_any(normalized, ("confirmo", "confirmar exclusao", "excluir definitivamente")):
            return _response(
                "precisa_confirmacao",
                f"Confirme com “excluir definitivamente o contrato {contract['title']}”. A minuta será removida e a proposta vinculada será restaurada.",
                contract=contract,
            )
        removed, proposal = await delete_contract(user, str(contract["id"]))
        return _response("excluido", f"Minuta excluída: “{removed['title']}”. A proposta vinculada voltou a ficar disponível.", contract=removed, proposal=proposal)

    if _contains_any(normalized, ("analisar proposta", "revise a proposta", "revisar proposta")):
        proposal = _find_named_document(proposals, message)
        if not proposal:
            return _response("nao_encontrada", "Não encontrei uma proposta para analisar.")
        reviewed = await analyze_with_nora(
            user,
            str(proposal["id"]),
            NoraAnalysisRequest(
                context="Análise solicitada pelo chat da Nora.",
                focus=["scope", "risk", "tone", "commercial", "legal", "grammar"],
            ),
        )
        return _response(
            "analisada",
            f"Analisei “{reviewed['title']}”. {reviewed['noraAnalysis']['summary']}",
            proposal=reviewed,
        )

    if _contains_any(normalized, ("gerar contrato", "criar contrato", "converter em contrato")):
        proposal = _find_named_document(proposals, message)
        if not proposal:
            return _response("nao_encontrada", "Não encontrei uma proposta para converter em contrato.")
        if proposal.get("status") not in {"approved", "sent", "accepted"}:
            proposal = await submit_proposal(user, str(proposal["id"]), "Submissão solicitada pela Nora.")
            if proposal.get("status") == "in_review":
                return _response(
                    "aguardando_aprovacao",
                    f"Enviei “{proposal['title']}” para aprovação. O contrato poderá ser gerado após a decisão do responsável.",
                    proposal=proposal,
                )
        contract, proposal = await create_contract(user, str(proposal["id"]), None)
        return _response(
            "contrato_criado",
            f"Contrato criado a partir de “{proposal['title']}” e pronto para edição.",
            contract=contract,
            proposal=proposal,
        )

    if _contains_any(normalized, ("enviar para assinatura", "link de assinatura", "assinar contrato")):
        contract = _find_named_document(contracts, message)
        if not contract:
            return _response("nao_encontrado", "Não encontrei um contrato para assinatura.")
        contract = await send_for_signature(user, str(contract["id"]))
        frontend_url = os.getenv("FRONTEND_URL", "http://127.0.0.1:5173")
        links = signature_links(tenant_id, contract, frontend_url)
        return _response(
            "enviado_assinatura",
            (
                f"Gerei {len(links)} link(s) seguro(s) de assinatura para “{contract['title']}”. "
                "Os links expiram em 30 dias e ficam disponíveis no painel do contrato."
            ),
            contract=contract,
            signatureLinks=links,
        )

    if "proposta" in normalized and _contains_any(normalized, ("criar", "crie", "quero", "nova", "gerar", "fazer")):
        new_session_id = f"commercial_{uuid.uuid4().hex}"
        client = _find_client(tenant_id, message)
        brainstorms = await list_brainstorm_sessions(tenant_id) if "brainstorm" in normalized else []
        brainstorm = _find_named_brainstorm(brainstorms, message) if brainstorms else None
        wants_brainstorm = "brainstorm" in normalized
        state = {
            "stage": "brainstorm" if wants_brainstorm and not brainstorm else "objective" if client else "client",
            "client": client,
            "brainstormId": str(brainstorm["id"]) if brainstorm else None,
            "amount": 0,
            "validUntil": (date.today() + timedelta(days=15)).isoformat(),
            "category": _infer_category(message),
            "companyResearch": (company_research or "")[:12_000],
        }
        _sessions[new_session_id] = state
        if wants_brainstorm and not brainstorm:
            return _response(
                "precisa_dados",
                "Qual sessão de Brainstorm deseja vincular? " + _brainstorm_options(brainstorms),
                new_session_id,
            )
        if client:
            linked = f' Brainstorm vinculado: “{brainstorm.get("title")}”.' if brainstorm else ""
            return _response(
                "precisa_dados",
                (
                    f"Cliente selecionado: {client.get('name') or client.get('company')}."
                    f"{linked} Qual é o objetivo principal da proposta?"
                ),
                new_session_id,
            )
        return _response(
            "precisa_dados",
            "Para qual cliente devo preparar a proposta? Informe o nome, a empresa ou o e-mail. "
            + _client_options(tenant_id),
            new_session_id,
        )

    return _response(
        "ajuda",
        (
            "Posso criar, listar, revisar, excluir e converter propostas em contratos, além de gerar links de assinatura. "
            "Exemplo: “quero criar uma proposta para a empresa Acme”."
        ),
    )
