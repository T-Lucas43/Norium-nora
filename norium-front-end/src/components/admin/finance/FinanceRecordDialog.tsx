import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { FinancePlan, FinanceReference } from "../../../features/admin-finance/types";
import { toCents } from "../../../features/admin-finance/format";
import Button from "../../shared/Button";
import AdminOverlay from "../layout/AdminOverlay";

export type FinanceRecordKind = "plan" | "subscription" | "payment" | "expense" | "reference" | "goal" | "budget";

interface FinanceRecordDialogProps {
  kind: FinanceRecordKind;
  record?: Record<string, unknown> | null;
  plans: FinancePlan[];
  categories: FinanceReference[];
  providers: FinanceReference[];
  referenceLabel?: string;
  saving?: boolean;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void> | void;
}

type FormState = Record<string, string | boolean>;

const today = new Date().toISOString().slice(0, 10);
const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

function text(record: Record<string, unknown> | null | undefined, key: string, fallback = "") {
  const value = record?.[key];
  return value === null || value === undefined ? fallback : String(value);
}

function bool(record: Record<string, unknown> | null | undefined, key: string, fallback = false) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function money(record: Record<string, unknown> | null | undefined, key: string) {
  return String((Number(record?.[key]) || 0) / 100);
}

function initialState(kind: FinanceRecordKind, record?: Record<string, unknown> | null): FormState {
  const common = { id: text(record, "id") };
  if (kind === "plan") return {
    ...common, code: text(record, "code"), name: text(record, "name"), description: text(record, "description"),
    monthlyPrice: money(record, "monthlyPriceCents"), quarterlyPrice: money(record, "quarterlyPriceCents"),
    semiannualPrice: money(record, "semiannualPriceCents"), annualPrice: money(record, "annualPriceCents"),
    lifetimePrice: money(record, "lifetimePriceCents"), setupFee: money(record, "setupFeeCents"),
    cancellationFee: money(record, "cancellationFeeCents"), lateFeePercentage: text(record, "lateFeePercentage", "0"),
    trialDays: text(record, "trialDays", "0"), active: bool(record, "active", true), popular: bool(record, "popular"),
    features: Array.isArray(record?.features) ? record.features.join("\n") : "", users: text((record?.limits as Record<string, unknown>) || {}, "users", "1"),
    noraCalls: text((record?.limits as Record<string, unknown>) || {}, "noraCalls", "100"),
    noraTokens: text((record?.limits as Record<string, unknown>) || {}, "noraTokens"),
    noraTokensPerPerson: text((record?.limits as Record<string, unknown>) || {}, "noraTokensPerPerson"),
    storageMb: text((record?.limits as Record<string, unknown>) || {}, "storageMb", "1000"), internalNotes: text(record, "internalNotes"),
  };
  if (kind === "subscription") return {
    ...common, customerId: text(record, "customerId"), customerName: text(record, "customerName"), customerEmail: text(record, "customerEmail"),
    planId: text(record, "planId"), status: text(record, "status", "active"), billingCycle: text(record, "billingCycle", "monthly"),
    startedAt: text(record, "startedAt", today), currentPeriodStart: text(record, "currentPeriodStart", today),
    currentPeriodEnd: text(record, "currentPeriodEnd", nextMonth), trialEndsAt: text(record, "trialEndsAt"), canceledAt: text(record, "canceledAt"),
    nextBillingAt: text(record, "nextBillingAt", nextMonth), discount: money(record, "discountCents"),
    discountPercentage: text(record, "discountPercentage", "0"), taxPercentage: text(record, "taxPercentage", "0"),
    paymentFeePercentage: text(record, "paymentFeePercentage", "0"), notes: text(record, "notes"),
  };
  if (kind === "payment") return {
    ...common, subscriptionId: text(record, "subscriptionId"), customerId: text(record, "customerId"), customerName: text(record, "customerName"),
    planId: text(record, "planId"), status: text(record, "status", "pending"), gross: money(record, "grossCents"),
    discount: money(record, "discountCents"), refund: money(record, "refundCents"), tax: money(record, "taxCents"), fee: money(record, "feeCents"),
    dueAt: text(record, "dueAt", today), paidAt: text(record, "paidAt"), provider: text(record, "provider", "manual"),
    paymentMethod: text(record, "paymentMethod", "pix"), externalId: text(record, "externalId"), notes: text(record, "notes"),
  };
  if (kind === "expense") return {
    ...common, title: text(record, "title"), description: text(record, "description"), amount: money(record, "amountCents"),
    categoryId: text(record, "categoryId"), subcategoryId: text(record, "subcategoryId"), supplierId: text(record, "supplierId"),
    costCenterId: text(record, "costCenterId"), providerId: text(record, "providerId"), status: text(record, "status", "pending"),
    expenseType: text(record, "expenseType", "variable"), dueAt: text(record, "dueAt", today), paidAt: text(record, "paidAt"),
    recurrence: text(record, "recurrence", "none"), recurrenceEndsAt: text(record, "recurrenceEndsAt"),
    installmentNumber: text(record, "installmentNumber", "1"), installmentCount: text(record, "installmentCount", "1"),
    paymentMethod: text(record, "paymentMethod", "pix"), jorro: bool(record, "jorro"),
    tags: Array.isArray(record?.tags) ? record.tags.join(", ") : "", notes: text(record, "notes"),
  };
  if (kind === "reference") return {
    ...common, name: text(record, "name"), description: text(record, "description"), active: bool(record, "active", true),
    parentId: text(record, "parentId"), color: text(record, "color", "#3b82f6"),
  };
  if (kind === "goal") return {
    ...common, name: text(record, "name"), metric: text(record, "metric", "revenue"), target: money(record, "targetCents"),
    targetValue: text(record, "targetValue", "0"), startAt: text(record, "startAt", today), endAt: text(record, "endAt", nextMonth), active: bool(record, "active", true),
  };
  return {
    ...common, name: text(record, "name"), categoryId: text(record, "categoryId"), providerId: text(record, "providerId"),
    limit: money(record, "limitCents"), period: text(record, "period", "monthly"), startAt: text(record, "startAt", today),
    endAt: text(record, "endAt"), active: bool(record, "active", true),
  };
}

