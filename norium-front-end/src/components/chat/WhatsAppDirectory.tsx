import { ArrowRight, ContactRound, ListChecks, Plus, Search, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChatConversa } from "./types";
import { contactDisplayName, contactMatchesSearch } from "./contactPicker";
import type { Contact, WhatsAppSyncProgress } from "./whatsappApi";
import { useWhatsAppProfilePhoto } from "./useAuthenticatedMedia";
import { requestScope } from "../../core/api/sessionScope";
import { useConversationLabels } from "../business/useConversationLabels";
import SelectionTagDialog from "../business/SelectionTagDialog";
import { saveBlob } from "../clients/clientModel";
import Button from "../shared/Button";

interface WhatsAppDirectoryProps {
  mode: "contacts" | "groups";
  contacts: Contact[];
  groups: ChatConversa[];
  loading?: boolean;
  error?: string | null;
  sync?: WhatsAppSyncProgress | null;
  onOpenContact: (contact: Contact) => void;
  onOpenGroup: (group: ChatConversa) => void;
  onCreateGroup: () => void;
  onRefresh: () => void;
}

function DirectoryAvatar({ identifier, name, photoUrl, group = false }: { identifier?: string; name: string; photoUrl?: string; group?: boolean }) {
  const { source, onError } = useWhatsAppProfilePhoto(identifier, photoUrl);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
  return (
    <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--background)] text-xs font-extrabold text-[var(--text-secondary)]">
      {source
        ? <img src={source} alt="" className="h-full w-full object-cover" onError={onError} />
        : group ? <UsersRound size={19} /> : initials}
    </span>
  );
}

function SyncBar({ sync }: { sync?: WhatsAppSyncProgress | null }) {
  if (!sync || sync.status === "idle") return null;
  const progress = Math.max(0, Math.min(100, Number(sync.progress || 0)));
  return (
    <div className={`mx-3 mt-3 rounded-xl border px-3 py-2 ${sync.status === "error" ? "border-red-500/30 bg-red-500/10" : "border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]"}`} role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-[11px] font-semibold">
        <span className="truncate text-[var(--text)]">{sync.message || sync.phase || (sync.status === "complete" ? "Sincronização concluída" : "Sincronizando contatos")}</span>
        <span className="shrink-0 text-[var(--primary)]">{Math.round(progress)}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--nx-hover)]">
        <div className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-300" style={{ width: `${progress}%` }} />
      </div>
      {(sync.contactsSynced || sync.photosSynced) ? (
        <p className="mt-1.5 text-[10px] text-[var(--text-secondary)]">{sync.contactsSynced || 0} contatos · {sync.photosSynced || 0} fotos</p>
      ) : null}
    </div>
  );
}

