from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import Field, field_validator

from app.shared.schemas import StrictModel


BrowserRisk = Literal["baixo", "medio", "alto"]
BrowserActionType = Literal[
    "navigate", "search", "click", "fill", "credential_fill", "select",
    "press", "wait", "extract", "screenshot", "download", "upload", "research",
]


def _is_domain(value: str) -> bool:
    labels = value.split(".")
    return (
        len(value) <= 253
        and len(labels) >= 2
        and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)
    )


class BrowserActionPayload(StrictModel):
    type: BrowserActionType
    target: str = Field(default="", max_length=500)
    value: str = Field(default="", max_length=10_000)
    description: str = Field(default="", max_length=500)
    credentialId: str | None = Field(default=None, max_length=160)
    credentialField: Literal["username", "password", "secret"] | None = None
    artifactId: str | None = Field(default=None, max_length=160)


class BrowserProfilePayload(StrictModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=500)
    allowedDomains: list[str] = Field(default_factory=list, max_length=50)
    blockedDomains: list[str] = Field(default_factory=list, max_length=50)
    credentialIds: list[str] = Field(default_factory=list, max_length=20)
    allowDownloads: bool = False
    allowUploads: bool = False
    allowForms: bool = False
    retainSession: bool = False
    maxDurationSeconds: int = Field(default=300, ge=30, le=900)
    maxActions: int = Field(default=20, ge=1, le=40)

    @field_validator("allowedDomains", "blockedDomains")
    @classmethod
    def normalize_domains(cls, values: list[str]) -> list[str]:
        normalized = [value.strip().lower().lstrip(".") for value in values if value.strip()]
        if any(not _is_domain(value) for value in normalized):
            raise ValueError("Informe somente dominios validos, sem protocolo, caminho ou porta.")
        return list(dict.fromkeys(normalized))


class BrowserPlanPayload(StrictModel):
    objective: str = Field(min_length=4, max_length=2000)
    startUrl: str = Field(min_length=8, max_length=2000)
    profileId: str | None = Field(default=None, max_length=160)
    executionMode: Literal["assisted", "automatic"] = "assisted"
    expectedResult: Literal["summary", "structured", "files"] = "summary"
    maxPages: int = Field(default=10, ge=1, le=50)
    taskType: Literal["automation", "summary", "academic", "layout", "custom"] = "automation"
    scope: Literal["page", "site"] = "site"
    reportTitle: str = Field(default="", max_length=200)
    maxSteps: int = Field(default=20, ge=1, le=40)
    timeoutSeconds: int = Field(default=300, ge=30, le=900)
    actions: list[BrowserActionPayload] = Field(default_factory=list, max_length=40)
    useAiPlanner: bool = True


class BrowserApprovalPayload(StrictModel):
    decision: Literal["approve", "reject"]
    note: str = Field(default="", max_length=500)
    actionId: str | None = Field(default=None, max_length=160)


class BrowserCredentialPayload(StrictModel):
    label: str = Field(min_length=2, max_length=120)
    domain: str = Field(min_length=3, max_length=255)
    username: str = Field(min_length=1, max_length=500)
    password: str = Field(min_length=1, max_length=5000)

    @field_validator("domain")
    @classmethod
    def normalize_domain(cls, value: str) -> str:
        normalized = value.strip().lower().lstrip(".")
        if not _is_domain(normalized):
            raise ValueError("Informe um dominio valido, sem protocolo, caminho ou porta.")
        return normalized


class BrowserUploadPayload(StrictModel):
    fileName: str = Field(min_length=1, max_length=240)
    mimeType: str = Field(default="application/octet-stream", max_length=160)
    dataUrl: str = Field(min_length=16, max_length=14_000_000)


class BrowserPlanActionsPayload(StrictModel):
    actions: list[BrowserActionPayload] = Field(min_length=1, max_length=40)


class BrowserReportPayload(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=200_000)
    revision: int = Field(ge=1)

    @field_validator("title", "content")
    @classmethod
    def nonblank_report(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Preencha o título e o conteúdo do relatório.")
        return value.strip()


class BrowserReportRewritePayload(StrictModel):
    revision: int = Field(ge=1)
    instruction: str = Field(default="Desenvolva a análise com frases completas, contexto, explicações e relações entre os conceitos.", min_length=4, max_length=2000)


class KnowledgeBasePayload(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    description: str = Field(default="", max_length=1000)
    visibility: Literal["private", "team", "workspace"] = "workspace"
    tags: list[str] = Field(default_factory=list, max_length=30)


class KnowledgeSourcePayload(StrictModel):
    kind: Literal["text", "url"] = "text"
    title: str = Field(min_length=2, max_length=220)
    content: str = Field(default="", max_length=300_000)
    url: str = Field(default="", max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=30)


class KnowledgeSearchPayload(StrictModel):
    query: str = Field(min_length=2, max_length=1000)
    baseIds: list[str] = Field(default_factory=list, max_length=50)
    limit: int = Field(default=6, ge=1, le=20)


class MarketplaceInstallPayload(StrictModel):
    confirm: bool
    version: str | None = Field(default=None, max_length=32)


class ModelProviderPayload(StrictModel):
    name: str = Field(min_length=2, max_length=120)
    provider: Literal["groq", "openai", "openai-compatible", "anthropic", "google"]
    model: str = Field(min_length=2, max_length=180)
    baseUrl: str = Field(default="", max_length=2000)
    secret: str = Field(default="", max_length=20_000)
    enabled: bool = False
    capabilities: list[Literal["text", "vision", "tools", "json"]] = Field(default_factory=lambda: ["text"])
    contextWindow: int = Field(default=8192, ge=1024, le=4_000_000)
    inputCostPerMillion: float = Field(default=0, ge=0, le=1000)
    outputCostPerMillion: float = Field(default=0, ge=0, le=1000)
    dataPolicy: Literal["external", "private", "local"] = "external"


class ModelPolicyPayload(StrictModel):
    name: str = Field(min_length=2, max_length=120)
    mode: Literal["automatic", "manual"] = "automatic"
    preferredProviderId: str | None = None
    fallbackProviderIds: list[str] = Field(default_factory=list, max_length=20)
    requireCapabilities: list[Literal["text", "vision", "tools", "json"]] = Field(default_factory=lambda: ["text"])
    maxInputCostPerMillion: float | None = Field(default=None, ge=0, le=1000)
    privacy: Literal["any", "private", "local"] = "any"
    monthlyBudget: float | None = Field(default=None, ge=0, le=10_000_000)
    enabled: bool = True


class ModelRoutePayload(StrictModel):
    policyId: str | None = None
    preferredProviderId: str | None = None
    requiredCapabilities: list[Literal["text", "vision", "tools", "json"]] = Field(default_factory=lambda: ["text"])
    estimatedInputTokens: int = Field(default=1000, ge=1, le=4_000_000)
    estimatedOutputTokens: int = Field(default=500, ge=1, le=1_000_000)
    privacy: Literal["any", "private", "local"] = "any"
    externalActionCommitted: bool = False


class ModelTestPayload(StrictModel):
    timeoutSeconds: int = Field(default=10, ge=2, le=30)


class MarketplaceUpdatePayload(StrictModel):
    confirm: bool
