import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${style}`}>{labels[status] || status}</span>;
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
  const load = useCallback(async () => { try { const response = await api<KnowledgeOverview>("/api/conhecimento"); setData(response); setBaseId((current) => current || response.bases[0]?.id || ""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao carregar bases."); } }, []);
  useEffect(() => { void load(); }, [load]);

  async function createBase(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const response = await api<{ item: GenericItem }>("/api/conhecimento/bases", { method: "POST", body: JSON.stringify({ name: baseName, description: "Base criada no Knowledge Center do Norium", visibility: "workspace", tags: [] }) }); setBaseId(response.item.id); setBaseName(""); setMessage("Base criada e pronta para receber fontes."); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao criar a base."); } finally { setBusy(false); } }
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

  return <main className="mx-auto w-full max-w-[1720px] space-y-5 p-4 text-[var(--text)] sm:p-6">
    <Hero icon={LibraryBig} eyebrow="Contexto empresarial" title="Conhecimento" description="Centralize textos e páginas públicas, indexe conteúdo real e consulte respostas com trechos citáveis e permissões por base." actions={<Button variant="primary" onClick={() => onOpenNora("Consulte a base de conhecimento sobre ")}><Bot size={16} /> Consultar com Nora</Button>} />
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={LibraryBig} label="Bases" value={data.bases.length} detail="Escopos independentes" /><Metric icon={UploadCloud} label="Fontes" value={data.sources.length} detail="Texto e páginas públicas" /><Metric icon={Box} label="Trechos" value={data.sources.reduce((sum, item) => sum + Number(item.chunkCount || 0), 0)} detail="Partes indexadas" /><Metric icon={ShieldCheck} label="Governança" value="Ativa" detail="Permissão antes da busca" /></section>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <section className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="space-y-4"><form onSubmit={createBase} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"><h2 className="font-black">Nova base</h2><div className="mt-3 flex gap-2"><input required minLength={2} value={baseName} onChange={(event) => setBaseName(event.target.value)} placeholder="Ex.: Políticas internas" className="intelligence-field min-w-0" /><Button type="submit" variant="primary" iconOnly disabled={busy} aria-label="Criar base"><Plus size={17} /></Button></div></form><div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="flex items-center justify-between gap-2"><h2 className="font-black">Bases disponíveis</h2>{baseId && <Button iconOnly variant="danger" onClick={() => void deleteBase()} disabled={busy} aria-label="Excluir base selecionada"><Trash2 size={14} /></Button>}</div><div className="mt-3 space-y-2">{data.bases.map((base) => <button key={base.id} onClick={() => setBaseId(base.id)} className={`w-full rounded-xl border p-3 text-left ${baseId === base.id ? "border-cyan-300/50 bg-cyan-400/8" : "border-[var(--border)] bg-[var(--background)]"}`}><strong className="block text-sm">{String(base.name)}</strong><span className="mt-1 block text-xs font-semibold text-[var(--text-secondary)]">{Number(base.sourceCount || 0)} fonte(s) • {String(base.visibility || "workspace")}</span></button>)}{!data.bases.length && <p className="py-5 text-center text-sm font-semibold text-[var(--text-secondary)]">Crie a primeira base.</p>}</div></div><div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"><h2 className="font-black">Fontes da base</h2><div className="mt-3 space-y-2">{data.sources.filter((source) => source.baseId === baseId).map((source) => <article key={source.id} className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><strong className="block truncate text-sm">{String(source.title)}</strong><span className="text-xs font-semibold text-[var(--text-secondary)]">{String(source.kind)} • {Number(source.chunkCount || 0)} trecho(s)</span></div><StatusPill status={String(source.stale ? "stale" : source.status || "indexed")} /></div><div className="mt-3 flex gap-1"><Button size="sm" className="flex-1" disabled={busy} onClick={() => void sourceAction(source.id, "reindex")}><RefreshCw size={13} /> Reindexar</Button><Button size="sm" iconOnly disabled={busy} onClick={() => void sourceAction(source.id, "stale")} aria-label="Marcar fonte desatualizada"><AlertTriangle size={13} /></Button><Button size="sm" iconOnly variant="danger" disabled={busy} onClick={() => void sourceAction(source.id, "delete")} aria-label="Excluir fonte"><Trash2 size={13} /></Button></div></article>)}{!data.sources.some((source) => source.baseId === baseId) && <p className="py-4 text-center text-xs font-semibold text-[var(--text-secondary)]">Nenhuma fonte nesta base.</p>}</div></div></aside>
      <div className="space-y-5"><form onSubmit={addSource} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-black">Adicionar fonte</h2><p className="text-sm font-semibold text-[var(--text-secondary)]">URLs passam pela mesma proteção contra redes privadas.</p></div><select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as "text" | "url")} className="intelligence-field sm:w-44"><option value="text">Texto colado</option><option value="url">Página web</option></select></div><div className="mt-4 grid gap-3"><input required minLength={2} value={sourceTitle} onChange={(event) => setSourceTitle(event.target.value)} placeholder="Título da fonte" className="intelligence-field" />{sourceKind === "text" ? <textarea required minLength={2} value={sourceContent} onChange={(event) => setSourceContent(event.target.value)} rows={7} placeholder="Cole aqui o conteúdo autorizado..." className="intelligence-field resize-y py-3" /> : <input required type="url" value={sourceContent} onChange={(event) => setSourceContent(event.target.value)} placeholder="https://empresa.com/politica" className="intelligence-field" />}<Button variant="primary" type="submit" disabled={busy || !baseId}><UploadCloud size={16} /> Indexar fonte</Button></div></form>
        <form onSubmit={search} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"><h2 className="text-lg font-black">Buscar com fontes</h2><div className="mt-3 flex flex-col gap-2 sm:flex-row"><label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3"><Search size={17} className="text-[var(--text-secondary)]" /><input required minLength={2} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="O que a empresa definiu sobre..." className="h-11 min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none" /></label><Button variant="primary" type="submit" disabled={busy}><Search size={16} /> Buscar</Button></div><div className="mt-4 grid gap-3 lg:grid-cols-2">{results.map((result, index) => <article key={`${result.sourceTitle}-${index}`} className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><div className="flex items-start justify-between gap-2"><div><strong className="text-sm">{result.sourceTitle}</strong><p className="mt-1 text-xs font-bold text-cyan-200">{result.baseName} • relevância {result.score}</p></div>{result.stale && <span className="rounded-full bg-amber-400/12 px-2 py-1 text-xs font-black text-amber-100">Desatualizada</span>}</div><blockquote className="mt-3 border-l-2 border-cyan-300/50 pl-3 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{result.quote}</blockquote>{result.sourceUrl && <a href={result.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs font-black text-cyan-200">Abrir fonte <ExternalLink size={12} /></a>}</article>)}</div></form>
      </div>
    </section>
  </main>;
}

function MarketplaceDashboard() {
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

function ModelsDashboard() {
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
  if (mode === "marketplace") return <MarketplaceDashboard />;
  return <ModelsDashboard />;
}
