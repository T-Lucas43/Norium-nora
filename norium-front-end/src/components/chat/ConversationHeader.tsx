import { Archive, ArrowLeft, Languages, MoreVertical, PanelRight, Search, Trash2, VolumeX } from "lucide-react";
import type { ReactNode } from "react";

type Action = "silenciar" | "arquivar" | "papel" | "excluir";

export default function ConversationHeader({ avatar, name, subtitle, group, panelOpen, searching, translating,
  onPanel, onSearch, onTranslate, onBack, onAction }: {
  avatar: ReactNode; name: string; subtitle: string; group: boolean; panelOpen?: boolean;
  searching: boolean; translating: boolean; onPanel: () => void; onSearch: () => void;
  onTranslate: () => void; onBack?: () => void; onAction?: (action: Action) => void;
}) {
  return <header className="nx-conv-thread-head nx-whatsapp-thread-header">
    {onBack && <button type="button" className="nx-conv-iconbtn nx-whatsapp-back" aria-label="Voltar para conversas" onClick={onBack}><ArrowLeft size={18} /></button>}
    <button type="button" className="nx-whatsapp-contact-title" onClick={onPanel} title="Abrir dados do contato">
      {avatar}<span><strong>{name}</strong><small>{subtitle || (group ? "Grupo do WhatsApp" : "WhatsApp")}</small></span>
    </button>
    <div className="nx-whatsapp-header-actions">
      <span className="nx-badge is-green nx-whatsapp-channel">WhatsApp</span>
      <button type="button" className="nx-conv-iconbtn nx-whatsapp-header-inline" aria-label="Pesquisar" title="Pesquisar nesta conversa" aria-pressed={searching} onClick={onSearch}><Search size={16} /></button>
      <button type="button" className="nx-conv-iconbtn nx-whatsapp-header-inline" aria-label="Traduzir" title="Traduzir" aria-pressed={translating} onClick={onTranslate}><Languages size={16} /></button>
      <button type="button" className="nx-conv-iconbtn" aria-label="Dados" title="Painel do cliente" aria-expanded={panelOpen} onClick={onPanel}><PanelRight size={16} /></button>
      <details className="nx-whatsapp-header-menu" onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.stopPropagation(); } }}>
        <summary className="nx-conv-iconbtn" aria-label="Mais ações da conversa" title="Mais ações da conversa"><MoreVertical size={17} /></summary>
        <div className="nx-conv-menu">
          <button type="button" className="nx-whatsapp-overflow-search" aria-label="Pesquisar" onClick={onSearch}><Search size={15} />Pesquisar nesta conversa</button>
          <button type="button" className="nx-whatsapp-overflow-search" aria-label="Traduzir" onClick={onTranslate}><Languages size={15} />Traduzir</button>
          <button type="button" onClick={onPanel}><PanelRight size={15} />Dados do contato</button>
          {onAction && <><button type="button" onClick={() => onAction("silenciar")}><VolumeX size={15} />Silenciar ou reativar som</button>
            <button type="button" onClick={() => onAction("arquivar")}><Archive size={15} />Arquivar ou desarquivar</button>
            <button type="button" onClick={() => onAction("papel")}>Papel de parede</button>
            <button type="button" className="is-danger" onClick={() => onAction("excluir")}><Trash2 size={15} />Excluir conversa</button></>}
        </div>
      </details>
    </div>
  </header>;
}
