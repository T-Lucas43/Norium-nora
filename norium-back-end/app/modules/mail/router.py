"""Dominio de e-mail extraido sem alterar contratos do Gmail."""

from __future__ import annotations

from datetime import datetime, timezone
import logging
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, Response
from pydantic import Field

from app.shared.schemas import StrictModel
from app.infrastructure.http.oauth_result import oauth_result_html

from app.routers.inbox_router import record_event
from app.routers.auth_router import current_user
from app.modules.operations.schemas import ReceiptCreate
from app.modules.operations.service import finalize_email_agent_result, record_receipt
from app.services.email_agent import shared_email_agent
from app.services.gmail_service import GmailConfigError, GmailService

router = APIRouter(tags=["Gmail"])
email_agent = shared_email_agent
logger = logging.getLogger(__name__)


class AttachmentPayload(StrictModel):
    fileName: str = Field(min_length=1, max_length=240)
    mimeType: str = "application/octet-stream"
    dataUrl: str = Field(min_length=16)


# Mantém o identificador histórico no OpenAPI quando há schemas homônimos.
AttachmentPayload.__module__ = "app.routers.gmail_router"
AttachmentPayload.model_rebuild(force=True)


class SendEmailPayload(StrictModel):
    user_id: str = "lucas123"
    to: list[str] = Field(min_length=1)
    cc: list[str] = []
    bcc: list[str] = []
    subject: str = ""
    body: str = ""
    attachments: list[AttachmentPayload] = []


class ReplyEmailPayload(StrictModel):
    user_id: str = "lucas123"
    body: str = Field(min_length=1)
    attachments: list[AttachmentPayload] = []


class DraftEmailPayload(SendEmailPayload):
    pass


class ModifyMessagePayload(StrictModel):
    user_id: str = "lucas123"
    action: Literal[
        "read",
        "unread",
        "archive",
        "move_inbox",
        "trash",
        "untrash",
        "star",
        "unstar",
        "spam",
        "important",
        "unimportant",
        "labels",
    ]
    addLabelIds: list[str] = []
    removeLabelIds: list[str] = []


class LabelPayload(StrictModel):
    user_id: str = "lucas123"
    name: str = Field(min_length=1, max_length=225)


class EmailAgentPayload(StrictModel):
    user_id: str = "lucas123"
    session_id: str | None = None
    message: str = Field(min_length=1)


class DisconnectPayload(StrictModel):
    user_id: str = "lucas123"


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def gmail_event_timestamp(message: dict[str, Any]) -> str | None:
    raw_timestamp = message.get("timestamp")
    try:
        return datetime.fromtimestamp(int(raw_timestamp), tz=timezone.utc).isoformat()
    except Exception:
        return None


def gmail_oauth_error_message(error: str, error_description: str | None) -> str:
    """Traduz falhas de configuracao sem confundi-las com cancelamento."""
    error_key = str(error or "").strip().casefold()
    description_key = str(error_description or "").strip().casefold()
    testing_markers = (
        "test user",
        "test users",
        "being tested",
        "modo de teste",
        "unverified",
        "not verified",
        "verification",
        "developer hasn't given you access",
        "developer has not given you access",
    )
    if error_key == "access_denied" and any(marker in description_key for marker in testing_markers):
        return (
            "O Google bloqueou esta conta porque o cliente OAuth do Norium ainda está em modo de teste "
            "ou aguardando verificação. Inclua a conta em Test users para homologação ou publique e "
            "verifique o app no Google Cloud para liberar os demais usuários."
        )
    if error_key == "redirect_uri_mismatch":
        return (
            "O endereço de retorno do Gmail não coincide com o URI autorizado no Google Cloud. "
            "Cadastre exatamente o callback público do Norium, incluindo https e sem alterar a barra final."
        )
    if error_key == "org_internal":
        return (
            "Este cliente Google está configurado como interno e só aceita contas da organização autorizada. "
            "Use uma conta desse domínio ou altere o público do app no Google Cloud."
        )
    if error_key == "access_denied":
        return "A autorização foi cancelada na Conta do Google. Nenhum acesso foi concedido."
    return "O Google não conseguiu autorizar esta conta. Gere um novo link e tente novamente."


