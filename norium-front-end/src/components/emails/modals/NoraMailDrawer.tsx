import type { RefObject } from "react";
import { Send, X } from "lucide-react";
import NoraAvatar from "../../layout/NoraAvatar";
import { NoraMarkdown } from "../../nora/NoraResponseContent";
import type { AgentMessage, GmailMessage } from "../../../features/mail/types";

type NoraMailDrawerProps = {
  /** Mensagem aberta: muda os atalhos entre "sobre este e-mail" e "sobre a caixa". */
  selectedMessage: GmailMessage | null;
  messages: AgentMessage[];
  loading: boolean;
  input: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onSummarize: () => void;
  onNextAction: () => void;
  onSuggestReply: () => void;
  onListUnread: () => void;
  onSummarizeInbox: () => void;
  onCompose: () => void;
  onClose: () => void;
};

/** Painel conversacional da Nora dentro do Norium Mail. */
export default function NoraMailDrawer({
  selectedMessage,
  messages,
  loading,
  input,
  scrollRef,
  onInputChange,
  onSend,
  onSummarize,
  onNextAction,
  onSuggestReply,
  onListUnread,
  onSummarizeInbox,
  onCompose,
  onClose,
}: NoraMailDrawerProps) {
  return (
    <aside className="nx-mail-layer nx-mail-nora nora-mail-drawer" aria-label="Nora para E-mails">
      <div className="nx-mail-layer-h">
        <NoraAvatar className="rounded-full" />
        <div>
          <h3>Nora para E-mails</h3>
          <p>{selectedMessage ? `Contexto: ${selectedMessage.subject}` : "Caixa de entrada e novos envios"}</p>
        </div>
        <button type="button" onClick={onClose} className="nx-mail-iconbtn" aria-label="Fechar">
          <X size={16} />
        </button>
      </div>

      <div className="nx-mail-nora-chips nora-native-scroll">
        {selectedMessage ? (
          <>
            <button type="button" onClick={onSummarize} className="nx-btn is-sm">Resumir aberto</button>
            <button type="button" onClick={onSuggestReply} className="nx-btn is-sm">Sugerir resposta</button>
            <button type="button" onClick={onNextAction} className="nx-btn is-sm">Próxima ação</button>
          </>
        ) : (
          <>
            <button type="button" onClick={onListUnread} className="nx-btn is-sm">Não lidos</button>
            <button type="button" onClick={onSummarizeInbox} className="nx-btn is-sm">Resumir caixa</button>
            <button type="button" onClick={onCompose} className="nx-btn is-sm">Criar e-mail</button>
          </>
        )}
      </div>

      <div ref={scrollRef} className="nx-mail-nora-msgs nora-native-scroll">
        {messages.map((message, index) =>
          message.role === "user" ? (
            <div key={`${message.role}-${index}`} className="nx-mail-msg-u">{message.text}</div>
          ) : (
            <div key={`${message.role}-${index}`} className="nx-mail-msg-n">
              <div className="nora-mail-answer min-w-0"><NoraMarkdown text={message.text} /></div>
            </div>
          ),
        )}
        {loading && <div className="nx-faint nx-small" role="status">Nora lendo seus e-mails...</div>}
      </div>

      <div className="nx-mail-composer">
        <div>
          <textarea
            rows={2}
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            aria-label="Mensagem para a Nora"
            placeholder="Peça um resumo executivo, uma prioridade ou uma resposta…"
          />
          <button type="button" onClick={onSend} disabled={loading || !input.trim()} className="nx-mail-send" aria-label="Enviar para a Nora">
            <Send size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}
