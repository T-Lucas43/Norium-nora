import { useEffect, useMemo, useState } from "react";
import { Copy, FileText, Mail, MessageCircle, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import Button from "../shared/Button";
import { messageTemplatesApi, type MessageChannel, type MessageTemplate, type MessageTemplateInput } from "../../features/message-templates/api";

const emptyForm: MessageTemplateInput = { name: "", channel: "email", category: "comercial", subject: "", body: "" };
const categories = ["comercial", "follow-up", "agendamento", "onboarding", "suporte", "financeiro", "cobrança", "pós-venda", "geral"];

export default function MessageTemplatesDashboard() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [channel, setChannel] = useState<MessageChannel>("email");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<MessageTemplateInput>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const filtered = useMemo(() => templates.filter((item) => item.channel === channel && `${item.name} ${item.category} ${item.body}`.toLowerCase().includes(query.toLowerCase())), [channel, query, templates]);

  async function load() {
    setLoading(true); setError("");
    try { setTemplates((await messageTemplatesApi.list()).templates); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível carregar os modelos."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function startNew(targetChannel = channel) { setEditingId(null); setForm({ ...emptyForm, channel: targetChannel }); setOpen(true); }
  function startEdit(item: MessageTemplate) { setEditingId(item.id); setForm({ name: item.name, channel: item.channel, category: item.category, subject: item.subject, body: item.body }); setOpen(true); }
  function duplicate(item: MessageTemplate) { setEditingId(null); setForm({ name: `${item.name} (cópia)`, channel: item.channel, category: item.category, subject: item.subject, body: item.body }); setOpen(true); }
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

  return <div className="min-h-full bg-[var(--background)] p-5 text-[var(--text)]">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><span className="text-xs font-black uppercase tracking-[.18em] text-[var(--primary)]">CRM Norium</span><h1 className="mt-1 text-2xl font-black">Modelos de mensagens</h1><p className="mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">Crie mensagens consistentes para e-mail e WhatsApp, personalize os campos do cliente e reutilize no momento do atendimento.</p></div><Button variant="primary" onClick={() => startNew()}><Plus size={16}/> Novo modelo</Button></header>
    <div className="mt-5 flex flex-wrap items-center gap-2"><button onClick={() => setChannel("email")} className={`rounded-lg px-4 py-2 text-sm font-bold ${channel === "email" ? "bg-[var(--primary)] text-white" : "border border-[var(--border)] bg-[var(--surface)]"}`}><Mail className="mr-2 inline" size={15}/>E-mail</button><button onClick={() => setChannel("whatsapp")} className={`rounded-lg px-4 py-2 text-sm font-bold ${channel === "whatsapp" ? "bg-[var(--primary)] text-white" : "border border-[var(--border)] bg-[var(--surface)]"}`}><MessageCircle className="mr-2 inline" size={15}/>WhatsApp</button><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar modelo" aria-label="Buscar modelo" className="ml-auto h-10 min-w-64 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm"/></div>
    {error && <p role="alert" className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm font-bold text-rose-400">{error}</p>}
    {loading ? <p className="mt-8 text-sm text-[var(--text-secondary)]">Carregando modelos…</p> : <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((item) => <article key={item.id} className="flex min-h-64 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="flex items-start justify-between gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]"><FileText size={18}/></span><span className="rounded-full border border-[var(--border)] px-2 py-1 text-[10px] font-black uppercase">{item.builtIn ? "Norium" : "Personalizado"}</span></div><h2 className="mt-3 font-black">{item.name}</h2><p className="mt-1 text-xs font-bold uppercase text-[var(--primary)]">{item.category}</p>{item.subject && <p className="mt-3 text-sm font-bold">{item.subject}</p>}<p className="mt-2 line-clamp-5 whitespace-pre-wrap text-xs leading-5 text-[var(--text-secondary)]">{item.body}</p><div className="mt-auto flex flex-wrap gap-2 pt-4">{!item.builtIn && <Button size="sm" onClick={() => startEdit(item)}><Pencil size={14}/> Editar</Button>}<Button size="sm" onClick={() => duplicate(item)}><Copy size={14}/> Duplicar</Button>{!item.builtIn && <Button size="sm" onClick={() => void remove(item)}><Trash2 size={14}/> Excluir</Button>}</div></article>)}</div>}
    {!loading && !filtered.length && <div className="mt-8 rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-secondary)]">Nenhum modelo encontrado.</div>}
    {open && <div className="fixed inset-0 z-[120] grid place-items-center overflow-y-auto bg-black/65 p-4"><section className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"><div className="flex items-center justify-between"><h2 className="text-lg font-black">{editingId ? "Editar modelo" : "Novo modelo"}</h2><button onClick={() => setOpen(false)} aria-label="Fechar" className="rounded-lg p-2 hover:bg-[var(--surface-hover)]"><X size={18}/></button></div><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">Nome<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)]"/></label><label className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">Canal<select value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as MessageChannel, subject: event.target.value === "email" ? form.subject : "" })} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)]"><option value="email">E-mail</option><option value="whatsapp">WhatsApp</option></select></label><label className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">Categoria<input list="template-categories" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)]"/><datalist id="template-categories">{categories.map((item) => <option key={item} value={item}/>)}</datalist></label>{form.channel === "email" && <label className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">Assunto<input value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)]"/></label>}</div><label className="mt-3 grid gap-1 text-xs font-bold text-[var(--text-secondary)]">Mensagem<textarea rows={10} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm leading-6 text-[var(--text)]"/></label><p className="mt-2 text-xs text-[var(--text-secondary)]">Campos disponíveis: {"{{client_name}}, {{company_name}}, {{sender_name}}, {{service_name}}, {{professional_name}}, {{date}}, {{time}}, {{next_step}}"}</p><div className="mt-4 flex justify-end gap-2"><Button onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" disabled={!form.name.trim() || !form.body.trim()} onClick={() => void save()}><Save size={15}/> Salvar modelo</Button></div></section></div>}
  </div>;
}
