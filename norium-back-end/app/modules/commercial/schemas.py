from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator

from app.shared.schemas import StrictModel
from app.modules.commercial.pdf_editor import PdfEdits


ProposalStatus = Literal[
    "draft",
    "in_review",
    "changes_requested",
    "approved",
    "rejected",
    "sent",
    "viewed",
    "negotiating",
    "accepted",
    "declined",
    "expired",
    "contracted",
    "archived",
]
ContractStatus = Literal["draft", "awaiting_signatures", "signed", "active", "completed", "cancelled"]
TemplateDocumentType = Literal["proposal", "contract", "term", "budget", "report", "custom"]
PdfOperation = Literal[
    "merge",
    "split",
    "reorder",
    "delete_pages",
    "rotate",
    "compress",
    "images_to_pdf",
    "watermark",
    "edit_pdf",
    "page_numbers",
    "add_password",
    "remove_password",
    "ocr",
    "extract_text",
    "remove_metadata",
    "sanitize",
    "compare",
]
SignerRole = Literal["client", "contractor", "witness"]
LogoAlignment = Literal["left", "center", "right"]
SuggestionSeverity = Literal["info", "warning", "critical"]


class ClientSnapshot(StrictModel):
    id: str = Field(min_length=1, max_length=180)
    document: str = Field(default="", max_length=40)
    name: str = Field(min_length=2, max_length=180)
    company: str = Field(default="", max_length=180)
    email: str = Field(default="", max_length=220)


class Branding(StrictModel):
    logoUrl: str = Field(default="", max_length=2_000_000)
    logoAlignment: LogoAlignment = "left"
    logoScale: int = Field(default=100, ge=30, le=180)
    primaryColor: str = Field(default="#1E293B", pattern=r"^#[0-9A-Fa-f]{6}$")
    secondaryColor: str = Field(default="#3B82F6", pattern=r"^#[0-9A-Fa-f]{6}$")
    textColor: str = Field(default="#0F172A", pattern=r"^#[0-9A-Fa-f]{6}$")
    headerHtml: str = Field(default="", max_length=10_000)
    footerHtml: str = Field(default="", max_length=10_000)


class SignerInput(StrictModel):
    name: str = Field(min_length=2, max_length=180)
    email: str = Field(min_length=3, max_length=220)
    role: SignerRole
    order: int = Field(default=1, ge=1, le=50)
    required: bool = True

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()


class DeliverableInput(StrictModel):
    title: str = Field(min_length=2, max_length=180)
    description: str = Field(default="", max_length=2000)
    dueDate: str | None = None
    responsibleId: str = Field(default="", max_length=180)
    responsibleName: str = Field(default="", max_length=180)
    createCalendarEvent: bool = True


class ProposalCreate(StrictModel):
    clientId: str = Field(min_length=1, max_length=180)
    brainstormId: str | None = Field(default=None, max_length=180)
    title: str = Field(min_length=2, max_length=220)
    contentHtml: str = Field(default="<p>Descreva o escopo da proposta.</p>", max_length=350_000)
    scopeSummary: str = Field(default="", max_length=4000)
    amount: float = Field(default=0, ge=0, le=999_999_999)
    currency: str = Field(default="BRL", min_length=3, max_length=3)
    validUntil: str | None = None
    brandProfileId: str | None = Field(default=None, max_length=180)
    branding: Branding = Field(default_factory=Branding)
    signers: list[SignerInput] = Field(default_factory=list, max_length=50)
    deliverables: list[DeliverableInput] = Field(default_factory=list, max_length=100)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProposalBriefRequest(StrictModel):
    clientId: str = Field(min_length=1, max_length=180)
    brainstormId: str | None = Field(default=None, max_length=180)
    title: str = Field(default="", max_length=220)
    objective: str = Field(min_length=10, max_length=4000)
    scopeNotes: str = Field(min_length=10, max_length=12_000)
    team: str = Field(default="", max_length=4000)
    deadline: str = Field(default="", max_length=500)
    deliverablesNotes: str = Field(default="", max_length=6000)
    exclusions: str = Field(default="", max_length=6000)
    notes: str = Field(default="", max_length=6000)
    amount: float = Field(default=0, ge=0, le=999_999_999)
    currency: str = Field(default="BRL", min_length=3, max_length=3)
    tone: Literal["consultive", "executive", "technical", "friendly"] = "consultive"


class ProposalUpdate(StrictModel):
    pdfEdits: PdfEdits | None = None
    expectedVersion: int | None = Field(default=None, ge=1)
    clientId: str | None = Field(default=None, max_length=180)
    brainstormId: str | None = Field(default=None, max_length=180)
    title: str | None = Field(default=None, min_length=2, max_length=220)
    contentHtml: str | None = Field(default=None, max_length=350_000)
    scopeSummary: str | None = Field(default=None, max_length=4000)
    amount: float | None = Field(default=None, ge=0, le=999_999_999)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    validUntil: str | None = None
    branding: Branding | None = None
    signers: list[SignerInput] | None = Field(default=None, max_length=50)
    deliverables: list[DeliverableInput] | None = Field(default=None, max_length=100)
    metadata: dict[str, Any] | None = None


