import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  Box,
  BrainCircuit,
  CheckCircle2,
  CircleDollarSign,
  ExternalLink,
  Gauge,
  LibraryBig,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  Trash2,
  UploadCloud,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { apiRequest } from "../../core/api/client";
import Button from "../shared/Button";
import { showConfirm } from "../shared/AppDialogProvider";
import BrowserAgentDashboard from "./BrowserAgentDashboard";
import MarketplaceDashboardV2 from "./MarketplaceDashboardV2";
import ModelsDashboardV2 from "./ModelsDashboardV2";
import "../../styles/screens/inteligencia-equipe-conta.css";

type Mode = "browser" | "knowledge" | "marketplace" | "models";
type GenericItem = Record<string, unknown> & { id: string; name?: string; title?: string; status?: string };

type KnowledgeOverview = { bases: GenericItem[]; sources: GenericItem[] };
type KnowledgeResult = {
  score: number;
  baseName: string;
  sourceTitle: string;
  sourceUrl?: string;
  quote: string;
  stale: boolean;
};
type CatalogItem = GenericItem & {
  type: string;
  description: string;
  version: string;
  author: string;
  verified: boolean;
  permissions: string[];
  dependencies: string[];
  category: string;
};
type MarketplaceOverview = { catalog: CatalogItem[]; installations: GenericItem[] };
type Provider = GenericItem & {
  provider: string;
  model: string;
  enabled: boolean;
  configured: boolean;
  capabilities: string[];
  dataPolicy: string;
  managed?: boolean;
};
type ModelsOverview = {
  providers: Provider[];
  policies: GenericItem[];
  usage: { requests: number; inputTokens: number; outputTokens: number; estimatedCost: number };
};

function api<T>(path: string, init?: RequestInit) {
  return apiRequest<T>(path, init);
}

function StatusPill({ status }: { status: string }) {
  const style = status === "completed" || status === "indexed" || status === "installed" || status === "ready"
    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
    : status === "failed" || status === "rejected" || status === "removed" || status === "cancelled"
      ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
      : status === "awaiting_approval" || status === "paused" || status === "stale"
        ? "border-amber-400/30 bg-amber-400/10 text-amber-100"
        : "border-cyan-400/30 bg-cyan-400/10 text-cyan-100";
  const labels: Record<string, string> = {
    completed: "Concluído", indexed: "Indexado", installed: "Instalado", ready: "Pronto",
    failed: "Falhou", rejected: "Rejeitado", removed: "Removido", cancelled: "Cancelado",
    awaiting_approval: "Aguardando aprovação", paused: "Pausado", stale: "Desatualizada", running: "Executando",
    queued: "Na fila", planned: "Planejado",
  };
  const tone = style.includes("emerald") ? "is-green" : style.includes("rose") ? "is-red" : style.includes("amber") ? "is-amber" : "is-blue";
  return <span className={`nx-badge ${tone}`}>{labels[status] || status}</span>;
}

function Hero({ icon: Icon, eyebrow, title, description, actions }: { icon: LucideIcon; eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="overflow-hidden rounded-2xl border border-[var(--dashboard-panel-border)] bg-[var(--dashboard-hero-bg)] p-5 shadow-[var(--dashboard-panel-shadow)] sm:p-7">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-cyan-400/14 text-cyan-100"><Icon size={26} /></span>
          <div className="min-w-0">
            <span className="inline-flex rounded-full border border-white/15 bg-white/8 px-3 py-1 text-xs font-black uppercase tracking-[.12em]">{eyebrow}</span>
            <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-4xl">{title}</h1>
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-[var(--text-secondary)]">{description}</p>
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}

function Metric({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string | number; detail: string }) {
  return (
    <article data-metric-tone="blue" className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--glass-shadow)]">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-500/14 text-cyan-200"><Icon size={18} /></span>
      <p className="mt-3 text-xs font-black uppercase tracking-[.12em] text-[var(--text-secondary)]">{label}</p>
      <strong className="metric-value mt-1 block text-2xl font-black">{value}</strong>
      <small className="mt-1 block font-semibold text-[var(--text-secondary)]">{detail}</small>
    </article>
  );
}

