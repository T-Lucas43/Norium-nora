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
    <Button size="sm" variant="ghost" className="h-[30px] px-2 font-medium text-[var(--nx-text-2)]" onClick={() => void show()} title="Inserir modelo de mensagem"><FileText size={15}/> Modelo</Button>
    {open && <section className="absolute bottom-[calc(100%+8px)] left-0 z-[90] w-[min(430px,calc(100vw-32px))] rounded-xl border border-[var(--nx-border)] bg-[var(--nx-surface)] p-4 text-[var(--nx-text)] shadow-[0_12px_32px_rgba(16,24,40,.14)]" aria-label="Selecionar modelo de mensagem">
      <div className="mb-3 flex items-center justify-between"><div><strong className="text-sm font-semibold">Modelo de {channel === "email" ? "e-mail" : "WhatsApp"}</strong><p className="text-xs text-[var(--nx-text-2)]">Personalize os campos antes de inserir.</p></div><button type="button" onClick={() => setOpen(false)} aria-label="Fechar modelos" className="rounded-lg p-2 text-[var(--nx-text-2)] hover:bg-[var(--nx-hover)]"><X size={16}/></button></div>
      {loading && !templates.length ? <p className="flex items-center gap-2 text-xs"><Loader2 className="animate-spin" size={14}/> Carregando…</p> : <div className="grid gap-3">
        <label className="grid gap-1.5 text-[12.5px] font-medium text-[var(--nx-text-2)]">Modelo<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="h-9 rounded-lg border border-[var(--nx-border-strong)] bg-[var(--nx-surface)] px-3 text-sm text-[var(--nx-text)]">{templates.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.category}</option>)}</select></label>
        {requiredVariables.map((key) => <label key={key} className="grid gap-1.5 text-[12.5px] font-medium text-[var(--nx-text-2)]">{variableLabels[key] || key}<input value={variables[key] || ""} onChange={(event) => setVariables((current) => ({ ...current, [key]: event.target.value }))} className="h-9 rounded-lg border border-[var(--nx-border-strong)] bg-[var(--nx-surface)] px-3 text-sm text-[var(--nx-text)]"/></label>)}
        {selected && <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--nx-surface-2)] p-3 text-xs leading-5 text-[var(--nx-text-2)]">{selected.body}</div>}
        {error && <p role="alert" className="text-xs text-[var(--nx-danger)]">{error}</p>}
        <Button variant="primary" onClick={() => void apply()} disabled={loading || !selectedId}>{loading ? "Aplicando…" : "Inserir na mensagem"}</Button>
      </div>}
    </section>}
  </div>;
}