class ProposalSubmit(StrictModel):
    note: str = Field(default="", max_length=1200)


class ProposalApprovalDecision(StrictModel):
    note: str = Field(default="", max_length=1200)


class ProposalStatusChange(StrictModel):
    status: ProposalStatus
    note: str = Field(default="", max_length=1200)


class DocumentDuplicateRequest(StrictModel):
    title: str | None = Field(default=None, max_length=220)


class NoraAnalysisRequest(StrictModel):
    context: str = Field(default="", max_length=4000)
    focus: list[Literal["scope", "risk", "tone", "commercial", "legal", "grammar"]] = Field(
        default_factory=lambda: ["scope", "risk", "tone", "grammar"],
        max_length=6,
    )


class NoraWritingRequest(StrictModel):
    instruction: str = Field(min_length=3, max_length=4000)
    selectedText: str = Field(default="", max_length=16_000)
    mode: Literal["insert", "expand", "rewrite"] = "insert"


class DocumentShareRequest(StrictModel):
    channel: Literal["email", "team"]
    recipient: str = Field(default="", max_length=500)
    subject: str = Field(default="", max_length=240)
    message: str = Field(default="", max_length=12_000)


class SuggestionDecision(StrictModel):
    decision: Literal["accepted", "rejected"]


class ContractCreate(StrictModel):
    title: str | None = Field(default=None, max_length=220)
    templateId: str | None = Field(default=None, max_length=180)


class ContractUpdate(StrictModel):
    pdfEdits: PdfEdits | None = None
    expectedVersion: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, min_length=2, max_length=220)
    contentHtml: str | None = Field(default=None, max_length=350_000)
    branding: Branding | None = None
    signers: list[SignerInput] | None = Field(default=None, max_length=50)


class SignatureRequest(StrictModel):
    name: str = Field(min_length=2, max_length=180)
    email: str = Field(min_length=3, max_length=220)
    consent: bool
    signatureDataUrl: str = Field(default="", max_length=1_500_000)

    @field_validator("email")
    @classmethod
    def normalize_signature_email(cls, value: str) -> str:
        return value.strip().lower()


class InstantiateObligationsRequest(StrictModel):
    projectId: str = Field(default="default", max_length=180)
    projectName: str = Field(default="Contrato", max_length=180)
    createCalendarEvents: bool = True


class BrandProfileCreate(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    branding: Branding
    isDefault: bool = False


class TemplateCreate(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    description: str = Field(default="", max_length=800)
    contentHtml: str = Field(min_length=1, max_length=350_000)
    shared: bool = False
    category: str = Field(default="geral", max_length=80)
    documentType: TemplateDocumentType = "proposal"
    active: bool = True
    isDefault: bool = False
    variables: list[str] = Field(default_factory=list, max_length=100)


class TemplateUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = Field(default=None, max_length=800)
    contentHtml: str | None = Field(default=None, min_length=1, max_length=350_000)
    shared: bool | None = None
    category: str | None = Field(default=None, max_length=80)
    documentType: TemplateDocumentType | None = None
    active: bool | None = None
    isDefault: bool | None = None
    variables: list[str] | None = Field(default=None, max_length=100)


class DocumentImportRequest(StrictModel):
    fileName: str = Field(min_length=1, max_length=220)
    mimeType: Literal["application/pdf", "image/png", "image/jpeg", "image/webp"]
    dataBase64: str = Field(min_length=4, max_length=40_000_000)
    category: Literal["pdf", "sent", "received", "draft", "archived"] = "pdf"
    direction: Literal["internal", "sent", "received"] = "internal"
    confidential: bool = False


class ImportedDocumentUpdate(StrictModel):
    title: str | None = Field(default=None, min_length=1, max_length=220)
    category: Literal["pdf", "sent", "received", "draft", "archived"] | None = None
    favorite: bool | None = None
    archived: bool | None = None
    confidential: bool | None = None


class PdfProcessRequest(StrictModel):
    operation: PdfOperation
    documentIds: list[str] = Field(min_length=1, max_length=50)
    options: dict[str, Any] = Field(default_factory=dict, max_length=20)


class PublicDocumentLinkRequest(StrictModel):
    expiresInHours: int = Field(default=168, ge=1, le=24 * 90)
    allowDownload: bool = True
    allowComment: bool = True
    allowDecision: bool = True


class PublicDocumentAction(StrictModel):
    action: Literal["comment", "request_changes", "accept", "decline"]
    name: str = Field(default="", max_length=180)
    message: str = Field(default="", max_length=4000)
