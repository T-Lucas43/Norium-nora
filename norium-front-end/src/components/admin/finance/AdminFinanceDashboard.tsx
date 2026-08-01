import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArchiveRestore, BarChart3, Building2, CircleDollarSign, Copy, Download, FileClock,
  FileSpreadsheet, Gauge, Goal, Landmark, Pencil, Plus, ReceiptText, RefreshCw, Settings2,
  Trash2, Upload, UsersRound, WalletCards,
} from "lucide-react";
import type { AuthSession } from "../../../types/auth";
import { adminFinanceApi } from "../../../features/admin-finance/api";
import type {
  AdminFinanceDashboardData, AuditLog, Expense, FinanceBudget, FinanceGoal, FinancePeriod, FinancePlan,
  FinanceReference, FinanceSection, FinanceSettings, Payment, Subscription,
} from "../../../features/admin-finance/types";
import { downloadBlob, formatDate, formatMoney } from "../../../features/admin-finance/format";
import Button from "../../shared/Button";
import EmptyState from "../../shared/EmptyState";
import { showConfirm } from "../../shared/AppDialogProvider";
import FinanceDataTable, { type FinanceColumn } from "./FinanceDataTable";
import FinanceImportDialog from "./FinanceImportDialog";
import FinanceOverview from "./FinanceOverview";
import FinanceRecordDialog, { type FinanceRecordKind } from "./FinanceRecordDialog";

interface AdminFinanceDashboardProps { session: AuthSession; }
type FinanceEntity = FinancePlan | Subscription | Payment | Expense | FinanceReference | FinanceGoal | FinanceBudget;
type ReferenceKind = "categories" | "suppliers" | "cost-centers" | "providers";

const sections: Array<{ id: FinanceSection; label: string; icon: typeof BarChart3 }> = [
  { id: "overview", label: "Visão geral", icon: BarChart3 },
  { id: "plans", label: "Planos", icon: WalletCards },
  { id: "subscriptions", label: "Assinaturas", icon: UsersRound },
  { id: "payments", label: "Receitas", icon: CircleDollarSign },
  { id: "expenses", label: "Despesas", icon: ReceiptText },
  { id: "registries", label: "Cadastros", icon: Building2 },
  { id: "planning", label: "Metas e orçamentos", icon: Goal },
  { id: "jorro", label: "Jorro", icon: Gauge },
  { id: "settings", label: "Configurações", icon: Settings2 },
  { id: "audit", label: "Auditoria", icon: FileClock },
];

const periodOptions: Array<[FinancePeriod, string]> = [
  ["today", "Hoje"], ["7d", "Últimos 7 dias"], ["30d", "Últimos 30 dias"], ["90d", "Últimos 90 dias"],
  ["month", "Este mês"], ["quarter", "Este trimestre"], ["semester", "Este semestre"], ["year", "Este ano"],
];

const referenceLabels: Record<ReferenceKind, string> = {
  categories: "categoria", suppliers: "fornecedor", "cost-centers": "centro de custo", providers: "provedor",
};

const statusLabels: Record<string, string> = {
  active: "Ativa", canceled: "Cancelada", trial: "Em teste", defaulting: "Inadimplente", paused: "Pausada",
  pending: "Pendente", paid: "Pago", overdue: "Vencido", failed: "Falhou", refunded: "Reembolsado",
};

