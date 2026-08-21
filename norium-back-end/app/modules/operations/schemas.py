from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator

from app.shared.schemas import StrictModel


OperationStatus = Literal["pending", "approved", "rejected", "executed", "failed", "cancelled"]
AuditStatus = Literal["success", "warning", "error", "info"]


class AuditCreate(StrictModel):
    action: str = Field(min_length=2, max_length=120)
    source: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=1200)
    status: AuditStatus = "info"
    entityType: str | None = Field(default=None, max_length=80)
    entityId: str | None = Field(default=None, max_length=180)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ReceiptCreate(StrictModel):
    action: str = Field(min_length=2, max_length=120)
    title: str = Field(min_length=2, max_length=180)
    description: str = Field(default="", max_length=1200)
    status: Literal["executed", "failed"] = "executed"
    entityType: str | None = Field(default=None, max_length=80)
    entityId: str | None = Field(default=None, max_length=180)
    undoAction: str | None = Field(default=None, max_length=160)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ApprovalCreate(StrictModel):
    title: str = Field(min_length=2, max_length=180)
    description: str = Field(default="", max_length=1200)
    action: str = Field(min_length=2, max_length=120)
    source: str = Field(min_length=2, max_length=80)
    payload: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    expiresAt: str | None = None


class ApprovalDecision(StrictModel):
    decision: Literal["approved", "rejected", "cancelled"]
    note: str = Field(default="", max_length=800)

    @field_validator("note")
    @classmethod
    def normalize_note(cls, value: str) -> str:
        return value.strip()


class ApprovalUpdate(StrictModel):
    title: str = Field(min_length=2, max_length=180)
    description: str = Field(default="", max_length=1200)

    @field_validator("title", "description")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        return value.strip()


class NoraMemoryCreate(StrictModel):
    key: str = Field(min_length=2, max_length=120)
    value: str = Field(min_length=2, max_length=1200)
    category: Literal["communication", "client", "project", "process", "general"] = "general"
    scope: Literal["personal", "team"] = "personal"

    @field_validator("key", "value")
    @classmethod
    def normalize_memory_text(cls, value: str) -> str:
        return value.strip()


class OperationTemplateCreate(StrictModel):
    name: str = Field(min_length=2, max_length=120)
    kind: Literal[
        "email",
        "task",
        "calendar",
        "meeting",
        "project",
        "finance",
        "report",
        "automation",
        "message",
    ]
    description: str = Field(default="", max_length=600)
    content: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list, max_length=12)


class OperationTemplateUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=600)
    content: dict[str, Any] | None = None
    tags: list[str] | None = Field(default=None, max_length=12)


class FollowUpCreate(StrictModel):
    title: str = Field(min_length=2, max_length=180)
    channel: Literal["gmail", "whatsapp", "task", "calendar", "finance", "other"] = "other"
    counterpart: str = Field(default="", max_length=180)
    dueAt: str | None = None
    referenceId: str | None = Field(default=None, max_length=180)
    description: str = Field(default="", max_length=800)
    metadata: dict[str, Any] = Field(default_factory=dict)


class FollowUpUpdate(StrictModel):
    status: Literal["open", "done", "cancelled", "snoozed"] | None = None
    title: str | None = Field(default=None, min_length=2, max_length=180)
    dueAt: str | None = None
    description: str | None = Field(default=None, max_length=800)


class OperationSettingsUpdate(StrictModel):
    autonomy: Literal["confirm_all", "balanced", "autonomous"] | None = None
    dailyBriefing: bool | None = None
    smartReminders: bool | None = None
    followUpHours: int | None = Field(default=None, ge=1, le=720)
