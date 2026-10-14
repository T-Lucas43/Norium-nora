import { BellOff, Hash, MessageSquare, Pin, PinOff, Plus, Search, X } from "lucide-react";
import { useState } from "react";
import type { ConversationListItem } from "./TeamConversationList";
import type { NoriumUser } from "../../types/auth";
import NoraAvatar from "../layout/NoraAvatar";
import TeamChatDialog from "./TeamChatDialog";
import type { PresenceState } from "./TeamStatusDialog";

export default function TeamConversationNavigation({ items, selectedId, loading, pinningId, onSelect, onPin, onCreate, onNora, user, states, onStatus }: {
  items: ConversationListItem[]; selectedId: string; loading: boolean; pinningId: string; user: NoriumUser;
  onSelect: (item: ConversationListItem) => void; onPin: (item: ConversationListItem) => void; onCreate: () => void; onNora?: () => void;
  states?: Record<string, PresenceState>; onStatus?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unread" | "mentions">("all");
  const [picker, setPicker] = useState(false);
  const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
  const visible = items.filter((item) => normalize(item.title).includes(normalize(query)) && (filter === "all" || filter === "unread" && item.unreadCount > 0 || filter === "mentions" && (item.mentionCount || 0) > 0))
    .sort((a, b) => (b.lastMessage?.createdAt || "").localeCompare(a.lastMessage?.createdAt || "") || a.title.localeCompare(b.title));
  function row(item: ConversationListItem) {
    const presence = item.scope === "direct" ? states?.[item.recipientId || ""] : undefined;
    return <div key={item.id} role={item.scope === "team" ? "region" : undefined} aria-label={item.scope === "team" ? "Time todo" : undefined} className={`team-conversation-row ${selectedId === item.id ? "is-selected" : ""}`}><button type="button" className="team-conversation-open" onClick={() => { onSelect(item); setPicker(false); }} aria-label={`Abrir conversa ${item.title}`} aria-current={selectedId === item.id ? "true" : undefined}>
      <span className={`team-conversation-avatar is-${item.scope}`} data-presence={presence?.state}>{item.avatar ? <img loading="lazy" src={item.avatar} alt="" /> : item.scope === "direct" ? item.title.split(/\s+/).slice(0, 2).map((p) => p[0]).join("") : <Hash size={16} />}{item.online && <i aria-label="Online" />}</span>
      <span className="team-conversation-copy"><span className="team-conversation-title"><strong>{item.title}</strong>{item.lastMessage && <time>{new Date(item.lastMessage.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time>}</span><span className="team-conversation-preview"><span>{item.lastMessage ? `${item.lastMessage.senderName}: ${item.lastMessage.text}` : item.scope === "direct" ? item.online ? "Online agora" : "Iniciar uma conversa" : "Toda a equipe em um só lugar"}</span>{item.unreadCount > 0 && <b aria-label={`${item.unreadCount} mensagens não lidas`}>{item.unreadCount > 99 ? "99+" : item.unreadCount}</b>}</span>{(item.mentionCount || 0) > 0 && <small className="team-v3-mention-count">@ {item.mentionCount} menções</small>}</span></button>
      {presence && <small className="team-v3-direct-context">{presence.emoji} {presence.text || [presence.label, presence.context].filter(Boolean).join(" · ")}</small>}{(item.notificationMode === "none" || item.mutedUntil && Date.parse(item.mutedUntil) > Date.now()) && <BellOff className="team-v3-muted" size={12} aria-label="Conversa silenciada" />}
      <button type="button" className={`team-conversation-pin ${item.pinned ? "is-pinned" : ""}`} disabled={pinningId === item.id} onClick={() => onPin(item)} aria-label={`${item.pinned ? "Desafixar" : "Fixar"} conversa ${item.title}`} title={item.pinned ? "Desafixar conversa" : "Fixar conversa"}>{item.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button></div>;
  }
  return <aside className="team-conversations team-v3-navigation" aria-label="Conversas da equipe"><div className="team-conversations-heading"><strong>Conversas</strong><button type="button" className="team-icon-button" aria-label="Nova conversa" title="Nova conversa" onClick={() => setPicker(true)}><Plus size={16} /></button></div>
    <label className="team-conversation-search"><Search size={16} /><input aria-label="Buscar conversas" placeholder="Buscar conversa ou pessoa" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="Limpar busca" onClick={() => setQuery("")}><X size={14} /></button>}</label>
    <div className="team-conversation-filters">{([['all', 'Todas'], ['unread', 'Não lidas'], ['mentions', 'Menções']] as const).map(([id, title]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{title}</button>)}</div>
    <div className="team-conversations-scroll">{onNora && <section aria-label="Nora"><h3>Assistente</h3><button type="button" className="team-v3-nora-link" onClick={onNora}><NoraAvatar className="h-8 w-8" /><span><strong>Nora</strong><small>Sua conversa privada</small></span></button></section>}
      {loading && !items.length && <p role="status">Carregando conversas...</p>}
      {([['pinned', 'Fixadas'], ['subteam', 'Subequipes'], ['direct', 'Mensagens diretas']] as const).map(([id, label]) => <section key={id} aria-label={id === "direct" ? "Contatos" : label}><h3>{id === "pinned" ? <Pin size={12} /> : id === "direct" ? <MessageSquare size={12} /> : <Hash size={12} />}{label}{id !== "pinned" && <button type="button" className="team-icon-button" onClick={id === "subteam" ? onCreate : () => setPicker(true)} aria-label={id === "subteam" ? "Criar subequipe" : "Nova mensagem direta"} title={id === "subteam" ? "Criar subequipe" : "Nova mensagem direta"}><Plus size={14} /></button>}</h3>{visible.filter((item) => id === "pinned" ? item.pinned : !item.pinned && (id === "subteam" ? item.scope !== "direct" : item.scope === "direct")).map(row)}</section>)}
      {!loading && !visible.length && <p className="team-conversation-empty">Nenhuma conversa encontrada. <button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>Mostrar todas</button></p>}
    </div><div className="team-v3-user">{user.fotoUrl ? <img src={user.fotoUrl} alt="" /> : <span>{user.nome.split(/\s+/).slice(0, 2).map((p) => p[0]).join("")}</span>}<div><strong>{user.nome}</strong><small>{states?.[user.id]?.text || states?.[user.id]?.label || "Disponível"}</small></div></div>
    {picker && <TeamChatDialog title="Nova conversa" onClose={() => setPicker(false)}><button className="nx-btn" onClick={() => { setPicker(false); onCreate(); }}>Criar subequipe</button><p>Selecione uma pessoa da equipe</p><div className="team-v3-picker-list">{items.filter((item) => item.scope === "direct").map(row)}</div></TeamChatDialog>}
    {onStatus && <button type="button" className="team-v3-set-status" onClick={onStatus}>Definir status · {states?.[user.id]?.label || "Disponível"}</button>}
  </aside>;
}
