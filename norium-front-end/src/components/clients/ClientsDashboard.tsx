import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, CalendarDays, CheckSquare, History, LoaderCircle, Mail, MessageSquare, Paperclip, Pencil, Phone, Plus, Search, Trash2, UserRoundCheck, Wallet, X } from "lucide-react";
import { apiRequest } from "../../core/api/client";

type ClientStage = "new" | "contacted" | "proposal" | "won" | "lost";
type ClientStatus = "lead" | "active" | "inactive";

type Client = {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  segment: string;
  status: ClientStatus;
  stage: ClientStage;
  ownerName: string;
  nextActionAt: string | null;
  tags: string[];
  notes: string;
  updatedAt: string;
};

type Client360 = {
  summary: Record<"emails" | "messages" | "tasks" | "finance" | "calendar" | "attachments" | "followUps", number>;
  timeline: Array<{
    id: string;
    type: string;
    title: string;
    description: string;
    timestamp: string;
    deepLink?: { tab: string; entityType: string; entityId: string; metadata?: Record<string, unknown> };
  }>;
  lastContactAt: string | null;
};

const emptyForm = {
  name: "",
  company: "",
  email: "",
  phone: "",
  segment: "",
  status: "lead" as ClientStatus,
  stage: "new" as ClientStage,
  ownerName: "",
  nextActionAt: "",
  tags: "",
  notes: "",
};

const stageLabels: Record<ClientStage, string> = {
  new: "Novo",
  contacted: "Contatado",
  proposal: "Proposta",
  won: "Convertido",
  lost: "Perdido",
};