def cancel_gmail_oauth_attempt(user_id: str, state: str | None) -> None:
    """Cancela state valido sem deixar uma falha de persistencia quebrar o callback."""
    try:
        GmailService(user_id).cancel_oauth(state)
    except Exception:
        logger.exception("Falha ao cancelar uma tentativa OAuth do Gmail")


async def record_gmail_messages_for_central(messages: list[dict[str, Any]], folder: str, user_id: str) -> int:
    count = 0
    for message in messages:
        message_id = str(message.get("id") or "").strip()
        if not message_id:
            continue
        sent = folder == "sent" or "SENT" in (message.get("labels") or [])
        title = "E-mail enviado" if sent else "E-mail recebido"
        subject = message.get("subject") or "(sem assunto)"
        actor = message.get("to") if sent else message.get("fromName") or message.get("fromEmail") or "Remetente"
        description = f"{actor} - {subject}"
        snippet = (message.get("snippet") or "").strip()
        if snippet:
            description = f"{description}: {snippet}"
        await record_event(
            source="gmail",
            title=title,
            description=description,
            metadata={
                "messageId": message_id,
                "userId": user_id,
                "threadId": message.get("threadId"),
                "folder": folder,
                "subject": subject,
                "from": message.get("from"),
                "to": message.get("to"),
            },
            event_id=f"gmail_{user_id}_{folder}_{message_id}",
            timestamp=gmail_event_timestamp(message),
            broadcast=not sent,
        )
        count += 1
    return count


@router.get("/api/emails/gmail/status")
async def gmail_status(user: dict[str, Any] = Depends(current_user)):
    return GmailService(tenant_id(user)).status()


@router.get("/api/emails/gmail/auth-url")
async def gmail_auth_url(user: dict[str, Any] = Depends(current_user)):
    try:
        return GmailService(tenant_id(user)).authorization_url()
    except GmailConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/emails/gmail/disconnect")
async def gmail_disconnect(payload: DisconnectPayload, user: dict[str, Any] = Depends(current_user)):
    return GmailService(tenant_id(user)).disconnect()


@router.get(
    "/api/auth/callback/gmail",
    response_class=HTMLResponse,
    openapi_extra={
        "parameters": [
            {
                "name": "code",
                "in": "query",
                "required": True,
                "schema": {"type": "string", "title": "Code"},
            }
        ]
    },
)
async def gmail_callback(
    code: str | None = Query(default=None, include_in_schema=False),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
    user_id: str | None = None,
):
    # O Google pode devolver apenas ``error`` quando o usuario cancela. O campo
    # fica opcional em execucao, mas o contrato OpenAPI historico continua
    # documentando ``code`` como obrigatorio via ``openapi_extra`` acima.
    # ``user_id`` permanece apenas por compatibilidade de contrato e nunca e
    # usado como autorizacao. A conta vem exclusivamente do state aleatorio.
    resolved_user_id = GmailService.user_id_from_state(state)
    if not resolved_user_id:
        return HTMLResponse(
            oauth_result_html(
                provider="Gmail",
                success=False,
                title="Falha ao conectar o Gmail",
                message="A solicitação de conexão é inválida ou expirou.",
            ),
            status_code=400,
        )
    if error:
        cancel_gmail_oauth_attempt(resolved_user_id, state)
        message = gmail_oauth_error_message(error, error_description)
        logger.warning("Google recusou OAuth do Gmail: %s", error)
        return HTMLResponse(
            oauth_result_html(
                provider="Gmail",
                success=False,
                title="Gmail não conectado",
                message=message,
            ),
            status_code=400,
        )
    if not code:
        cancel_gmail_oauth_attempt(resolved_user_id, state)
        return HTMLResponse(
            oauth_result_html(
                provider="Gmail",
                success=False,
                title="Resposta incompleta do Google",
                message="O Google não devolveu um código de autorização. Gere um novo link no Norium.",
            ),
            status_code=400,
        )
    try:
        GmailService(resolved_user_id).finish_oauth(code=code, state=state)
    except GmailConfigError:
        logger.warning("Callback OAuth do Gmail recusado para uma tentativa invalida ou expirada")
        return HTMLResponse(
            oauth_result_html(
                provider="Gmail",
                success=False,
                title="Falha ao conectar o Gmail",
                message="A solicitação de conexão é inválida, expirou ou já foi utilizada.",
            ),
            status_code=400,
        )
    except Exception:
        logger.exception("Falha no callback OAuth do Gmail")
        return HTMLResponse(
            oauth_result_html(
                provider="Gmail",
                success=False,
                title="Não foi possível conectar o Gmail",
                message="O Google não concluiu a autorização. Tente novamente em alguns instantes.",
            ),
            status_code=400,
        )

    return oauth_result_html(
        provider="Gmail",
        success=True,
        title="Gmail conectado",
        message="Autorização concluída. Seus e-mails serão sincronizados automaticamente no Norium Mail.",
    )


