from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from app.shared.schemas import StrictModel


class WorkspacePayload(StrictModel):
    name: str = Field(min_length=2, max_length=100)
    legalName: str = Field(default="", max_length=160)
    document: str = Field(default="", max_length=32)
    domain: str = Field(default="", max_length=160)
    logoUrl: str = Field(default="", max_length=2000)
    primaryColor: str = Field(default="#1677ff", pattern=r"^#[0-9a-fA-F]{6}$")
    accentColor: str = Field(default="#22d3ee", pattern=r"^#[0-9a-fA-F]{6}$")
    emailSignature: str = Field(default="", max_length=4000)
    reportFooter: str = Field(default="", max_length=500)


class AbsencePayload(StrictModel):
    memberId: str = Field(min_length=1)
    substituteId: str = Field(min_length=1)
    startsAt: str = Field(min_length=8)
    endsAt: str = Field(min_length=8)
    reason: str = Field(default="", max_length=500)
    redirectTasks: bool = True
    redirectMessages: bool = True
    redirectApprovals: bool = True


class PortalInvitePayload(StrictModel):
    clientName: str = Field(min_length=2, max_length=160)
    email: str = Field(min_length=3, max_length=254)
    expiresInDays: int = Field(default=14, ge=1, le=90)
    permissions: list[Literal["requests", "documents", "approvals", "deadlines"]] = [
        "requests",
        "documents",
        "approvals",
        "deadlines",
    ]


class PortalRequestPayload(StrictModel):
    title: str = Field(min_length=2, max_length=180)
    description: str = Field(default="", max_length=6000)
    attachments: list[dict[str, Any]] = []


class PublicFormPayload(StrictModel):
    title: str = Field(min_length=2, max_length=180)
    description: str = Field(default="", max_length=1200)
    destination: Literal["client", "task", "calendar", "opportunity"] = "client"
    fields: list[dict[str, Any]] = []
    successMessage: str = Field(default="Recebemos suas informacoes.", max_length=500)
    active: bool = True


class FormSubmissionPayload(StrictModel):
    values: dict[str, Any]
    attachments: list[dict[str, Any]] = []


class KnowledgePayload(StrictModel):
    title: str = Field(min_length=2, max_length=220)
    content: str = Field(min_length=2, max_length=100_000)
    sourceUrl: str = Field(default="", max_length=2000)
    tags: list[str] = []
    visibility: Literal["workspace", "team", "private"] = "workspace"


class KnowledgePdfPayload(StrictModel):
    fileName: str = Field(min_length=5, max_length=255)
    dataUrl: str = Field(min_length=16, max_length=20_000_000)
    title: str = Field(default="", max_length=220)
    tags: list[str] = []
    visibility: Literal["workspace", "team", "private"] = "workspace"


class KnowledgeQueryPayload(StrictModel):
    query: str = Field(min_length=2, max_length=1000)
    limit: int = Field(default=5, ge=1, le=20)


class SignaturePayload(StrictModel):
    title: str = Field(min_length=2, max_length=180)
    provider: Literal["manual", "clicksign", "docusign", "zapsign"] = "manual"
    documentUrl: str = Field(min_length=3, max_length=2000)
    signers: list[dict[str, str]] = Field(min_length=1)
    message: str = Field(default="", max_length=2000)
    expiresAt: str | None = None


class SignatureStatusPayload(StrictModel):
    status: Literal["draft", "sent", "viewed", "signed", "declined", "expired", "cancelled"]


class ApprovalRulePayload(StrictModel):
    name: str = Field(min_length=2, max_length=180)
    resource: Literal["finance", "email", "task", "automation", "deletion", "signature"]
    condition: dict[str, Any] = {}
    approverIds: list[str] = Field(min_length=1)
    active: bool = True


class ApprovalEvaluationPayload(StrictModel):
    resource: str = Field(min_length=1)
    data: dict[str, Any] = {}


class VaultPayload(StrictModel):
    integration: str = Field(min_length=2, max_length=80)
    label: str = Field(min_length=2, max_length=120)
    secret: str = Field(min_length=4, max_length=20_000)
    expiresAt: str | None = None
    scopes: list[str] = []


class SlaPolicyPayload(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    channel: Literal["all", "gmail", "whatsapp", "telegram", "portal"]
    priority: Literal["all", "low", "medium", "high", "urgent"] = "all"
    responseMinutes: int = Field(ge=1, le=43_200)
    businessHours: dict[str, Any] = {
        "timezone": "America/Sao_Paulo",
        "weekdays": [1, 2, 3, 4, 5],
        "start": "08:00",
        "end": "18:00",
    }
    escalateTo: list[str] = []
    active: bool = True


class SlaCasePayload(StrictModel):
    policyId: str = Field(min_length=1)
    title: str = Field(min_length=2, max_length=220)
    resourceType: str = Field(min_length=1, max_length=80)
    resourceId: str = Field(min_length=1, max_length=220)
    priority: Literal["low", "medium", "high", "urgent"] = "medium"
    responsibleId: str | None = None


class QuickCapturePayload(StrictModel):
    content: str = Field(default="", max_length=20_000)
    kind: Literal["text", "audio", "image", "file"] = "text"
    fileName: str = Field(default="", max_length=255)
    mimeType: str = Field(default="", max_length=160)
    dataUrl: str = Field(default="", max_length=20_000_000)
    destination: Literal["auto", "task", "finance", "calendar", "note"] = "auto"
    confirm: bool = False


class OcrPayload(StrictModel):
    fileName: str = Field(default="", max_length=255)
    mimeType: str = Field(default="", max_length=160)
    dataUrl: str = Field(default="", max_length=20_000_000)
    recognizedText: str = Field(default="", max_length=100_000)
    createTransaction: bool = False


class MeetingPayload(StrictModel):
    title: str = Field(min_length=2, max_length=220)
    transcript: str = Field(default="", max_length=200_000)
    audioDataUrl: str = Field(default="", max_length=30_000_000)
    participants: list[str] = []
    createTasks: bool = False


class HandoffPayload(StrictModel):
    note: str = Field(default="", max_length=4000)
    nextOperatorId: str | None = None
