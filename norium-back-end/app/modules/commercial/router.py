from __future__ import annotations

import json
import os
import asyncio
import base64
import io
import logging
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse

from app.modules.auth.router import current_user, effective_permissions, user_from_websocket_ticket
from app.modules.commercial.repository import read_store
from app.modules.commercial.schemas import (
    BrandProfileCreate,
    ContractCreate,
    ContractUpdate,
    DocumentDuplicateRequest,
    DocumentImportRequest,
    DocumentAccessUpdate,
    DocumentShareRequest,
    ImportedDocumentUpdate,
    InstantiateObligationsRequest,
    NoraAnalysisRequest,
    NoraWritingRequest,
    PdfProcessRequest,
    ProposalBriefRequest,
    ProposalCreate,
    ProposalPdfUpload,
    ProposalFromPdfRequest,
    ProposalApprovalDecision,
    ProposalStatusChange,
    ProposalSubmit,
    ProposalUpdate,
    SmartDocumentRequest,
    SignatureRequest,
    SuggestionDecision,
    TemplateCreate,
    TemplateUpdate,
)

from app.modules.commercial.document_files import (
    cancel_processing_job,
    create_processing_job,
    delete_imported_document,
    document_bytes,
    import_document,
    imported_document_or_404,
    pdf_capabilities,
    processing_job_or_404,
    processing_job_summary,
    run_processing_job,
    update_imported_document,
)

from app.modules.commercial.service import (
    analyze_with_nora,
    can_approve,
    cancel_contract,
    collaboration_tenant_id,
    contract_or_404,
    create_brand_profile,
    create_contract,
    create_proposal,
    upload_proposal_pdf,
    audit_proposal_created_from_pdf,
    can_view_proposal,
    create_proposal_from_knowledge_pdf,
    ensure_proposal_visible,
    create_template,
    get_template,
    change_proposal_status,
    decide_proposal,
    decide_suggestion,
    delete_contract,
    delete_proposal,
    delete_template,
    document_for_response,
    generate_proposal_draft,
    generate_smart_document_draft,
    find_accessible_document,
    create_smart_document,
    duplicate_proposal,
    duplicate_template,
    instantiate_obligations,
    list_commercial_data,
    require_document_access,
    proposal_or_404,
    public_signature_data,
    send_for_signature,
    sign_contract,
    sign_contract_public,
    signature_links,
    submit_proposal,
    update_contract,
    update_document_access,
    update_proposal,
    update_template,
    write_document_with_nora,
)

logger = logging.getLogger(__name__)
from app.modules.operations.schemas import AuditCreate
from app.modules.operations.service import record_audit
from app.modules.team.router import append_team_message_for_user
from app.routers.inbox_router import record_event
from app.services.gmail_service import GmailConfigError, GmailService
from app.modules.commercial.service import plain_text
from app.modules.commercial.pdf_export import build_commercial_pdf


router = APIRouter(prefix="/api/comercial", tags=["Documentos"])


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
            "deepLink": {"tab": "Documentos", "entityType": "commercial_document", "entityId": entity_id},
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
    store = await asyncio.to_thread(read_store, tenant_id)
    if document_type == "proposal":
        _, document = proposal_or_404(store, document_id)
        ensure_proposal_visible(user, document)
        if document_type == "proposal" and str(document.get("visibility") or "team") == "private":
            raise HTTPException(
                status_code=409,
                detail="Proposta privada nao pode ser compartilhada. Torne-a visivel a equipe antes de compartilhar.",
            )
    else:
        _, document = contract_or_404(store, document_id)
    require_document_access(document, user, "owner")

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
    pdf_bytes, pdf_name = build_commercial_pdf(document, document_type, tenant_id=collaboration_tenant_id(user))
    pdf_attachment = {
        "fileName": pdf_name,
        "mimeType": "application/pdf",
        "dataUrl": f"data:application/pdf;base64,{base64.b64encode(pdf_bytes).decode('ascii')}",
    }

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
                attachments=[pdf_attachment],
            )
        except GmailConfigError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Falha ao enviar documento comercial pelo Gmail.")
            raise HTTPException(status_code=502, detail="Falha temporaria ao enviar documento pelo Gmail.") from exc

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
            "deepLink": {"tab": "Documentos", "entityType": document_type, "entityId": document_id},
        },
        attachments=[pdf_attachment],
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


