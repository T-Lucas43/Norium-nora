import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  SlidersHorizontal,
  ListChecks,
  MessageSquare,
  MoreVertical,
  Pin,
  RefreshCw,
  Search,
  SquarePen,
  Star,
  Trash2,
  User,
  Users,
  VolumeX,
  X,
} from "lucide-react";
import type { ChatConversa } from "./types";
import type { WhatsAppSyncProgress } from "./whatsappApi";
import { useWhatsAppProfilePhoto } from "./useAuthenticatedMedia";
import { conversationDisplayName, isTechnicalWhatsAppLabel } from "./contactPicker";
import { avatarColor } from "./avatarColor";
import { requestScope } from "../../core/api/sessionScope";
import { useConversationLabels } from "../business/useConversationLabels";
import SelectionTagDialog from "../business/SelectionTagDialog";
import Button from "../shared/Button";
import { saveBlob } from "../clients/clientModel";
import { ContactLabels } from "./ContactLabels";
import VirtualConversationList from "./VirtualConversationList";
import { useConversationSearch } from "./useConversationSearch";
import type { ReactNode } from "react";
import { useWhatsAppScope } from "./WhatsAppScope";

type ChatAction = "lida" | "fixada" | "favorita" | "silenciada" | "arquivada";
type Filter = "todos" | "nao-lidas" | "favoritos" | "grupos" | "arquivados";

interface SidebarProps {
  attendanceFilters?: ReactNode;
  conversas: ChatConversa[];
  conversaSelecionada: string | null;
  onSelecionar: (id: string) => void;
  onAcao: (id: string, acao: ChatAction, valor: boolean) => void;
  onExcluir: (id: string, e: React.MouseEvent) => void;
  onAbrirConfigPropria: () => void;
  onAbrirModalContatos: () => void;
  onAbrirModalCriarGrupo: () => void;
  onAtualizar: () => void;
  sincronizando?: boolean;
  syncProgress?: WhatsAppSyncProgress | null;
  onClose?: () => void;
  connected?: boolean;
  onSearchResults?: (items: ChatConversa[]) => void;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}

function getInitials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function ChatAvatar({ chat }: { chat: ChatConversa }) {
  const { inboxId } = useWhatsAppScope();
  const { source: photoUrl, onError } = useWhatsAppProfilePhoto(inboxId ? undefined : chat.id, chat.metadados?.photoUrl || chat.photoUrl);
  const displayName = conversationDisplayName(chat);
  const showInitials = !photoUrl && !chat.esGrupo && Boolean(displayName) && !isTechnicalWhatsAppLabel(displayName);
  return (
    <div className={`nx-conv-av h-9 w-9 ${showInitials ? "" : "is-photo"}`} style={showInitials ? { background: avatarColor(displayName) } : undefined}>
      {photoUrl ? (
        <img src={photoUrl} alt={displayName} className="h-full w-full object-cover" onError={onError} />
      ) : chat.esGrupo ? <Users size={16} /> : showInitials ? (
        <span>{getInitials(displayName)}</span>
      ) : <User size={16} />}
    </div>
  );
}

