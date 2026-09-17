from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


Money = Annotated[int, Field(ge=0, le=999_999_999_999)]
SignedMoney = Annotated[int, Field(ge=-999_999_999_999, le=999_999_999_999)]
Percentage = Annotated[float, Field(ge=0, le=100)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class BillingCycle(StrEnum):
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    SEMIANNUAL = "semiannual"
    ANNUAL = "annual"
    LIFETIME = "lifetime"


class SubscriptionStatus(StrEnum):
    ACTIVE = "active"
    CANCELED = "canceled"
    TRIAL = "trial"
    DEFAULTING = "defaulting"
    PAUSED = "paused"


class PaymentStatus(StrEnum):
    PENDING = "pending"
    PAID = "paid"
    OVERDUE = "overdue"
    FAILED = "failed"
    REFUNDED = "refunded"
    CANCELED = "canceled"


class ExpenseStatus(StrEnum):
    PENDING = "pending"
    PAID = "paid"
    OVERDUE = "overdue"
    CANCELED = "canceled"


class ExpenseType(StrEnum):
    FIXED = "fixed"
    VARIABLE = "variable"
    RECURRING = "recurring"


class Recurrence(StrEnum):
    NONE = "none"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    SEMIANNUAL = "semiannual"
    ANNUAL = "annual"


class Attachment(StrictModel):
    id: str
    name: str
    url: str
    contentType: str = "application/octet-stream"
    size: int = Field(default=0, ge=0)


class PlanInput(StrictModel):
    code: str = Field(min_length=2, max_length=40, pattern=r"^[a-z0-9_-]+$")
    name: str = Field(min_length=2, max_length=100)
    description: str = Field(default="", max_length=600)
    monthlyPriceCents: Money = 0
    quarterlyPriceCents: Money = 0
    semiannualPriceCents: Money = 0
    annualPriceCents: Money = 0
    lifetimePriceCents: Money = 0
    setupFeeCents: Money = 0
    cancellationFeeCents: Money = 0
    lateFeePercentage: Percentage = 0
    trialDays: int = Field(default=0, ge=0, le=365)
    active: bool = True
    popular: bool = False
    features: list[str] = Field(default_factory=list, max_length=100)
    limits: dict[str, int] = Field(default_factory=dict)
    internalNotes: str = Field(default="", max_length=2000)

    @field_validator("features")
    @classmethod
    def unique_features(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(item.strip() for item in value if item.strip()))


class PlanPatch(StrictModel):
    code: str | None = Field(default=None, min_length=2, max_length=40, pattern=r"^[a-z0-9_-]+$")
    name: str | None = Field(default=None, min_length=2, max_length=100)
    description: str | None = Field(default=None, max_length=600)
    monthlyPriceCents: Money | None = None
    quarterlyPriceCents: Money | None = None
    semiannualPriceCents: Money | None = None
    annualPriceCents: Money | None = None
    lifetimePriceCents: Money | None = None
    setupFeeCents: Money | None = None
    cancellationFeeCents: Money | None = None
    lateFeePercentage: Percentage | None = None
    trialDays: int | None = Field(default=None, ge=0, le=365)
    active: bool | None = None
    popular: bool | None = None
    features: list[str] | None = None
    limits: dict[str, int] | None = None
    internalNotes: str | None = Field(default=None, max_length=2000)


class SubscriptionInput(StrictModel):
    customerId: str = Field(min_length=1, max_length=120)
    customerName: str = Field(min_length=1, max_length=160)
    customerEmail: str = Field(default="", max_length=254)
    planId: str = Field(min_length=1, max_length=120)
    status: SubscriptionStatus = SubscriptionStatus.ACTIVE
    billingCycle: BillingCycle = BillingCycle.MONTHLY
    startedAt: date
    currentPeriodStart: date
    currentPeriodEnd: date
    trialEndsAt: date | None = None
    canceledAt: date | None = None
    nextBillingAt: date | None = None
    discountCents: Money = 0
    discountPercentage: Percentage = 0
    taxPercentage: Percentage = 0
    paymentFeePercentage: Percentage = 0
    notes: str = Field(default="", max_length=2000)


class SubscriptionPatch(StrictModel):
    customerName: str | None = Field(default=None, min_length=1, max_length=160)
    customerEmail: str | None = Field(default=None, max_length=254)
    planId: str | None = Field(default=None, min_length=1, max_length=120)
    status: SubscriptionStatus | None = None
    billingCycle: BillingCycle | None = None
    currentPeriodStart: date | None = None
    currentPeriodEnd: date | None = None
    trialEndsAt: date | None = None
    canceledAt: date | None = None
    nextBillingAt: date | None = None
    discountCents: Money | None = None
    discountPercentage: Percentage | None = None
    taxPercentage: Percentage | None = None
    paymentFeePercentage: Percentage | None = None
    notes: str | None = Field(default=None, max_length=2000)


class PaymentInput(StrictModel):
    subscriptionId: str | None = Field(default=None, max_length=120)
    customerId: str = Field(min_length=1, max_length=120)
    customerName: str = Field(min_length=1, max_length=160)
    planId: str | None = Field(default=None, max_length=120)
    status: PaymentStatus = PaymentStatus.PENDING
    grossCents: Money
    discountCents: Money = 0
    refundCents: Money = 0
    taxCents: Money = 0
    feeCents: Money = 0
    dueAt: date
    paidAt: date | None = None
    provider: str = Field(default="manual", max_length=80)
    paymentMethod: str = Field(default="", max_length=80)
    externalId: str = Field(default="", max_length=180)
    notes: str = Field(default="", max_length=2000)


class PaymentPatch(StrictModel):
    status: PaymentStatus | None = None
    grossCents: Money | None = None
    discountCents: Money | None = None
    refundCents: Money | None = None
    taxCents: Money | None = None
    feeCents: Money | None = None
    dueAt: date | None = None
    paidAt: date | None = None
    provider: str | None = Field(default=None, max_length=80)
    paymentMethod: str | None = Field(default=None, max_length=80)
    externalId: str | None = Field(default=None, max_length=180)
    notes: str | None = Field(default=None, max_length=2000)


class ExpenseInput(StrictModel):
    title: str = Field(min_length=2, max_length=180)
    description: str = Field(default="", max_length=4000)
    amountCents: Money
    categoryId: str = Field(min_length=1, max_length=120)
    subcategoryId: str | None = Field(default=None, max_length=120)
    supplierId: str | None = Field(default=None, max_length=120)
    costCenterId: str | None = Field(default=None, max_length=120)
    providerId: str | None = Field(default=None, max_length=120)
    status: ExpenseStatus = ExpenseStatus.PENDING
    expenseType: ExpenseType = ExpenseType.VARIABLE
    dueAt: date
    paidAt: date | None = None
    recurrence: Recurrence = Recurrence.NONE
    recurrenceEndsAt: date | None = None
    installmentNumber: int = Field(default=1, ge=1, le=999)
    installmentCount: int = Field(default=1, ge=1, le=999)
    paymentMethod: str = Field(default="", max_length=80)
    jorro: bool = False
    tags: list[str] = Field(default_factory=list, max_length=30)
    attachments: list[Attachment] = Field(default_factory=list, max_length=20)
    notes: str = Field(default="", max_length=3000)


class ExpensePatch(StrictModel):
    title: str | None = Field(default=None, min_length=2, max_length=180)
    description: str | None = Field(default=None, max_length=4000)
    amountCents: Money | None = None
    categoryId: str | None = Field(default=None, min_length=1, max_length=120)
    subcategoryId: str | None = Field(default=None, max_length=120)
    supplierId: str | None = Field(default=None, max_length=120)
    costCenterId: str | None = Field(default=None, max_length=120)
    providerId: str | None = Field(default=None, max_length=120)
    status: ExpenseStatus | None = None
    expenseType: ExpenseType | None = None
    dueAt: date | None = None
    paidAt: date | None = None
    recurrence: Recurrence | None = None
    recurrenceEndsAt: date | None = None
    installmentNumber: int | None = Field(default=None, ge=1, le=999)
    installmentCount: int | None = Field(default=None, ge=1, le=999)
    paymentMethod: str | None = Field(default=None, max_length=80)
    jorro: bool | None = None
    tags: list[str] | None = None
    attachments: list[Attachment] | None = None
    notes: str | None = Field(default=None, max_length=3000)


class ReferenceInput(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    description: str = Field(default="", max_length=1000)
    active: bool = True
    parentId: str | None = Field(default=None, max_length=120)
    color: str = Field(default="#3b82f6", pattern=r"^#[0-9a-fA-F]{6}$")
    metadata: dict[str, str] = Field(default_factory=dict)


class ReferencePatch(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = Field(default=None, max_length=1000)
    active: bool | None = None
    parentId: str | None = Field(default=None, max_length=120)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    metadata: dict[str, str] | None = None


class GoalInput(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    metric: Literal["revenue", "mrr", "profit", "customers", "margin"]
    targetCents: SignedMoney = 0
    targetValue: float = 0
    startAt: date
    endAt: date
    active: bool = True


class GoalPatch(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    metric: Literal["revenue", "mrr", "profit", "customers", "margin"] | None = None
    targetCents: SignedMoney | None = None
    targetValue: float | None = None
    startAt: date | None = None
    endAt: date | None = None
    active: bool | None = None


class BudgetInput(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    categoryId: str | None = Field(default=None, max_length=120)
    providerId: str | None = Field(default=None, max_length=120)
    limitCents: Money
    period: Literal["monthly", "quarterly", "annual"] = "monthly"
    startAt: date
    endAt: date | None = None
    active: bool = True


class BudgetPatch(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    categoryId: str | None = Field(default=None, max_length=120)
    providerId: str | None = Field(default=None, max_length=120)
    limitCents: Money | None = None
    period: Literal["monthly", "quarterly", "annual"] | None = None
    startAt: date | None = None
    endAt: date | None = None
    active: bool | None = None


class AdminFinanceSettings(StrictModel):
    currency: str = Field(default="BRL", min_length=3, max_length=3)
    locale: str = Field(default="pt-BR", max_length=20)
    dateFormat: str = Field(default="dd/MM/yyyy", max_length=30)
    timezone: str = Field(default="America/Sao_Paulo", max_length=80)
    defaultTaxPercentage: Percentage = 0
    defaultPaymentFeePercentage: Percentage = 0
    revenueRecognition: Literal["cash", "accrual"] = "cash"
    defaultPaymentMethod: str = Field(default="pix", max_length=80)
    closingDay: int = Field(default=1, ge=1, le=28)
    fiscalYearStartMonth: int = Field(default=1, ge=1, le=12)
    jorroProviderEnabled: bool = False
    jorroMonthlyBudgetCents: Money = 0
    alertThresholds: list[int] = Field(default_factory=lambda: [50, 75, 90, 100])

    @field_validator("alertThresholds")
    @classmethod
    def valid_thresholds(cls, value: list[int]) -> list[int]:
        return sorted(set(item for item in value if 1 <= item <= 100)) or [50, 75, 90, 100]


class BulkStatusInput(StrictModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    status: str = Field(min_length=2, max_length=40)


class ImportMapping(StrictModel):
    sourceColumn: str
    targetField: str


class ImportCommitInput(StrictModel):
    kind: Literal["expenses", "payments", "jorro"]
    rows: list[dict[str, str]] = Field(max_length=5000)
    mapping: list[ImportMapping]


class AdminPermissionPatch(StrictModel):
    view: bool = False
    managePlans: bool = False
    manageSubscriptions: bool = False
    managePayments: bool = False
    manageExpenses: bool = False
    manageSettings: bool = False
    importData: bool = False
    exportData: bool = False


class AuditEntry(StrictModel):
    id: str
    timestamp: datetime
    userId: str
    userName: str
    action: str
    entity: str
    entityId: str
    before: dict | None = None
    after: dict | None = None
