import { Fragment, useEffect, useMemo, useState } from "react";
import { Copy, FileText, Pencil, Plus, Save, Search, Trash2, X } from "lucide-react";
import Button from "../shared/Button";
import { messageTemplatesApi, type MessageChannel, type MessageTemplate, type MessageTemplateInput } from "../../features/message-templates/api";

const emptyForm: MessageTemplateInput = { name: "", channel: "email", category: "comercial", subject: "", body: "" };
const categories = ["comercial", "follow-up", "agendamento", "onboarding", "suporte", "financeiro", "cobrança", "pós-venda", "geral"];
const variableLabels: Array<[string, string]> = [
  ["client_name", "Nome do cliente"],
  ["company_name", "Empresa"],
  ["sender_name", "Seu nome"],
  ["service_name", "Serviço"],
  ["professional_name", "Profissional"],
  ["date", "Data"],
  ["time", "Horário"],
  ["next_step", "Próximo passo"],
];

type ChannelFilter = MessageChannel | "todos";

const channelLabel = (channel: MessageChannel) => (channel === "email" ? "E-mail" : channel === "team" ? "Equipe" : "WhatsApp");
const channelBadge = (channel: MessageChannel) => (channel === "email" ? "nx-badge is-red" : channel === "team" ? "nx-badge is-blue" : "nx-badge is-green");
const fieldClass = "h-9 w-full rounded-lg border border-[var(--nx-border-strong)] bg-[var(--nx-surface)] px-3 text-sm text-[var(--nx-text)] outline-none focus:border-[var(--nx-primary)]";
const labelClass = "grid gap-1.5 text-[12.5px] font-medium text-[var(--nx-text-2)]";

function TemplateText({ text }: { text: string }) {
  const parts = text.split(/(\{\{[a-z_]+\}\})/g);
  return <>{parts.map((part, index) => /^\{\{[a-z_]+\}\}$/.test(part)
    ? <span key={index} className="nx-badge is-blue mx-0.5 align-baseline">{part}</span>
    : <Fragment key={index}>{part}</Fragment>)}</>;
}

