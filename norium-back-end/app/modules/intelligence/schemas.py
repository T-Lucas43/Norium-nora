from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator

from app.shared.schemas import StrictModel


BrowserRisk = Literal["baixo", "medio", "alto"]


class BrowserProfilePayload(StrictModel):
    name: str = Field(min_length=2, max_length=120)
    allowedDomains: list[str] = Field(default_factory=list, max_length=50)
    blockedDomains: list[str] = Field(default_factory=list, max_length=50)
    allowDownloads: bool = False
    retainSession: bool = False

    @field_validator("allowedDomains", "blockedDomains")
    @classmethod
    def normalize_domains(cls, values: list[str]) -> list[str]:
        normalized = [value.strip().lower().lstrip(".") for value in values if value.strip()]
        return list(dict.fromkeys(normalized))


class BrowserPlanPayload(StrictModel):
    objective: str = Field(min_length=4, max_length=2000)
    startUrl: str = Field(min_length=8, max_length=2000)
    profileId: str | None = None
    maxPages: int = Field(default=1, ge=1, le=1)


class BrowserApprovalPayload(StrictModel):
    decision: Literal["approve", "reject"]
    note: str = Field(default="", max_length=500)


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
    provider: Literal["groq", "openai", "openai-compatible", "anthropic"]
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