function recordOf(value: FinanceEntity): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function StatusBadge({ value }: { value: string }) {
  const positive = ["active", "paid"].includes(value);
  const warning = ["pending", "trial", "paused"].includes(value);
  return <span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-black ${positive ? "bg-emerald-500/12 text-emerald-400" : warning ? "bg-amber-500/12 text-amber-400" : "bg-red-500/12 text-red-400"}`}>{statusLabels[value] || value}</span>;
}

export default function AdminFinanceDashboard({ session }: AdminFinanceDashboardProps) {
  const token = session.token;
  const [section, setSection] = useState<FinanceSection>("overview");
  const [period, setPeriod] = useState<FinancePeriod>("month");
  const [filters, setFilters] = useState({ planId: "all", status: "all", categoryId: "all", providerId: "all", paymentMethod: "all", supplierId: "all", costCenterId: "all" });
  const [dashboard, setDashboard] = useState<AdminFinanceDashboardData | null>(null);
  const [plans, setPlans] = useState<FinancePlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<FinanceReference[]>([]);
  const [suppliers, setSuppliers] = useState<FinanceReference[]>([]);
  const [costCenters, setCostCenters] = useState<FinanceReference[]>([]);
  const [providers, setProviders] = useState<FinanceReference[]>([]);
  const [goals, setGoals] = useState<FinanceGoal[]>([]);
  const [budgets, setBudgets] = useState<FinanceBudget[]>([]);
  const [settings, setSettings] = useState<FinanceSettings | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [jorro, setJorro] = useState<Record<string, unknown> | null>(null);
  const [referenceKind, setReferenceKind] = useState<ReferenceKind>("categories");
  const [selectedExpenseIds, setSelectedExpenseIds] = useState<string[]>([]);
  const [dialog, setDialog] = useState<{ kind: FinanceRecordKind; record?: FinanceEntity | null } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const loadDashboard = useCallback(async () => {
    const result = await adminFinanceApi.dashboard(token, { preset: period === "custom" ? "month" : period, ...filters });
    setDashboard(result);
  }, [filters, period, token]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [dashboardResult, plansResult, subscriptionsResult, paymentsResult, expensesResult, categoriesResult, suppliersResult, centersResult, providersResult, goalsResult, budgetsResult, settingsResult, auditResult, jorroResult] = await Promise.all([
        adminFinanceApi.dashboard(token, { preset: period === "custom" ? "month" : period, ...filters }), adminFinanceApi.plans(token),
        adminFinanceApi.subscriptions(token, { pageSize: 200 }), adminFinanceApi.payments(token, { pageSize: 200 }), adminFinanceApi.expenses(token, { pageSize: 200 }),
        adminFinanceApi.references(token, "categories"), adminFinanceApi.references(token, "suppliers"), adminFinanceApi.references(token, "cost-centers"), adminFinanceApi.references(token, "providers"),
        adminFinanceApi.goals(token), adminFinanceApi.budgets(token), adminFinanceApi.settings(token), adminFinanceApi.audit(token, { pageSize: 200 }), adminFinanceApi.jorro(token),
      ]);
      setDashboard(dashboardResult); setPlans(plansResult.items); setSubscriptions(subscriptionsResult.items); setPayments(paymentsResult.items);
      setExpenses(expensesResult.items); setCategories(categoriesResult.items); setSuppliers(suppliersResult.items); setCostCenters(centersResult.items);
      setProviders(providersResult.items); setGoals(goalsResult.items); setBudgets(budgetsResult.items); setSettings(settingsResult.settings);
      setAuditLogs(auditResult.items); setJorro(jorroResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o financeiro administrativo.");
    } finally { setLoading(false); }
  }, [filters, period, token]);

  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 4500); return () => window.clearTimeout(timer); }, [notice]);

  const references = referenceKind === "categories" ? categories : referenceKind === "suppliers" ? suppliers : referenceKind === "cost-centers" ? costCenters : providers;

  async function saveRecord(payload: Record<string, unknown>) {
    if (!dialog) return;
    setSaving(true); setError("");
    try {
      const id = dialog.record?.id;
      if (dialog.kind === "reference") {
        if (id) await adminFinanceApi.updateReference(token, referenceKind, id, payload);
        else await adminFinanceApi.createReference(token, referenceKind, payload);
      } else {
        const collection = dialog.kind === "plan" ? "plans" : dialog.kind === "subscription" ? "subscriptions" : dialog.kind === "payment" ? "payments" : dialog.kind === "expense" ? "expenses" : dialog.kind === "goal" ? "goals" : "budgets";
        if (id) await adminFinanceApi.update<FinanceEntity>(token, collection, id, payload);
        else await adminFinanceApi.create<FinanceEntity>(token, collection, payload);
      }
      setDialog(null); setNotice("Registro financeiro salvo com sucesso."); await loadAll();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o registro."); }
    finally { setSaving(false); }
  }

  async function remove(kind: FinanceRecordKind, item: FinanceEntity) {
    const confirmed = await showConfirm({ title: "Excluir registro?", description: "A exclusão será registrada na trilha de auditoria.", confirmLabel: "Excluir", tone: "danger" });
    if (!confirmed) return;
    try {
      if (kind === "reference") await adminFinanceApi.removeReference(token, referenceKind, item.id);
      else {
        const collection = kind === "plan" ? "plans" : kind === "subscription" ? "subscriptions" : kind === "payment" ? "payments" : kind === "expense" ? "expenses" : kind === "goal" ? "goals" : "budgets";
        await adminFinanceApi.remove(token, collection, item.id);
      }
      setNotice("Registro excluído."); await loadAll();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível excluir."); }
  }

  async function duplicate(collection: "plans" | "expenses", id: string) {
    try { await adminFinanceApi.duplicate(token, collection, id); setNotice("Cópia criada com sucesso."); await loadAll(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível duplicar."); }
  }

  async function exportFile(format: "csv" | "xlsx" | "pdf") {
    try { const blob = await adminFinanceApi.exportFile(token, format); downloadBlob(blob, `norium-financeiro.${format}`); setNotice(`Relatório ${format.toUpperCase()} gerado.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao exportar relatório."); }
  }

  async function bulkExpenseStatus(status: string) {
    if (!selectedExpenseIds.length) return;
    try { await adminFinanceApi.bulkExpenseStatus(token, selectedExpenseIds, status); setSelectedExpenseIds([]); setNotice("Despesas atualizadas em lote."); await loadAll(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha na atualização em lote."); }
  }

  async function saveSettings() {
    if (!settings) return;
    setSaving(true);
    try { const result = await adminFinanceApi.saveSettings(token, settings); setSettings(result.settings); setNotice("Configurações financeiras salvas."); await loadDashboard(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao salvar configurações."); }
    finally { setSaving(false); }
  }

  const planColumns = useMemo<FinanceColumn<FinancePlan>[]>(() => [
    { key: "name", title: "Plano", sortable: true, render: (item) => <div><strong>{item.name}</strong><p className="text-xs text-[var(--text-secondary)]">{item.code}</p></div>, searchValue: (item) => `${item.name} ${item.code}` },
    { key: "monthly", title: "Mensal", sortable: true, render: (item) => formatMoney(item.monthlyPriceCents), searchValue: (item) => String(item.monthlyPriceCents) },
    { key: "annual", title: "Anual", render: (item) => formatMoney(item.annualPriceCents) },
    { key: "trial", title: "Teste", render: (item) => `${item.trialDays} dias` },
    { key: "active", title: "Status", render: (item) => <StatusBadge value={item.active ? "active" : "canceled"} /> },
  ], []);
  const subscriptionColumns = useMemo<FinanceColumn<Subscription>[]>(() => [
    { key: "customer", title: "Cliente", sortable: true, render: (item) => <div><strong>{item.customerName}</strong><p className="text-xs text-[var(--text-secondary)]">{item.customerEmail}</p></div>, searchValue: (item) => `${item.customerName} ${item.customerEmail}` },
    { key: "plan", title: "Plano", render: (item) => plans.find((plan) => plan.id === item.planId)?.name || item.planId },
    { key: "cycle", title: "Ciclo", render: (item) => item.billingCycle },
    { key: "status", title: "Status", render: (item) => <StatusBadge value={item.status} /> },
    { key: "next", title: "Próxima cobrança", sortable: true, render: (item) => formatDate(item.nextBillingAt) },
  ], [plans]);
  const paymentColumns = useMemo<FinanceColumn<Payment>[]>(() => [
    { key: "customer", title: "Cliente", sortable: true, render: (item) => item.customerName, searchValue: (item) => item.customerName },
    { key: "gross", title: "Valor bruto", sortable: true, render: (item) => formatMoney(item.grossCents), searchValue: (item) => String(item.grossCents) },
    { key: "net", title: "Valor líquido", render: (item) => formatMoney(Math.max(0, item.grossCents - item.discountCents - item.refundCents - item.taxCents - item.feeCents)) },
    { key: "due", title: "Vencimento", sortable: true, render: (item) => formatDate(item.dueAt) },
    { key: "status", title: "Status", render: (item) => <StatusBadge value={item.status} /> },
    { key: "provider", title: "Provedor", render: (item) => item.provider || "Manual" },
  ], []);
  const expenseColumns = useMemo<FinanceColumn<Expense>[]>(() => [
    { key: "title", title: "Despesa", sortable: true, render: (item) => <div><strong>{item.title}</strong><p className="text-xs text-[var(--text-secondary)]">{item.installmentCount > 1 ? `${item.installmentNumber}/${item.installmentCount}` : item.expenseType}</p></div>, searchValue: (item) => `${item.title} ${item.description}` },
    { key: "category", title: "Categoria", render: (item) => categories.find((category) => category.id === item.categoryId)?.name || item.categoryId },
    { key: "amount", title: "Valor", sortable: true, render: (item) => formatMoney(item.amountCents), searchValue: (item) => String(item.amountCents) },
    { key: "due", title: "Vencimento", sortable: true, render: (item) => formatDate(item.dueAt) },
    { key: "status", title: "Status", render: (item) => <StatusBadge value={item.status} /> },
    { key: "attachments", title: "Comprovantes", render: (item) => String(item.attachments?.length || 0) },
  ], [categories]);
  const referenceColumns = useMemo<FinanceColumn<FinanceReference>[]>(() => [
    { key: "name", title: "Nome", sortable: true, render: (item) => <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: item.color }} /><strong>{item.name}</strong></div>, searchValue: (item) => item.name },
    { key: "description", title: "Descrição", render: (item) => item.description || "—" },
    { key: "active", title: "Status", render: (item) => <StatusBadge value={item.active ? "active" : "canceled"} /> },
  ], []);

  if (loading && !dashboard) return <div className="grid min-h-[60vh] place-items-center"><RefreshCw className="animate-spin text-blue-400" size={28} /><span className="sr-only">Carregando financeiro</span></div>;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1720px] flex-1 flex-col gap-4 overflow-hidden p-4 lg:p-5">
      <section className="finance-panel shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-blue-500/12 text-blue-400"><Landmark size={21}/></span><div><h2 className="text-xl font-black">Financeiro administrativo</h2><p className="finance-subtitle">Receita do SaaS, assinaturas, custos operacionais e consumo Jorro em uma única visão.</p></div></div>
          <div className="flex flex-wrap gap-2"><Button onClick={() => setImportOpen(true)}><Upload size={16}/> Importar</Button><Button onClick={() => void exportFile("csv")}><Download size={16}/> CSV</Button><Button onClick={() => void exportFile("xlsx")}><FileSpreadsheet size={16}/> Excel</Button><Button variant="primary" onClick={() => void exportFile("pdf")}><Download size={16}/> PDF</Button><Button iconOnly aria-label="Atualizar" title="Atualizar" onClick={() => void loadAll()}><RefreshCw size={17} className={loading ? "animate-spin" : ""}/></Button></div>
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">{sections.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setSection(id)} className={`inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-black transition ${section === id ? "border-blue-400/60 bg-blue-500/14 text-blue-300" : "border-[var(--border)] bg-[var(--background)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"}`}><Icon size={15}/>{label}</button>)}</div>
      </section>

      <section className="finance-panel shrink-0 p-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <select className="finance-field" value={period} onChange={(event) => setPeriod(event.target.value as FinancePeriod)}>{periodOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select className="finance-field" value={filters.planId} onChange={(event) => setFilters((current) => ({ ...current, planId: event.target.value }))}><option value="all">Todos os planos</option>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select>
          <select className="finance-field" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}><option value="all">Todos os status</option>{["active", "trial", "paid", "pending", "overdue", "defaulting", "canceled", "refunded"].map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select>
          <select className="finance-field" value={filters.categoryId} onChange={(event) => setFilters((current) => ({ ...current, categoryId: event.target.value }))}><option value="all">Todas as categorias</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <select className="finance-field" value={filters.providerId} onChange={(event) => setFilters((current) => ({ ...current, providerId: event.target.value }))}><option value="all">Todos os provedores</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <select className="finance-field" value={filters.paymentMethod} onChange={(event) => setFilters((current) => ({ ...current, paymentMethod: event.target.value }))}><option value="all">Todos os métodos</option><option value="pix">Pix</option><option value="credit_card">Cartão</option><option value="boleto">Boleto</option><option value="transfer">Transferência</option></select>
          <Button onClick={() => setFilters({ planId: "all", status: "all", categoryId: "all", providerId: "all", paymentMethod: "all", supplierId: "all", costCenterId: "all" })}><ArchiveRestore size={15}/> Limpar</Button>
        </div>
      </section>

      {(notice || error) && <div role="status" className={`shrink-0 rounded-lg border px-4 py-3 text-sm font-bold ${error ? "border-red-400/30 bg-red-500/10 text-red-300" : "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"}`}>{error || notice}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {section === "overview" && dashboard && <FinanceOverview data={dashboard}/>}
        {section === "plans" && <TableSection title="Planos comerciais" description="Preços, ciclos, limites, teste, taxas e disponibilidade." actionLabel="Novo plano" onAction={() => setDialog({ kind: "plan" })}><FinanceDataTable items={plans} columns={planColumns} emptyTitle="Nenhum plano cadastrado" actions={(item) => <RowActions onEdit={() => setDialog({ kind: "plan", record: item })} onCopy={() => void duplicate("plans", item.id)} onDelete={() => void remove("plan", item)}/>} /></TableSection>}
        {section === "subscriptions" && <TableSection title="Assinaturas" description="Clientes ativos, em teste, inadimplentes, pausados e cancelados." actionLabel="Nova assinatura" onAction={() => setDialog({ kind: "subscription" })}><FinanceDataTable items={subscriptions} columns={subscriptionColumns} emptyTitle="Nenhuma assinatura cadastrada" actions={(item) => <RowActions onEdit={() => setDialog({ kind: "subscription", record: item })} onDelete={() => void remove("subscription", item)}/>} /></TableSection>}
        {section === "payments" && <TableSection title="Receitas e pagamentos" description="Receita prevista, faturada, recebida, pendente, perdida e reembolsada." actionLabel="Nova receita" onAction={() => setDialog({ kind: "payment" })}><FinanceDataTable items={payments} columns={paymentColumns} emptyTitle="Nenhuma receita registrada" actions={(item) => <RowActions onEdit={() => setDialog({ kind: "payment", record: item })} onDelete={() => void remove("payment", item)}/>} /></TableSection>}
        {section === "expenses" && <TableSection title="Despesas operacionais" description="Custos fixos, variáveis, recorrentes, parcelas, fornecedores e comprovantes." actionLabel="Nova despesa" onAction={() => setDialog({ kind: "expense" })}>{selectedExpenseIds.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-400/30 bg-blue-500/10 p-3"><span className="mr-auto text-sm font-black">{selectedExpenseIds.length} selecionada(s)</span><Button size="sm" onClick={() => void bulkExpenseStatus("paid")}>Marcar pagas</Button><Button size="sm" onClick={() => void bulkExpenseStatus("pending")}>Marcar pendentes</Button></div>}<FinanceDataTable items={expenses} columns={expenseColumns} selectedIds={selectedExpenseIds} onSelectedIdsChange={setSelectedExpenseIds} emptyTitle="Nenhuma despesa registrada" actions={(item) => <RowActions onEdit={() => setDialog({ kind: "expense", record: item })} onCopy={() => void duplicate("expenses", item.id)} onDelete={() => void remove("expense", item)}/>} /></TableSection>}
        {section === "registries" && <TableSection title="Cadastros auxiliares" description="Categorias, subcategorias, fornecedores, centros de custo e provedores sem limites artificiais." actionLabel={`Novo ${referenceLabels[referenceKind]}`} onAction={() => setDialog({ kind: "reference" })} extra={<select className="finance-field min-w-52" value={referenceKind} onChange={(event) => setReferenceKind(event.target.value as ReferenceKind)}><option value="categories">Categorias</option><option value="suppliers">Fornecedores</option><option value="cost-centers">Centros de custo</option><option value="providers">Provedores</option></select>}><FinanceDataTable items={references} columns={referenceColumns} emptyTitle="Nenhum cadastro encontrado" actions={(item) => <RowActions onEdit={() => setDialog({ kind: "reference", record: item })} onDelete={() => void remove("reference", item)}/>} /></TableSection>}
        {section === "planning" && <PlanningSection goals={goals} budgets={budgets} onNewGoal={() => setDialog({ kind: "goal" })} onNewBudget={() => setDialog({ kind: "budget" })} onEdit={(kind, item) => setDialog({ kind, record: item })} onDelete={(kind, item) => void remove(kind, item)}/>}
        {section === "jorro" && <JorroSection data={jorro} dashboard={dashboard} onSync={async () => { try { const result = await adminFinanceApi.syncJorro(token); setJorro(result); setNotice(String(result.message || "Integração Jorro verificada.")); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao consultar Jorro."); } }} onImport={() => setImportOpen(true)}/>}
        {section === "settings" && settings && <SettingsSection value={settings} onChange={setSettings} onSave={() => void saveSettings()} saving={saving}/>}
        {section === "audit" && <AuditSection items={auditLogs}/>}
      </div>

      {dialog && (
        <FinanceRecordDialog
          kind={dialog.kind}
          record={dialog.record ? recordOf(dialog.record) : null}
          plans={plans}
          categories={categories}
          providers={providers}
          referenceLabel={dialog.kind === "reference" ? referenceLabels[referenceKind] : undefined}
          saving={saving}
          onClose={() => setDialog(null)}
          onSubmit={saveRecord}
        />
      )}
      {importOpen && (
        <FinanceImportDialog
          loading={saving}
          onClose={() => setImportOpen(false)}
          onPreview={(file) => adminFinanceApi.previewImport(token, file)}
          onCommit={async (payload) => {
            setSaving(true);
            try {
              const result = await adminFinanceApi.commitImport(token, payload);
              setNotice(`${result.created} registro(s) importado(s).`);
              setImportOpen(false);
              await loadAll();
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </div>
  );
}

function TableSection({ title, description, actionLabel, onAction, extra, children }: { title: string; description: string; actionLabel: string; onAction: () => void; extra?: React.ReactNode; children: React.ReactNode }) {
  return <section className="space-y-4"><header className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="finance-title">{title}</h2><p className="finance-subtitle">{description}</p></div><div className="flex flex-wrap gap-2">{extra}<Button variant="primary" onClick={onAction}><Plus size={16}/>{actionLabel}</Button></div></header>{children}</section>;
}

function RowActions({ onEdit, onCopy, onDelete }: { onEdit: () => void; onCopy?: () => void; onDelete: () => void }) {
  return <>{onCopy && <Button size="sm" iconOnly title="Duplicar" aria-label="Duplicar" onClick={onCopy}><Copy size={15}/></Button>}<Button size="sm" iconOnly title="Editar" aria-label="Editar" onClick={onEdit}><Pencil size={15}/></Button><Button size="sm" iconOnly variant="danger" title="Excluir" aria-label="Excluir" onClick={onDelete}><Trash2 size={15}/></Button></>;
}

function PlanningSection({ goals, budgets, onNewGoal, onNewBudget, onEdit, onDelete }: { goals: FinanceGoal[]; budgets: FinanceBudget[]; onNewGoal: () => void; onNewBudget: () => void; onEdit: (kind: "goal" | "budget", item: FinanceGoal | FinanceBudget) => void; onDelete: (kind: "goal" | "budget", item: FinanceGoal | FinanceBudget) => void }) {
  return <div className="grid gap-4 xl:grid-cols-2"><article className="finance-panel"><header className="mb-4 flex items-center justify-between"><div><h3 className="finance-title">Metas</h3><p className="finance-subtitle">Receita, MRR, lucro, clientes ou margem.</p></div><Button iconOnly aria-label="Nova meta" onClick={onNewGoal}><Plus size={16}/></Button></header><div className="space-y-3">{goals.length ? goals.map((item) => <ProgressRecord key={item.id} title={item.name} value={item.progressPercentage || 0} description={`${item.metric} · até ${formatDate(item.endAt)}`} onEdit={() => onEdit("goal", item)} onDelete={() => onDelete("goal", item)}/>) : <EmptyState title="Nenhuma meta ativa"/>}</div></article><article className="finance-panel"><header className="mb-4 flex items-center justify-between"><div><h3 className="finance-title">Orçamentos</h3><p className="finance-subtitle">Limites por categoria ou provedor, com alertas progressivos.</p></div><Button iconOnly aria-label="Novo orçamento" onClick={onNewBudget}><Plus size={16}/></Button></header><div className="space-y-3">{budgets.length ? budgets.map((item) => <ProgressRecord key={item.id} title={item.name} value={item.usagePercentage || 0} description={`${formatMoney(item.spentCents || 0)} de ${formatMoney(item.limitCents)}`} onEdit={() => onEdit("budget", item)} onDelete={() => onDelete("budget", item)}/>) : <EmptyState title="Nenhum orçamento ativo"/>}</div></article></div>;
}

function ProgressRecord({ title, description, value, onEdit, onDelete }: { title: string; description: string; value: number; onEdit: () => void; onDelete: () => void }) {
  return <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><strong className="block truncate text-sm">{title}</strong><span className="text-xs text-[var(--text-secondary)]">{description}</span></div><RowActions onEdit={onEdit} onDelete={onDelete}/></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface)]"><div className={`h-full rounded-full ${value >= 100 ? "bg-red-500" : value >= 75 ? "bg-amber-400" : "bg-blue-500"}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }}/></div><p className="mt-1 text-right text-xs font-black">{value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</p></div>;
}

function JorroSection({ data, dashboard, onSync, onImport }: { data: Record<string, unknown> | null; dashboard: AdminFinanceDashboardData | null; onSync: () => Promise<void>; onImport: () => void }) {
  const metrics = dashboard?.metrics;
  return <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]"><article className="finance-panel"><div className="flex items-start justify-between gap-3"><div><h2 className="finance-title">Consumo Jorro</h2><p className="finance-subtitle">Custos da IA separados das demais despesas operacionais.</p></div><span className="rounded-full bg-cyan-500/12 px-3 py-1 text-xs font-black text-cyan-400">{String(data?.mode || "manual")}</span></div><div className="mt-5 grid gap-3 sm:grid-cols-2"><Metric label="Consumo no período" value={formatMoney(metrics?.jorroSpendCents || 0)}/><Metric label="Percentual da receita" value={`${(metrics?.jorroRevenuePercentage || 0).toLocaleString("pt-BR")}%`}/><Metric label="Orçamento mensal" value={formatMoney(metrics?.jorroBudgetCents || 0)}/><Metric label="Uso do orçamento" value={`${(metrics?.jorroBudgetUsagePercentage || 0).toLocaleString("pt-BR")}%`}/></div></article><article className="finance-panel"><h3 className="finance-title">Conector e importação</h3><p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{String(data?.message || "Importação manual e CSV disponíveis.")}</p><dl className="mt-4 space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-[var(--text-secondary)]">Status</dt><dd className="font-black">{data?.enabled ? "Habilitado" : "Manual"}</dd></div><div className="flex justify-between gap-3"><dt className="text-[var(--text-secondary)]">Última verificação</dt><dd className="font-black">{formatDate(String(data?.lastSyncAt || ""))}</dd></div></dl><div className="mt-5 flex flex-wrap gap-2"><Button onClick={() => void onSync()}><RefreshCw size={16}/> Testar conector</Button><Button variant="primary" onClick={onImport}><Upload size={16}/> Importar consumo</Button></div></article></div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4"><p className="text-xs font-bold text-[var(--text-secondary)]">{label}</p><p className="mt-2 text-xl font-black">{value}</p></div>; }

function SettingsSection({ value, onChange, onSave, saving }: { value: FinanceSettings; onChange: (value: FinanceSettings) => void; onSave: () => void; saving: boolean }) {
  const set = <K extends keyof FinanceSettings>(key: K, next: FinanceSettings[K]) => onChange({ ...value, [key]: next });
  return <section className="finance-panel max-w-5xl"><header className="mb-5"><h2 className="finance-title">Configurações financeiras</h2><p className="finance-subtitle">Padrões monetários, fiscais, fechamento, competência e alertas.</p></header><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><label className="finance-label">Moeda<input className="finance-field" maxLength={3} value={value.currency} onChange={(event) => set("currency", event.target.value.toUpperCase())}/></label><label className="finance-label">Fuso horário<input className="finance-field" value={value.timezone} onChange={(event) => set("timezone", event.target.value)}/></label><label className="finance-label">Reconhecimento<select className="finance-field" value={value.revenueRecognition} onChange={(event) => set("revenueRecognition", event.target.value as FinanceSettings["revenueRecognition"])}><option value="cash">Caixa</option><option value="accrual">Competência</option></select></label><label className="finance-label">Imposto padrão (%)<input className="finance-field" type="number" min="0" max="100" value={value.defaultTaxPercentage} onChange={(event) => set("defaultTaxPercentage", Number(event.target.value))}/></label><label className="finance-label">Taxa de pagamento (%)<input className="finance-field" type="number" min="0" max="100" value={value.defaultPaymentFeePercentage} onChange={(event) => set("defaultPaymentFeePercentage", Number(event.target.value))}/></label><label className="finance-label">Dia de fechamento<input className="finance-field" type="number" min="1" max="28" value={value.closingDay} onChange={(event) => set("closingDay", Number(event.target.value))}/></label><label className="finance-label">Método padrão<input className="finance-field" value={value.defaultPaymentMethod} onChange={(event) => set("defaultPaymentMethod", event.target.value)}/></label><label className="finance-label">Orçamento Jorro (centavos)<input className="finance-field" type="number" min="0" value={value.jorroMonthlyBudgetCents} onChange={(event) => set("jorroMonthlyBudgetCents", Number(event.target.value))}/></label><label className="finance-label flex-row items-center gap-3"><input type="checkbox" checked={value.jorroProviderEnabled} onChange={(event) => set("jorroProviderEnabled", event.target.checked)}/> Preparar conector Jorro</label></div><div className="mt-5"><Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Salvando..." : "Salvar configurações"}</Button></div></section>;
}

function AuditSection({ items }: { items: AuditLog[] }) {
  const columns: FinanceColumn<AuditLog>[] = [
    { key: "timestamp", title: "Data", sortable: true, render: (item) => new Date(item.timestamp).toLocaleString("pt-BR") },
    { key: "user", title: "Operador", sortable: true, render: (item) => item.userName || item.userId, searchValue: (item) => `${item.userName} ${item.userId}` },
    { key: "action", title: "Ação", render: (item) => item.action }, { key: "entity", title: "Entidade", render: (item) => item.entity },
    { key: "entityId", title: "Identificador", render: (item) => <code className="text-xs">{item.entityId}</code> },
  ];
  return <TableSection title="Trilha de auditoria" description="Alterações administrativas com operador, data, entidade e estado anterior/posterior." actionLabel="Atualizar" onAction={() => window.location.reload()}><FinanceDataTable items={items} columns={columns} emptyTitle="Nenhuma ação auditada" pageSize={20}/></TableSection>;
}