export default function ClientsDashboard() {
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [client360, setClient360] = useState<Client360 | null>(null);
  const [loading360, setLoading360] = useState(false);

  const loadClients = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiRequest<{ items: Client[] }>("/api/clientes");
      setClients(data.items || []);
      setSelectedId((current) => current && data.items.some((item) => item.id === current) ? current : data.items[0]?.id || null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel carregar os clientes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadClients();
  }, [loadClients]);

  useEffect(() => {
    if (!selectedId) {
      setClient360(null);
      return;
    }
    let active = true;
    setLoading360(true);
    void apiRequest<Client360>(`/api/clientes/${selectedId}/360`)
      .then((payload) => {
        if (active) setClient360(payload);
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : "Não foi possível carregar a ficha 360.");
      })
      .finally(() => {
        if (active) setLoading360(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    if (!needle) return clients;
    return clients.filter((item) => `${item.name} ${item.company} ${item.email} ${item.segment} ${item.tags.join(" ")}`.toLocaleLowerCase("pt-BR").includes(needle));
  }, [clients, query]);
  const selected = clients.find((item) => item.id === selectedId) || null;

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setEditorOpen(true);
  }

  function openEdit(client: Client) {
    setEditingId(client.id);
    setForm({
      name: client.name,
      company: client.company || "",
      email: client.email || "",
      phone: client.phone || "",
      segment: client.segment || "",
      status: client.status,
      stage: client.stage,
      ownerName: client.ownerName || "",
      nextActionAt: client.nextActionAt?.slice(0, 16) || "",
      tags: client.tags.join(", "),
      notes: client.notes || "",
    });
    setEditorOpen(true);
  }

  async function saveClient() {
    if (!form.name.trim()) return;
    setSaving(true);
    setError("");
    const payload = {
      ...form,
      name: form.name.trim(),
      nextActionAt: form.nextActionAt || null,
      tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    };
    try {
      const data = await apiRequest<{ item: Client }>(editingId ? `/api/clientes/${editingId}` : "/api/clientes", {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      setClients((current) => editingId ? current.map((item) => item.id === editingId ? data.item : item) : [data.item, ...current]);
      setSelectedId(data.item.id);
      setEditorOpen(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel salvar o cliente.");
    } finally {
      setSaving(false);
    }
  }

  async function removeClient(client: Client) {
    if (!window.confirm(`Excluir o cliente "${client.name}"?`)) return;
    try {
      await apiRequest(`/api/clientes/${client.id}`, { method: "DELETE" });
      setClients((current) => current.filter((item) => item.id !== client.id));
      setSelectedId((current) => current === client.id ? null : current);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel excluir o cliente.");
    }
  }

  return (
    <main className="min-h-[calc(100dvh-74px)] bg-[var(--background)] p-4 text-[var(--text)] sm:p-6">
      <div className="mx-auto max-w-[1600px]">
        <header className="flex flex-col gap-4 border-b border-[var(--border)] pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-lg bg-blue-500/12 text-blue-400"><UserRoundCheck size={21} /></span>
            <div><h1 className="text-2xl font-black">Clientes</h1><p className="text-sm font-semibold text-[var(--text-secondary)]">Relacionamento, etapa comercial e proximo contato em uma unica fila.</p></div>
          </div>
          <button type="button" onClick={openCreate} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-4 text-sm font-black text-white hover:brightness-110"><Plus size={16} /> Novo cliente</button>
        </header>

        {error && <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm font-bold text-rose-300">{error}</div>}
        <div className="mt-5 grid min-h-[650px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] lg:grid-cols-[390px_minmax(0,1fr)]">
          <aside className="border-b border-[var(--border)] lg:border-b-0 lg:border-r">
            <div className="border-b border-[var(--border)] p-4">
              <label className="flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 focus-within:border-blue-500"><Search size={16} className="text-[var(--text-secondary)]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, empresa ou tag" className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none" /></label>
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {loading ? <div className="grid h-40 place-items-center"><LoaderCircle className="animate-spin text-blue-400" /></div> : filtered.map((client) => (
                <button key={client.id} type="button" onClick={() => setSelectedId(client.id)} className={`flex w-full items-start gap-3 border-b border-[var(--border)] p-4 text-left hover:bg-[var(--surface-hover)] ${selectedId === client.id ? "bg-blue-500/10" : ""}`}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-500/12 font-black text-blue-300">{client.name.slice(0, 2).toUpperCase()}</span>
                  <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-black">{client.name}</strong><small className="mt-1 block truncate font-semibold text-[var(--text-secondary)]">{client.company || client.email || "Sem empresa informada"}</small><span className="mt-2 inline-flex rounded-full border border-[var(--border)] px-2 py-0.5 text-[9px] font-black uppercase text-blue-300">{stageLabels[client.stage]}</span></span>
                </button>
              ))}
              {!loading && filtered.length === 0 && <p className="p-8 text-center text-sm font-semibold text-[var(--text-secondary)]">Nenhum cliente encontrado.</p>}
            </div>
          </aside>

          <section className="min-w-0 p-5 sm:p-7">
            {selected ? (
              <>
                <div className="flex flex-col gap-4 border-b border-[var(--border)] pb-5 sm:flex-row sm:items-start sm:justify-between">
                  <div><p className="text-[10px] font-black uppercase text-blue-400">{stageLabels[selected.stage]}</p><h2 className="mt-1 text-2xl font-black">{selected.name}</h2><p className="mt-1 font-semibold text-[var(--text-secondary)]">{selected.company || "Cliente individual"} {selected.segment && `• ${selected.segment}`}</p></div>
                  <div className="flex gap-2"><button type="button" onClick={() => openEdit(selected)} className="grid h-10 w-10 place-items-center rounded-lg border border-[var(--border)] hover:bg-[var(--surface-hover)]" title="Editar cliente" aria-label="Editar cliente"><Pencil size={16} /></button><button type="button" onClick={() => void removeClient(selected)} className="grid h-10 w-10 place-items-center rounded-lg border border-rose-500/25 text-rose-300 hover:bg-rose-500/10" title="Excluir cliente" aria-label="Excluir cliente"><Trash2 size={16} /></button></div>
                </div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <InfoCard icon={Mail} label="E-mail" value={selected.email || "Nao informado"} />
                  <InfoCard icon={Phone} label="Telefone" value={selected.phone || "Nao informado"} />
                  <InfoCard icon={Building2} label="Responsavel" value={selected.ownerName || "Nao definido"} />
                </div>
                <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_320px]">
                  <article className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-5"><h3 className="text-sm font-black">Contexto e observacoes</h3><p className="mt-3 whitespace-pre-wrap text-sm font-semibold leading-6 text-[var(--text-secondary)]">{selected.notes || "Nenhuma observacao registrada."}</p></article>
                  <article className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-5"><h3 className="text-sm font-black">Proximo passo</h3><p className="mt-3 text-sm font-semibold text-[var(--text-secondary)]">{selected.nextActionAt ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(selected.nextActionAt)) : "Sem acompanhamento agendado."}</p><div className="mt-4 flex flex-wrap gap-2">{selected.tags.map((tag) => <span key={tag} className="rounded-full bg-cyan-500/10 px-2 py-1 text-[10px] font-black uppercase text-cyan-300">{tag}</span>)}</div></article>
                </div>
                <section className="mt-5 border-t border-[var(--border)] pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <div><h3 className="flex items-center gap-2 text-sm font-black"><History className="text-blue-400" size={17} /> Histórico completo do cliente</h3><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">Contatos, tarefas, compromissos, financeiro, anexos e ações da Nora em uma timeline.</p></div>
                    {loading360 && <LoaderCircle className="animate-spin text-blue-400" size={18} />}
                  </div>
                  {client360 && (
                    <>
                      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
                        <SummaryChip icon={Mail} label="E-mails" value={client360.summary.emails} />
                        <SummaryChip icon={MessageSquare} label="Conversas" value={client360.summary.messages} />
                        <SummaryChip icon={CheckSquare} label="Tarefas" value={client360.summary.tasks} />
                        <SummaryChip icon={Wallet} label="Financeiro" value={client360.summary.finance} />
                        <SummaryChip icon={CalendarDays} label="Agenda" value={client360.summary.calendar} />
                        <SummaryChip icon={Paperclip} label="Anexos" value={client360.summary.attachments} />
                        <SummaryChip icon={History} label="Follow-ups" value={client360.summary.followUps} />
                      </div>
                      <div className="mt-4 max-h-[380px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)] px-4">
                        {client360.timeline.map((item) => (
                          <button
                            key={`${item.type}-${item.id}`}
                            type="button"
                            className="grid w-full grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--border)] py-3 text-left last:border-b-0"
                            onClick={() => {
                              if (!item.deepLink) return;
                              localStorage.setItem("norium-deep-link", JSON.stringify(item.deepLink));
                              window.dispatchEvent(new CustomEvent("norium:deep-link", { detail: item.deepLink }));
                            }}
                          >
                            <span className="h-2 w-2 rounded-full bg-blue-500" />
                            <span className="min-w-0"><strong className="block truncate text-xs">{item.title || item.type}</strong><small className="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-semibold text-[var(--text-secondary)]">{item.description || "Sem descrição adicional."}</small></span>
                            <time className="text-[10px] font-bold text-[var(--text-secondary)]">{item.timestamp ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(item.timestamp)) : ""}</time>
                          </button>
                        ))}
                        {!client360.timeline.length && <p className="py-10 text-center text-xs font-semibold text-[var(--text-secondary)]">Nenhuma interação relacionada a este cliente ainda.</p>}
                      </div>
                    </>
                  )}
                </section>
              </>
            ) : <div className="grid h-full place-items-center text-center"><div><UserRoundCheck className="mx-auto text-blue-400" size={34} /><h2 className="mt-3 font-black">Comece seu relacionamento comercial</h2><p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">Cadastre o primeiro cliente para acompanhar contexto e proximos passos.</p></div></div>}
          </section>
        </div>
      </div>

      {editorOpen && <div className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm"><div className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl"><header className="flex items-center justify-between border-b border-[var(--border)] p-5"><div><h2 className="font-black">{editingId ? "Editar cliente" : "Novo cliente"}</h2><p className="text-xs font-semibold text-[var(--text-secondary)]">Dados comerciais e proximo acompanhamento.</p></div><button type="button" onClick={() => setEditorOpen(false)} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--surface-hover)]"><X size={18} /></button></header><div className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Nome" value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
        <Field label="Empresa" value={form.company} onChange={(value) => setForm({ ...form, company: value })} />
        <Field label="E-mail" value={form.email} onChange={(value) => setForm({ ...form, email: value })} type="email" />
        <Field label="Telefone" value={form.phone} onChange={(value) => setForm({ ...form, phone: value })} />
        <Field label="Segmento" value={form.segment} onChange={(value) => setForm({ ...form, segment: value })} />
        <Field label="Responsavel" value={form.ownerName} onChange={(value) => setForm({ ...form, ownerName: value })} />
        <label className="text-xs font-black uppercase text-[var(--text-secondary)]">Etapa<select value={form.stage} onChange={(event) => setForm({ ...form, stage: event.target.value as ClientStage })} className="mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 normal-case text-[var(--text)]"><option value="new">Novo</option><option value="contacted">Contatado</option><option value="proposal">Proposta</option><option value="won">Convertido</option><option value="lost">Perdido</option></select></label>
        <label className="text-xs font-black uppercase text-[var(--text-secondary)]">Status<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as ClientStatus })} className="mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 normal-case text-[var(--text)]"><option value="lead">Lead</option><option value="active">Ativo</option><option value="inactive">Inativo</option></select></label>
        <Field label="Proximo contato" value={form.nextActionAt} onChange={(value) => setForm({ ...form, nextActionAt: value })} type="datetime-local" />
        <Field label="Tags separadas por virgula" value={form.tags} onChange={(value) => setForm({ ...form, tags: value })} />
        <label className="sm:col-span-2 text-xs font-black uppercase text-[var(--text-secondary)]">Observacoes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={4} className="mt-2 w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 normal-case text-[var(--text)] outline-none focus:border-blue-500" /></label>
      </div><footer className="flex justify-end gap-2 border-t border-[var(--border)] p-5"><button type="button" onClick={() => setEditorOpen(false)} className="h-10 rounded-lg border border-[var(--border)] px-4 text-sm font-black">Cancelar</button><button type="button" disabled={saving || !form.name.trim()} onClick={() => void saveClient()} className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--primary)] px-4 text-sm font-black text-white disabled:opacity-50">{saving && <LoaderCircle className="animate-spin" size={15} />} Salvar cliente</button></footer></div></div>}
    </main>
  );
}

function InfoCard({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: string }) {
  return <article className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4"><Icon className="text-blue-400" size={17} /><p className="mt-3 text-[10px] font-black uppercase text-[var(--text-secondary)]">{label}</p><p className="mt-1 truncate text-sm font-black">{value}</p></article>;
}

function SummaryChip({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: number }) {
  return <article className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><Icon className="text-blue-400" size={15} /><strong className="mt-2 block text-lg font-black">{value}</strong><small className="text-[10px] font-bold text-[var(--text-secondary)]">{label}</small></article>;
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <label className="text-xs font-black uppercase text-[var(--text-secondary)]">{label}<input type={type} value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 normal-case text-[var(--text)] outline-none focus:border-blue-500" /></label>;
}
