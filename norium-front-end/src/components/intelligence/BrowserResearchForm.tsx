import { useState, type FormEvent } from "react";
import { BookOpen, FileText, LayoutTemplate, ListChecks, Settings2, Sparkles } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import Button from "../shared/Button";

export type ResearchSettings = { id?: string; objective: string; startUrl: string; taskType?: string; scope?: string; maxPages?: number; reportTitle?: string; timeoutSeconds?: number; executionMode?: string; profileId?: string | null };
export const researchTypes = [
  { id: "summary", label: "Resumo", icon: FileText, hint: "Pontos principais, temas e conclusões", prompt: "Leia o site e prepare um resumo organizado com os principais temas, informações relevantes e conclusões." },
  { id: "academic", label: "Acadêmico", icon: BookOpen, hint: "Síntese, discussão e referências", prompt: "Produza um resumo acadêmico com tema, objetivo, metodologia da consulta, síntese, discussão crítica e conclusão. Diferencie as afirmações do site das evidências disponíveis." },
  { id: "layout", label: "Layout", icon: LayoutTemplate, hint: "Cores, tipografia e experiência", prompt: "Analise o layout e a experiência do site: hierarquia, navegação, cores, tipografia, componentes e comportamento no desktop e celular. Separe observações e sugestões de melhoria." },
  { id: "custom", label: "Personalizado", icon: Settings2, hint: "Defina exatamente o que precisa", prompt: "Leia o site e prepare um relatório sobre " },
];

export default function BrowserResearchForm({ initial, profiles, onPlanned, onCancel }: {
  initial?: ResearchSettings | null; profiles: Array<{ id: string; name?: string }>; onPlanned: (id: string) => void; onCancel?: () => void;
}) {
  const [form, setForm] = useState({ taskType: initial?.taskType || "summary", objective: initial?.objective || researchTypes[0].prompt, startUrl: initial?.startUrl || "", scope: initial?.scope || "site", maxPages: initial?.maxPages || 10, reportTitle: initial?.reportTitle || "", timeoutSeconds: initial?.timeoutSeconds || 600, executionMode: initial?.executionMode || "automatic", profileId: initial?.profileId || "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await apiRequest<{ item: { id: string } }>(initial?.id ? `/api/navegador/runs/${initial.id}/research-plan` : "/api/navegador/runs/plan", { method: initial?.id ? "PUT" : "POST", body: JSON.stringify({ ...form, profileId: form.profileId || null, maxSteps: 20, expectedResult: "summary", actions: [], useAiPlanner: false }) });
      onPlanned(response.item.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível preparar o plano."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={(event) => void submit(event)} className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
    <div><h2 className="font-semibold">{initial?.id ? "Editar pedido" : "O que vamos pesquisar?"}</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">Escolha o resultado e revise o plano antes de começar.</p></div>
    <div className="grid grid-cols-2 gap-2">{researchTypes.map(({ id, label, icon: Icon, hint, prompt }) => <button key={id} type="button" aria-pressed={form.taskType === id} title={hint} onClick={() => setForm({ ...form, taskType: id, objective: prompt })} className={`rounded-lg border p-3 text-left ${form.taskType === id ? "border-[var(--text-secondary)] bg-[var(--surface-hover)]" : "border-[var(--border)]"}`}><Icon size={17} className="mb-2 text-[var(--text-secondary)]" /><span className="text-sm font-medium">{label}</span></button>)}</div>
    <label className="block text-xs font-medium">Endereço do site<input required type="url" maxLength={2000} value={form.startUrl} onChange={(event) => setForm({ ...form, startUrl: event.target.value })} placeholder="https://exemplo.com" className="intelligence-field mt-2" /></label>
    <label className="block text-xs font-medium">Instruções para a Nora<textarea required minLength={4} maxLength={2000} rows={5} value={form.objective} onChange={(event) => setForm({ ...form, objective: event.target.value })} className="intelligence-field mt-2 resize-y py-3" /></label>
    <label className="block text-xs font-medium">Título do relatório<input maxLength={200} value={form.reportTitle} onChange={(event) => setForm({ ...form, reportTitle: event.target.value })} placeholder="Gerado a partir da pesquisa" className="intelligence-field mt-2" /></label>
    <div className="grid grid-cols-2 gap-3"><label className="text-xs font-medium">Escopo<select value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })} className="intelligence-field mt-2"><option value="site">Percorrer o site</option><option value="page">Só esta página</option></select></label><label className="text-xs font-medium">Limite de páginas<input type="number" min={1} max={50} disabled={form.scope === "page"} value={form.maxPages} onChange={(event) => setForm({ ...form, maxPages: Number(event.target.value) })} className="intelligence-field mt-2" /></label></div>
    <details className="rounded-lg border border-[var(--border)] p-3"><summary className="cursor-pointer text-xs font-medium">Opções de execução</summary><div className="mt-3 space-y-3"><label className="block text-xs">Perfil de acesso<select className="intelligence-field mt-1" value={form.profileId} onChange={(event) => setForm({ ...form, profileId: event.target.value })}><option value="">Consulta pública</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label className="block text-xs">Tempo máximo (segundos)<input type="number" min={60} max={900} value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: Number(event.target.value) })} className="intelligence-field mt-1" /></label><label className="block text-xs">Acompanhamento<select value={form.executionMode} onChange={(event) => setForm({ ...form, executionMode: event.target.value })} className="intelligence-field mt-1"><option value="automatic">Contínuo, com pausar e cancelar</option><option value="assisted">Confirmar após abrir o site</option></select></label></div></details>
    <p className="flex gap-2 text-xs leading-5 text-[var(--text-secondary)]"><Sparkles size={15} className="mt-1 shrink-0 text-amber-400" />A Nora resume o conteúdo acessível. O relatório informa as páginas lidas, os limites encontrados e os links das fontes.</p>
    {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
    <div className="flex gap-2"><Button type="submit" disabled={busy}><ListChecks size={16} />{busy ? "Preparando…" : initial?.id ? "Salvar pedido" : "Preparar pesquisa"}</Button>{onCancel && <Button onClick={onCancel}>Cancelar edição</Button>}</div>
  </form>;
}