function payloadFor(kind: FinanceRecordKind, form: FormState, record?: Record<string, unknown> | null) {
  const optionalDate = (value: string | boolean) => String(value || "") || null;
  if (kind === "plan") return {
    code: String(form.code), name: String(form.name), description: String(form.description), monthlyPriceCents: toCents(String(form.monthlyPrice)),
    quarterlyPriceCents: toCents(String(form.quarterlyPrice)), semiannualPriceCents: toCents(String(form.semiannualPrice)),
    annualPriceCents: toCents(String(form.annualPrice)), lifetimePriceCents: toCents(String(form.lifetimePrice)),
    setupFeeCents: toCents(String(form.setupFee)), cancellationFeeCents: toCents(String(form.cancellationFee)),
    lateFeePercentage: Number(form.lateFeePercentage) || 0, trialDays: Number(form.trialDays) || 0, active: Boolean(form.active),
    popular: Boolean(form.popular), features: String(form.features).split("\n").map((item) => item.trim()).filter(Boolean),
    limits: { ...((record?.limits && typeof record.limits === "object" && !Array.isArray(record.limits)) ? record.limits : {}), users: Number(form.users) || 0, noraCalls: Number(form.noraCalls) || 0, storageMb: Number(form.storageMb) || 0,
      ...(String(form.noraTokens).trim() ? { noraTokens: Number(form.noraTokens) } : {}),
      ...(String(form.noraTokensPerPerson).trim() ? { noraTokensPerPerson: Number(form.noraTokensPerPerson) } : {}),
    },
    internalNotes: String(form.internalNotes),
  };
  if (kind === "subscription") return {
    customerId: String(form.customerId), customerName: String(form.customerName), customerEmail: String(form.customerEmail), planId: String(form.planId),
    status: String(form.status), billingCycle: String(form.billingCycle), startedAt: String(form.startedAt), currentPeriodStart: String(form.currentPeriodStart),
    currentPeriodEnd: String(form.currentPeriodEnd), trialEndsAt: optionalDate(form.trialEndsAt), canceledAt: optionalDate(form.canceledAt),
    nextBillingAt: optionalDate(form.nextBillingAt), discountCents: toCents(String(form.discount)), discountPercentage: Number(form.discountPercentage) || 0,
    taxPercentage: Number(form.taxPercentage) || 0, paymentFeePercentage: Number(form.paymentFeePercentage) || 0, notes: String(form.notes),
  };
  if (kind === "payment") return {
    subscriptionId: String(form.subscriptionId) || null, customerId: String(form.customerId), customerName: String(form.customerName), planId: String(form.planId) || null,
    status: String(form.status), grossCents: toCents(String(form.gross)), discountCents: toCents(String(form.discount)), refundCents: toCents(String(form.refund)),
    taxCents: toCents(String(form.tax)), feeCents: toCents(String(form.fee)), dueAt: String(form.dueAt), paidAt: optionalDate(form.paidAt),
    provider: String(form.provider), paymentMethod: String(form.paymentMethod), externalId: String(form.externalId), notes: String(form.notes),
  };
  if (kind === "expense") return {
    title: String(form.title), description: String(form.description), amountCents: toCents(String(form.amount)), categoryId: String(form.categoryId),
    subcategoryId: String(form.subcategoryId) || null, supplierId: String(form.supplierId) || null, costCenterId: String(form.costCenterId) || null,
    providerId: String(form.providerId) || null, status: String(form.status), expenseType: String(form.expenseType), dueAt: String(form.dueAt), paidAt: optionalDate(form.paidAt),
    recurrence: String(form.recurrence), recurrenceEndsAt: optionalDate(form.recurrenceEndsAt), installmentNumber: Number(form.installmentNumber) || 1,
    installmentCount: Number(form.installmentCount) || 1, paymentMethod: String(form.paymentMethod), jorro: Boolean(form.jorro),
    tags: String(form.tags).split(",").map((item) => item.trim()).filter(Boolean), attachments: [], notes: String(form.notes),
  };
  if (kind === "reference") return { name: String(form.name), description: String(form.description), active: Boolean(form.active), parentId: String(form.parentId) || null, color: String(form.color), metadata: {} };
  if (kind === "goal") return {
    name: String(form.name), metric: String(form.metric), targetCents: ["revenue", "mrr", "profit"].includes(String(form.metric)) ? toCents(String(form.target)) : 0,
    targetValue: ["customers", "margin"].includes(String(form.metric)) ? Number(form.targetValue) || 0 : 0,
    startAt: String(form.startAt), endAt: String(form.endAt), active: Boolean(form.active),
  };
  return { name: String(form.name), categoryId: String(form.categoryId) || null, providerId: String(form.providerId) || null, limitCents: toCents(String(form.limit)), period: String(form.period), startAt: String(form.startAt), endAt: optionalDate(form.endAt), active: Boolean(form.active) };
}

