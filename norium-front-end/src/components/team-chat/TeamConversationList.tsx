import { Hash, MessageSquare, Pin, PinOff, Plus, Search, Users, X } from "lucide-react";
import { useState } from "react";
import type { TeamConversation } from "./teamChatConversations";

export type ConversationListItem = TeamConversation & { title: string; avatar?: string; online?: boolean };

export default function TeamConversationList({ items, selectedId, loading, pinningId, onSelect, onPin, onCreate }: {
  items: ConversationListItem[]; selectedId: string; loading: boolean; pinningId: string;
  onSelect: (item: ConversationListItem) => void;
  onPin: (item: ConversationListItem) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const normalized = query.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
  const visible = items.filter((item) => (!unreadOnly || item.unreadCount > 0) && item.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").includes(normalized))
    .sort((a, b) => (b.lastMessage?.createdAt || "").localeCompare(a.lastMessage?.createdAt || "") || a.title.localeCompare(b.title));
  return <aside className="team-conversations" aria-label="Conversas da equipe">
    <div className="team-conversations-heading"><span>Conversas <small>{items.length}</small></span><button type="button" className="team-icon-button" onClick={onCreate} aria-label="Criar subequipe" title="Criar subequipe"><Plus size={18} /></button></div>
    <label className="team-conversation-search"><Search size={16} /><input aria-label="Buscar conversas" placeholder="Buscar conversa ou pessoa" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="Limpar busca" onClick={() => setQuery("")}><X size={14} /></button>}</label>
    <div className="team-conversation-filters"><button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>Todas</button><button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Não lidas {items.reduce((sum, item) => sum + (item.unreadCount > 0 ? 1 : 0), 0) || ""}</button></div>
    <div className="team-conversations-scroll">
      {loading && !items.length && <p className="team-conversation-empty" role="status">Carregando conversas...</p>}
      {(["team", "subteam", "direct"] as const).map((scope) => {
        const group = visible.filter((item) => item.scope === scope).sort((a, b) => Number(b.pinned) - Number(a.pinned));
        const label = scope === "team" ? "Time todo" : scope === "subteam" ? "Subequipes" : "Contatos";
        return group.length > 0 && <section key={scope} aria-label={label}>
          <h3>{scope === "team" ? <Users size={12} /> : scope === "subteam" ? <Hash size={12} /> : <MessageSquare size={12} />}{label}{scope === "direct" && <span className="team-contacts-online-count">{items.filter((item) => item.scope === "direct" && item.online).length} online</span>}</h3>
          {group.map((item) => {
            const Icon = item.scope === "team" ? Users : item.scope === "subteam" ? Hash : MessageSquare;
            const date = item.lastMessage?.createdAt ? new Date(item.lastMessage.createdAt) : null;
            const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString("pt-BR") === new Date().toLocaleDateString("pt-BR") ? date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "";
            return <div key={item.id} className={`team-conversation-row ${selectedId === item.id ? "is-selected" : ""}`}>
              <button type="button" className="team-conversation-open" onClick={() => onSelect(item)} aria-label={`Abrir conversa ${item.title}`} aria-current={selectedId === item.id ? "true" : undefined}>
                <span className={`team-conversation-avatar is-${item.scope}`}>{item.avatar ? <img src={item.avatar} alt="" /> : item.scope === "direct" ? item.title.split(/\s+/).slice(0, 2).map((part) => part[0]).join("") : <Icon size={18} />}{item.online && <i aria-label="Online" />}</span>
                <span className="team-conversation-copy"><span className="team-conversation-title"><strong>{item.title}</strong><time>{time}</time></span><span className="team-conversation-preview"><span>{item.lastMessage ? `${item.lastMessage.senderName}: ${item.lastMessage.text}` : item.scope === "team" ? "Toda a equipe em um só lugar" : item.scope === "subteam" ? "Conversa da subequipe" : "Iniciar uma conversa"}</span>{item.unreadCount > 0 && <b aria-label={`${item.unreadCount} mensagens não lidas`}>{item.unreadCount > 99 ? "99+" : item.unreadCount}</b>}</span>{item.scope === "direct" && <span className={`team-contact-presence ${item.online ? "is-online" : ""}`}><i />{item.online ? "Online agora" : "Offline"}</span>}</span>
              </button>
              <button type="button" className={`team-conversation-pin ${item.pinned ? "is-pinned" : ""}`} disabled={pinningId === item.id} onClick={() => onPin(item)} aria-label={`${item.pinned ? "Desafixar" : "Fixar"} conversa ${item.title}`} title={item.pinned ? "Desafixar conversa" : "Fixar conversa"}>{item.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
            </div>;
          })}
        </section>;
      })}
      {!loading && !visible.length && <div className="team-conversation-empty"><Search size={24} /><p>{unreadOnly ? "Nenhuma conversa não lida." : "Nenhuma conversa encontrada."}</p>{(query || unreadOnly) && <button type="button" onClick={() => { setQuery(""); setUnreadOnly(false); }}>Mostrar todas</button>}</div>}
    </div>
    <div className="team-conversations-tip"><Pin size={13} /><span>As fixadas ficam no topo de cada seção.</span></div>
  </aside>;
}
