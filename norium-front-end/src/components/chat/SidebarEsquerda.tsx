import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  MessageSquare,
  MoreVertical,
  Pin,
  PlusCircle,
  Search,
  Settings,
  Trash2,
  User,
  Users,
  VolumeX,
  X,
} from "lucide-react";
import type { ChatConversa } from "./types";
import Button from "../shared/Button";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";

interface SidebarProps {
  conversas: ChatConversa[];
  conversaSelecionada: string | null;
  onSelecionar: (id: string) => void;
  onAcao: (id: string, acao: "lida" | "fixada" | "silenciada" | "arquivada", valor: boolean) => void;
  onExcluir: (id: string, e: React.MouseEvent) => void;
  onAbrirConfigPropria: () => void;
  onAbrirModalContatos: () => void;
  onAbrirModalCriarGrupo: () => void;
  onClose?: () => void;
}

function getInitials(name: string) {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function ChatAvatar({ chat }: { chat: ChatConversa }) {
  const [failed, setFailed] = useState(false);
  const photoUrl = useAuthenticatedMedia(chat.metadados?.photoUrl || chat.photoUrl);

  return (
    <div className="h-12 w-12 rounded-full bg-[var(--background)] border border-[var(--border)] flex items-center justify-center overflow-hidden shrink-0 text-[var(--text-secondary)]">
      {photoUrl && !failed ? (
        <img
          src={photoUrl}
          alt={chat.contato}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : chat.esGrupo ? (
        <Users size={18} />
      ) : chat.contato ? (
        <span className="text-xs font-extrabold">{getInitials(chat.contato)}</span>
      ) : (
        <User size={18} />
      )}
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
  onClose,
}: SidebarProps) {
  const [filtroTipo, setFiltroTipo] = useState<"todos" | "nao-lidas" | "grupos" | "arquivados">("todos");
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

  const filtradas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return conversas
      .filter((chat) => {
        if (filtroTipo === "arquivados") return chat.arquivada === true;
        if (chat.arquivada) return false;
        if (filtroTipo === "nao-lidas") return Boolean(chat.naoLidasCount && chat.naoLidasCount > 0);
        if (filtroTipo === "grupos") return chat.esGrupo === true;
        if (!termo) return true;
        return `${chat.contato} ${chat.ultimoTexto} ${chat.id}`.toLowerCase().includes(termo);
      })
      .sort((a, b) => {
        if (Boolean(a.fixada) !== Boolean(b.fixada)) return a.fixada ? -1 : 1;
        return Number(b.timestampUltimaMsg || 0) - Number(a.timestampUltimaMsg || 0);
      });
  }, [busca, conversas, filtroTipo]);

  return (
    <aside className="w-[400px] min-w-[340px] border-r border-[var(--border)] flex flex-col h-full bg-[var(--surface)] select-none">
      <div className="module-sidebar-mobile-header">
        <span><MessageSquare size={18} /> Conversas</span>
        <button type="button" onClick={onClose} aria-label="Fechar lista de conversas">
          <X size={19} />
        </button>
      </div>
      <div className="px-4 py-3 border-b border-[var(--border)] space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-[var(--text)]">Conversas</h2>
          <div className="flex items-center gap-1 text-[var(--text)]">
            <Button variant="ghost" size="sm" iconOnly onClick={onAbrirModalContatos} title="Novo chat" aria-label="Novo chat">
              <PlusCircle size={18} />
            </Button>
            <Button variant="ghost" size="sm" iconOnly onClick={onAbrirModalCriarGrupo} title="Criar grupo" aria-label="Criar grupo">
              <Users size={18} />
            </Button>
            <Button variant="ghost" size="sm" iconOnly onClick={onAbrirConfigPropria} title="Configuracoes" aria-label="Configuracoes">
              <Settings size={18} />
            </Button>
          </div>
        </div>

        <div className="h-10 rounded-lg bg-[var(--background)] border border-[var(--border)] flex items-center gap-2 px-3">
          <Search size={15} className="text-[var(--text-secondary)]" />
          <input
            value={busca}
            onChange={(event) => setBusca(event.target.value)}
            placeholder="Pesquisar ou comecar uma conversa"
            className="min-w-0 flex-1 bg-transparent outline-none text-sm text-[var(--text)] placeholder:text-[var(--text-secondary)]"
          />
        </div>

        <div className="flex gap-1 overflow-x-auto text-xs font-semibold scrollbar-hide">
          {[
            ["todos", "Todos"],
            ["nao-lidas", "Nao lidas"],
            ["grupos", "Grupos"],
            ["arquivados", "Arquivados"],
          ].map(([valor, label]) => (
            <button
              key={valor}
              onClick={() => setFiltroTipo(valor as typeof filtroTipo)}
              className={`h-8 px-3 rounded-full border whitespace-nowrap ${filtroTipo === valor ? "bg-[#00a884] text-[#0b141a] border-transparent" : "border-[var(--border)] hover:bg-[var(--surface-hover)] text-[var(--text)]"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtradas.map((chat) => {
          const unread = Number(chat.naoLidasCount || 0);
          return (
            <div
              key={chat.id}
              onClick={() => onSelecionar(chat.id)}
              className={`h-[76px] px-3 flex items-center gap-3 cursor-pointer transition-colors relative border-b border-[var(--border)]/50 ${conversaSelecionada === chat.id ? "bg-[#2a3942]/70" : "hover:bg-[var(--surface-hover)]"}`}
            >
              <ChatAvatar chat={chat} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate text-[var(--text)]">{chat.contato}</span>
                  <span className={`text-xs shrink-0 ${unread > 0 ? "text-emerald-600 font-bold" : "text-[var(--text-secondary)]"}`}>{chat.horario}</span>
                </div>

                <div className="mt-1 flex items-center gap-1.5 min-w-0">
                  {chat.fixada && <Pin size={12} className="text-[var(--primary)] rotate-45 shrink-0" />}
                  {chat.silenciada && <VolumeX size={12} className="text-[var(--text-secondary)] shrink-0" />}
                  <span className={`text-xs truncate ${unread > 0 ? "text-[var(--text)] font-semibold" : "text-[var(--text-secondary)]"}`}>{chat.ultimoTexto || "Sem mensagens recentes"}</span>
                </div>

                <span className="mt-1 inline-flex h-5 items-center rounded-full bg-emerald-500/10 px-2 text-xs font-bold uppercase text-emerald-600">
                  WhatsApp
                </span>
              </div>

              {unread > 0 && (
                <div className="absolute right-10 bottom-4 h-5 min-w-5 px-1.5 bg-emerald-500 rounded-full flex items-center justify-center text-xs font-extrabold text-white">
                  {unread > 99 ? "99+" : unread}
                </div>
              )}

              <div className="relative" data-chat-menu-root>
                <Button variant="ghost" size="sm" iconOnly
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuAbertoId(menuAbertoId === chat.id ? null : chat.id);
                  }}
                  className="hover:bg-[var(--background)] text-[var(--text-secondary)]"
                >
                  <MoreVertical size={16} />
                </Button>

                {menuAbertoId === chat.id && (
                  <div className="absolute right-0 top-9 w-48 bg-[#233138] border border-white/10 rounded-lg shadow-2xl z-50 py-1 text-xs font-semibold text-[#e9edef]">
                    <button onClick={(event) => { event.stopPropagation(); onAcao(chat.id, "fixada", !chat.fixada); setMenuAbertoId(null); }} className="w-full px-3 py-2 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2">
                      <Pin size={13} /> {chat.fixada ? "Desfixar" : "Fixar"}
                    </button>
                    <button onClick={(event) => { event.stopPropagation(); onAcao(chat.id, "silenciada", !chat.silenciada); setMenuAbertoId(null); }} className="w-full px-3 py-2 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2">
                      <VolumeX size={13} /> {chat.silenciada ? "Reativar som" : "Silenciar"}
                    </button>
                    <button onClick={(event) => { event.stopPropagation(); onAcao(chat.id, "arquivada", !chat.arquivada); setMenuAbertoId(null); }} className="w-full px-3 py-2 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2">
                      <Archive size={13} /> {chat.arquivada ? "Desarquivar" : "Arquivar"}
                    </button>
                    <div className="my-1 h-px bg-[var(--border)]" />
                    <button onClick={(event) => { onExcluir(chat.id, event); setMenuAbertoId(null); }} className="w-full px-3 py-2 text-left text-red-500 hover:bg-[var(--surface-hover)] flex items-center gap-2">
                      <Trash2 size={13} /> Excluir
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {filtradas.length === 0 && (
          <div className="p-8 text-center text-sm font-medium text-[var(--text-secondary)]">
            Nenhuma conversa encontrada.
          </div>
        )}
      </div>
    </aside>
  );
}
