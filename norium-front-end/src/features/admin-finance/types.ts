export type FinancePeriod = "today" | "7d" | "30d" | "90d" | "month" | "quarter" | "semester" | "year" | "custom";
export type FinanceSection = "overview" | "plans" | "subscriptions" | "payments" | "expenses" | "registries" | "planning" | "jorro" | "settings" | "audit";
export type PaymentStatus = "pending" | "paid" | "overdue" | "failed" | "refunded" | "canceled";
export type ExpenseStatus = "pending" | "paid" | "overdue" | "canceled";
export type SubscriptionStatus = "active" | "canceled" | "trial" | "defaulting" | "paused";

export interface FinancePlan {
  id: string;
  code: string;
  name: string;
  description: string;
  monthlyPriceCents: number;
  quarterlyPriceCents: number;
  semiannualPriceCents: number;
  annualPriceCents: number;
  lifetimePriceCents: number;
  setupFeeCents: number;
  cancellationFeeCents: number;
  lateFeePercentage: number;
  trialDays: number;
  active: boolean;
  popular: boolean;
  features: string[];
  limits: Record<string, number>;
  internalNotes: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  planId: string;
  status: SubscriptionStatus;
  billingCycle: "monthly" | "quarterly" | "semiannual" | "annual" | "lifetime";
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt?: string | null;
  canceledAt?: string | null;
  nextBillingAt?: string | null;
  discountCents: number;
  discountPercentage: number;
  taxPercentage: number;
  paymentFeePercentage: number;
  notes: string;
}

export interface Payment {
  id: string;
  subscriptionId?: string | null;
  customerId: string;
  customerName: string;
  planId?: string | null;
  status: PaymentStatus;
  grossCents: number;
  discountCents: number;
  refundCents: number;
  taxCents: number;
  feeCents: number;
  dueAt: string;
  paidAt?: string | null;
  provider: string;
  paymentMethod: string;
  externalId: string;
  notes: string;
}

export interface Expense {
  id: string;
  title: string;
  description: string;
  amountCents: number;
  categoryId: string;
  subcategoryId?: string | null;
  supplierId?: string | null;
  costCenterId?: string | null;
  providerId?: string | null;
  status: ExpenseStatus;
  expenseType: "fixed" | "variable" | "recurring";
  dueAt: string;
  paidAt?: string | null;
  recurrence: "none" | "weekly" | "monthly" | "quarterly" | "semiannual" | "annual";
  recurrenceEndsAt?: string | null;
  installmentNumber: number;
  installmentCount: number;
  paymentMethod: string;
  jorro: boolean;
  tags: string[];
  attachments: Array<{ id: string; name: string; url: string; contentType: string; size: number }>;
  notes: string;
}

export interface FinanceReference {
  id: string;
  name: string;
  description: string;
  active: boolean;
  parentId?: string | null;
  color: string;
  metadata: Record<string, string>;
}

export interface FinanceGoal {
  id: string;
  name: string;
  metric: "revenue" | "mrr" | "profit" | "customers" | "margin";
  targetCents: number;
  targetValue: number;
  startAt: string;
  endAt: string;
  active: boolean;
  currentValue?: number;
  progressPercentage?: number;
}

export interface FinanceBudget {
  id: string;
  name: string;
  categoryId?: string | null;
  providerId?: string | null;
  limitCents: number;
  period: "monthly" | "quarterly" | "annual";
  startAt: string;
  endAt?: string | null;
  active: boolean;
  spentCents?: number;
  usagePercentage?: number;
  reachedThreshold?: number;
}

export interface FinanceSettings {
  currency: string;
  locale: string;
  dateFormat: string;
  timezone: string;
  defaultTaxPercentage: number;
  defaultPaymentFeePercentage: number;
  revenueRecognition: "cash" | "accrual";
  defaultPaymentMethod: string;
  closingDay: number;
  fiscalYearStartMonth: number;
  jorroProviderEnabled: boolean;
  jorroMonthlyBudgetCents: number;
  alertThresholds: number[];
}

export interface DashboardMetrics {
  billedRevenueCents: number;
  receivedRevenueCents: number;
  pendingRevenueCents: number;
  lostRevenueCents: number;
  refundedRevenueCents: number;
  expensesCents: number;
  grossProfitCents: number;
  netProfitCents: number;
  grossMarginPercentage: number;
  netMarginPercentage: number;
  averageTicketCents: number;
  mrrCents: number;
  arrCents: number;
  expected30DaysCents: number;
  jorroSpendCents: number;
  jorroRevenuePercentage: number;
  jorroBudgetCents: number;
  jorroBudgetUsagePercentage: number;
  subscriptions: Record<SubscriptionStatus, number>;
}

export interface AdminFinanceDashboardData {
  period: { preset: string; start: string; end: string; previousStart: string; previousEnd: string };
  metrics: DashboardMetrics;
  deltas: Record<string, number | null>;
  charts: {
    cashFlow: Array<{ date: string; revenueCents: number; expensesCents: number; forecastCents: number }>;
    revenueByPlan: Array<{ id: string; name: string; valueCents: number }>;
    expensesByCategory: Array<{ id: string; name: string; valueCents: number }>;
  };
  goals: FinanceGoal[];
  budgets: FinanceBudget[];
  alerts: Array<{ id: string; type: string; severity: string; title: string; description: string }>;
  settings: FinanceSettings;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  userId: string;
  userName: string;
  action: string;
  entity: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export interface ImportPreview {
  fileName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  totalRows: number;
  suggestedMapping: Array<{ sourceColumn: string; targetField: string }>;
}
