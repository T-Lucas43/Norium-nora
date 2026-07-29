from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator

from app.shared.schemas import StrictModel


InboxStatus = Literal["novo", "em_atendimento", "aguardando", "resolvido", "arquivado"]
GoalMetric = Literal[
    "tarefas_concluidas",
    "tempo_resposta",
    "compromissos_realizados",
    "followups_concluidos",
    "automacoes_executadas",
]


class SharedInboxUpdate(StrictModel):
    assignedToId: str | None = Field(default=None, max_length=120)
    assignedToName: str | None = Field(default=None, max_length=160)
    status: InboxStatus | None = None
    dueAt: str | None = None
    priority: Literal["baixa", "media", "alta", "urgente"] | None = None
    internalNote: str | None = Field(default=None, max_length=2000)

    @field_validator("assignedToId", "assignedToName", "internalNote")
    @classmethod
    def clean_optional_text(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value


class TeamGoalCreate(StrictModel):
    title: str = Field(min_length=2, max_length=180)
    metric: GoalMetric
    target: float = Field(gt=0, le=1_000_000)
    periodStart: str
    periodEnd: str
    assignedToId: str | None = Field(default=None, max_length=120)
    assignedToName: str | None = Field(default=None, max_length=160)
    description: str = Field(default="", max_length=800)


class TeamGoalUpdate(StrictModel):
    title: str | None = Field(default=None, min_length=2, max_length=180)
    target: float | None = Field(default=None, gt=0, le=1_000_000)
    periodStart: str | None = None
    periodEnd: str | None = None
    assignedToId: str | None = Field(default=None, max_length=120)
    assignedToName: str | None = Field(default=None, max_length=160)
    description: str | None = Field(default=None, max_length=800)
    status: Literal["ativa", "concluida", "cancelada"] | None = None


class FocusModeUpdate(StrictModel):
    enabled: bool
    objective: Literal[
        "responder_clientes",
        "organizar_tarefas",
        "preparar_reunioes",
        "resolver_financeiro",
        "acompanhar_equipe",
        "personalizado",
    ] = "personalizado"
    label: str = Field(default="", max_length=160)
    sources: list[str] = Field(default_factory=list, max_length=12)


class PushSubscriptionCreate(StrictModel):
    endpoint: str = Field(min_length=10, max_length=2400)
    keys: dict[str, str] = Field(default_factory=dict)
    deviceName: str = Field(default="", max_length=160)
    userAgent: str = Field(default="", max_length=600)


class ImportRow(StrictModel):
    data: dict[str, Any]


class DataImportPayload(StrictModel):
    kind: Literal["clientes", "tarefas", "lancamentos"]
    rows: list[dict[str, Any]] = Field(min_length=1, max_length=5000)
    dryRun: bool = False


class BackupRestorePayload(StrictModel):
    confirmation: Literal["RESTAURAR"]


class TwoFactorVerify(StrictModel):
    code: str = Field(pattern=r"^\d{6}$")


class CompoundCommandRequest(StrictModel):
    message: str = Field(min_length=2, max_length=4000)
    sessionId: str | None = Field(default=None, max_length=180)
    confirm: bool = False