function Notice({ tone = "info", children }: { tone?: "info" | "error" | "success"; children: ReactNode }) {
  const style = tone === "error" ? "border-rose-400/30 bg-rose-400/10 text-rose-100" : tone === "success" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100" : "border-cyan-400/30 bg-cyan-400/10 text-cyan-50";
  return <div role="status" className={`rounded-xl border px-4 py-3 text-sm font-bold ${style}`}>{children}</div>;
}

function BrowserDashboard({ onOpenNora }: { onOpenNora: (prompt?: string) => void }) {
  return <BrowserAgentDashboard onOpenNora={onOpenNora} />;
}

function KnowledgeDashboard({ onOpenNora }: { onOpenNora: (prompt?: string) => void }) {
  const [data, setData] = useState<KnowledgeOverview>({ bases: [], sources: [] });
  const [baseId, setBaseId] = useState("");
  const [baseName, setBaseName] = useState("");
  const [sourceKind, setSourceKind] = useState<"text" | "url">("text");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceContent, setSourceContent] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [baseFormOpen, setBaseFormOpen] = useState(false);
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => { try { const response = await api<KnowledgeOverview>("/api/conhecimento"); setData(response); setBaseId((current) => current || response.bases[0]?.id || ""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao carregar bases."); } }, []);
  useEffect(() => { void load(); }, [load]);

  async function createBase(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const response = await api<{ item: GenericItem }>("/api/conhecimento/bases", { method: "POST", body: JSON.stringify({ name: baseName, description: "Base criada no Knowledge Center do Norium", visibility: "workspace", tags: [] }) }); setBaseId(response.item.id); setBaseName(""); setBaseFormOpen(false); setMessage("Base criada e pronta para receber fontes."); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao criar a base."); } finally { setBusy(false); } }
  async function addSource(event: FormEvent) { event.preventDefault(); if (!baseId) return; setBusy(true); setError(""); try { await api(`/api/conhecimento/bases/${baseId}/sources`, { method: "POST", body: JSON.stringify({ kind: sourceKind, title: sourceTitle, content: sourceKind === "text" ? sourceContent : "", url: sourceKind === "url" ? sourceContent : "", tags: [] }) }); setSourceTitle(""); setSourceContent(""); setMessage("Fonte indexada com controle de duplicidade."); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao indexar a fonte."); } finally { setBusy(false); } }
  async function search(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const response = await api<{ results: KnowledgeResult[] }>("/api/conhecimento/search", { method: "POST", body: JSON.stringify({ query, baseIds: baseId ? [baseId] : [], limit: 8 }) }); setResults(response.results); setMessage(response.results.length ? `${response.results.length} trecho(s) encontrado(s) com fonte.` : "Nenhum trecho autorizado corresponde à consulta."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha na busca."); } finally { setBusy(false); } }
  async function deleteBase() {
    const base = data.bases.find((item) => item.id === baseId);
    if (!base) return;
    const confirmed = await showConfirm({ title: "Excluir base de conhecimento?", description: `A base “${String(base.name)}” e suas fontes serão removidas.`, confirmLabel: "Excluir base", tone: "danger" });
    if (!confirmed) return;
    setBusy(true); setError("");
    try { await api(`/api/conhecimento/bases/${baseId}`, { method: "DELETE" }); setBaseId(""); setResults([]); setMessage("Base e fontes removidas."); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao excluir a base."); }
    finally { setBusy(false); }
  }
  async function sourceAction(sourceId: string, action: "reindex" | "stale" | "delete") {
    setBusy(true); setError("");
    try {
      if (action === "delete") {
        const confirmed = await showConfirm({ title: "Excluir fonte?", description: "Os trechos indexados desta fonte serão removidos da busca.", confirmLabel: "Excluir fonte", tone: "danger" });
        if (!confirmed) return;
        await api(`/api/conhecimento/sources/${sourceId}`, { method: "DELETE" });
      } else {
        await api(`/api/conhecimento/sources/${sourceId}/${action}`, { method: "POST" });
      }
      setMessage(action === "reindex" ? "Fonte reindexada." : action === "stale" ? "Fonte marcada como desatualizada." : "Fonte excluída.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "A ação sobre a fonte falhou."); }
    finally { setBusy(false); }
  }

  const baseSources = data.sources.filter((source) => source.baseId === baseId);
  const normalizedFilter = sourceFilter.trim().toLocaleLowerCase("pt-BR");
  const visibleSources = normalizedFilter ? baseSources.filter((source) => `${String(source.title || "")} ${String(source.kind || "")}`.toLocaleLowerCase("pt-BR").includes(normalizedFilter)) : baseSources;
  const totalChunks = data.sources.reduce((sum, item) => sum + Number(item.chunkCount || 0), 0);
  const failedSources = data.sources.filter((item) => ["failed", "rejected"].includes(String(item.status || ""))).length;
  const healthySources = data.sources.filter((item) => !item.stale && ["indexed", "ready", "completed", ""].includes(String(item.status || ""))).length;
  const health = data.sources.length ? Math.round((healthySources / data.sources.length) * 100) : 0;
  const showBaseForm = baseFormOpen || !data.bases.length;
  const selectedBase = data.bases.find((item) => item.id === baseId);

  return <main className="nx-page nxi-screen">
    <header className="nx-ph">
      <div><h1>Conhecimento</h1><p>O que a Nora sabe: bases, fontes e trechos indexados</p></div>
      <div className="nx-ph-actions">
        <button type="button" className="nx-btn" onClick={() => onOpenNora("Consulte a base de conhecimento sobre ")}><Bot size={16} /> Consultar com Nora</button>
        <button type="button" className="nx-btn" onClick={() => { searchInputRef.current?.focus(); searchInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }}><Search size={16} /> Buscar com fontes</button>
        <button type="button" className="nx-btn is-primary" aria-expanded={showBaseForm} onClick={() => setBaseFormOpen((value) => !value)}><Plus size={16} /> Nova base</button>
      </div>
    </header>
    {error && <div role="status" className="nxi-alert is-error">{error}</div>}{message && <div role="status" className="nxi-alert is-success">{message}</div>}
    {showBaseForm && <form onSubmit={createBase} className="nx-card nxi-card-pad is-sm"><div className="nxi-actions"><div className="nx-grow"><h2 className="nxi-card-title">Nova base</h2><p className="nxi-card-sub">Cada base é um escopo independente, com permissão verificada antes de cada busca.</p></div></div><div className="nxi-actions" style={{ marginTop: 12 }}><input required minLength={2} value={baseName} onChange={(event) => setBaseName(event.target.value)} placeholder="Ex.: Políticas internas" aria-label="Nome da nova base" className="nxi-field" style={{ flex: 1, width: "auto", minWidth: 180 }} /><button type="submit" className="nx-btn is-primary" disabled={busy} aria-label="Criar base"><Plus size={16} /> Criar base</button></div></form>}
    <section className="nxi-split">
      <div className="nx-card" style={{ overflow: "hidden" }}>
        <div className="nxi-toolbar" style={{ alignItems: "flex-start" }}>
          <div className="nxi-chips" aria-label="Bases disponíveis" style={{ flex: "1 1 100%" }}>
            {data.bases.map((base) => <button key={base.id} type="button" onClick={() => setBaseId(base.id)} aria-pressed={baseId === base.id} className={`nxi-chip ${baseId === base.id ? "is-active" : ""}`} title={`${Number(base.sourceCount || 0)} fonte(s) · ${String(base.visibility || "workspace")}`}>{String(base.name)}<span className="nx-faint">{Number(base.sourceCount || 0)}</span></button>)}
            {!data.bases.length && <span className="nx-faint nx-small">Crie a primeira base.</span>}
            {baseId && <button type="button" className="nxi-icon-btn is-danger" style={{ marginLeft: "auto" }} onClick={() => void deleteBase()} disabled={busy} aria-label="Excluir base selecionada" title="Excluir base selecionada"><Trash2 size={14} /></button>}
          </div>
          <label className="nxi-search" style={{ flex: 1, minWidth: 180 }}><Search size={16} /><input value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} placeholder="Buscar na base" aria-label="Buscar fontes na base selecionada" /></label>
          <button type="button" className="nx-btn is-primary" aria-expanded={sourceFormOpen} disabled={!baseId} onClick={() => setSourceFormOpen((value) => !value)}><UploadCloud size={16} /> Adicionar fonte</button>
        </div>
        {sourceFormOpen && <form onSubmit={addSource} className="nxi-toolbar" style={{ display: "grid", gap: 12, background: "var(--nx-surface-2)" }}>
          <div className="nxi-actions"><div className="nx-grow"><h2 className="nxi-card-title">Adicionar fonte{selectedBase ? ` em ${String(selectedBase.name)}` : ""}</h2><p className="nxi-card-sub">URLs passam pela mesma proteção contra redes privadas.</p></div><select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as "text" | "url")} aria-label="Tipo da fonte" className="nxi-field" style={{ width: 180 }}><option value="text">Texto colado</option><option value="url">Página web</option></select></div>
          <input required minLength={2} value={sourceTitle} onChange={(event) => setSourceTitle(event.target.value)} placeholder="Título da fonte" aria-label="Título da fonte" className="nxi-field" />
          {sourceKind === "text" ? <textarea required minLength={2} value={sourceContent} onChange={(event) => setSourceContent(event.target.value)} rows={6} placeholder="Cole aqui o conteúdo autorizado..." aria-label="Conteúdo da fonte" className="nxi-field" /> : <input required type="url" value={sourceContent} onChange={(event) => setSourceContent(event.target.value)} placeholder="https://empresa.com/politica" aria-label="Endereço da página" className="nxi-field" />}
          <div className="nxi-actions is-end"><button type="button" className="nx-btn" onClick={() => setSourceFormOpen(false)}>Fechar</button><button type="submit" className="nx-btn is-primary" disabled={busy || !baseId}><UploadCloud size={16} /> Indexar fonte</button></div>
        </form>}
        <div className="nxi-table-wrap"><table className="nx-table"><thead><tr><th>Fonte</th><th>Tipo</th><th>Trechos</th><th>Atualizado</th><th>Status</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>
          {visibleSources.map((source) => <tr key={source.id}><td style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{String(source.title)}</td><td className="nx-muted">{sourceKindLabel(source.kind)}</td><td className="nx-muted">{Number(source.chunkCount || 0) || "—"}</td><td className="nx-muted">{displayDate(source.updatedAt || source.indexedAt || source.createdAt)}</td><td><StatusPill status={String(source.stale ? "stale" : source.status || "indexed")} /></td><td><div className="nxi-actions" style={{ flexWrap: "nowrap", justifyContent: "flex-end" }}><button type="button" className="nx-btn is-sm" disabled={busy} onClick={() => void sourceAction(source.id, "reindex")}><RefreshCw size={13} /> Reindexar</button><button type="button" className="nxi-icon-btn" disabled={busy} onClick={() => void sourceAction(source.id, "stale")} aria-label="Marcar fonte desatualizada" title="Marcar fonte desatualizada"><AlertTriangle size={13} /></button><button type="button" className="nxi-icon-btn is-danger" disabled={busy} onClick={() => void sourceAction(source.id, "delete")} aria-label="Excluir fonte" title="Excluir fonte"><Trash2 size={13} /></button></div></td></tr>)}
        </tbody></table></div>
        {!visibleSources.length && <p className="nxi-empty">{baseSources.length ? "Nenhuma fonte corresponde à busca." : data.bases.length ? "Nenhuma fonte nesta base." : "Crie a primeira base para adicionar fontes."}</p>}
      </div>
      <div className="nxi-stack">
        <section className="nx-card nxi-card-pad is-sm">
          <h2 className="nxi-card-title">Saúde da base</h2>
          <div style={{ marginTop: 10, fontSize: 26, fontWeight: 600 }}>{totalChunks.toLocaleString("pt-BR")} {totalChunks === 1 ? "trecho" : "trechos"}</div>
          <div className="nx-faint nx-small">em {data.sources.length} {data.sources.length === 1 ? "fonte" : "fontes"} · {data.bases.length} {data.bases.length === 1 ? "base" : "bases"}{failedSources ? ` · ${failedSources} com erro` : ""}</div>
          <div className="nx-bar" style={{ marginTop: 12 }} role="progressbar" aria-label="Fontes indexadas e atualizadas" aria-valuenow={health} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${health}%` }} /></div>
          <div className="nx-faint nx-small" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}><ShieldCheck size={13} /> Permissão verificada antes de cada busca</div>
        </section>
        <form onSubmit={search} className="nx-card nxi-card-pad is-sm">
          <h2 className="nxi-card-title">Teste a Nora</h2>
          <p className="nx-muted nx-small" style={{ margin: "4px 0 0" }}>Pergunte algo e veja os trechos e as fontes de onde vem a resposta.</p>
          <div className="nxi-actions" style={{ marginTop: 12, flexWrap: "nowrap" }}><label className="nxi-search" style={{ flex: 1 }}><Search size={16} /><input ref={searchInputRef} required minLength={2} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="O que a empresa definiu sobre..." aria-label="Pergunta para buscar com fontes" /></label><button type="submit" className="nx-btn is-primary" disabled={busy}><Search size={15} /> Buscar</button></div>
          {!!results.length && <div className="nxi-stack is-sm" style={{ marginTop: 14 }}>{results.map((result, index) => <article key={`${result.sourceTitle}-${index}`} style={{ borderTop: index ? "1px solid var(--nx-border)" : 0, paddingTop: index ? 12 : 0 }}><blockquote className="nx-muted nx-small" style={{ margin: 0, lineHeight: 1.5 }}>“{result.quote}”</blockquote><div className="nx-faint nx-small" style={{ marginTop: 6, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}><span>Fonte: {result.sourceTitle} · {result.baseName} · relevância {result.score}</span>{result.stale && <span className="nx-badge is-amber">Desatualizada</span>}{result.sourceUrl && <a href={result.sourceUrl} target="_blank" rel="noreferrer" className="nxi-link" style={{ fontSize: 12.5 }}>Abrir fonte <ExternalLink size={12} /></a>}</div></article>)}</div>}
        </form>
      </div>
    </section>
  </main>;
}

function sourceKindLabel(kind: unknown) {
  const value = String(kind || "");
  return ({ text: "Texto", url: "Página", pdf: "PDF", docx: "DOCX" } as Record<string, string>)[value] || value || "—";
}

function displayDate(value: unknown) {
  if (!value) return "—";
  const parsed = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : String(value));
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString("pt-BR");
}

export function MarketplaceDashboardLegacy() {
  const [data, setData] = useState<MarketplaceOverview>({ catalog: [], installations: [] });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setData(await api<MarketplaceOverview>("/api/marketplace")); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao carregar o marketplace."); } }, []);
  useEffect(() => { void load(); }, [load]);
  const visible = useMemo(() => data.catalog.filter((item) => `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(query.toLowerCase())), [data.catalog, query]);
  const selected = data.catalog.find((item) => item.id === selectedId) || null;
  const installed = (catalogId: string) => data.installations.find((item) => item.catalogId === catalogId && item.status === "installed");
  async function install(item: CatalogItem) { setBusy(true); setError(""); try { await api(`/api/marketplace/${item.id}/install`, { method: "POST", body: JSON.stringify({ confirm: confirmed, version: item.version }) }); setMessage(`${item.name} instalado desativado para revisão segura.`); setConfirmed(false); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha na instalação."); } finally { setBusy(false); } }
  async function uninstall(installationId: string) { setBusy(true); setError(""); try { await api(`/api/marketplace/installations/${installationId}`, { method: "DELETE" }); setMessage("Instalação removida. Histórico e recursos foram preservados desativados."); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao remover."); } finally { setBusy(false); } }
  return <main className="mx-auto w-full max-w-[1720px] space-y-5 p-4 text-[var(--text)] sm:p-6"><Hero icon={Store} eyebrow="Catálogo governado" title="Marketplace interno" description="Descubra agentes, automações, modelos e pacotes versionados. Toda instalação mostra permissões, dependências e nasce desativada para revisão." />
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={Store} label="Catálogo" value={data.catalog.length} detail="Componentes verificados" /><Metric icon={Box} label="Instalados" value={data.installations.filter((item) => item.status === "installed").length} detail="Recursos em uso ou revisão" /><Metric icon={ShieldCheck} label="Verificados" value={data.catalog.filter((item) => item.verified).length} detail="Autor e permissões conhecidos" /><Metric icon={RefreshCw} label="Atualizações" value={data.installations.filter((item) => item.status === "installed" && data.catalog.find((catalog) => catalog.id === item.catalogId)?.version !== item.version).length} detail="Versões preservam configuração" /></section>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <label className="flex h-12 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4"><Search size={17} className="text-[var(--text-secondary)]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar agentes, automações, modelos ou pacotes..." className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none" /></label>
    <section className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">{visible.map((item) => { const installation = installed(item.id); return <article key={item.id} className="flex min-h-72 flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--glass-shadow)]"><div className="flex items-start justify-between gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-blue-500/14 text-cyan-200">{item.type === "agent" ? <Bot size={20} /> : item.type === "automation" ? <Zap size={20} /> : item.type === "template" ? <LibraryBig size={20} /> : <Box size={20} />}</span>{item.verified && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-2 py-1 text-xs font-black text-emerald-200"><ShieldCheck size={12} /> Verificado</span>}</div><p className="mt-4 text-xs font-black uppercase tracking-wide text-cyan-200">{item.category} • v{item.version}</p><h2 className="mt-2 text-lg font-black">{item.name}</h2><p className="mt-2 flex-1 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{item.description}</p><div className="mt-4 flex gap-2">{installation ? <><Button className="flex-1" disabled><CheckCircle2 size={15} /> Instalado</Button><Button variant="danger" iconOnly disabled={busy} onClick={() => void uninstall(installation.id)} aria-label={`Remover ${item.name}`}><Trash2 size={15} /></Button></> : <Button variant="primary" className="flex-1" onClick={() => { setSelectedId(item.id); setConfirmed(false); }}><Plus size={15} /> Ver e instalar</Button>}</div></article>; })}</section>
    {selected && <div className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={`Instalar ${selected.name}`}><section className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-wide text-cyan-200">{selected.type} • v{selected.version}</p><h2 className="mt-2 text-2xl font-black">{selected.name}</h2><p className="mt-2 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{selected.description}</p></div><Button iconOnly variant="ghost" onClick={() => setSelectedId(null)} aria-label="Fechar"><XCircle size={18} /></Button></div><div className="mt-5 grid gap-4 sm:grid-cols-2"><section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><h3 className="font-black">Permissões</h3><ul className="mt-3 space-y-2 text-sm font-semibold text-[var(--text-secondary)]">{selected.permissions.map((item) => <li key={item}>• {item}</li>)}</ul></section><section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><h3 className="font-black">Dependências</h3><ul className="mt-3 space-y-2 text-sm font-semibold text-[var(--text-secondary)]">{selected.dependencies.map((item) => <li key={item}>• {item}</li>)}</ul></section></div><Notice>O recurso será criado desativado. A remoção preserva histórico e configurações desativadas.</Notice><label className="mt-5 flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-4 text-sm font-bold"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" /> Li as permissões, dependências e confirmo esta instalação.</label><div className="mt-5 flex justify-end gap-2"><Button onClick={() => setSelectedId(null)}>Cancelar</Button><Button variant="primary" disabled={!confirmed || busy} onClick={() => void install(selected)}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Instalar desativado</Button></div></section></div>}
  </main>;
}

export function ModelsDashboardLegacy() {
  const [data, setData] = useState<ModelsOverview>({ providers: [], policies: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 } });
  const [providerForm, setProviderForm] = useState({ name: "", provider: "openai-compatible", model: "", baseUrl: "", secret: "", enabled: false, capabilities: ["text"], contextWindow: 8192, inputCostPerMillion: 0, outputCostPerMillion: 0, dataPolicy: "external" });
  const [policyForm, setPolicyForm] = useState({ name: "Roteamento principal", mode: "automatic", preferredProviderId: "", maxInputCostPerMillion: "", privacy: "any" });
  const [routeResult, setRouteResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setData(await api<ModelsOverview>("/api/modelos-ia")); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao carregar modelos."); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function saveProvider(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await api("/api/modelos-ia/providers", { method: "POST", body: JSON.stringify(providerForm) }); setProviderForm({ ...providerForm, name: "", model: "", baseUrl: "", secret: "", enabled: false }); setMessage("Provedor salvo com segredo criptografado."); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao salvar provedor."); } finally { setBusy(false); } }
  async function savePolicy(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await api("/api/modelos-ia/policies", { method: "POST", body: JSON.stringify({ name: policyForm.name, mode: policyForm.mode, preferredProviderId: policyForm.preferredProviderId || null, fallbackProviderIds: [], requireCapabilities: ["text"], maxInputCostPerMillion: policyForm.maxInputCostPerMillion === "" ? null : Number(policyForm.maxInputCostPerMillion), privacy: policyForm.privacy, monthlyBudget: null, enabled: true }) }); setMessage("Política de roteamento salva."); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao salvar política."); } finally { setBusy(false); } }
  async function simulateRoute() { setBusy(true); setError(""); try { const result = await api<Record<string, unknown>>("/api/modelos-ia/route", { method: "POST", body: JSON.stringify({ policyId: data.policies[0]?.id || null, preferredProviderId: policyForm.preferredProviderId || null, requiredCapabilities: ["text"], estimatedInputTokens: 1000, estimatedOutputTokens: 500, privacy: policyForm.privacy, externalActionCommitted: false }) }); setRouteResult(result); setMessage("Rota calculada sem consumir tokens."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao calcular a rota."); } finally { setBusy(false); } }
  async function testProvider(providerId: string) { setBusy(true); setError(""); try { const result = await api<{ ok: boolean; detail: string }>(`/api/modelos-ia/providers/${providerId}/test`, { method: "POST", body: JSON.stringify({ timeoutSeconds: 10 }) }); setMessage(result.detail); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao testar provedor."); } finally { setBusy(false); } }
  const selectedRoute = routeResult?.selected as Provider | null | undefined;
  return <main className="mx-auto w-full max-w-[1720px] space-y-5 p-4 text-[var(--text)] sm:p-6"><Hero icon={Network} eyebrow="Gateway multi-modelo" title="IA e Modelos" description="Cadastre provedores por adaptadores, proteja chaves, defina políticas por capacidade, custo e privacidade e simule fallback antes de usar na Nora ou em automações." />
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={BrainCircuit} label="Provedores" value={data.providers.length} detail={`${data.providers.filter((item) => item.configured).length} configurado(s)`} /><Metric icon={Network} label="Políticas" value={data.policies.length} detail="Roteamento manual ou automático" /><Metric icon={Gauge} label="Requisições" value={data.usage.requests} detail={`${data.usage.inputTokens + data.usage.outputTokens} tokens medidos`} /><Metric icon={CircleDollarSign} label="Custo estimado" value={`US$ ${data.usage.estimatedCost.toFixed(4)}`} detail="Baseado no cadastro de preços" /></section>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <section className="grid gap-5 xl:grid-cols-2"><form onSubmit={saveProvider} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"><h2 className="text-lg font-black">Cadastrar provedor</h2><p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">A chave nunca volta pela API depois de salva.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><input required value={providerForm.name} onChange={(event) => setProviderForm({ ...providerForm, name: event.target.value })} placeholder="Nome interno" className="intelligence-field" /><select value={providerForm.provider} onChange={(event) => setProviderForm({ ...providerForm, provider: event.target.value })} className="intelligence-field"><option value="groq">Groq</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openai-compatible">OpenAI-compatible</option></select><input required value={providerForm.model} onChange={(event) => setProviderForm({ ...providerForm, model: event.target.value })} placeholder="ID do modelo" className="intelligence-field" /><input value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} placeholder="URL base (opcional nos oficiais)" className="intelligence-field" /><input required type="password" autoComplete="new-password" value={providerForm.secret} onChange={(event) => setProviderForm({ ...providerForm, secret: event.target.value })} placeholder="Chave secreta" className="intelligence-field sm:col-span-2" /><label className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold sm:col-span-2">Habilitar após salvar<input type="checkbox" checked={providerForm.enabled} onChange={(event) => setProviderForm({ ...providerForm, enabled: event.target.checked })} /></label><Button type="submit" variant="primary" disabled={busy} className="sm:col-span-2"><ShieldCheck size={16} /> Salvar credencial criptografada</Button></div></form>
      <form onSubmit={savePolicy} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"><h2 className="text-lg font-black">Política de roteamento</h2><p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">O fallback é bloqueado depois de uma ação externa já confirmada.</p><div className="mt-4 grid gap-3"><input required value={policyForm.name} onChange={(event) => setPolicyForm({ ...policyForm, name: event.target.value })} placeholder="Nome da política" className="intelligence-field" /><select value={policyForm.mode} onChange={(event) => setPolicyForm({ ...policyForm, mode: event.target.value })} className="intelligence-field"><option value="automatic">Seleção automática</option><option value="manual">Seleção manual</option></select><select value={policyForm.preferredProviderId} onChange={(event) => setPolicyForm({ ...policyForm, preferredProviderId: event.target.value })} className="intelligence-field"><option value="">Sem preferência</option>{data.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} / {provider.model}</option>)}</select><select value={policyForm.privacy} onChange={(event) => setPolicyForm({ ...policyForm, privacy: event.target.value })} className="intelligence-field"><option value="any">Privacidade: qualquer provedor permitido</option><option value="private">Somente privado ou local</option><option value="local">Somente local</option></select><input type="number" min="0" step="0.01" value={policyForm.maxInputCostPerMillion} onChange={(event) => setPolicyForm({ ...policyForm, maxInputCostPerMillion: event.target.value })} placeholder="Custo máximo de entrada por 1M tokens" className="intelligence-field" /><div className="grid gap-2 sm:grid-cols-2"><Button type="submit" variant="primary" disabled={busy}><Plus size={16} /> Salvar política</Button><Button type="button" disabled={busy} onClick={() => void simulateRoute()}><Gauge size={16} /> Simular rota</Button></div></div></form></section>
    {routeResult && <Notice tone={selectedRoute ? "success" : "error"}>{selectedRoute ? <>Selecionado: <strong>{selectedRoute.name} / {selectedRoute.model}</strong>. Custo estimado: US$ {Number(routeResult.estimatedCost || 0).toFixed(6)}. Fallback {routeResult.fallbackAllowed ? "permitido" : "bloqueado"}.</> : String(routeResult.reason || "Nenhum provedor atende à política.")}</Notice>}
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"><div className="flex items-center justify-between"><div><h2 className="text-lg font-black">Registro de modelos</h2><p className="text-sm font-semibold text-[var(--text-secondary)]">Disponíveis para seleção na Nora e no bloco “Executar IA com roteamento”.</p></div><Button iconOnly variant="ghost" onClick={() => void load()} aria-label="Atualizar"><RefreshCw size={16} /></Button></div><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{data.providers.map((provider) => <article key={provider.id} className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><div className="flex items-start justify-between gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-500/14 text-cyan-200"><BrainCircuit size={18} /></span><span className={`rounded-full px-2 py-1 text-xs font-black ${provider.enabled && provider.configured ? "bg-emerald-400/10 text-emerald-200" : "bg-amber-400/10 text-amber-100"}`}>{provider.enabled && provider.configured ? "Disponível" : "Configuração pendente"}</span></div><p className="mt-3 text-xs font-black uppercase tracking-wide text-cyan-200">{provider.provider} • {provider.dataPolicy}</p><h3 className="mt-1 font-black">{provider.name}</h3><p className="mt-1 break-all text-xs font-semibold text-[var(--text-secondary)]">{provider.model}</p><div className="mt-3 flex flex-wrap gap-1">{provider.capabilities.map((capability) => <span key={capability} className="rounded-full border border-[var(--border)] px-2 py-1 text-xs font-bold">{capability}</span>)}</div><Button className="mt-4 w-full" disabled={busy || (!provider.configured && !provider.managed)} onClick={() => void testProvider(provider.id)}><RefreshCw size={14} /> Testar configuração</Button></article>)}</div></section>
  </main>;
}

export default function IntelligenceHubDashboard({ mode, onOpenNora }: { mode: Mode; onOpenNora: (prompt?: string) => void }) {
  if (mode === "browser") return <BrowserDashboard onOpenNora={onOpenNora} />;
  if (mode === "knowledge") return <KnowledgeDashboard onOpenNora={onOpenNora} />;
  if (mode === "marketplace") return <MarketplaceDashboardV2 />;
  return <ModelsDashboardV2 />;
}
