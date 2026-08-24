import { ArrowRight, ContactRound, Plus, Search, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import type { ChatConversa } from "./types";
import { contactDisplayName, contactMatchesSearch } from "./contactPicker";
import type { Contact, WhatsAppSyncProgress } from "./whatsappApi";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";

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

function DirectoryAvatar({ name, photoUrl, group = false }: { name: string; photoUrl?: string; group?: boolean }) {
  const [failed, setFailed] = useState(false);
  const source = useAuthenticatedMedia(photoUrl);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
  return (
    <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--background)] text-xs font-extrabold text-[var(--text-secondary)]">
      {source && !failed
        ? <img src={source} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
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
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/45">
        <div className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-300" style={{ width: `${progress}%` }} />
      </div>
      {(sync.contactsSynced || sync.photosSynced) ? (
        <p className="mt-1.5 text-[10px] text-[var(--text-secondary)]">{sync.contactsSynced || 0} contatos · {sync.photosSynced || 0} fotos</p>
      ) : null}
    </div>
  );
}

export default function WhatsAppDirectory({ mode, contacts, groups, loading, error, sync, onOpenContact, onOpenGroup, onCreateGroup, onRefresh }: WhatsAppDirectoryProps) {
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const filteredContacts = useMemo(() => contacts.filter((contact) => contactMatchesSearch(contact, search)), [contacts, search]);
  const filteredGroups = useMemo(() => groups.filter((group) => `${group.contato} ${group.metadados?.descricaoGrupo || ""}`.toLocaleLowerCase("pt-BR").includes(normalizedSearch)), [groups, normalizedSearch]);
  const title = mode === "contacts" ? "Contatos" : "Grupos";
  const Icon = mode === "contacts" ? ContactRound : UsersRound;
  const empty = mode === "contacts" ? filteredContacts.length === 0 : filteredGroups.length === 0;

  return (
    <>
      <aside className="norium-chat-sidebar flex h-full min-h-0 w-[380px] min-w-[320px] flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
        <header className="shrink-0 border-b border-[var(--border)] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold"><Icon size={19} className="text-[var(--primary)]" /> {title}</h2>
              <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{mode === "contacts" ? "Contatos retornados pelo WhatsApp" : "Conversas em grupo e comunidades"}</p>
            </div>
            {mode === "groups" && (
              <button type="button" onClick={onCreateGroup} className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--primary)] text-white" aria-label="Criar grupo" title="Criar grupo"><Plus size={18} /></button>
            )}
          </div>
          <label className="mt-4 flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 focus-within:border-[var(--primary)]">
            <Search size={15} className="text-[var(--text-secondary)]" />
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={mode === "contacts" ? "Pesquisar nome ou telefone" : "Pesquisar grupos"} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-secondary)]" aria-label={`Pesquisar ${title.toLocaleLowerCase("pt-BR")}`} />
          </label>
        </header>

        <SyncBar sync={sync} />

        <div className="norium-chat-list min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
          {loading && <p className="p-8 text-center text-sm font-semibold text-[var(--text-secondary)]">Carregando {title.toLocaleLowerCase("pt-BR")}...</p>}
          {!loading && error && (
            <div className="p-8 text-center text-sm">
              <p className="font-semibold text-red-400">{error}</p>
              <button type="button" onClick={onRefresh} className="mt-3 rounded-xl border border-[var(--border)] px-4 py-2 font-semibold hover:border-[var(--primary)]">Tentar novamente</button>
            </div>
          )}
          {!loading && !error && mode === "contacts" && filteredContacts.map((contact) => {
            const name = contactDisplayName(contact);
            return (
              <button key={contact.id || contact.phone} type="button" onClick={() => onOpenContact(contact)} className="group flex w-full items-center gap-3 border-b border-[var(--border)]/55 px-4 py-3 text-left transition hover:bg-[var(--surface-hover)]">
                <DirectoryAvatar name={name} photoUrl={contact.photoUrl} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{name}</span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--text-secondary)]">{contact.bio || contact.phone || contact.id}</span>
                </span>
                <ArrowRight size={15} className="text-[var(--text-secondary)] opacity-0 transition group-hover:opacity-100" />
              </button>
            );
          })}
          {!loading && !error && mode === "groups" && filteredGroups.map((group) => (
            <button key={group.id} type="button" onClick={() => onOpenGroup(group)} className="group flex w-full items-center gap-3 border-b border-[var(--border)]/55 px-4 py-3 text-left transition hover:bg-[var(--surface-hover)]">
              <DirectoryAvatar name={group.contato} photoUrl={group.metadados?.photoUrl || group.photoUrl} group />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">{group.contato}</span>
                <span className="mt-0.5 block truncate text-xs text-[var(--text-secondary)]">{group.metadados?.participantes?.length || 0} participantes · {group.ultimoTexto || "Sem mensagens"}</span>
              </span>
              <ArrowRight size={15} className="text-[var(--text-secondary)] opacity-0 transition group-hover:opacity-100" />
            </button>
          ))}
          {!loading && !error && empty && (
            <div className="grid place-items-center gap-2 px-8 py-14 text-center text-[var(--text-secondary)]">
              <Icon size={28} strokeWidth={1.5} />
              <p className="text-sm font-semibold">Nenhum {mode === "contacts" ? "contato" : "grupo"} encontrado.</p>
            </div>
          )}
        </div>
      </aside>

      <main className="norium-chat-directory-empty flex min-w-0 flex-1 flex-col items-center justify-center bg-[var(--background)] p-8 text-center text-[var(--text)]">
        <div className="grid h-24 w-24 place-items-center rounded-[30px] border border-[var(--primary)]/25 bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)]"><Icon size={42} strokeWidth={1.35} /></div>
        <h3 className="mt-5 text-xl font-semibold">{mode === "contacts" ? "Escolha um contato" : "Escolha um grupo"}</h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-[var(--text-secondary)]">{mode === "contacts" ? "Abra uma conversa usando o nome disponível no WhatsApp. O Norium mantém nomes e fotos retornados pela integração sincronizados." : "Abra o histórico, veja participantes e continue a conversa em grupo pelo Norium."}</p>
        {mode === "groups" && <button type="button" onClick={onCreateGroup} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-bold text-white"><Plus size={17} /> Novo grupo</button>}
      </main>
    </>
  );
}