export default function WhatsAppDirectory({ mode, contacts, groups, loading, error, sync, onOpenContact, onOpenGroup, onCreateGroup, onRefresh }: WhatsAppDirectoryProps) {
  const scope = requestScope();
  const labels = useConversationLabels("contacts", mode === "contacts");
  const [search, setSearch] = useState("");
  const [selectionMode, setSelectionMode] = useState(false), [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tagsOpen, setTagsOpen] = useState(false), [visible, setVisible] = useState(50);
  useEffect(() => { setSearch(""); setSelectedIds([]); setSelectionMode(false); setTagsOpen(false); setVisible(50); }, [scope, mode]);
  useEffect(() => { setVisible(50); setSelectedIds([]); }, [search, labels.signature]);
  useEffect(() => { const available = new Set(contacts.map(contact => contact.id || contact.phone));
    setSelectedIds(current => current.some(id => !available.has(id)) ? current.filter(id => available.has(id)) : current);
  }, [contacts]);
  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const filteredContacts = useMemo(() => contacts.filter(contact => contactMatchesSearch(contact, search)
    && (!labels.signature || [contact.id, contact.phone, contact.lid, ...(contact.aliases || [])].some(id => id && labels.matching?.has(id.trim().toLowerCase())))), [contacts, search, labels.signature, labels.matching]);
  const filteredGroups = useMemo(() => groups.filter((group) => `${group.contato} ${group.metadados?.descricaoGrupo || ""}`.toLocaleLowerCase("pt-BR").includes(normalizedSearch)), [groups, normalizedSearch]);
  const title = mode === "contacts" ? "Contatos" : "Grupos";
  const Icon = mode === "contacts" ? ContactRound : UsersRound;
  const empty = mode === "contacts" ? filteredContacts.length === 0 : filteredGroups.length === 0;
  function exportSelected() {
    const cell = (value: string) => `"${(/^[\s]*[=+\-@]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
    const rows = [["Nome", "WhatsApp"], ...contacts.filter(contact => selectedIds.includes(contact.id || contact.phone)).map(contact => [contactDisplayName(contact), contact.phone || contact.id])];
    saveBlob(new Blob(["\uFEFF"+rows.map(row => row.map(cell).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }), "contatos-whatsapp-selecionados.csv");
  }

  return (
    <>
      <aside className="norium-chat-sidebar flex h-full min-h-0 w-[300px] min-w-[280px] flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
        <header className="max-h-[55%] shrink-0 overflow-y-auto border-b border-[var(--border)] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Icon size={16} className="text-[var(--nx-primary-text)]" /> {title}</h2>
              <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{mode === "contacts" ? "Contatos retornados pelo WhatsApp" : "Conversas em grupo e comunidades"}</p>
            </div>
            {mode === "groups" && (
              <button type="button" onClick={onCreateGroup} className="nx-btn is-primary is-sm w-[30px] px-0" aria-label="Criar grupo" title="Criar grupo"><Plus size={18} /></button>
            )}
          </div>
          <label className="nx-conv-search mt-3">
            <Search size={15} className="text-[var(--text-secondary)]" />
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={mode === "contacts" ? "Pesquisar nome ou telefone" : "Pesquisar grupos"} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-secondary)]" aria-label={`Pesquisar ${title.toLocaleLowerCase("pt-BR")}`} />
          </label>
          {mode === "contacts" && <div className="mt-3 grid gap-3">{labels.toolbar}
            <Button size="sm" icon={<ListChecks size={14} />} onClick={() => { setSelectionMode(current => !current); setSelectedIds([]); setTagsOpen(false); }}>{selectionMode ? "Encerrar seleção" : "Selecionar contatos"}</Button>
            {selectionMode && <label className="business-note flex items-center gap-2"><input type="checkbox" aria-label="Selecionar até 100 contatos visíveis" disabled={!filteredContacts.length || loading || labels.loading} checked={!!filteredContacts.length && filteredContacts.slice(0, Math.min(visible, 100)).every(contact => selectedIds.includes(contact.id || contact.phone))} onChange={event => setSelectedIds(event.target.checked ? filteredContacts.slice(0, Math.min(visible, 100)).map(contact => contact.id || contact.phone) : [])} />Selecionar contatos visíveis (até 100)</label>}
          </div>}
        </header>

        <SyncBar sync={sync} />

        <div className="norium-chat-list min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
          {loading && <p className="p-8 text-center text-sm font-semibold text-[var(--text-secondary)]">Carregando {title.toLocaleLowerCase("pt-BR")}...</p>}
          {!loading && error && (
            <div className="p-8 text-center text-sm">
              <p className="font-semibold text-red-400">{error}</p>
              <button type="button" onClick={onRefresh} className="nx-btn is-sm mt-3">Tentar novamente</button>
            </div>
          )}
          {!loading && !error && mode === "contacts" && filteredContacts.slice(0, visible).map((contact) => {
            const name = contactDisplayName(contact);
            const id = contact.id || contact.phone;
            return (
              <div key={id} className="group flex w-full items-center gap-3 border-b border-[var(--border)]/55 px-4 py-3 text-left transition hover:bg-[var(--surface-hover)]">
                {selectionMode && <input type="checkbox" aria-label={`Selecionar contato ${name}`} checked={selectedIds.includes(id)} disabled={!selectedIds.includes(id) && selectedIds.length >= 100} onChange={event => setSelectedIds(current => event.target.checked ? [...current, id] : current.filter(value => value !== id))} />}
                <button type="button" onClick={() => onOpenContact(contact)} className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--nx-primary)]">
                <DirectoryAvatar identifier={contact.id || contact.phone} name={name} photoUrl={contact.photoUrl} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{name}</span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--text-secondary)]">{contact.bio || contact.phone || contact.id}</span>
                </span>
                <ArrowRight size={15} className="text-[var(--text-secondary)] opacity-0 transition group-hover:opacity-100" />
                </button>
              </div>
            );
          })}
          {!loading && !error && mode === "groups" && filteredGroups.slice(0, visible).map((group) => (
            <button key={group.id} type="button" onClick={() => onOpenGroup(group)} className="group flex w-full items-center gap-3 border-b border-[var(--border)]/55 px-4 py-3 text-left transition hover:bg-[var(--surface-hover)]">
              <DirectoryAvatar identifier={group.id} name={group.contato} photoUrl={group.metadados?.photoUrl || group.photoUrl} group />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">{group.contato}</span>
                <span className="mt-0.5 block truncate text-xs text-[var(--text-secondary)]">{group.metadados?.participantes?.length || 0} participantes · {group.ultimoTexto || "Sem mensagens"}</span>
              </span>
              <ArrowRight size={15} className="text-[var(--text-secondary)] opacity-0 transition group-hover:opacity-100" />
            </button>
          ))}
          {!loading && !error && !labels.loading && empty && (
            <div className="grid place-items-center gap-2 px-8 py-14 text-center text-[var(--text-secondary)]">
              <Icon size={28} strokeWidth={1.5} />
              <p className="text-sm font-semibold">Nenhum {mode === "contacts" ? "contato" : "grupo"} encontrado.</p>
            </div>
          )}
          {!loading && !error && (mode === "contacts" ? filteredContacts.length : filteredGroups.length) > visible && <div className="p-3"><Button size="sm" onClick={() => setVisible(value => value+50)}>Carregar mais {mode === "contacts" ? "contatos" : "grupos"}</Button></div>}
          {mode === "contacts" && labels.more && <div className="p-3">{labels.more}</div>}
        </div>
        {mode === "contacts" && selectionMode && <div className="business-conversation-bulk" role="region" aria-label="Ações para contatos selecionados"><strong>{selectedIds.length}/100 selecionados</strong><div className="flex flex-wrap gap-2"><Button size="sm" disabled={!selectedIds.length} onClick={() => setTagsOpen(true)}>Etiqueta</Button><Button size="sm" disabled={!selectedIds.length} onClick={exportSelected}>Exportar selecionados</Button><Button size="sm" onClick={() => setSelectedIds([])}>Limpar seleção</Button></div></div>}
      </aside>
      {tagsOpen && mode === "contacts" && selectedIds.length > 0 && <SelectionTagDialog ids={selectedIds} target="contacts" onClose={() => setTagsOpen(false)} />}

      <main className="norium-chat-directory-empty flex min-w-0 flex-1 flex-col items-center justify-center bg-[var(--background)] p-8 text-center text-[var(--text)]">
        <div className="grid h-14 w-14 place-items-center rounded-xl bg-[var(--nx-primary-soft)] text-[var(--nx-primary-text)]"><Icon size={24} /></div>
        <h3 className="mt-5 text-xl font-semibold">{mode === "contacts" ? "Escolha um contato" : "Escolha um grupo"}</h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-[var(--text-secondary)]">{mode === "contacts" ? "Abra uma conversa usando o nome disponível no WhatsApp. O Norium mantém nomes e fotos retornados pela integração sincronizados." : "Abra o histórico, veja participantes e continue a conversa em grupo pelo Norium."}</p>
        {mode === "groups" && <button type="button" onClick={onCreateGroup} className="nx-btn is-primary mt-5"><Plus size={17} /> Novo grupo</button>}
      </main>
    </>
  );
}
