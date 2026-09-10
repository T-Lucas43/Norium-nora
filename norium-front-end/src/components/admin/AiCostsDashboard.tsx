import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronDown, CircleDollarSign, Coins, Cpu, Plus, RefreshCw, Save, Search, UsersRound, X } from "lucide-react";
import { apiBlobRequest } from "../../core/api/client";
import { authJson } from "../../utils/authApi";
import type { NoriumUser } from "../../types/auth";
import Button from "../shared/Button";
import "./ai-costs.css";

interface Totals { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number; totalTokens: number; costUsd: number; inputCostUsd: number; outputCostUsd: number; unpricedRequests: number; estimatedRequests: number }
interface Tariff { id: string; provider: string; model: string; name: string; baseUrl: string; unitTokens: number; inputUsd: number | null; outputUsd: number | null; cachedInputUsd: number | null; cacheWriteUsd: number | null; source: string; validUntil: string | null; version: number; updatedAt: string }
interface Model extends Tariff, Totals { connections: { providerId: string; userId: string | null; configured: boolean; enabled: boolean; workspace: string }[] }
interface Limits { monthlyBudgetUsd: number | null; monthlyTokenLimit: number | null; period?: "weekly" | "monthly"; startDate?: string | null; autoRenew?: boolean; resetAt?: string | null }
interface UserModel extends Totals { modelId: string; capacityInputOnly: number | null; capacityOutputOnly: number | null; capacityMixed: number | null }
interface CostUser extends Totals { id: string; name: string; email: string; limits: Limits; currentMonth: Totals; currentCycle?: Totals; cycle?: { startAt: string; endAt: string; nextResetAt: string | null; status: string; active: boolean }; remainingUsd: number | null; remainingTokens: number | null; pendingRequests: number; models: UserModel[] }
interface Usage { id: string; userId: string; modelId: string; createdAt: string; source: string; workspace: string; inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number; costUsd: number | null; estimated: boolean }
interface Overview { month: string; currentMonth: string; trackingStartedAt: string; updatedAt: string; totals: Totals; models: Model[]; users: CostUser[]; recentUsage: Usage[]; audit: { created_at: string; actor: string; action: string; target: string }[] }
type TariffForm = { provider: string; model: string; name: string; baseUrl: string; unitTokens: string; inputUsd: string; outputUsd: string; cachedInputUsd: string; cacheWriteUsd: string; source: string; validUntil: string };
const number = (value: number | null | undefined) => value == null ? "Sem limite" : new Intl.NumberFormat("pt-BR").format(value);
const money = (value: number | null | undefined) => value == null ? "Pendente" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
const date = (value: string) => new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(value));
const providers: Record<string, string> = { groq: "Groq", google: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic", "openai-compatible": "API compatível", unknown: "Provedor legado" };
const emptyForm: TariffForm = { provider: "groq", model: "", name: "", baseUrl: "", unitTokens: "1000000", inputUsd: "", outputUsd: "", cachedInputUsd: "", cacheWriteUsd: "", source: "Cadastro administrativo", validUntil: "" };

export default function AiCostsDashboard({ token, actor, users }: { token: string; actor: NoriumUser; users: NoriumUser[] }) {
  const [data, setData] = useState<Overview | null>(null);
  const [month, setMonth] = useState(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).format(new Date()));
  const [tab, setTab] = useState<"users" | "models" | "history">("users");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<TariffForm | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const generation = useRef(0);
  const editor = useRef<HTMLFormElement>(null);

  const refresh = useCallback(async (quiet = false) => {
    const request = ++generation.current;
    if (!quiet) setLoading(true);
    try {
      const result = await authJson<Overview>(`/api/auth/admin/ai-costs?month=${encodeURIComponent(month)}`, token);
      if (request !== generation.current) return;
      setData(result); setError("");
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "Falha ao carregar custos de IA.");
    } finally { if (request === generation.current) setLoading(false); }
  }, [month, token]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const editorOpen = editing !== null;
  useEffect(() => { void refresh(); return invalidate; }, [refresh, invalidate]);
  useEffect(() => { const timer = window.setInterval(() => { if (!document.hidden && !editing && !saving) void refresh(true); }, 30_000); return () => window.clearInterval(timer); }, [refresh, editing, saving]);
  useEffect(() => { if (editorOpen) { editor.current?.scrollIntoView?.({ behavior: "smooth", block: "center" }); editor.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus(); } }, [editingExisting, editorOpen]);

  const visibleUsers = useMemo(() => (data?.users || []).filter(u => `${u.name} ${u.email}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [data, search]);
  const modelMap = useMemo(() => new Map(data?.models.map(m => [m.id, m])), [data]);
  function edit(model?: Model) {
    setEditingExisting(Boolean(model));
    setEditing(model ? { provider: model.provider, model: model.model, name: model.name, baseUrl: model.baseUrl, unitTokens: String(model.unitTokens), inputUsd: model.inputUsd == null ? "" : String(model.inputUsd), outputUsd: model.outputUsd == null ? "" : String(model.outputUsd), cachedInputUsd: model.cachedInputUsd == null ? "" : String(model.cachedInputUsd), cacheWriteUsd: model.cacheWriteUsd == null ? "" : String(model.cacheWriteUsd), source: model.source, validUntil: model.validUntil || "" } : { ...emptyForm });
    setTab("models"); setNotice("");
  }
  async function saveTariff(event: React.FormEvent) {
    event.preventDefault(); if (!editing) return;
    setSaving(true); setError("");
    try {
      await authJson("/api/auth/admin/ai-costs/tariffs", token, { method: "POST", body: JSON.stringify({ ...editing, unitTokens: Number(editing.unitTokens), inputUsd: Number(editing.inputUsd), outputUsd: Number(editing.outputUsd), cachedInputUsd: editing.cachedInputUsd === "" ? null : Number(editing.cachedInputUsd), cacheWriteUsd: editing.cacheWriteUsd === "" ? null : Number(editing.cacheWriteUsd), validUntil: editing.validUntil || null }) });
      setEditing(null); setNotice("Tarifa salva. Novas chamadas usam este preço; registros sem preço foram calculados. Custos anteriores já calculados foram preservados."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar a tarifa."); }
    finally { setSaving(false); }
  }
  async function saveLimits(userId: string, limits: Limits) {
    setSaving(true); setError(""); setNotice("");
    try {
      await authJson(`/api/auth/admin/ai-costs/users/${encodeURIComponent(userId)}/limits`, token, { method: "PUT", body: JSON.stringify(limits) });
      setNotice("Limites do ciclo salvos e aplicados às próximas solicitações de IA."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar os limites."); }
    finally { setSaving(false); }
  }
  async function resetCycle(userId: string, restartCycle: boolean, reason: string) {
    setSaving(true); setError(""); setNotice("");
    try {
      await authJson(`/api/auth/admin/ai-costs/users/${encodeURIComponent(userId)}/reset`, token, { method: "POST", body: JSON.stringify({ restartCycle, reason }) });
      setNotice("Saldo renovado. O histórico financeiro foi preservado."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível resetar o ciclo."); }
    finally { setSaving(false); }
  }
  async function exportPdf(userId = "") {
    setExporting(true); setError("");
    try {
      const blob = await apiBlobRequest(`/api/auth/admin/ai-costs/pdf?month=${encodeURIComponent(month)}&userId=${encodeURIComponent(userId)}`, { token, timeoutMs: 120_000 });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = `norium-custos-ia-${month}.pdf`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao exportar PDF."); }
    finally { setExporting(false); }
  }
  function exportCsv() {
    if (!data) return;
    const rows: (string | number | null)[][] = [["Período", "Usuário", "E-mail", "Provedor", "Modelo", "Requisições", "Entrada", "Saída (inclui raciocínio)", "Cache (incluído na entrada)", "Raciocínio (incluído na saída)", "Custo entrada USD", "Custo saída USD", "Custo total USD", "Requisições sem tarifa", "Requisições estimadas"]];
    for (const u of data.users) for (const m of u.models) if (m.requests) rows.push([data.month, u.name, u.email, modelMap.get(m.modelId)?.provider || "", modelMap.get(m.modelId)?.model || "", m.requests, m.inputTokens, m.outputTokens, m.cachedTokens, m.reasoningTokens, m.inputCostUsd, m.outputCostUsd, m.costUsd, m.unpricedRequests, m.estimatedRequests]);
    const csv = rows.map(row => row.map(v => `"${String(v ?? "").replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `norium-custos-ia-${month}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="ai-costs" aria-label="Custos de IA por usuário">
    <header className="ai-costs-heading"><div><span className="ai-costs-eyebrow">ADMINISTRAÇÃO · CONSUMO DE IA</span><h1>Custos por usuário</h1><p>Tokens, tarifas e saldo de cada conta, reunidos por modelo.</p></div><div className="ai-costs-actions"><Button size="sm" onClick={() => void exportPdf()} disabled={!data || loading || exporting}><ArrowDownToLine size={14} /> {exporting ? "Gerando PDF…" : "Exportar PDF"}</Button><Button size="sm" onClick={exportCsv} disabled={!data || loading}><ArrowDownToLine size={14} /> Exportar CSV</Button><Button size="sm" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Atualizar</Button></div></header>
    <div className="ai-costs-period"><label>Período <input aria-label="Mês dos custos" type="month" value={month === "all" || month === "cycle" ? "" : month} onChange={e => { if (e.target.value) setMonth(e.target.value); }} /></label><button type="button" className={month === "all" ? "is-active" : ""} onClick={() => setMonth("all")}>Todo o histórico</button><button type="button" className={month === "cycle" ? "is-active" : ""} onClick={() => setMonth("cycle")}>Ciclos atuais</button><span>Horário de Brasília · valores em USD · ciclos definidos por usuário</span></div>
    {error && <div className="ai-costs-alert" role="alert">{error}</div>}{notice && <div className="ai-costs-notice" role="status">{notice}</div>}
    {!data && loading && <p role="status">Carregando consumo e detectando modelos…</p>}
    {data && <>
      <div className="ai-costs-kpis"><Metric icon={<CircleDollarSign size={18} />} label="Custo de todos os usuários" value={money(data.totals.costUsd)} detail={`${data.totals.unpricedRequests ? "Subtotal · há valores pendentes" : "Entrada + saída"} · ${number(data.users.length)} contas`} /><Metric icon={<Coins size={18} />} label="Tokens consumidos" value={number(data.totals.totalTokens)} detail={`${number(data.totals.inputTokens)} entrada · ${number(data.totals.outputTokens)} saída`} /><Metric icon={<Cpu size={18} />} label="Modelos detectados" value={number(data.models.length)} detail={`${data.models.filter(m => m.connections.some(c => c.configured && c.enabled)).length} com conexão ativa`} /><Metric icon={<UsersRound size={18} />} label="Usuários com consumo" value={number(data.users.filter(u => u.requests > 0).length)} detail={`${number(data.totals.requests)} chamadas no período`} /></div>
      {(data.totals.unpricedRequests > 0 || data.totals.estimatedRequests > 0) && <div className="ai-costs-alert">{data.totals.unpricedRequests > 0 && `${number(data.totals.unpricedRequests)} chamadas aguardam tarifa e não entram no subtotal em dólares. `}{data.totals.estimatedRequests > 0 && `${number(data.totals.estimatedRequests)} registros são estimativas ou importações do histórico anterior.`}</div>}
      <nav className="ai-costs-tabs" aria-label="Visões de custos"><button type="button" aria-pressed={tab === "users"} onClick={() => setTab("users")}>Por usuário</button><button type="button" aria-pressed={tab === "models"} onClick={() => setTab("models")}>Modelos e tarifas</button><button type="button" aria-pressed={tab === "history"} onClick={() => setTab("history")}>Consumo e auditoria</button></nav>
      {tab === "users" && <div className="ai-costs-panel"><div className="ai-costs-toolbar"><div><h2>Consumo individual</h2><p>Abra uma conta para ver custos por modelo e definir o ciclo e o saldo disponível.</p></div><label className="ai-costs-search"><Search size={15} /><input aria-label="Buscar usuário nos custos" placeholder="Buscar nome ou e-mail" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
        <div className="ai-costs-users">{visibleUsers.map(u => <article key={u.id} className="ai-costs-user"><button type="button" className="ai-costs-user-toggle" aria-expanded={expanded === u.id} onClick={() => setExpanded(expanded === u.id ? "" : u.id)}><span className="ai-costs-avatar">{u.name.slice(0, 2).toUpperCase()}</span><span className="ai-costs-user-name"><strong>{u.name}</strong><small>{u.email || u.id}</small></span><span><small>Tokens</small><strong>{number(u.totalTokens)}</strong></span><span><small>Custo {u.unpricedRequests ? "parcial" : "total"}</small><strong>{money(u.costUsd)}</strong></span><ChevronDown size={16} className={expanded === u.id ? "rotate-180" : ""} /></button>
          {expanded === u.id && <div className="ai-costs-user-detail"><LimitEditor key={`${u.id}:${JSON.stringify(u.limits)}`} user={u} saving={saving} disabled={!users.some(item => item.id === u.id) || users.some(item => item.id === u.id && item.systemAdminRole === "owner" && item.id !== actor.id)} onSave={value => void saveLimits(u.id, value)} onReset={(restart, reason) => void resetCycle(u.id, restart, reason)} /><Button size="sm" disabled={exporting} onClick={() => void exportPdf(u.id)}>Exportar PDF deste usuário</Button>
            <h3>Detalhamento por modelo</h3><p className="ai-costs-muted">O saldo é compartilhado entre os modelos. A capacidade mista estima 75% de entrada e 25% de saída, sem cache. As capacidades abaixo são alternativas de uso do mesmo saldo.</p>
            <div className="ai-costs-table-wrap"><table><thead><tr><th>Modelo / provedor</th><th>Entrada</th><th>Saída</th><th>Cache / raciocínio¹</th><th>Custo entrada</th><th>Custo saída</th><th>Total USD</th><th>Tokens possíveis²</th></tr></thead><tbody>{u.models.map(m => <tr key={m.modelId}><td><strong>{modelMap.get(m.modelId)?.model}</strong><small>{providers[modelMap.get(m.modelId)?.provider || ""] || "Outro provedor"} · {number(m.requests)} chamadas</small></td><td>{number(m.inputTokens)}</td><td>{number(m.outputTokens)}</td><td>{number(m.cachedTokens)} / {number(m.reasoningTokens)}</td><td>{money(m.inputCostUsd)}</td><td>{money(m.outputCostUsd)}</td><td><strong>{m.unpricedRequests ? `${money(m.costUsd)} + pendente` : money(m.costUsd)}</strong></td><td>{m.capacityMixed == null ? "Sem cálculo" : number(m.capacityMixed)}<small>Entrada: {m.capacityInputOnly == null ? "—" : number(m.capacityInputOnly)}<br />Saída: {m.capacityOutputOnly == null ? "—" : number(m.capacityOutputOnly)}</small></td></tr>)}</tbody></table></div><p className="ai-costs-muted">¹ Cache já está na entrada; raciocínio já está na saída. Não são somados novamente. ² Usa o saldo do ciclo atual desta conta, mesmo ao consultar meses anteriores. Cadastre um orçamento e uma tarifa para calcular.</p>
          </div>}
        </article>)}{!visibleUsers.length && <p className="ai-costs-empty">Nenhum usuário encontrado.</p>}</div>
      </div>}
      {tab === "models" && <div className="ai-costs-panel"><div className="ai-costs-toolbar"><div><h2>Provedores, modelos e preços</h2><p>Conexões detectadas no sistema e nos workspaces. Cada modelo tem sua própria tarifa.</p></div><Button size="sm" variant="primary" onClick={() => edit()}><Plus size={14} /> Cadastrar tarifa</Button></div>
        {editing && <form ref={editor} className="ai-costs-editor" onSubmit={saveTariff}><div className="ai-costs-toolbar"><h3>{editingExisting ? "Editar tarifa do modelo" : "Cadastrar provedor e modelo"}</h3><button type="button" aria-label="Fechar edição de tarifa" onClick={() => setEditing(null)}><X size={18} /></button></div><div className="ai-costs-form-grid"><label>Provedor<select value={editing.provider} disabled={editingExisting} onChange={e => setEditing({ ...editing, provider: e.target.value })}>{Object.entries(providers).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>Identificador do modelo<input required disabled={editingExisting} value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })} placeholder="Ex.: openai/gpt-oss-20b" /></label><label>Nome da conexão<input required maxLength={120} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label><label>URL base da API<input type="url" disabled={editingExisting} required={editing.provider === "openai-compatible"} value={editing.baseUrl} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="Padrão do provedor, se vazio" /></label>
          <label>Quantidade de tokens por unidade<input required type="number" min="1" max="1000000000" step="1" value={editing.unitTokens} onChange={e => setEditing({ ...editing, unitTokens: e.target.value })} /></label>{([["inputUsd", "Preço de entrada (USD)"], ["outputUsd", "Preço de saída (USD)"], ["cachedInputUsd", "Entrada em cache (USD)"], ["cacheWriteUsd", "Gravação de cache (USD)"]] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min="0" max="1000000" step="any" required={key === "inputUsd" || key === "outputUsd"} value={editing[key]} onChange={e => setEditing({ ...editing, [key]: e.target.value })} placeholder={key === "cachedInputUsd" || key === "cacheWriteUsd" ? "Usar preço de entrada" : "0,00"} /></label>)}<label>Fonte ou observação<input maxLength={500} value={editing.source} onChange={e => setEditing({ ...editing, source: e.target.value })} /></label><label>Revisar tarifa até<input type="date" value={editing.validUntil} onChange={e => setEditing({ ...editing, validUntil: e.target.value })} /></label></div><p className="ai-costs-muted">Os preços se aplicam à quantidade de tokens informada. Use zero para gratuidade. A associação é feita por provedor + URL base + modelo. Credenciais continuam nas conexões de Modelos de IA. Uma alteração de preço vale para novas chamadas e registros que ainda não tinham tarifa.</p><Button variant="primary" size="sm" type="submit" disabled={saving}><Save size={14} /> {saving ? "Salvando…" : "Salvar tarifa"}</Button></form>}
        <div className="ai-costs-model-grid">{data.models.map(m => <article key={m.id} className="ai-costs-model"><div className="ai-costs-toolbar"><span className="ai-costs-provider">{providers[m.provider] || m.provider}</span><span className={`ai-costs-badge ${m.inputUsd == null ? "is-warning" : ""}`}>{m.inputUsd == null ? "Tarifa pendente" : m.connections.some(c => c.configured && c.enabled) ? "Conectado" : "Cadastrado / histórico"}</span></div><h3>{m.model}</h3><p className="ai-costs-muted">{m.name}</p><div className="ai-costs-model-total"><strong>{money(m.costUsd)}</strong><span>{number(m.totalTokens)} tokens · {number(m.requests)} chamadas</span></div><dl><div><dt>Entrada / {number(m.unitTokens)} tokens</dt><dd>{money(m.inputUsd)}</dd></div><div><dt>Saída / {number(m.unitTokens)} tokens</dt><dd>{money(m.outputUsd)}</dd></div><div><dt>Entrada em cache</dt><dd>{money(m.cachedInputUsd ?? m.inputUsd)}</dd></div><div><dt>Gravação de cache</dt><dd>{money(m.cacheWriteUsd ?? m.inputUsd)}</dd></div></dl><p className="ai-costs-muted break-all">{m.baseUrl || "URL não disponível"}</p>{/^https:\/\//.test(m.source) ? <a href={m.source} target="_blank" rel="noreferrer" className="ai-costs-source">Consultar fonte do preço ↗</a> : <p className="ai-costs-muted">{m.source}</p>}{m.validUntil && <p className="ai-costs-muted">Revisar até {m.validUntil.split("-").reverse().join("/")}</p>}<Button size="sm" onClick={() => edit(m)}>Editar tarifa</Button></article>)}</div>
      </div>}
      {tab === "history" && <div className="ai-costs-panel"><div className="ai-costs-toolbar"><div><h2>Últimas 100 chamadas do período</h2><p>Registros de uso com o modelo efetivamente utilizado, inclusive fallbacks.</p></div><label>Filtrar modelo<select value={modelFilter} onChange={e => setModelFilter(e.target.value)}><option value="">Todos os modelos</option>{data.models.map(m => <option value={m.id} key={m.id}>{m.model}</option>)}</select></label></div><div className="ai-costs-table-wrap"><table><thead><tr><th>Data / usuário</th><th>Modelo</th><th>Origem</th><th>Entrada / saída</th><th>USD</th><th>Medição</th></tr></thead><tbody>{data.recentUsage.filter(u => !modelFilter || u.modelId === modelFilter).map(u => <tr key={u.id}><td>{date(u.createdAt)}<small>{data.users.find(account => account.id === u.userId)?.name || u.userId}</small></td><td>{modelMap.get(u.modelId)?.model}</td><td>{u.source}<small>Workspace: {u.workspace}</small></td><td>{number(u.inputTokens)} / {number(u.outputTokens)}</td><td>{money(u.costUsd)}</td><td>{u.estimated ? "Estimado / legado" : "Informado pela API"}</td></tr>)}</tbody></table>{!data.recentUsage.length && <p className="ai-costs-empty">Nenhuma chamada registrada neste período. O consumo aparecerá automaticamente após o uso da IA.</p>}</div><h3 className="mt-6">Alterações administrativas</h3><div className="ai-costs-audit">{data.audit.map((item, index) => <p key={`${item.created_at}:${index}`}><strong>{item.action === "tariff_updated" ? "Tarifa atualizada" : item.action === "cycle_reset" ? "Saldo resetado" : "Limite atualizado"}</strong><span>{date(item.created_at)} · {data.users.find(u => u.id === item.actor)?.name || item.actor} · {data.users.find(u => u.id === item.target)?.name || item.target}</span></p>)}{!data.audit.length && <p className="ai-costs-muted">Nenhuma tarifa ou limite alterado pelo painel.</p>}</div></div>}
      <footer className="ai-costs-footnote">Contabilização central desde {date(data.trackingStartedAt)}. Histórico anterior importado quando há registros de tokens; uso sem registro não pode ser recuperado. Custos calculados pelas tarifas cadastradas, sujeitos à cobrança do provedor. Voz, armazenamento e ferramentas cobradas separadamente não entram nos custos de tokens. Atualização automática a cada 30 segundos · última: {date(data.updatedAt)}.</footer>
    </>}
  </section>;
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) { return <article className="ai-costs-kpi"><div>{icon}<span>{label}</span></div><strong>{value}</strong><p>{detail}</p></article>; }

function LimitEditor({ user, saving, disabled, onSave, onReset }: { user: CostUser; saving: boolean; disabled: boolean; onSave: (value: Limits) => void; onReset: (restart: boolean, reason: string) => void }) {
  const [budget, setBudget] = useState(user.limits.monthlyBudgetUsd == null ? "" : String(user.limits.monthlyBudgetUsd));
  const [tokens, setTokens] = useState(user.limits.monthlyTokenLimit == null ? "" : String(user.limits.monthlyTokenLimit));
  const [period, setPeriod] = useState(user.limits.period || "monthly");
  const [startDate, setStartDate] = useState(user.limits.startDate || "");
  const [autoRenew, setAutoRenew] = useState(user.limits.autoRenew ?? true);
  const [resetOpen, setResetOpen] = useState(false);
  const [restart, setRestart] = useState(true);
  const [reason, setReason] = useState("");
  const current = user.currentCycle || user.currentMonth;
  const usedPercent = user.limits.monthlyBudgetUsd == null ? 0 : user.limits.monthlyBudgetUsd === 0 ? 100 : Math.min(100, current.costUsd / user.limits.monthlyBudgetUsd * 100);
  const blocked = disabled || saving || user.pendingRequests > 0;
  return <div className="ai-costs-limits"><div><h3>Limites e calendário do usuário</h3><p className="ai-costs-muted">Campo vazio = sem limite. Zero = bloquear. O saldo vale para todos os modelos. Alterar o calendário recalcula o saldo com o histórico existente.</p>
    <form onSubmit={e => { e.preventDefault(); onSave({ monthlyBudgetUsd: budget === "" ? null : Number(budget), monthlyTokenLimit: tokens === "" ? null : Number(tokens), period, startDate: startDate || null, autoRenew }); }}>
      <label>Tipo de ciclo<select value={period} onChange={e => setPeriod(e.target.value as "weekly" | "monthly")} disabled={blocked}><option value="weekly">Semanal · a cada 7 dias</option><option value="monthly">Mensal · mesmo dia do mês</option></select></label>
      <label>Data de início<input type="date" min="2000-01-01" max="2100-12-31" required={period === "weekly" || !autoRenew} value={startDate} onChange={e => setStartDate(e.target.value)} disabled={blocked} /></label>
      <label>Renovação<select value={autoRenew ? "auto" : "manual"} onChange={e => setAutoRenew(e.target.value === "auto")} disabled={blocked}><option value="auto">Automática ao fim do ciclo</option><option value="manual">Manual · bloquear ao encerrar</option></select></label>
      <label>Orçamento por ciclo (USD)<input type="number" min="0" max="1000000" step="any" value={budget} onChange={e => setBudget(e.target.value)} disabled={blocked} placeholder="Sem limite" /></label>
      <label>Limite de tokens por ciclo<input type="number" min="0" max="1000000000000" step="1" value={tokens} onChange={e => setTokens(e.target.value)} disabled={blocked} placeholder="Sem limite" /></label>
      <Button size="sm" variant="primary" type="submit" disabled={blocked}><Save size={14} /> Salvar limites</Button>
    </form><p className="ai-costs-muted">Contagem a partir de 00h de Brasília. Início mensal vazio mantém o dia 1. Dias 29, 30 e 31 usam o último dia nos meses mais curtos. Antes do início, o uso fica bloqueado.</p>
    {user.pendingRequests > 0 && <p className="ai-costs-muted">Aguarde as chamadas em andamento para alterar ou resetar os limites.</p>}
    {disabled && <p className="ai-costs-muted">Você não pode alterar os limites desta conta.</p>}
    <Button size="sm" disabled={blocked} onClick={() => setResetOpen(!resetOpen)}>Resetar saldo</Button>
    {resetOpen && <form className="ai-costs-reset" aria-label="Confirmar reset de saldo" onSubmit={e => { e.preventDefault(); onReset(restart, reason); }}><h3>Renovar saldo de {user.name}</h3><p>O histórico de chamadas e custos será preservado. O saldo é renovado no instante da confirmação, usando os limites salvos.</p><label>Calendário após o reset<select value={restart ? "restart" : "keep"} onChange={e => setRestart(e.target.value === "restart")} disabled={blocked}><option value="restart">Novo ciclo começando hoje</option><option value="keep" disabled={user.cycle?.active === false}>Manter a próxima data de renovação</option></select></label><label>Motivo do reset (opcional)<input maxLength={500} value={reason} onChange={e => setReason(e.target.value)} disabled={blocked} /></label><Button size="sm" type="submit" variant="primary" disabled={blocked}>Confirmar reset</Button><Button size="sm" disabled={saving} onClick={() => setResetOpen(false)}>Cancelar</Button></form>}
    </div><div className="ai-costs-balance"><span>Saldo disponível no ciclo atual</span><strong>{user.remainingUsd == null ? "Sem limite em USD" : money(user.remainingUsd)}</strong><span>{user.remainingTokens == null ? "Sem limite de tokens" : `${number(user.remainingTokens)} tokens restantes`}</span>
      {user.cycle && <><span>{user.limits.period === "weekly" ? "Semanal" : "Mensal"} · {({ active: "Ativo", scheduled: "Aguardando início", expired: "Encerrado" } as Record<string, string>)[user.cycle.status]}</span><small>Contagem: {date(user.cycle.startAt)}<br />Encerra: {date(user.cycle.endAt)}<br />{user.cycle.nextResetAt ? `Renova automaticamente: ${date(user.cycle.nextResetAt)}` : "Renovação manual"}</small></>}
      {user.limits.resetAt && <small>Último reset: {date(user.limits.resetAt)}</small>}<progress aria-label="Orçamento do ciclo utilizado" max="100" value={usedPercent} /><small>{money(current.costUsd)} consumidos · {number(current.totalTokens)} tokens{user.pendingRequests ? ` · ${user.pendingRequests} chamadas em andamento` : ""}{current.unpricedRequests ? " · saldo parcial: falta cadastrar tarifa" : ""}</small></div></div>;
}
