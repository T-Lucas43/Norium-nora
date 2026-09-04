"""Display-only, bounded snapshots retained with Nora's conversation history."""

from typing import Annotated, Literal

from pydantic import Field

from app.shared.schemas import StrictModel


class ResponseMetric(StrictModel):
    label: str
    value: float = Field(allow_inf_nan=False)
    money: bool = False


class ResponseTask(StrictModel):
    id: str | None = None
    title: str
    description: str | None = None
    priority: str | None = None
    status: str | None = None
    dueDate: str | None = None
    projectName: str | None = None
    assigneeName: str | None = None


class ResponseProject(StrictModel):
    name: str
    description: str | None = None
    category: str | None = None
    dueDate: str | None = None


class TaskResponseView(StrictModel):
    kind: Literal["tasks"]
    items: list[ResponseTask] = Field(max_length=100)
    total: int = Field(ge=0)
    metrics: list[ResponseMetric] = Field(default_factory=list, max_length=16)
    project: ResponseProject | None = None


class ResponseEvent(StrictModel):
    id: str | None = None
    titulo: str | None = None
    title: str | None = None
    inicio: str | None = None
    fim: str | None = None
    descricao: str | None = None
    local: str | None = None
    status: str | None = None


class AgendaResponseView(StrictModel):
    kind: Literal["agenda"]
    events: list[ResponseEvent] = Field(max_length=100)
    date: str | None = None


class ResponseFinanceRow(StrictModel):
    id: str | None = None
    title: str
    amount: float | None = Field(default=None, allow_inf_nan=False)
    type: str | None = None
    status: str | None = None
    dueDate: str | None = None
    category: str | None = None
    frequency: str | None = None


class ResponseFinanceGroup(StrictModel):
    label: str
    total: int = Field(ge=0)
    rows: list[ResponseFinanceRow] = Field(max_length=100)


class FinanceResponseView(StrictModel):
    kind: Literal["finance"]
    metrics: list[ResponseMetric] = Field(max_length=16)
    groups: list[ResponseFinanceGroup] = Field(max_length=3)


ResponseView = Annotated[TaskResponseView | AgendaResponseView | FinanceResponseView, Field(discriminator="kind")]
