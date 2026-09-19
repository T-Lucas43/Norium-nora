"""Bounded contracts, independent of HTTP, model providers and business stores."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class BrainError(Exception):
    def __init__(self, code: str, status: int = 409):
        self.code, self.status = code, status
        super().__init__(code)


class InformationRequired(BrainError):
    """A safe, structured clarification that must return to the same job."""

    def __init__(self, code: str, prompt: str, details: dict[str, Any] | None = None):
        super().__init__(code, 422)
        self.prompt = prompt
        self.details = details or {}


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


@dataclass(frozen=True)
class Scope:
    tenant: str
    user: str
    workspace: str

    def __post_init__(self):
        if not all((self.tenant, self.user, self.workspace)):
            raise BrainError("identity_required", 401)

    def as_dict(self) -> dict[str, str]:
        return {"tenant": self.tenant, "user": self.user, "workspace": self.workspace}


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Submit(Strict):
    requestId: str = Field(min_length=8, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    message: str = Field(min_length=1, max_length=4000)
    category: Literal["routine", "document", "complex"] = "routine"
    complexBudgetApproved: bool = False
    attachmentIds: list[str] = Field(default_factory=list, max_length=8)


class Decision(Strict):
    kind: Literal["tool", "answer", "question"]
    tool: str = Field(default="", max_length=100)
    arguments: dict[str, Any] = Field(default_factory=dict)
    text: str = Field(default="", max_length=8000)


@dataclass(frozen=True)
class ModelReply:
    decision: Decision
    input_tokens: int
    output_tokens: int
    model: str


@dataclass(frozen=True)
class Outcome:
    status: Literal["succeeded", "rejected", "unknown", "needs_information"]
    data: dict[str, Any]
    evidence: dict[str, Any]


@dataclass(frozen=True)
class Profile:
    tokens: int
    calls: int
    seconds: int
    context: int
    tools: int


PROFILES = {
    "routine": Profile(12_000, 4, 180, 8_000, 8),
    "document": Profile(50_000, 8, 600, 12_000, 16),
    "complex": Profile(100_000, 12, 1200, 24_000, 24),
}
TERMINAL = {"completed", "cancelled", "failed"}
POLICY_VERSION = "2026-09-16.1"
