"""Dominio de e-mail extraido sem alterar contratos do Gmail."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, Response
from pydantic import Field

from app.shared.schemas import StrictModel

from app.routers.inbox_router import record_event
from app.routers.auth_router import current_user
from app.modules.operations.schemas import ReceiptCreate
from app.modules.operations.service import record_receipt
from app.services.email_agent import EmailAgent
from app.services.gmail_service import GmailConfigError, GmailService

router = APIRouter(tags=["Gmail"])
email_agent = EmailAgent()


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


@router.get("/api/auth/callback/gmail", response_class=HTMLResponse)
async def gmail_callback(
    code: str = Query(...),
    state: str | None = Query(default=None),
    user_id: str = "lucas123",
):
    resolved_user_id = GmailService.user_id_from_state(state) or user_id
    try:
        GmailService(resolved_user_id).finish_oauth(code=code, state=state)
    except Exception as exc:
        return HTMLResponse(
            f"""
            <html>
              <body style="font-family:system-ui;background:#0B1220;color:white;padding:32px">
                <h1>Falha ao conectar o Gmail</h1>
                <p>{str(exc)}</p>
              </body>
            </html>
            """,
            status_code=400,
        )

    return """
    <html>
      <body style="font-family:system-ui;background:#0B1220;color:white;padding:32px">
        <h1>Gmail conectado</h1>
        <p>Voce ja pode voltar para o Norium Mail. Seus e-mails serao sincronizados automaticamente.</p>
        <script>setTimeout(() => window.close(), 1200)</script>
      </body>
    </html>
    """


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
        raise HTTPException(status_code=502, detail=f"Falha ao sincronizar Gmail: {str(exc)}") from exc


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
        raise HTTPException(status_code=502, detail=f"Falha ao sincronizar Gmail com a Central: {str(exc)}") from exc


@router.get("/api/emails/gmail/messages/{message_id}")
async def get_gmail_message(message_id: str, user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    try:
        return GmailService(tenant_id(user)).get_message(message_id)
    except GmailConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Falha ao abrir e-mail: {str(exc)}") from exc


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
        raise HTTPException(status_code=502, detail=f"Falha ao enviar e-mail: {str(exc)}") from exc


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
        raise HTTPException(status_code=502, detail=f"Falha ao responder e-mail: {str(exc)}") from exc


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
        return await email_agent.handle(
            message=payload.message,
            session_id=payload.session_id,
            user_id=tenant_id(user),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Agente de e-mail falhou: {str(exc)}") from exc