const titles: Record<FinanceRecordKind, string> = {
  plan: "plano", subscription: "assinatura", payment: "receita", expense: "despesa", reference: "cadastro", goal: "meta", budget: "orçamento",
};

export default function FinanceRecordDialog({ kind, record, plans, categories, providers, referenceLabel, saving, onClose, onSubmit }: FinanceRecordDialogProps) {
  const [form, setForm] = useState<FormState>(() => initialState(kind, record));
  const title = `${record ? "Editar" : ["subscription", "payment", "expense", "goal"].includes(kind) ? "Nova" : "Novo"} ${referenceLabel || titles[kind]}`;
  const isEdit = Boolean(record?.id);
  const set = (key: string, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const content = useMemo(() => fieldsFor(kind, form, set, plans, categories, providers), [kind, form, plans, categories, providers]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const payload = payloadFor(kind, form, record) as Record<string, unknown>;
    if (kind === "expense" && Array.isArray(record?.attachments)) payload.attachments = record.attachments;
    await onSubmit(payload);
  }

  return (
    <AdminOverlay open title={title} width={880} closeLabel="Fechar" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5 sm:grid-cols-2">{content}</div>
        <footer className="flex justify-end gap-2 border-t border-[var(--border)] p-4"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" type="submit" loading={saving}>{isEdit ? "Salvar alterações" : "Criar"}</Button></footer>
      </form>
    </AdminOverlay>
  );
}

function fieldsFor(kind: FinanceRecordKind, form: FormState, set: (key: string, value: string | boolean) => void, plans: FinancePlan[], categories: FinanceReference[], providers: FinanceReference[]): ReactNode[] {
  const field = (key: string, label: string, options?: { type?: string; textarea?: boolean; required?: boolean; span?: boolean; placeholder?: string; min?: number; max?: number; step?: number }) => (
    <label key={key} className={options?.span ? "sm:col-span-2" : ""}><span className="finance-label">{label}</span>{options?.textarea ? <textarea className="finance-field min-h-24 resize-y" required={options.required} value={String(form[key] ?? "")} placeholder={options.placeholder} onChange={(event) => set(key, event.target.value)} /> : <input className="finance-field" type={options?.type || "text"} min={options?.min} max={options?.max} step={options?.step} required={options?.required} value={String(form[key] ?? "")} placeholder={options?.placeholder} onChange={(event) => set(key, event.target.value)} />}</label>
  );
  const select = (key: string, label: string, values: Array<[string, string]>) => <label key={key}><span className="finance-label">{label}</span><select className="finance-field" value={String(form[key] ?? "")} onChange={(event) => set(key, event.target.value)}>{values.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>;
  const check = (key: string, label: string) => <label key={key} className="flex min-h-11 items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-medium"><span>{label}</span><input type="checkbox" checked={Boolean(form[key])} onChange={(event) => set(key, event.target.checked)} /></label>;
  const refOptions = (items: FinanceReference[]): Array<[string, string]> => [["", "Não definido"], ...items.map((item) => [item.id, item.name] as [string, string])];

  if (kind === "plan") return [field("name", "Nome", { required: true }), field("code", "Código", { required: true }), field("description", "Descrição", { textarea: true, span: true }), field("monthlyPrice", "Preço mensal (R$)", { type: "number" }), field("quarterlyPrice", "Preço trimestral (R$)", { type: "number" }), field("semiannualPrice", "Preço semestral (R$)", { type: "number" }), field("annualPrice", "Preço anual (R$)", { type: "number" }), field("lifetimePrice", "Preço vitalício (R$)", { type: "number" }), field("setupFee", "Taxa de adesão (R$)", { type: "number" }), field("cancellationFee", "Taxa de cancelamento (R$)", { type: "number" }), field("lateFeePercentage", "Multa por atraso (%)", { type: "number" }), field("trialDays", "Dias de teste", { type: "number" }), field("users", "Limite de usuários", { type: "number" }), field("noraCalls", "Chamadas da Nora", { type: "number" }), field("noraTokens", "Franquia de tokens do plano", { type: "number", min: 0, max: 1000000000000, step: 1, placeholder: "Manter franquia atual" }), field("noraTokensPerPerson", "Limite de tokens por pessoa", { type: "number", min: 0, max: 1000000000000, step: 1, placeholder: "Manter limite atual" }), <p key="tokens-hint" className="sm:col-span-2 text-xs text-[var(--text-secondary)]">Tokens e chamadas são contados por ciclo. Zero bloqueia novas solicitações; campos de tokens vazios mantêm o valor atual ou o padrão do plano.</p>, field("storageMb", "Armazenamento (MB)", { type: "number" }), field("features", "Recursos, um por linha", { textarea: true, span: true }), field("internalNotes", "Observações internas", { textarea: true, span: true }), check("active", "Plano ativo"), check("popular", "Destacar como popular")];
  if (kind === "subscription") return [field("customerName", "Cliente", { required: true }), field("customerEmail", "E-mail"), field("customerId", "ID do cliente", { required: true }), select("planId", "Plano", plans.map((plan) => [plan.id, plan.name])), select("status", "Status", [["active", "Ativa"], ["trial", "Em teste"], ["defaulting", "Inadimplente"], ["paused", "Pausada"], ["canceled", "Cancelada"]]), select("billingCycle", "Ciclo", [["monthly", "Mensal"], ["quarterly", "Trimestral"], ["semiannual", "Semestral"], ["annual", "Anual"], ["lifetime", "Vitalício"]]), field("startedAt", "Início", { type: "date" }), field("nextBillingAt", "Próxima cobrança", { type: "date" }), field("currentPeriodStart", "Início do período", { type: "date" }), field("currentPeriodEnd", "Fim do período", { type: "date" }), field("trialEndsAt", "Fim do teste", { type: "date" }), field("canceledAt", "Cancelada em", { type: "date" }), field("discount", "Desconto fixo (R$)", { type: "number" }), field("discountPercentage", "Desconto (%)", { type: "number" }), field("taxPercentage", "Impostos (%)", { type: "number" }), field("paymentFeePercentage", "Taxa do meio (%)", { type: "number" }), field("notes", "Observações", { textarea: true, span: true })];
  if (kind === "payment") return [field("customerName", "Cliente", { required: true }), field("customerId", "ID do cliente", { required: true }), field("subscriptionId", "ID da assinatura"), select("planId", "Plano", [["", "Sem plano"], ...plans.map((plan) => [plan.id, plan.name] as [string, string])]), select("status", "Status", [["pending", "Pendente"], ["paid", "Recebida"], ["overdue", "Vencida"], ["failed", "Falhou"], ["refunded", "Reembolsada"], ["canceled", "Cancelada"]]), field("gross", "Valor bruto (R$)", { type: "number", required: true }), field("discount", "Desconto (R$)", { type: "number" }), field("refund", "Reembolso (R$)", { type: "number" }), field("tax", "Impostos (R$)", { type: "number" }), field("fee", "Taxa do meio (R$)", { type: "number" }), field("dueAt", "Vencimento", { type: "date", required: true }), field("paidAt", "Recebida em", { type: "date" }), field("provider", "Provedor"), field("paymentMethod", "Forma de pagamento"), field("externalId", "ID externo"), field("notes", "Observações", { textarea: true, span: true })];
  if (kind === "expense") return [field("title", "Descrição", { required: true }), field("amount", "Valor (R$)", { type: "number", required: true }), select("categoryId", "Categoria", categories.map((item) => [item.id, item.name])), select("providerId", "Provedor", refOptions(providers)), select("status", "Status", [["pending", "Pendente"], ["paid", "Paga"], ["overdue", "Vencida"], ["canceled", "Cancelada"]]), select("expenseType", "Tipo", [["fixed", "Fixa"], ["variable", "Variável"], ["recurring", "Recorrente"]]), field("dueAt", "Vencimento", { type: "date", required: true }), field("paidAt", "Pagamento", { type: "date" }), select("recurrence", "Recorrência", [["none", "Sem recorrência"], ["weekly", "Semanal"], ["monthly", "Mensal"], ["quarterly", "Trimestral"], ["semiannual", "Semestral"], ["annual", "Anual"]]), field("recurrenceEndsAt", "Fim da recorrência", { type: "date" }), field("installmentNumber", "Parcela atual", { type: "number" }), field("installmentCount", "Total de parcelas", { type: "number" }), field("paymentMethod", "Forma de pagamento"), field("tags", "Etiquetas, separadas por vírgula"), field("description", "Detalhes", { textarea: true, span: true }), field("notes", "Observações", { textarea: true, span: true }), check("jorro", "Custo do provedor Jorro")];
  if (kind === "reference") return [field("name", "Nome", { required: true }), field("color", "Cor", { type: "color" }), field("description", "Descrição", { textarea: true, span: true }), check("active", "Cadastro ativo")];
  if (kind === "goal") return [field("name", "Nome da meta", { required: true }), select("metric", "Indicador", [["revenue", "Receita"], ["mrr", "MRR"], ["profit", "Lucro"], ["customers", "Clientes"], ["margin", "Margem"]]), field("target", "Meta financeira (R$)", { type: "number" }), field("targetValue", "Meta numérica / percentual", { type: "number" }), field("startAt", "Início", { type: "date" }), field("endAt", "Fim", { type: "date" }), check("active", "Meta ativa")];
  return [field("name", "Nome do orçamento", { required: true }), field("limit", "Limite (R$)", { type: "number", required: true }), select("categoryId", "Categoria", refOptions(categories)), select("providerId", "Provedor", refOptions(providers)), select("period", "Período", [["monthly", "Mensal"], ["quarterly", "Trimestral"], ["annual", "Anual"]]), field("startAt", "Início", { type: "date" }), field("endAt", "Fim", { type: "date" }), check("active", "Orçamento ativo")];
}
