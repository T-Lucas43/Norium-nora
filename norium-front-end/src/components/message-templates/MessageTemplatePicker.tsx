import { useEffect, useMemo, useState } from "react";
import { FileText, Loader2, X } from "lucide-react";
import Button from "../shared/Button";
import { messageTemplatesApi, type MessageChannel, type MessageTemplate } from "../../features/message-templates/api";

const variableLabels: Record<string, string> = {
  client_name: "Nome do cliente",
  company_name: "Empresa",
  sender_name: "Seu nome",
  service_name: "Serviço",
  professional_name: "Profissional",
  date: "Data",
  time: "Horário",
  next_step: "Próximo passo",
};

function variablesFrom(template?: MessageTemplate) {
  const text = `${template?.subject || ""}\n${template?.body || ""}`;
  return Array.from(new Set(Array.from(text.matchAll(/\{\{([a-z_]+)\}\}/g), (match) => match[1])));
}

export default function MessageTemplatePicker({ channel, clientName = "", onApply }: {
  channel: MessageChannel;
  clientName?: string;
  onApply: (value: { subject: string; body: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({ client_name: clientName });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const selected = useMemo(() => templates.find((item) => item.id === selectedId), [selectedId, templates]);
  const requiredVariables = useMemo(() => variablesFrom(selected), [selected]);

  useEffect(() => { setVariables((current) => ({ ...current, client_name: clientName || current.client_name || "" })); }, [clientName]);

  async function show() {
    setOpen(true);
    if (templates.length) return;
    setLoading(true); setError("");
    try {
      const result = await messageTemplatesApi.list(channel);
      setTemplates(result.templates);
      setSelectedId(result.templates[0]?.id || "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível carregar os modelos."); }
    finally { setLoading(false); }
  }

  async function apply() {
    if (!selectedId) return;
    setLoading(true); setError("");
    try {
      const rendered = await messageTemplatesApi.render(selectedId, variables);
      onApply(rendered);
      setOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível aplicar o modelo."); }
    finally { setLoading(false); }
  }

  return <div className="relative">
    <Button size="sm" onClick={() => void show()}><FileText size={15}/> Modelo</Button>
    {open && <section className="absolute bottom-[calc(100%+8px)] left-0 z-[90] w-[min(430px,calc(100vw-32px))] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-[var(--text)] shadow-2xl" aria-label="Selecionar modelo de mensagem">
      <div className="mb-3 flex items-center justify-between"><div><strong className="text-sm">Modelo de {channel === "email" ? "e-mail" : "WhatsApp"}</strong><p className="text-[11px] text-[var(--text-secondary)]">Personalize os campos antes de inserir.</p></div><button type="button" onClick={() => setOpen(false)} aria-label="Fechar modelos" className="rounded-lg p-2 hover:bg-[var(--surface-hover)]"><X size={16}/></button></div>
      {loading && !templates.length ? <p className="flex items-center gap-2 text-xs"><Loader2 className="animate-spin" size={14}/> Carregando…</p> : <div className="grid gap-3">
        <label className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">Modelo<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)]">{templates.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.category}</option>)}</select></label>
        {requiredVariables.map((key) => <label key={key} className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">{variableLabels[key] || key}<input value={variables[key] || ""} onChange={(event) => setVariables((current) => ({ ...current, [key]: event.target.value }))} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)]"/></label>)}
        {selected && <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-xs leading-5 text-[var(--text-secondary)]">{selected.body}</div>}
        {error && <p role="alert" className="text-xs font-bold text-rose-400">{error}</p>}
        <Button variant="primary" onClick={() => void apply()} disabled={loading || !selectedId}>{loading ? "Aplicando…" : "Inserir na mensagem"}</Button>
      </div>}
    </section>}
  </div>;
}
