import { AlertTriangle, ArrowDownRight, ArrowUpRight, Banknote, CircleDollarSign, CreditCard, Gauge, ReceiptText, TrendingUp, UsersRound } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AdminFinanceDashboardData } from "../../../features/admin-finance/types";
import { formatCompactMoney, formatMoney } from "../../../features/admin-finance/format";

interface FinanceOverviewProps { data: AdminFinanceDashboardData; }

const chartColors = ["#2563eb", "#06b6d4", "#10b981", "#f59e0b", "#f43f5e", "#8b5cf6"];

export default function FinanceOverview({ data }: FinanceOverviewProps) {
  const { metrics, deltas, charts } = data;
  const cards = [
    ["Receita recebida", metrics.receivedRevenueCents, "receivedRevenueCents", CircleDollarSign],
    ["MRR", metrics.mrrCents, "mrrCents", TrendingUp],
    ["ARR", metrics.arrCents, "mrrCents", Banknote],
    ["Despesas", metrics.expensesCents, "expensesCents", ReceiptText],
    ["Lucro líquido", metrics.netProfitCents, "netProfitCents", Gauge],
    ["Ticket médio", metrics.averageTicketCents, "averageTicketCents", CreditCard],
  ] as const;
  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {cards.map(([label, value, deltaKey, Icon]) => <MetricCard key={label} tone={deltaKey === "expensesCents" ? "rose" : value < 0 ? "rose" : "emerald"} label={label} value={formatMoney(value)} delta={deltas[deltaKey]} icon={Icon} />)}
      </section>
      <section className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <article className="finance-panel min-h-[330px]">
          <header className="mb-4"><h3 className="finance-title">Receitas, despesas e previsão</h3><p className="finance-subtitle">Evolução do período selecionado, já descontando taxas, impostos e reembolsos.</p></header>
          <ResponsiveContainer width="100%" height={255}>
            <AreaChart data={charts.cashFlow}><defs><linearGradient id="received" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#2563eb" stopOpacity={0.5}/><stop offset="95%" stopColor="#2563eb" stopOpacity={0}/></linearGradient></defs><CartesianGrid stroke="var(--border)" strokeDasharray="3 3"/><XAxis dataKey="date" tick={{ fill: "var(--text-secondary)", fontSize: 11 }}/><YAxis tickFormatter={(value) => formatCompactMoney(Number(value))} tick={{ fill: "var(--text-secondary)", fontSize: 11 }}/><Tooltip formatter={(value) => formatMoney(Number(value))} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}/><Legend/><Area type="monotone" dataKey="revenueCents" name="Recebida" stroke="#2563eb" fill="url(#received)"/><Area type="monotone" dataKey="expensesCents" name="Despesas" stroke="#f43f5e" fillOpacity={0}/><Area type="monotone" dataKey="forecastCents" name="Prevista" stroke="#06b6d4" strokeDasharray="5 4" fillOpacity={0}/></AreaChart>
          </ResponsiveContainer>
        </article>
        <article className="finance-panel min-h-[330px]">
          <header className="mb-4"><h3 className="finance-title">Receita por plano</h3><p className="finance-subtitle">Participação dos planos na receita recebida.</p></header>
          {charts.revenueByPlan.length ? <ResponsiveContainer width="100%" height={255}><PieChart><Pie data={charts.revenueByPlan} dataKey="valueCents" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={3}>{charts.revenueByPlan.map((item, index) => <Cell key={item.id} fill={chartColors[index % chartColors.length]} />)}</Pie><Tooltip formatter={(value) => formatMoney(Number(value))} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}/><Legend /></PieChart></ResponsiveContainer> : <ChartEmpty label="Ainda não há receita recebida neste período." />}
        </article>
      </section>
      <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <article className="finance-panel"><h3 className="finance-title">Resultado operacional</h3><div className="mt-4 grid grid-cols-2 gap-3"><MiniMetric label="Receita faturada" value={formatMoney(metrics.billedRevenueCents)}/><MiniMetric label="Receita pendente" value={formatMoney(metrics.pendingRevenueCents)}/><MiniMetric label="Lucro bruto" value={formatMoney(metrics.grossProfitCents)}/><MiniMetric label="Margem líquida" value={`${metrics.netMarginPercentage.toLocaleString("pt-BR")}%`}/><MiniMetric label="Reembolsos" value={formatMoney(metrics.refundedRevenueCents)}/><MiniMetric label="Perdida" value={formatMoney(metrics.lostRevenueCents)}/></div></article>
        <article className="finance-panel"><h3 className="finance-title">Assinaturas</h3><div className="mt-4 grid grid-cols-2 gap-3"><MiniMetric label="Ativas" value={String(metrics.subscriptions.active)} icon={<UsersRound size={16}/>}/><MiniMetric label="Em teste" value={String(metrics.subscriptions.trial)}/><MiniMetric label="Inadimplentes" value={String(metrics.subscriptions.defaulting)}/><MiniMetric label="Canceladas" value={String(metrics.subscriptions.canceled)}/><MiniMetric label="Receita em 30 dias" value={formatMoney(metrics.expected30DaysCents)} wide/></div></article>
        <article className="finance-panel"><h3 className="finance-title">Jorro</h3><div className="mt-4 grid grid-cols-2 gap-3"><MiniMetric label="Consumo" value={formatMoney(metrics.jorroSpendCents)}/><MiniMetric label="% da receita" value={`${metrics.jorroRevenuePercentage.toLocaleString("pt-BR")}%`}/><MiniMetric label="Orçamento" value={formatMoney(metrics.jorroBudgetCents)}/><MiniMetric label="Uso do limite" value={`${metrics.jorroBudgetUsagePercentage.toLocaleString("pt-BR")}%`}/></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--background)]"><div className="h-full rounded-full bg-cyan-400" style={{ width: `${Math.min(100, metrics.jorroBudgetUsagePercentage)}%` }} /></div></article>
      </section>
      <section className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <article className="finance-panel min-h-[300px]"><h3 className="finance-title">Despesas por categoria</h3><ResponsiveContainer width="100%" height={235}><BarChart data={charts.expensesByCategory} layout="vertical"><CartesianGrid stroke="var(--border)" strokeDasharray="3 3"/><XAxis type="number" tickFormatter={(value) => formatCompactMoney(Number(value))} tick={{ fill: "var(--text-secondary)", fontSize: 11 }}/><YAxis dataKey="name" type="category" width={100} tick={{ fill: "var(--text-secondary)", fontSize: 11 }}/><Tooltip formatter={(value) => formatMoney(Number(value))} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}/><Bar dataKey="valueCents" name="Despesas" fill="#06b6d4" radius={[0, 5, 5, 0]}/></BarChart></ResponsiveContainer></article>
        <article className="finance-panel"><h3 className="finance-title">Alertas financeiros</h3><div className="mt-4 max-h-60 space-y-2 overflow-y-auto">{data.alerts.length ? data.alerts.map((alert) => <div key={alert.id} className="flex gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><AlertTriangle size={17} className={alert.severity === "critical" ? "text-red-400" : "text-amber-400"}/><div><p className="text-sm font-semibold">{alert.title}</p><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{alert.description}</p></div></div>) : <ChartEmpty label="Nenhum alerta financeiro ativo." />}</div></article>
      </section>
    </div>
  );
}