export default function MessageTemplatesDashboard() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [channel, setChannel] = useState<ChannelFilter>("todos");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<MessageTemplateInput>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const filtered = useMemo(() => templates.filter((item) => (channel === "todos" || item.channel === channel) && `${item.name} ${item.category} ${item.body}`.toLowerCase().includes(query.toLowerCase())), [channel, query, templates]);
  const selected = filtered.find((item) => item.id === selectedId) || filtered[0];

  async function load() {
    setLoading(true); setError("");
    try { setTemplates((await messageTemplatesApi.list()).templates); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível carregar os modelos."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function startNew(targetChannel: MessageChannel = channel === "todos" ? "email" : channel) { setEditingId(null); setForm({ ...emptyForm, channel: targetChannel }); setOpen(true); }
  function startEdit(item: MessageTemplate) { setEditingId(item.id); setForm({ name: item.name, channel: item.channel, category: item.category, subject: item.subject, body: item.body, shortcut: item.shortcut || "" }); setOpen(true); }
  function duplicate(item: MessageTemplate) { setEditingId(null); setForm({ name: `${item.name} (cópia)`, channel: item.channel, category: item.category, subject: item.subject, body: item.body }); setOpen(true); }
  function insertVariable(key: string) { setForm((current) => ({ ...current, body: `${current.body}{{${key}}}` })); }
  async function save() {
    if (!form.name.trim() || !form.body.trim()) return;
    setError("");
    try {
      if (editingId) await messageTemplatesApi.update(editingId, form); else await messageTemplatesApi.create(form);
      setOpen(false); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível salvar o modelo."); }
  }
  async function remove(item: MessageTemplate) {
    if (item.builtIn || !window.confirm(`Excluir o modelo “${item.name}”?`)) return;
    try { await messageTemplatesApi.remove(item.id); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível excluir o modelo."); }
  }

  const filters: Array<[ChannelFilter, string]> = [["todos", "Todos"], ["email", "E-mail"], ["whatsapp", "WhatsApp"], ["team", "Equipe"]];

  return <div className="nx-page min-h-full">
    <header className="nx-ph">
      <div><h1>Modelos de mensagens</h1><p>Textos prontos com campos automáticos para e-mail e WhatsApp</p></div>
      <div className="nx-ph-actions items-center">
        <div className="nx-seg" role="group" aria-label="Filtrar por canal">{filters.map(([value, label]) => <button key={value} type="button" aria-pressed={channel === value} className={channel === value ? "is-active" : ""} onClick={() => setChannel(value)}>{label}</button>)}</div>
        <button type="button" className="nx-btn is-primary" onClick={() => startNew()}><Plus size={16}/> Novo modelo</button>
      </div>
    </header>

    <label className="nx-input w-full max-w-sm text-[var(--nx-text-3)]"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar modelo" aria-label="Buscar modelo"/></label>

    {error && <p role="alert" className="rounded-lg bg-[var(--nx-danger-soft)] px-3 py-2 text-[13px] text-[var(--nx-danger)]">{error}</p>}

    {loading ? <p className="text-sm text-[var(--nx-text-3)]" role="status">Carregando modelos…</p>
      : !filtered.length ? <div className="nx-card p-10 text-center text-sm text-[var(--nx-text-3)]">Nenhum modelo encontrado.</div>
      : <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
        <div className="nx-card overflow-x-auto">
          <table className="nx-table min-w-[480px]">
            <thead><tr><th>Modelo</th><th>Canal</th><th>Categoria</th><th>Origem</th></tr></thead>
            <tbody>{filtered.map((item) => <tr key={item.id} onClick={() => setSelectedId(item.id)} aria-selected={selected?.id === item.id} className={`cursor-pointer hover:bg-[var(--nx-surface-2)] ${selected?.id === item.id ? "bg-[var(--nx-primary-soft)] hover:bg-[var(--nx-primary-soft)]" : ""}`}>
              <td className="font-medium"><button type="button" className="text-left" onClick={() => setSelectedId(item.id)}>{item.name}</button></td>
              <td><span className={channelBadge(item.channel)}>{channelLabel(item.channel)}</span></td>
              <td className="capitalize text-[var(--nx-text-2)]">{item.category}</td>
              <td className="text-[var(--nx-text-2)]">{item.builtIn ? "Norium" : "Personalizado"}</td>
            </tr>)}</tbody>
          </table>
        </div>

        {selected && <article className="nx-card flex flex-col gap-3 p-[18px]" aria-label={`Modelo ${selected.name}`}>
          <div className="flex items-center gap-2"><FileText size={16} className="text-[var(--nx-text-3)]"/><h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{selected.name}</h2><span className={channelBadge(selected.channel)}>{channelLabel(selected.channel)}</span></div>
          <div className="flex flex-wrap gap-2 text-[12.5px] text-[var(--nx-text-3)]"><span className="capitalize">{selected.category}</span><span>·</span><span>{selected.builtIn ? "Norium" : "Personalizado"}</span></div>
          {selected.subject && <div><div className="mb-1.5 text-[12.5px] font-medium text-[var(--nx-text-2)]">Assunto</div><div className="rounded-lg border border-[var(--nx-border-strong)] px-3 py-2 text-sm"><TemplateText text={selected.subject}/></div></div>}
          <div><div className="mb-1.5 text-[12.5px] font-medium text-[var(--nx-text-2)]">Mensagem</div><div className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--nx-border-strong)] p-3 text-sm leading-7"><TemplateText text={selected.body}/></div></div>
          <div className="text-[12.5px] text-[var(--nx-text-3)]">Campos: {variableLabels.map(([, label]) => label.toLowerCase()).join(", ")}</div>
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            {!selected.builtIn && <button type="button" className="nx-btn is-sm" onClick={() => startEdit(selected)}><Pencil size={14}/> Editar</button>}
            <button type="button" className="nx-btn is-sm" onClick={() => duplicate(selected)}><Copy size={14}/> Duplicar</button>
            {!selected.builtIn && <button type="button" className="nx-btn is-sm text-[var(--nx-danger)]" onClick={() => void remove(selected)}><Trash2 size={14}/> Excluir</button>}
          </div>
        </article>}
      </div>}

    {open && <div className="fixed inset-0 z-[120] grid place-items-center overflow-y-auto bg-black/50 p-4" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="template-dialog-title" className="nx-card w-full max-w-[660px] p-6 text-[var(--nx-text)] shadow-[0_20px_48px_rgba(15,23,42,.25)]">
        <div className="flex items-start justify-between gap-3"><div><h2 id="template-dialog-title" className="text-lg font-semibold">{editingId ? "Editar modelo" : "Novo modelo de mensagem"}</h2><p className="mt-1 text-[13px] text-[var(--nx-text-2)]">Use campos automáticos para personalizar</p></div><button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="grid h-8 w-8 place-items-center rounded-lg text-[var(--nx-text-2)] hover:bg-[var(--nx-hover)]"><X size={16}/></button></div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <label className={labelClass}>Nome<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={fieldClass}/></label>
          <label className={labelClass}>Canal<select value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as MessageChannel, subject: event.target.value === "email" ? form.subject : "" })} className={fieldClass}><option value="email">E-mail</option><option value="whatsapp">WhatsApp</option><option value="team">Chat da equipe</option></select></label>
          <label className={labelClass}>Categoria<input list="template-categories" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} className={fieldClass}/><datalist id="template-categories">{categories.map((item) => <option key={item} value={item}/>)}</datalist></label>
        </div>
        <label className={`${labelClass} mt-3`}>Atalho no chat, sem /<input aria-label="Atalho do modelo" value={form.shortcut || ""} onChange={(event) => setForm({ ...form, shortcut: event.target.value.toLowerCase().replace(/^\//, "") })} placeholder="Ex.: boas-vindas" maxLength={30} className={fieldClass}/></label>
        {form.channel === "email" && <label className={`${labelClass} mt-3`}>Assunto<input value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} className={fieldClass}/></label>}
        <label className={`${labelClass} mt-3`}>Mensagem<textarea rows={9} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} className="rounded-lg border border-[var(--nx-border-strong)] bg-[var(--nx-surface)] p-3 text-sm leading-6 text-[var(--nx-text)] outline-none focus:border-[var(--nx-primary)]"/></label>
        <div className="mt-3 flex flex-wrap items-center gap-1.5"><span className="text-[12.5px] text-[var(--nx-text-3)]">Inserir campo:</span>{variableLabels.map(([key, label]) => <button key={key} type="button" className="nx-badge hover:bg-[var(--nx-primary-soft)] hover:text-[var(--nx-primary-text)]" title={`{{${key}}}`} onClick={() => insertVariable(key)}>{label}</button>)}</div>
        <p className="mt-2 text-xs text-[var(--nx-text-3)]">Campos disponíveis: {"{{client_name}}, {{company_name}}, {{sender_name}}, {{service_name}}, {{professional_name}}, {{date}}, {{time}}, {{next_step}}"}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2"><Button onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" disabled={!form.name.trim() || !form.body.trim()} onClick={() => void save()}><Save size={15}/> Salvar modelo</Button></div>
      </section>
    </div>}
  </div>;
}