@router.get("/pdf/capabilities")
async def get_pdf_capabilities(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    del user
    return await pdf_capabilities()


@router.post("/documents/import")
async def post_document_import(
    payload: DocumentImportRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    document = await import_document(collaboration_tenant_id(user), user, payload)
    await audit(user, "document_imported", f'Arquivo "{document["title"]}" importado.', "document", document["id"], "success")
    return {"document": document}


@router.patch("/documents/{document_id}")
async def patch_imported_document(
    document_id: str,
    payload: ImportedDocumentUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    document = await update_imported_document(collaboration_tenant_id(user), user, document_id, payload)
    return {"document": document}


@router.delete("/documents/{document_id}")
async def remove_imported_document(
    document_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    document = await delete_imported_document(collaboration_tenant_id(user), document_id)
    await audit(user, "document_deleted", f'Arquivo "{document["title"]}" excluido.', "document", document_id, "warning")
    return {"ok": True, "document": document}


@router.get("/documents/{document_id}/download")
async def download_imported_document(
    document_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> Response:
    tenant_id = collaboration_tenant_id(user)
    store = await asyncio.to_thread(read_store, tenant_id)
    _, document = imported_document_or_404(store, document_id)
    content = document_bytes(tenant_id, document)
    await audit(user, "document_downloaded", f'Arquivo "{document.get("title")}" baixado.', "document", document_id, "info")
    filename = str(document.get("originalFileName") or "documento").replace('"', "")
    return Response(content, media_type=str(document.get("mimeType") or "application/octet-stream"),
                    headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "private, no-store"})


@router.post("/pdf/process")
async def post_pdf_process(
    payload: PdfProcessRequest,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = collaboration_tenant_id(user)
    job = await create_processing_job(tenant_id, user, payload)
    transient_options = {
        key: value
        for key, value in payload.options.items()
        if key == "password"
    }
    background_tasks.add_task(run_processing_job, tenant_id, job["id"], transient_options)
    await audit(user, "pdf_processing_queued", f'{job["label"]} agendado.', "processing_job", job["id"], "info")
    return {"job": job}


@router.get("/pdf/jobs/{job_id}")
async def get_pdf_job(job_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = await asyncio.to_thread(read_store, collaboration_tenant_id(user))
    _, job = processing_job_or_404(store, job_id)
    return {"job": processing_job_summary(job)}


@router.post("/pdf/jobs/{job_id}/cancel")
async def post_cancel_pdf_job(job_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    job = await cancel_processing_job(collaboration_tenant_id(user), job_id)
    return {"job": job}


@router.post("/proposals")
async def post_proposal(payload: ProposalCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    proposal = await create_proposal(user, payload)
    await audit(user, "proposal_created", f'Proposta "{proposal["title"]}" criada.', "proposal", proposal["id"], "success")
    await notify(user, "Nova proposta comercial", proposal["title"], "proposal_created", proposal["id"])
    return {"proposal": document_for_response(proposal)}


@router.post("/proposals/import-pdf")
async def import_proposal_pdf(payload: ProposalPdfUpload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    proposal = await upload_proposal_pdf(user, payload)
    await audit(user, "proposal_pdf_imported", f'Proposta "{proposal["title"]}" importada em PDF.', "proposal", proposal["id"], "success")
    return {"proposal": document_for_response(proposal)}


@router.post("/proposals/{proposal_id}/files")
async def attach_proposal_pdf(proposal_id: str, payload: ProposalPdfUpload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    proposal = await upload_proposal_pdf(user, payload, proposal_id)
    response = document_for_response(proposal)
    await manager.broadcast(collaboration_tenant_id(user), proposal_id, {"type": "DOCUMENT_UPDATED", "documentType": "proposal", "document": response, "actorId": str(user.get("id") or "")})
    await audit(user, "proposal_file_attached", f'Novo arquivo em "{proposal["title"]}".', "proposal", proposal_id, "success")
    return {"proposal": response}


@router.post("/proposal-draft")
async def post_proposal_draft(
    payload: ProposalBriefRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"draft": await generate_proposal_draft(user, payload)}


@router.post("/document-draft")
async def post_document_draft(
    payload: SmartDocumentRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Gera uma previa editavel com um unico briefing curto."""

    return {"draft": await generate_smart_document_draft(user, payload)}


@router.post("/documents/generate")
async def post_generate_document(
    payload: SmartDocumentRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Gera e salva documento + PDF; usado pela Central e pelo chat."""

    document, artifact = await create_smart_document(user, payload)
    template_type = str((document.get("metadata") or {}).get("documentType") or "custom")
    await audit(user, "document_generated", f'Documento "{document["title"]}" gerado pela Nora.', template_type, document["id"], "success")
    await notify(user, "Novo documento", document["title"], "document_generated", document["id"])
    return {"document": document_for_response(document), "file": artifact}


@router.post("/proposals/from-knowledge-pdf")
async def post_proposal_from_pdf(
    payload: ProposalFromPdfRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Nova proposta em rascunho privado a partir de um PDF autorizado.

    Mantém os demais dados/cláusulas da fonte e altera só os campos pedidos.
    Nunca sobrescreve o original nem publica, envia ou encaminha para
    assinatura: o fluxo de aprovação existente continua valendo.
    """
    result = await create_proposal_from_knowledge_pdf(user, payload.documentId, payload)
    await audit_proposal_created_from_pdf(user, result)
    return result


@router.get("/proposals/{proposal_id}")
async def get_proposal(proposal_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    _, _, _, proposal = await find_accessible_document(user, "proposal", proposal_id, "view")
    ensure_proposal_visible(user, proposal)
    return {"proposal": document_for_response(proposal)}


@router.get("/proposals/{proposal_id}/pdf")
async def export_proposal_pdf(proposal_id: str, user: dict[str, Any] = Depends(current_user), include_edits: bool = True) -> StreamingResponse:
    store_id, _, _, proposal = await find_accessible_document(user, "proposal", proposal_id, "view")
    pdf_bytes, filename = await asyncio.to_thread(build_commercial_pdf, proposal, "proposal", include_edits, store_id)
    ensure_proposal_visible(user, proposal)
    await audit(user, "proposal_pdf_exported", f'PDF da proposta "{proposal["title"]}" gerado.', "proposal", proposal_id, "success")
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.delete("/proposals/{proposal_id}")
async def remove_proposal(proposal_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    proposal = await delete_proposal(user, proposal_id)
    await audit(user, "proposal_deleted", f'Proposta "{proposal["title"]}" excluida.', "proposal", proposal_id, "warning")
    if str(proposal.get("visibility") or "team") != "private":
        await notify(user, "Proposta excluida", proposal["title"], "proposal_deleted", proposal_id)
    return {"ok": True, "proposal": document_for_response(proposal)}


@router.patch("/proposals/{proposal_id}")
async def patch_proposal(
    proposal_id: str,
    payload: ProposalUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await update_proposal(user, proposal_id, payload)
    response_proposal = document_for_response(proposal)
    if str(proposal.get("visibility") or "team") != "private":
        await manager.broadcast(
            collaboration_tenant_id(user),
            proposal_id,
        {"type": "DOCUMENT_UPDATED", "documentType": "proposal", "document": response_proposal, "actorId": str(user.get("id") or "")},
        )
    return {"proposal": response_proposal}


@router.post("/proposals/{proposal_id}/duplicate")
async def post_duplicate_proposal(
    proposal_id: str,
    payload: DocumentDuplicateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await duplicate_proposal(user, proposal_id, payload)
    await audit(user, "proposal_duplicated", f'Proposta "{proposal["title"]}" duplicada.', "proposal", proposal["id"], "success")
    return {"proposal": document_for_response(proposal)}


@router.patch("/proposals/{proposal_id}/status")
async def patch_proposal_status(
    proposal_id: str,
    payload: ProposalStatusChange,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await change_proposal_status(user, proposal_id, payload)
    await audit(user, "proposal_status_changed", f'Status de "{proposal["title"]}" atualizado.', "proposal", proposal_id, "success")
    return {"proposal": document_for_response(proposal)}


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
    return {"proposal": document_for_response(proposal)}


@router.post("/proposals/{proposal_id}/approve")
async def post_approve(
    proposal_id: str,
    payload: ProposalApprovalDecision,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await decide_proposal(user, proposal_id, approved=True, note=payload.note)
    await audit(user, "proposal_approved", f'Proposta "{proposal["title"]}" aprovada.', "proposal", proposal_id, "success")
    await notify(user, "Proposta aprovada", proposal["title"], "proposal_approved", proposal_id)
    return {"proposal": document_for_response(proposal)}


@router.post("/proposals/{proposal_id}/request-changes")
async def post_request_changes(
    proposal_id: str,
    payload: ProposalApprovalDecision,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await decide_proposal(user, proposal_id, approved=False, note=payload.note)
    await audit(user, "proposal_changes_requested", f'Ajustes solicitados em "{proposal["title"]}".', "proposal", proposal_id, "warning")
    return {"proposal": document_for_response(proposal)}


@router.post("/proposals/{proposal_id}/nora-analysis")
async def post_nora_analysis(
    proposal_id: str,
    payload: NoraAnalysisRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await analyze_with_nora(user, proposal_id, payload)
    await audit(user, "proposal_analyzed", f'Nora analisou "{proposal["title"]}".', "proposal", proposal_id, "info")
    return {"proposal": document_for_response(proposal)}


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
    response_proposal = document_for_response(proposal)
    if str(proposal.get("visibility") or "team") != "private":
        await manager.broadcast(
            collaboration_tenant_id(user),
            proposal_id,
        {"type": "DOCUMENT_UPDATED", "documentType": "proposal", "document": response_proposal, "actorId": str(user.get("id") or "")},
        )
    return {"proposal": response_proposal}


@router.post("/proposals/{proposal_id}/contract")
async def post_contract(
    proposal_id: str,
    payload: ContractCreate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    contract, proposal = await create_contract(user, proposal_id, payload.title, payload.templateId)
    await audit(user, "contract_created", f'Contrato "{contract["title"]}" gerado.', "contract", contract["id"], "success")
    await notify(user, "Contrato gerado", contract["title"], "contract_created", contract["id"])
    return {"contract": document_for_response(contract), "proposal": document_for_response(proposal)}


@router.get("/contracts/{contract_id}")
async def get_contract(contract_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    _, _, _, contract = await find_accessible_document(user, "contract", contract_id, "view")
    return {"contract": document_for_response(contract)}


@router.get("/contracts/{contract_id}/pdf")
async def export_contract_pdf(contract_id: str, user: dict[str, Any] = Depends(current_user), include_edits: bool = True) -> StreamingResponse:
    store_id, _, _, contract = await find_accessible_document(user, "contract", contract_id, "view")
    pdf_bytes, filename = await asyncio.to_thread(build_commercial_pdf, contract, "contract", include_edits, tenant_id=store_id)
    await audit(user, "contract_pdf_exported", f'PDF do contrato "{contract["title"]}" gerado.', "contract", contract_id, "success")
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.patch("/contracts/{contract_id}")
async def patch_contract(
    contract_id: str,
    payload: ContractUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    contract = await update_contract(user, contract_id, payload)
    response_contract = document_for_response(contract)
    await manager.broadcast(
        collaboration_tenant_id(user),
        contract_id,
        {"type": "DOCUMENT_UPDATED", "documentType": "contract", "document": response_contract, "actorId": str(user.get("id") or "")},
    )
    return {"contract": response_contract}


@router.post("/contracts/{contract_id}/cancel")
async def post_cancel_contract(
    contract_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    contract = await cancel_contract(user, contract_id)
    response_contract = document_for_response(contract)
    await audit(user, "contract_cancelled", f'Contrato "{contract["title"]}" cancelado e preservado no historico.', "contract", contract_id, "success")
    await manager.broadcast(
        collaboration_tenant_id(user),
        contract_id,
        {"type": "DOCUMENT_UPDATED", "documentType": "contract", "document": response_contract, "actorId": str(user.get("id") or "")},
    )
    return {"contract": response_contract}


@router.delete("/contracts/{contract_id}")
async def remove_contract(
    contract_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    contract, proposal = await delete_contract(user, contract_id)
    await audit(user, "contract_deleted", f'Minuta "{contract["title"]}" excluida.', "contract", contract_id, "success")
    await manager.broadcast(
        collaboration_tenant_id(user),
        contract_id,
        {"type": "DOCUMENT_DELETED", "documentType": "contract", "documentId": contract_id, "actorId": str(user.get("id") or "")},
    )
    return {
        "ok": True,
        "contract": document_for_response(contract),
        "proposal": document_for_response(proposal) if proposal else None,
    }


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


@router.put("/proposals/{proposal_id}/access")
async def put_proposal_access(
    proposal_id: str,
    payload: DocumentAccessUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    proposal = await update_document_access(user, "proposal", proposal_id, payload)
    await audit(user, "document_access_updated", f'Permissões de "{proposal["title"]}" atualizadas.', "proposal", proposal_id, "success")
    return {"proposal": document_for_response(proposal)}


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


@router.put("/contracts/{contract_id}/access")
async def put_contract_access(
    contract_id: str,
    payload: DocumentAccessUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    contract = await update_document_access(user, "contract", contract_id, payload)
    await audit(user, "document_access_updated", f'Permissões de "{contract["title"]}" atualizadas.', "contract", contract_id, "success")
    return {"contract": document_for_response(contract)}


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
        "contract": document_for_response(contract),
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
    return {"contract": document_for_response(contract)}


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
    return {**result, "contract": document_for_response(contract)}


@router.post("/brand-profiles")
async def post_brand_profile(
    payload: BrandProfileCreate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await create_brand_profile(user, payload)
    return {"brandProfile": item}


@router.get("/templates/{template_id}")
async def get_template_detail(template_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"template": await get_template(user, template_id)}


@router.post("/templates")
async def post_template(payload: TemplateCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    item = await create_template(user, payload)
    return {"template": item}


@router.patch("/templates/{template_id}")
async def patch_template(
    template_id: str,
    payload: TemplateUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"template": await update_template(user, template_id, payload)}


@router.post("/templates/{template_id}/duplicate")
async def post_duplicate_template(
    template_id: str,
    payload: DocumentDuplicateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"template": await duplicate_template(user, template_id, payload)}


@router.delete("/templates/{template_id}")
async def remove_template(template_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    item = await delete_template(user, template_id)
    return {"ok": True, "template": item}


@router.websocket("/ws/{document_id}")
async def commercial_socket(document_id: str, websocket: WebSocket, ticket: str = "") -> None:
    try:
        user = await user_from_websocket_ticket(ticket)
        if not effective_permissions(user).get("propostas"):
            raise HTTPException(status_code=403, detail="Acesso comercial indisponivel.")
    except Exception:
        await websocket.close(code=4401)
        return
    tenant_id = collaboration_tenant_id(user)
    store = await asyncio.to_thread(read_store, tenant_id)
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
    if not can_view_proposal(user, document):
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