function MetricCard({ label, value, delta, icon: Icon, tone }: { label: string; value: string; delta?: number | null; icon: typeof CircleDollarSign; tone: string }) {
  const positive = Number(delta) >= 0;
  return <article data-metric-tone={tone} className="finance-panel p-4"><div className="flex items-start justify-between"><span className="grid h-9 w-9 place-items-center rounded-lg bg-blue-500/12 text-blue-400"><Icon size={18}/></span>{delta !== null && delta !== undefined && <span className={`inline-flex items-center gap-1 text-xs font-medium ${positive ? "text-emerald-400" : "text-red-400"}`}>{positive ? <ArrowUpRight size={14}/> : <ArrowDownRight size={14}/>}{Math.abs(delta).toLocaleString("pt-BR")}%</span>}</div><p className="metric-value mt-4 truncate text-xl font-semibold" title={value}>{value}</p><p className="mt-1 text-xs font-medium text-[var(--text-secondary)]">{label}</p></article>;
}

function MiniMetric({ label, value, icon, wide }: { label: string; value: string; icon?: React.ReactNode; wide?: boolean }) {
  return <div className={`rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 ${wide ? "col-span-2" : ""}`}><div className="flex items-center gap-2 text-[var(--text-secondary)]">{icon}<span className="text-xs font-medium">{label}</span></div><p className="mt-2 text-base font-semibold">{value}</p></div>;
}

function ChartEmpty({ label }: { label: string }) { return <div className="grid h-56 place-items-center text-center text-sm font-semibold text-[var(--text-secondary)]">{label}</div>; }
