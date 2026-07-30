from __future__ import annotations

import json
import os
import asyncio
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect

from app.modules.auth.router import current_user, user_from_token
from app.modules.commercial.repository import read_store
from app.modules.commercial.schemas import (
    BrandProfileCreate,
    ContractCreate,
    ContractUpdate,
    DocumentShareRequest,
    InstantiateObligationsRequest,
    NoraAnalysisRequest,
    NoraWritingRequest,
    ProposalBriefRequest,
    ProposalCreate,
    ProposalApprovalDecision,
    ProposalSubmit,
    ProposalUpdate,
    SignatureRequest,
    SuggestionDecision,
    TemplateCreate,
)
from app.modules.commercial.service import (
    analyze_with_nora,
    can_approve,
    collaboration_tenant_id,
    contract_or_404,
    create_brand_profile,
    create_contract,
    create_proposal,
    create_template,
    decide_proposal,
    decide_suggestion,
    delete_proposal,
    generate_proposal_draft,
    instantiate_obligations,
    list_commercial_data,
    public_signature_data,
    send_for_signature,
    sign_contract,
    sign_contract_public,
    signature_links,
    submit_proposal,
    update_contract,
    update_proposal,
    write_document_with_nora,
)
from app.modules.operations.schemas import AuditCreate
from app.modules.operations.service import record_audit
from app.modules.team.router import append_team_message_for_user
from app.routers.inbox_router import record_event
from app.services.gmail_service import GmailConfigError, GmailService
from app.modules.commercial.service import plain_text


router = APIRouter(prefix="/api/comercial", tags=["Propostas e Contratos"])


class CommercialConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[str, dict[str, list[WebSocket]]] = defaultdict(lambda: defaultdict(list))

    async def connect(self, tenant_id: str, document_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections[tenant_id][document_id].append(websocket)

    def disconnect(self, tenant_id: str, document_id: str, websocket: WebSocket) -> None:
        sockets = self.connections.get(tenant_id, {}).get(document_id, [])
        if websocket in sockets:
            sockets.remove(websocket)
        if not sockets:
            self.connections.get(tenant_id, {}).pop(document_id, None)
        if not self.connections.get(tenant_id):
            self.connections.pop(tenant_id, None)

    async def broadcast(self, tenant_id: str, document_id: str, payload: dict[str, Any]) -> None:
        stale: list[WebSocket] = []
        for socket in list(self.connections.get(tenant_id, {}).get(document_id, [])):
            try:
                await socket.send_json(payload)
            except Exception:
                stale.append(socket)
        for socket in stale:
            self.disconnect(tenant_id, document_id, socket)


manager = CommercialConnectionManager()


async def audit(user: dict[str, Any], action: str, description: str, entity_type: str, entity_id: str, status: str = "info") -> None:
    await record_audit(
        user,
        AuditCreate(
            action=action,
            source="commercial",
            description=description,
            status=status,
            entityType=entity_type,
            entityId=entity_id,
        ),
    )


async def notify(user: dict[str, Any], title: str, description: str, action: str, entity_id: str) -> None:
    await record_event(
        source="sistema",
        title=title,
        description=description,
        metadata={
            "userId": collaboration_tenant_id(user),
            "action": action,
            "entityType": "commercial_document",
            "entityId": entity_id,
            "deepLink": {"tab": "Propostas", "entityType": "commercial_document", "entityId": entity_id},
        },
    )


async def share_document(
    *,
    user: dict[str, Any],
    document_type: str,
    document_id: str,
    payload: DocumentShareRequest,
    request: Request,
) -> dict[str, Any]:
    tenant_id = collaboration_tenant_id(user)
    store = read_store(tenant_id)
    if document_type == "proposal":
        _, document = proposal_or_404(store, document_id)
    else:
        _, document = contract_or_404(store, document_id)

    title = str(document.get("title") or "Documento comercial")
    client = document.get("client") if isinstance(document.get("client"), dict) else {}
    summary = str(document.get("scopeSummary") or "").strip()
    body_text = plain_text(str(document.get("contentHtml") or "")).strip()
    introduction = payload.message.strip() or (
        f"Segue {('a proposta' if document_type == 'proposal' else 'o contrato')} "
        f'"{title}" para sua análise.'
    )
    document_copy = "\n\n".join(
        part
        for part in [
            introduction,
            f"Cliente: {client.get('name') or client.get('company') or 'Não informado'}",
            f"Resumo: {summary}" if summary else "",
            body_text[:18_000],
        ]
        if part
    )

    if payload.channel == "email":
        recipient = payload.recipient.strip() or str(client.get("email") or "").strip()
        if "@" not in recipient:
            raise HTTPException(status_code=422, detail="Informe um e-mail de destinatário válido.")

        if document_type == "contract" and document.get("status") == "awaiting_signatures":
            frontend_url = (
                os.getenv("FRONTEND_URL", "").strip()
                or request.headers.get("origin", "").strip()
                or "http://127.0.0.1:5173"
            )
            matching_link = next(
                (
                    item
                    for item in signature_links(tenant_id, document, frontend_url)
                    if str(item.get("email") or "").casefold() == recipient.casefold()
                ),
                None,
            )
            if matching_link:
                document_copy = f"{document_copy}\n\nLink individual para assinatura:\n{matching_link['url']}"

        try:
            result = await asyncio.to_thread(
                GmailService(tenant_id).send_message,
                to=[recipient],
                subject=payload.subject.strip() or title,
                body=document_copy,
            )
        except GmailConfigError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Falha ao enviar pelo Gmail: {exc}") from exc

        await audit(
            user,
            "commercial_document_shared_email",
            f'{title} enviado para {recipient}.',
            document_type,
            document_id,
            "success",
        )
        await notify(
            user,
            "Documento comercial enviado",
            f'{title} foi enviado por e-mail para {recipient}.',
            "commercial_document_shared_email",
            document_id,
        )
        return {
            "ok": True,
            "channel": "email",
            "recipient": recipient,
            "messageId": str((result.get("message") or {}).get("id") or ""),
        }

    sender_id = str(user.get("id") or tenant_id)
    team_message = await append_team_message_for_user(
        sender_id,
        document_copy,
        sender_id=sender_id,
        sender_name=str(user.get("nome") or user.get("email") or "Membro"),
        sender_avatar=str(user.get("fotoUrl") or ""),
        metadata={
            "action": "commercial_document_shared",
            "documentType": document_type,
            "documentId": document_id,
            "deepLink": {"tab": "Propostas", "entityType": document_type, "entityId": document_id},
        },
    )
    await audit(
        user,
        "commercial_document_shared_team",
        f'{title} compartilhado no chat da equipe.',
        document_type,
        document_id,
        "success",
    )
    return {
        "ok": True,
        "channel": "team",
        "messageId": str(team_message.get("id") or ""),
    }


@router.get("")
async def get_commercial(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await list_commercial_data(user)


@router.post("/proposals")
async def post_proposal(payload: ProposalCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    proposal = await create_proposal(user, payload)
    await audit(user, "proposal_created", f'Proposta "{proposal["title"]}" criada.', "proposal", proposal["id"], "success")
    await notify(user, "Nova proposta comercial", proposal["title"], "proposal_created", proposal["id"])
    return {"proposal": proposal}


@router.post("/proposal-draft")
async def post_proposal_draft(
    payload: ProposalBriefRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"draft": await generate_proposal_draft(user, payload)}


@router.get("/proposals/{proposal_id}")
async def get_proposal(proposal_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = read_store(collaboration_tenant_id(user))
    _, proposal = next(
        ((index, item) for index, item in enumerate(store["proposals"]) if str(item.get("id")) == proposal_id),
        (None, None),
    )
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposta nao encontrada.")
    return {"proposal": proposal}


@router.delete("/proposals/{proposal_id}")
async def remove_proposal(proposal_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    proposal = await delete_proposal(user, proposal_id)
    await audit(user, "proposal_deleted", f'Proposta "{proposal["title"]}" excluida.', "proposal", proposal_id, "warning")
    await notify(user, "Proposta excluida", proposal["title"], "proposal_deleted", proposal_id)
    return {"ok": True, "proposal": proposal}


@router.patch("/proposals/{proposal_id}")
async def patch_proposal(
    proposal_id: str,
    payload: ProposalUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await update_proposal(user, proposal_id, payload)
    await manager.broadcast(
        collaboration_tenant_id(user),
        proposal_id,
        {"type": "DOCUMENT_UPDATED", "documentType": "proposal", "document": proposal, "actorId": str(user.get("id") or "")},
    )
    return {"proposal": proposal}


@router.post("/proposals/{proposal_id}/submit")
async def post_submit(
    proposal_id: str,
    payload: ProposalSubmit,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await submit_proposal(user, proposal_id, payload.note)
    await audit(user, "proposal_submitted", f'Proposta "{proposal["title"]}" submetida.', "proposal", proposal_id, "success")
    await notify(
        user,
        "Proposta aguardando aprovacao" if proposal["status"] == "in_review" else "Proposta aprovada",
        proposal["title"],
        "proposal_submitted",
        proposal_id,
    )
    return {"proposal": proposal}


@router.post("/proposals/{proposal_id}/approve")
async def post_approve(
    proposal_id: str,
    payload: ProposalApprovalDecision,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await decide_proposal(user, proposal_id, approved=True, note=payload.note)
    await audit(user, "proposal_approved", f'Proposta "{proposal["title"]}" aprovada.', "proposal", proposal_id, "success")
    await notify(user, "Proposta aprovada", proposal["title"], "proposal_approved", proposal_id)
    return {"proposal": proposal}


@router.post("/proposals/{proposal_id}/request-changes")
async def post_request_changes(
    proposal_id: str,
    payload: ProposalApprovalDecision,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await decide_proposal(user, proposal_id, approved=False, note=payload.note)
    await audit(user, "proposal_changes_requested", f'Ajustes solicitados em "{proposal["title"]}".', "proposal", proposal_id, "warning")
    return {"proposal": proposal}


@router.post("/proposals/{proposal_id}/nora-analysis")
async def post_nora_analysis(
    proposal_id: str,
    payload: NoraAnalysisRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await analyze_with_nora(user, proposal_id, payload)
    await audit(user, "proposal_analyzed", f'Nora analisou "{proposal["title"]}".', "proposal", proposal_id, "info")
    return {"proposal": proposal}


@router.post("/proposals/{proposal_id}/nora-write")
async def post_proposal_nora_write(
    proposal_id: str,
    payload: NoraWritingRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, str]:
    return await write_document_with_nora(user, "proposal", proposal_id, payload)


@router.post("/proposals/{proposal_id}/suggestions/{suggestion_id}")
async def post_suggestion_decision(
    proposal_id: str,
    suggestion_id: str,
    payload: SuggestionDecision,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await decide_suggestion(user, proposal_id, suggestion_id, payload.decision)
    await manager.broadcast(
        collaboration_tenant_id(user),
        proposal_id,
        {"type": "DOCUMENT_UPDATED", "documentType": "proposal", "document": proposal, "actorId": str(user.get("id") or "")},
    )
    return {"proposal": proposal}


@router.post("/proposals/{proposal_id}/contract")
async def post_contract(
    proposal_id: str,
    payload: ContractCreate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    contract, proposal = await create_contract(user, proposal_id, payload.title, payload.templateId)
    await audit(user, "contract_created", f'Contrato "{contract["title"]}" gerado.', "contract", contract["id"], "success")
    await notify(user, "Contrato gerado", contract["title"], "contract_created", contract["id"])
    return {"contract": contract, "proposal": proposal}


@router.get("/contracts/{contract_id}")
async def get_contract(contract_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = read_store(collaboration_tenant_id(user))
    _, contract = contract_or_404(store, contract_id)
    return {"contract": contract}


@router.patch("/contracts/{contract_id}")
async def patch_contract(
    contract_id: str,
    payload: ContractUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    contract = await update_contract(user, contract_id, payload)
    await manager.broadcast(
        collaboration_tenant_id(user),
        contract_id,
        {"type": "DOCUMENT_UPDATED", "documentType": "contract", "document": contract, "actorId": str(user.get("id") or "")},
    )
    return {"contract": contract}


@router.post("/contracts/{contract_id}/nora-write")
async def post_contract_nora_write(
    contract_id: str,
    payload: NoraWritingRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, str]:
    return await write_document_with_nora(user, "contract", contract_id, payload)


@router.post("/proposals/{proposal_id}/share")
async def post_share_proposal(
    proposal_id: str,
    payload: DocumentShareRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return await share_document(
        user=user,
        document_type="proposal",
        document_id=proposal_id,
        payload=payload,
        request=request,
    )


@router.post("/contracts/{contract_id}/share")
async def post_share_contract(
    contract_id: str,
    payload: DocumentShareRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return await share_document(
        user=user,
        document_type="contract",
        document_id=contract_id,
        payload=payload,
        request=request,
    )


@router.post("/contracts/{contract_id}/send-for-signature")
async def post_send_for_signature(
    contract_id: str,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    contract = await send_for_signature(user, contract_id)
    await audit(user, "contract_sent_for_signature", f'Contrato "{contract["title"]}" enviado para assinatura.', "contract", contract_id, "success")
    await notify(user, "Contrato aguardando assinaturas", contract["title"], "contract_signature_requested", contract_id)
    frontend_url = (
        os.getenv("FRONTEND_URL", "").strip()
        or request.headers.get("origin", "").strip()
        or "http://127.0.0.1:5173"
    )
    return {
        "contract": contract,
        "signatureLinks": signature_links(collaboration_tenant_id(user), contract, frontend_url),
    }


@router.get("/public/signature/{token}")
async def get_public_signature(token: str) -> dict[str, Any]:
    return public_signature_data(token)


@router.post("/public/signature/{token}")
async def post_public_signature(
    token: str,
    payload: SignatureRequest,
    request: Request,
) -> dict[str, Any]:
    contract = await sign_contract_public(
        token,
        payload,
        ip=request.client.host if request.client else "",
        user_agent=request.headers.get("User-Agent", ""),
    )
    return {
        "ok": True,
        "contract": {
            "id": contract.get("id"),
            "title": contract.get("title"),
            "status": contract.get("status"),
            "signedAt": contract.get("signedAt"),
        },
    }


@router.post("/contracts/{contract_id}/signers/{signer_id}/sign")
async def post_sign(
    contract_id: str,
    signer_id: str,
    payload: SignatureRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = collaboration_tenant_id(user)
    contract = await sign_contract(
        tenant_id,
        contract_id,
        signer_id,
        payload,
        ip=request.client.host if request.client else "",
        user_agent=request.headers.get("User-Agent", ""),
        actor_id=str(user.get("id") or ""),
    )
    await audit(user, "contract_signed", f'Assinatura registrada em "{contract["title"]}".', "contract", contract_id, "success")
    if contract.get("status") == "signed":
        await notify(user, "Contrato totalmente assinado", contract["title"], "contract_signed", contract_id)
    return {"contract": contract}


@router.post("/contracts/{contract_id}/instantiate")
async def post_instantiate(
    contract_id: str,
    payload: InstantiateObligationsRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    result = await instantiate_obligations(user, contract_id, payload)
    contract = result["contract"]
    await audit(
        user,
        "contract_obligations_instantiated",
        f'{len(result["tasks"])} tarefa(s) criada(s) a partir de "{contract["title"]}".',
        "contract",
        contract_id,
        "success",
    )
    await notify(user, "Contrato desdobrado em tarefas", f'{contract["title"]}: {len(result["tasks"])} tarefa(s).', "contract_instantiated", contract_id)
    return result


@router.post("/brand-profiles")
async def post_brand_profile(
    payload: BrandProfileCreate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await create_brand_profile(user, payload)
    return {"brandProfile": item}


@router.post("/templates")
async def post_template(payload: TemplateCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    item = await create_template(user, payload)
    return {"template": item}


@router.websocket("/ws/{document_id}")
async def commercial_socket(document_id: str, websocket: WebSocket, token: str = "") -> None:
    try:
        user = await user_from_token(token)
    except Exception:
        await websocket.close(code=4401)
        return
    tenant_id = collaboration_tenant_id(user)
    store = read_store(tenant_id)
    document = next(
        (
            item
            for collection in (store["proposals"], store["contracts"])
            for item in collection
            if str(item.get("id")) == document_id
        ),
        None,
    )
    if not document:
        await websocket.close(code=4404)
        return
    participant = {
        "id": str(user.get("id") or ""),
        "name": str(user.get("nome") or user.get("email") or "Membro"),
        "photoUrl": str(user.get("fotoUrl") or ""),
    }
    await manager.connect(tenant_id, document_id, websocket)
    await manager.broadcast(tenant_id, document_id, {"type": "PRESENCE_JOIN", "participant": participant})
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                message = {}
            if message.get("type") == "PING":
                await websocket.send_json({"type": "PONG"})
            elif message.get("type") == "CURSOR":
                await manager.broadcast(
                    tenant_id,
                    document_id,
                    {"type": "CURSOR", "participant": participant, "selection": message.get("selection")},
                )
    except WebSocketDisconnect:
        manager.disconnect(tenant_id, document_id, websocket)
        await manager.broadcast(tenant_id, document_id, {"type": "PRESENCE_LEAVE", "participant": participant})
    except Exception:
        manager.disconnect(tenant_id, document_id, websocket)