@router.get("/api/emails/gmail/labels")
async def list_gmail_labels(user: dict[str, Any] = Depends(current_user)):
    try:
        return GmailService(tenant_id(user)).list_labels()
    except GmailConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/api/emails/gmail/labels")
async def create_gmail_label(payload: LabelPayload, user: dict[str, Any] = Depends(current_user)):
    try:
        return GmailService(tenant_id(user)).create_label(payload.name)
    except GmailConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/api/emails/gmail/messages")
async def list_gmail_messages(
    user_id: str = "lucas123",
    folder: str = "inbox",
    q: str | None = None,
    page_token: str | None = None,
    max_results: int = Query(default=25, ge=1, le=50),
    user: dict[str, Any] = Depends(current_user),
):
    try:
        return GmailService(tenant_id(user)).list_messages(
            folder=folder,
            query=q,
            page_token=page_token,
            max_results=max_results,
        )
    except GmailConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao sincronizar Gmail.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao sincronizar Gmail.") from exc


@router.post("/api/emails/gmail/sync-central")
async def sync_gmail_to_central(user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    try:
        resolved_user_id = tenant_id(user)
        service = GmailService(resolved_user_id)
        inbox = service.list_messages(folder="inbox", max_results=8).get("messages", [])
        sent = service.list_messages(folder="sent", max_results=8).get("messages", [])
        total = 0
        total += await record_gmail_messages_for_central(inbox, "inbox", resolved_user_id)
        total += await record_gmail_messages_for_central(sent, "sent", resolved_user_id)
        return {"synced": total}
    except GmailConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao sincronizar Gmail com a Central.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao sincronizar Gmail com a Central.") from exc


@router.get("/api/emails/gmail/messages/{message_id}")
async def get_gmail_message(message_id: str, user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    try:
        return GmailService(tenant_id(user)).get_message(message_id)
    except GmailConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao abrir e-mail.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao abrir e-mail.") from exc


@router.post("/api/emails/gmail/send")
async def send_gmail_message(payload: SendEmailPayload, user: dict[str, Any] = Depends(current_user)):
    try:
        resolved_user_id = tenant_id(user)
        result = GmailService(resolved_user_id).send_message(
            to=payload.to,
            cc=payload.cc,
            bcc=payload.bcc,
            subject=payload.subject,
            body=payload.body,
            attachments=[attachment.model_dump() for attachment in payload.attachments],
        )
        await record_event(
            source="gmail",
            title="E-mail enviado",
            description=payload.subject or "Mensagem sem assunto",
            metadata={"userId": resolved_user_id, "folder": "sent", "to": payload.to, "message": result.get("message", {})},
            broadcast=False,
        )
        sent_message = result.get("message", {}) if isinstance(result, dict) else {}
        await record_receipt(
            user,
            ReceiptCreate(
                action="email_sent",
                title="E-mail enviado",
                description=f'{payload.subject or "Mensagem sem assunto"} para {", ".join(payload.to)}.',
                entityType="email",
                entityId=str(sent_message.get("id") or "") or None,
                metadata={
                    "to": payload.to,
                    "cc": payload.cc,
                    "bcc": payload.bcc,
                    "subject": payload.subject,
                    "attachmentCount": len(payload.attachments),
                },
            ),
        )
        return result
    except GmailConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao enviar e-mail.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao enviar e-mail.") from exc


@router.post("/api/emails/gmail/drafts")
async def create_gmail_draft(payload: DraftEmailPayload, user: dict[str, Any] = Depends(current_user)):
    try:
        resolved_user_id = tenant_id(user)
        result = GmailService(resolved_user_id).create_draft(
            to=payload.to,
            cc=payload.cc,
            bcc=payload.bcc,
            subject=payload.subject,
            body=payload.body,
            attachments=[attachment.model_dump() for attachment in payload.attachments],
        )
        await record_event(
            source="gmail",
            title="Rascunho de e-mail criado",
            description=payload.subject or "Rascunho sem assunto",
            metadata={"userId": resolved_user_id, "folder": "drafts", "to": payload.to, "draft": result.get("draft", {})},
            broadcast=False,
        )
        return result
    except GmailConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/emails/gmail/drafts/{draft_id}/send")
async def send_gmail_draft(draft_id: str, user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    try:
        return GmailService(tenant_id(user)).send_draft(draft_id)
    except GmailConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/emails/gmail/messages/{message_id}/reply")
async def reply_gmail_message(message_id: str, payload: ReplyEmailPayload, user: dict[str, Any] = Depends(current_user)):
    try:
        resolved_user_id = tenant_id(user)
        result = GmailService(resolved_user_id).reply_message(
            message_id=message_id,
            body=payload.body,
            attachments=[attachment.model_dump() for attachment in payload.attachments],
        )
        await record_event(
            source="gmail",
            title="Resposta enviada no Gmail",
            description=payload.body[:220],
            metadata={"userId": resolved_user_id, "folder": "sent", "messageId": message_id, "message": result.get("message", {})},
            broadcast=False,
        )
        sent_message = result.get("message", {}) if isinstance(result, dict) else {}
        await record_receipt(
            user,
            ReceiptCreate(
                action="email_replied",
                title="Resposta de e-mail enviada",
                description=f"Resposta enviada na conversa {message_id}.",
                entityType="email",
                entityId=str(sent_message.get("id") or message_id),
                metadata={"threadMessageId": message_id, "attachmentCount": len(payload.attachments)},
            ),
        )
        return result
    except GmailConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao responder e-mail.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao responder e-mail.") from exc


@router.patch("/api/emails/gmail/messages/{message_id}")
async def modify_gmail_message(message_id: str, payload: ModifyMessagePayload, user: dict[str, Any] = Depends(current_user)):
    try:
        return GmailService(tenant_id(user)).modify_message(
            message_id,
            action=payload.action,
            add_label_ids=payload.addLabelIds,
            remove_label_ids=payload.removeLabelIds,
        )
    except GmailConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/emails/gmail/attachments")
async def download_gmail_attachment(
    message_id: str = Query(...),
    attachment_id: str = Query(...),
    filename: str = Query(default="anexo"),
    mime_type: str = Query(default="application/octet-stream"),
    user_id: str = "lucas123",
    user: dict[str, Any] = Depends(current_user),
):
    try:
        content = GmailService(tenant_id(user)).download_attachment(message_id=message_id, attachment_id=attachment_id)
    except GmailConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    safe_name = Path(filename).name or "anexo"
    return Response(
        content=content,
        media_type=mime_type or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )


@router.post("/api/emails/gmail/agente/mensagem")
async def conversar_com_agente_email(payload: EmailAgentPayload, user: dict[str, Any] = Depends(current_user)):
    try:
        result = await email_agent.handle(
            message=payload.message,
            session_id=payload.session_id,
            user_id=tenant_id(user),
        )
        return await finalize_email_agent_result(user, email_agent, result, surface="mail")
    except Exception as exc:
        logger.exception("Agente de e-mail falhou.")
        raise HTTPException(status_code=500, detail="O agente de e-mail falhou temporariamente.") from exc
