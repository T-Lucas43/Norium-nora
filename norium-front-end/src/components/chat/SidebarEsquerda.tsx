import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  MessageSquare,
  MoreVertical,
  Pin,
  PlusCircle,
  RefreshCw,
  Search,
  Settings,
  Star,
  Trash2,
  User,
  Users,
  VolumeX,
  X,
} from "lucide-react";
import type { ChatConversa } from "./types";
import type { WhatsAppSyncProgress } from "./whatsappApi";
import Button from "../shared/Button";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";

type ChatAction = "lida" | "fixada" | "favorita" | "silenciada" | "arquivada";
type Filter = "todos" | "nao-lidas" | "favoritos" | "grupos" | "arquivados";

interface SidebarProps {
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
}

function getInitials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function ChatAvatar({ chat }: { chat: ChatConversa }) {
  const [failed, setFailed] = useState(false);
  const photoUrl = useAuthenticatedMedia(chat.metadados?.photoUrl || chat.photoUrl);
  return (
    <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--background)] text-[var(--text-secondary)]">
      {photoUrl && !failed ? (
        <img src={photoUrl} alt={chat.contato} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : chat.esGrupo ? <Users size={17} /> : chat.contato ? (
        <span className="text-xs font-extrabold">{getInitials(chat.contato)}</span>
      ) : <User size={17} />}
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
}: SidebarProps) {
  const [filtroTipo, setFiltroTipo] = useState<Filter>("todos");
  const [menuAbertoId, setMenuAbertoId] = useState<string | null>(null);
  const [busca, setBusca] = useState("");

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
    return Number(b.timestampUltimaMsg || 0) - Number(a.timestampUltimaMsg || 0);
  }), [conversas]);

  const filtradas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return sorted.filter((chat) => {
      if (termo && !`${chat.contato} ${chat.ultimoTexto} ${chat.id}`.toLowerCase().includes(termo)) return false;
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
  }, [busca, conversaSelecionada, filtroTipo, sorted]);

  // Lista unificada: contatos e grupos juntos, em ordem de atividade/tempo
  // (fixadas no topo — ver `sorted`). Sem seções separadas de "Conversas"/"Grupos".
  const sections = useMemo(() => [{ label: "", items: filtradas }], [filtradas]);

  const counts = {
    unread: conversas.filter((chat) => !chat.arquivada && Number(chat.naoLidasCount || 0) > 0).length,
    favorites: conversas.filter((chat) => !chat.arquivada && chat.favorita).length,
    groups: conversas.filter((chat) => !chat.arquivada && chat.esGrupo).length,
    archived: conversas.filter((chat) => chat.arquivada).length,
  };

  const renderChat = (chat: ChatConversa) => {
    const unread = Number(chat.naoLidasCount || 0);
    const selected = conversaSelecionada === chat.id;
    return (
      <div
        key={chat.id}
        onClick={() => onSelecionar(chat.id)}
        className={`group/chat relative flex min-h-[72px] cursor-pointer items-center gap-3 border-b border-[var(--border)]/55 px-3 py-2.5 transition-colors ${selected ? "bg-[color-mix(in_srgb,var(--primary)_14%,var(--surface))]" : "hover:bg-[var(--surface-hover)]"}`}
      >
        <ChatAvatar chat={chat} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={`truncate text-sm text-[var(--text)] ${unread > 0 ? "font-extrabold" : "font-semibold"}`}>{chat.contato}</span>
            <span className={`shrink-0 text-[11px] ${unread > 0 ? "font-bold text-[var(--primary)]" : "text-[var(--text-secondary)]"}`}>{chat.horario}</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            {chat.fixada && <Pin size={11} className="shrink-0 rotate-45 text-[var(--primary)]" />}
            {chat.favorita && <Star size={11} fill="currentColor" className="shrink-0 text-[var(--primary)]" />}
            {chat.silenciada && <VolumeX size={11} className="shrink-0 text-[var(--text-secondary)]" />}
            <span className={`truncate text-xs ${unread > 0 ? "font-semibold text-[var(--text)]" : "text-[var(--text-secondary)]"}`}>{chat.ultimoTexto || "Sem mensagens recentes"}</span>
          </div>
        </div>
        {unread > 0 && <span className="absolute bottom-2.5 right-10 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--primary)] px-1.5 text-[10px] font-extrabold text-white">{unread > 99 ? "99+" : unread}</span>}

        <div className="relative" data-chat-menu-root>
          <Button variant="ghost" size="sm" iconOnly aria-label={`Acoes de ${chat.contato}`} onClick={(event) => { event.stopPropagation(); setMenuAbertoId(menuAbertoId === chat.id ? null : chat.id); }} className="text-[var(--text-secondary)] opacity-40 transition group-hover/chat:opacity-100">
            <MoreVertical size={16} />
          </Button>
          {menuAbertoId === chat.id && (
            <div className="absolute right-0 top-9 z-50 w-48 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 text-xs font-semibold text-[var(--text)] shadow-2xl">
              <button onClick={(e) => { e.stopPropagation(); onAcao(chat.id, "favorita", !chat.favorita); setMenuAbertoId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-hover)]"><Star size={13} /> {chat.favorita ? "Remover dos favoritos" : "Adicionar aos favoritos"}</button>
              <button onClick={(e) => { e.stopPropagation(); onAcao(chat.id, "fixada", !chat.fixada); setMenuAbertoId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-hover)]"><Pin size={13} /> {chat.fixada ? "Desfixar" : "Fixar"}</button>
              <button onClick={(e) => { e.stopPropagation(); onAcao(chat.id, "silenciada", !chat.silenciada); setMenuAbertoId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-hover)]"><VolumeX size={13} /> {chat.silenciada ? "Reativar som" : "Silenciar"}</button>
              <button onClick={(e) => { e.stopPropagation(); onAcao(chat.id, "arquivada", !chat.arquivada); setMenuAbertoId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-hover)]"><Archive size={13} /> {chat.arquivada ? "Desarquivar" : "Arquivar"}</button>
              <div className="my-1 h-px bg-[var(--border)]" />
              <button onClick={(e) => { onExcluir(chat.id, e); setMenuAbertoId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-500 hover:bg-[var(--surface-hover)]"><Trash2 size={13} /> Excluir</button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const filters: Array<[Filter, string, number | null]> = [
    ["todos", "Tudo", null],
    ["nao-lidas", "Nao lidas", counts.unread],
    ["favoritos", "Favoritos", counts.favorites],
    ["grupos", "Grupos", counts.groups],
    ["arquivados", "Arquivadas", counts.archived],
  ];

  return (
    <aside className="norium-chat-sidebar flex h-full min-h-0 w-[380px] min-w-[320px] select-none flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface)]">
      <div className="module-sidebar-mobile-header">
        <span><MessageSquare size={18} /> Conversas</span>
        <button type="button" onClick={onClose} aria-label="Fechar lista de conversas"><X size={19} /></button>
      </div>
      <div className="shrink-0 space-y-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold tracking-tight text-[var(--text)]">Norium WhatsApp</h2>
            <p className="text-[11px] font-medium text-[var(--text-secondary)]">{conversas.length} conversas em cache seguro</p>
          </div>
          <div className="flex items-center gap-0.5 text-[var(--text)]">
            <Button variant="ghost" size="sm" iconOnly onClick={onAtualizar} disabled={sincronizando} title="Sincronizar agora" aria-label="Sincronizar agora"><RefreshCw size={17} className={sincronizando ? "animate-spin" : ""} /></Button>
            <Button variant="ghost" size="sm" iconOnly onClick={onAbrirModalContatos} title="Novo chat" aria-label="Novo chat"><PlusCircle size={18} /></Button>
            <Button variant="ghost" size="sm" iconOnly onClick={onAbrirModalCriarGrupo} title="Criar grupo" aria-label="Criar grupo"><Users size={18} /></Button>
            <Button variant="ghost" size="sm" iconOnly onClick={onAbrirConfigPropria} title="Configuracoes" aria-label="Configuracoes"><Settings size={18} /></Button>
          </div>
        </div>
        <div className="flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 focus-within:border-[var(--primary)]">
          <Search size={15} className="text-[var(--text-secondary)]" />
          <input value={busca} onChange={(event) => setBusca(event.target.value)} placeholder="Pesquisar ou iniciar conversa" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-secondary)]" />
        </div>
        <div className="scrollbar-hide flex gap-1 overflow-x-auto text-xs font-semibold">
          {filters.map(([value, label, count]) => (
            <button key={value} onClick={() => setFiltroTipo(value)} className={`h-8 whitespace-nowrap rounded-full border px-3 transition ${filtroTipo === value ? "border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_18%,transparent)] text-[var(--primary)]" : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface-hover)]"}`}>
              {label}{count ? ` ${count}` : ""}
            </button>
          ))}
        </div>
      </div>

      {syncProgress && syncProgress.status !== "idle" && (sincronizando || syncProgress.status === "error") && (
        <div className={`shrink-0 border-b px-4 py-2.5 ${syncProgress.status === "error" ? "border-red-500/25 bg-red-500/10" : "border-[var(--primary)]/20 bg-[color-mix(in_srgb,var(--primary)_8%,transparent)]"}`} role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-[10px] font-bold">
            <span className="truncate text-[var(--text)]">{syncProgress.message || syncProgress.phase || "Sincronizando contatos e fotos"}</span>
            <span className="shrink-0 text-[var(--primary)]">{Math.round(Math.max(0, Math.min(100, syncProgress.progress || 0)))}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/50">
            <div className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, syncProgress.progress || 0))}%` }} />
          </div>
        </div>
      )}

      <div className="norium-chat-list min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {sections.map((section) => (
          <div key={section.label || filtroTipo}>
            {section.label && <div className="sticky top-0 z-10 border-b border-[var(--border)]/60 bg-[color-mix(in_srgb,var(--surface)_94%,transparent)] px-4 py-2 text-[10px] font-extrabold uppercase tracking-[0.16em] text-[var(--text-secondary)] backdrop-blur">{section.label} · {section.items.length}</div>}
            {section.items.map(renderChat)}
          </div>
        ))}
        {filtradas.length === 0 && <div className="p-8 text-center text-sm font-medium text-[var(--text-secondary)]">Nenhuma conversa encontrada.</div>}
      </div>
    </aside>
  );
}