export default function SidebarEsquerda({
  conversas,
  conversaSelecionada,
  onSelecionar,
  onAcao,
  onExcluir,
  onAbrirConfigPropria,
  onAbrirModalContatos,
  onAbrirModalCriarGrupo,
  onAtualizar,
  sincronizando = false,
  syncProgress,
  onClose,
  connected = false,
  onSearchResults, onLoadMore, loadingMore = false,
  attendanceFilters,
}: SidebarProps) {
  const { inboxId } = useWhatsAppScope();
  const [filtroTipo, setFiltroTipo] = useState<Filter>("todos");
  const [menuAbertoId, setMenuAbertoId] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const serverSearch = useConversationSearch(busca, onSearchResults);
  const scope = requestScope(); const labels = useConversationLabels("conversations", !inboxId);
  const [selectionMode, setSelectionMode] = useState(false); const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  useEffect(() => { setSelectedIds([]); setSelectionMode(false); setBulkTagsOpen(false); setBusca(""); }, [scope]);
  useEffect(() => { const available = new Set(conversas.map(chat => chat.id)); setSelectedIds(current => current.some(id => !available.has(id)) ? current.filter(id => available.has(id)) : current); }, [conversas]);
  function exportSelected() {
    const cell = (raw: string) => { const value = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw; return `"${value.replaceAll('"', '""')}"`; };
    const rows = [["Nome", "WhatsApp"], ...conversas.filter(chat => selectedIds.includes(chat.id)).map(chat => [conversationDisplayName(chat), chat.metadados?.numeroCompleto || chat.id])];
    saveBlob(new Blob(["\uFEFF"+rows.map(row => row.map(cell).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }), "contatos-whatsapp-selecionados.csv");
  }

  useEffect(() => {
    const fecharMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-chat-menu-root]")) setMenuAbertoId(null);
    };
    document.addEventListener("mousedown", fecharMenu);
    return () => document.removeEventListener("mousedown", fecharMenu);
  }, []);

  const sorted = useMemo(() => [...conversas].sort((a, b) => {
    if (Boolean(a.fixada) !== Boolean(b.fixada)) return a.fixada ? -1 : 1;
    return Number(b.timestampUltimaMsg || 0) - Number(a.timestampUltimaMsg || 0)
      || a.contato.localeCompare(b.contato, "pt-BR", { sensitivity: "base" }) || a.id.localeCompare(b.id);
  }), [conversas]);

  const filtradas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return sorted.filter((chat) => {
      if (labels.matching && !labels.matching.has(chat.id)) return false;
      if (termo && (serverSearch.matching ? !serverSearch.matching.has(chat.id) : !`${chat.contato} ${chat.ultimoTexto} ${chat.id}`.toLowerCase().includes(termo))) return false;
      if (filtroTipo === "arquivados") return chat.arquivada === true;
      if (chat.arquivada) return false;
      // Ao abrir uma conversa ela e marcada como lida no WhatsApp. Mantemos a
      // conversa selecionada visivel para que ela nao desapareca sob o cursor
      // enquanto o usuario ainda esta lendo/respondendo dentro deste filtro.
      if (filtroTipo === "nao-lidas") return Number(chat.naoLidasCount || 0) > 0 || chat.id === conversaSelecionada;
      if (filtroTipo === "favoritos") return chat.favorita === true;
      if (filtroTipo === "grupos") return chat.esGrupo === true;
      return true;
    });
  }, [busca, conversaSelecionada, filtroTipo, sorted, labels.matching, serverSearch.matching]);

  // Lista unificada: contatos e grupos juntos, em ordem de atividade/tempo
  // (fixadas no topo — ver `sorted`). Sem seções separadas de "Conversas"/"Grupos".

  const counts = {
    unread: conversas.filter((chat) => !chat.arquivada && Number(chat.naoLidasCount || 0) > 0).length,
    favorites: conversas.filter((chat) => !chat.arquivada && chat.favorita).length,
    groups: conversas.filter((chat) => !chat.arquivada && chat.esGrupo).length,
    archived: conversas.filter((chat) => chat.arquivada).length,
  };

  const renderChat = (chat: ChatConversa) => {
    const unread = Number(chat.naoLidasCount || 0);
    const selected = conversaSelecionada === chat.id;
    const displayName = conversationDisplayName(chat);
    return (
      <div
        key={chat.id}
        onClick={() => onSelecionar(chat.id)}
        role="button" tabIndex={0} aria-label={`Abrir conversa com ${displayName}`}
        onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelecionar(chat.id); } }}
        className={`nx-conv-row group/chat relative flex cursor-pointer items-center gap-2.5 px-4 py-3 ${selected ? "is-selected" : ""}`}
      >
        {selectionMode && <input type="checkbox" checked={selectedIds.includes(chat.id)} disabled={!selectedIds.includes(chat.id) && selectedIds.length >= 100} aria-label={`Selecionar conversa com ${displayName}`} onClick={event => event.stopPropagation()} onChange={event => setSelectedIds(current => event.target.checked ? [...current, chat.id] : current.filter(id => id !== chat.id))} />}
        <ChatAvatar chat={chat} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[13.5px] font-semibold text-[var(--nx-text)]">{displayName}</span>
            <span className={`shrink-0 text-xs ${unread > 0 ? "font-medium text-[var(--nx-primary-text)]" : "text-[var(--nx-text-3)]"}`}>{chat.horario}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {chat.fixada && <Pin size={11} className="shrink-0 rotate-45 text-[var(--nx-text-3)]" aria-label="Fixada" />}
            {chat.favorita && <Star size={11} fill="currentColor" className="shrink-0 text-[var(--nx-warning)]" aria-label="Favorita" />}
            {chat.silenciada && <VolumeX size={11} className="shrink-0 text-[var(--nx-text-3)]" aria-label="Silenciada" />}
            <span className={`min-w-0 flex-1 truncate text-[12.5px] ${unread > 0 ? "text-[var(--nx-text)]" : "text-[var(--nx-text-2)]"}`}>{chat.ultimoTexto || "Sem mensagens recentes"}</span>
            {unread > 0 && <span className="nx-conv-count">{unread > 99 ? "99+" : unread}</span>}
          </div>
          <ContactLabels contactId={chat.id} />
          {chat.assignee && <small className="nx-whatsapp-assignment-label">{chat.assignee.status === "resolved" ? "Resolvida" : chat.assignee.status === "waiting_customer" ? "Aguardando · " : ""}{chat.assignee.status !== "resolved" && (chat.assignee.name || (chat.assignee.assigneeKind === "nora" ? "Nora atendendo" : "Sem responsável"))}</small>}
        </div>

        <div className="relative -mr-2" data-chat-menu-root>
          <button type="button" aria-label={`Acoes de ${displayName}`} title="Mais ações" onClick={(event) => { event.stopPropagation(); setMenuAbertoId(menuAbertoId === chat.id ? null : chat.id); }} className="nx-conv-iconbtn h-7 w-7 opacity-40 transition group-hover/chat:opacity-100 focus:opacity-100">
            <MoreVertical size={16} />
          </button>
          {menuAbertoId === chat.id && (
            <div className="nx-conv-menu absolute right-0 top-8 z-50 w-52 overflow-hidden py-1">
              <button onClick={(e) => { e.stopPropagation(); onAcao(chat.id, "favorita", !chat.favorita); setMenuAbertoId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left"><Star size={14} /> {chat.favorita ? "Remover dos favoritos" : "Adicionar aos favoritos"}</button>
              <button onClick={(e) => { e.stopPropagation(); onAcao(chat.id, "fixada", !chat.fixada); setMenuAbertoId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left"><Pin size={14} /> {chat.fixada ? "Desfixar" : "Fixar"}</button>
              <button onClick={(e) => { e.stopPropagation(); onAcao(chat.id, "silenciada", !chat.silenciada); setMenuAbertoId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left"><VolumeX size={14} /> {chat.silenciada ? "Reativar som" : "Silenciar"}</button>
              <button onClick={(e) => { e.stopPropagation(); onAcao(chat.id, "arquivada", !chat.arquivada); setMenuAbertoId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left"><Archive size={14} /> {chat.arquivada ? "Desarquivar" : "Arquivar"}</button>
              <div className="my-1 h-px bg-[var(--nx-border)]" />
              <button onClick={(e) => { onExcluir(chat.id, e); setMenuAbertoId(null); }} className="is-danger flex w-full items-center gap-2 px-3 py-2 text-left"><Trash2 size={14} /> Excluir</button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const filters: Array<[Filter, string, number | null]> = [
    ["todos", "Tudo", null],
    ["nao-lidas", "Não lidas", counts.unread],
    ["favoritos", "Favoritos", counts.favorites],
    ["grupos", "Grupos", counts.groups],
    ["arquivados", "Arquivadas", counts.archived],
  ];

  return (
    <aside className="norium-chat-sidebar flex h-full min-h-0 w-[300px] min-w-[280px] select-none flex-col overflow-hidden border-r border-[var(--nx-border)] bg-[var(--nx-surface)]">
      <div className="module-sidebar-mobile-header">
        <span><MessageSquare size={18} /> Conversas</span>
        <button type="button" onClick={onClose} aria-label="Fechar lista de conversas"><X size={19} /></button>
      </div>
      <div className="business-conversation-header shrink-0 space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="nx-whatsapp-list-title"><h2 className="truncate text-[16px] font-semibold text-[var(--nx-text)]">Conversas</h2>
              <button type="button" className={`nx-whatsapp-connection ${connected ? "is-connected" : ""}`} onClick={onAbrirConfigPropria}>{connected ? "Conectado" : "Desconectado"}</button></div>
          </div>
          <div className="flex items-center gap-0.5">
            <button type="button" className="nx-conv-iconbtn" onClick={onAtualizar} disabled={sincronizando} title="Sincronizar agora" aria-label="Sincronizar agora"><RefreshCw size={16} className={sincronizando ? "animate-spin" : ""} /></button>
            <button type="button" className="nx-conv-iconbtn" onClick={onAbrirModalContatos} title="Novo chat" aria-label="Novo chat"><SquarePen size={16} /></button>
            <button type="button" className="nx-conv-iconbtn" onClick={onAbrirModalCriarGrupo} title="Criar grupo" aria-label="Criar grupo"><Users size={16} /></button>
          </div>
        </div>
        <label className="nx-conv-search">
          <Search size={16} />
          <input value={busca} onChange={(event) => setBusca(event.target.value)} placeholder="Buscar nome, telefone ou mensagem" aria-label="Buscar conversa" />
        </label>
        {serverSearch.loading && <p className="business-note" role="status">Buscando no histórico sincronizado…</p>}
        {serverSearch.error && <p className="business-note" role="status">Busca indisponível. Mostrando o cache local.</p>}
        {attendanceFilters}
        <div className="nx-whatsapp-list-filters">
          <select className="nx-whatsapp-filter-select" aria-label="Filtrar conversas" value={filtroTipo} onChange={event => setFiltroTipo(event.target.value as Filter)}>
            {filters.map(([value, label, count]) => <option key={value} value={value}>{label}{count ? ` (${count})` : ""}</option>)}
          </select>
          <details className="nx-whatsapp-list-tools"><summary className="nx-btn is-sm" aria-label="Etiquetas e seleção"><SlidersHorizontal size={14} />Etiquetas e seleção</summary>
            <div className="nx-whatsapp-list-tools-menu">
              {!inboxId && labels.toolbar}
              <Button size="sm" icon={<ListChecks size={14} />} onClick={() => { setSelectionMode(current => !current); setSelectedIds([]); setBulkTagsOpen(false); }}>{selectionMode ? "Encerrar seleção" : "Selecionar conversas"}</Button>
            </div>
          </details>
        </div>
      </div>

      {syncProgress?.requiresPro && (
        <div className="nx-conv-alert shrink-0" role="alert">
          <p className="text-[12.5px] font-semibold">A agenda completa exige uma instância W-API PRO.</p>
          <p className="mt-1 text-xs leading-5 opacity-90">
            {syncProgress.reconnectRequired
              ? "Abra as configurações, desconecte e conecte o WhatsApp novamente para o Norium criar a instância PRO."
              : "Reconecte a integração com uma instância PRO para liberar todos os nomes e contatos."}
          </p>
          <button
            type="button"
            onClick={onAbrirConfigPropria}
          >
            Abrir configurações para reconectar
          </button>
          {syncProgress.status === "partial" && (
            <button
              type="button"
              onClick={onAtualizar}
              className="ml-2"
            >
              Atualizar novamente
            </button>
          )}
        </div>
      )}

      {syncProgress?.status === "partial" && !syncProgress.requiresPro && (
        <div className="nx-conv-alert shrink-0" role="alert">
          <p className="text-[12.5px] font-semibold">Sincronização parcial do WhatsApp</p>
          <p className="mt-1 text-xs leading-5 opacity-90">
            {syncProgress.message || "O Norium carregou o cache disponível, mas parte do catálogo ainda precisa ser atualizada."}
          </p>
          {Boolean(syncProgress.catalogWarnings?.length) && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs opacity-90">
              {syncProgress.catalogWarnings?.slice(0, 3).map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}
          <button
            type="button"
            onClick={onAtualizar}
          >
            Atualizar novamente
          </button>
        </div>
      )}

      {syncProgress && !syncProgress.requiresPro && syncProgress.status !== "idle" && (sincronizando || syncProgress.status === "error") && (
        <div className={`shrink-0 border-t border-[var(--nx-border)] px-4 py-2.5 ${syncProgress.status === "error" ? "bg-[var(--nx-danger-soft)]" : "bg-[var(--nx-surface-2)]"}`} role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className={`truncate ${syncProgress.status === "error" ? "text-[var(--nx-danger)]" : "text-[var(--nx-text-2)]"}`}>{syncProgress.message || syncProgress.phase || "Sincronizando contatos e fotos"}</span>
            <span className="shrink-0 font-medium text-[var(--nx-primary-text)]">{Math.round(Math.max(0, Math.min(100, syncProgress.progress || 0)))}%</span>
          </div>
          <div className="nx-conv-progress mt-1.5">
            <i style={{ width: `${Math.max(0, Math.min(100, syncProgress.progress || 0))}%` }} />
          </div>
        </div>
      )}

      <VirtualConversationList items={filtradas} renderItem={renderChat}
        onReachEnd={busca.trim() ? serverSearch.hasMore ? serverSearch.more : undefined : !loadingMore ? onLoadMore : undefined}
        footer={<div className="nx-whatsapp-list-footer">{labels.more}
          {busca.trim() ? serverSearch.hasMore && <Button size="sm" disabled={serverSearch.loading} onClick={serverSearch.more}>Mais resultados ({serverSearch.total})</Button>
            : onLoadMore && <Button size="sm" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Carregando conversas…" : "Carregar mais conversas"}</Button>}</div>}
        empty={!labels.loading && <div className="border-t border-[var(--nx-border)] p-8 text-center text-[13px] text-[var(--nx-text-3)]">Nenhuma conversa encontrada.</div>} />
      {selectionMode && <div className="business-conversation-bulk" role="region" aria-label="Ações para conversas selecionadas"><strong>{selectedIds.length}/100 selecionadas</strong><div className="flex flex-wrap gap-2"><Button size="sm" disabled={!selectedIds.length || Boolean(inboxId)} title={inboxId ? "Etiquetas em equipe: próxima etapa" : undefined} onClick={() => setBulkTagsOpen(true)}>Etiqueta</Button><Button size="sm" disabled={!selectedIds.length} onClick={exportSelected}>Exportar contatos</Button><Button size="sm" onClick={() => setSelectedIds([])}>Limpar</Button></div></div>}
      {bulkTagsOpen && selectedIds.length > 0 && <SelectionTagDialog ids={selectedIds} target="conversations" onClose={() => setBulkTagsOpen(false)} />}
    </aside>
  );
}
