import type { RefObject } from "react";
import { Send, X } from "lucide-react";
import Button from "../../shared/Button";
import NoraAvatar from "../../layout/NoraAvatar";
import { NoraMarkdown } from "../../nora/NoraResponseContent";
import { cn } from "../../../utils/cn";
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
    <aside className="mail-modal fixed right-6 top-24 z-50 flex h-[640px] w-[390px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-lg border border-white/12 bg-[#18181B] shadow-2xl">
      <div className="flex h-14 items-center justify-between border-b border-white/10 px-4">
        <div className="flex items-center gap-3">
          <NoraAvatar className="h-9 w-9" />
          <div>
            <h3 className="text-sm font-bold">Nora para E-mails</h3>
            <p className="max-w-[240px] truncate text-xs font-semibold text-white/45">
              {selectedMessage ? `Contexto: ${selectedMessage.subject}` : "Caixa de entrada e novos envios"}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" iconOnly onClick={onClose} className="hover:bg-white/7" aria-label="Fechar">
          <X size={17} />
        </Button>
      </div>

      <div className="flex gap-2 border-b border-white/10 p-3">
        {selectedMessage ? (
          <>
            <Button onClick={onSummarize} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Resumir aberto</Button>
            <Button onClick={onSuggestReply} className="mail-hover rounded-full border-cyan-300/25 py-1.5 text-cyan-100 hover:bg-cyan-300/10">Sugerir resposta</Button>
            <Button onClick={onNextAction} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Proxima acao</Button>
          </>
        ) : (
          <>
            <Button onClick={onListUnread} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Nao lidos</Button>
            <Button onClick={onSummarizeInbox} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Resumir caixa</Button>
            <Button onClick={onCompose} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Criar e-mail</Button>
          </>
        )}
      </div>

      <div ref={scrollRef} className="nora-native-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={cn(
              "whitespace-pre-wrap rounded-lg border p-3 text-sm font-semibold leading-5",
              message.role === "user"
                ? "mail-primary ml-auto max-w-[84%] border-transparent bg-[#0EA5E9] text-white"
                : "mail-card max-w-[90%] border-white/10 bg-[#121217] text-white",
            )}
          >
            {message.role === "ai" ? <NoraMarkdown text={message.text} /> : message.text}
          </div>
        ))}
        {loading && <div className="text-sm font-bold text-white/50">Nora lendo seus e-mails...</div>}
      </div>

      <div className="border-t border-white/10 p-3">
        <div className="mail-input flex items-center gap-2 rounded-lg border border-white/12 bg-[#121217] p-2">
          <input
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSend();
            }}
            placeholder="Peca algo ao agente..."
            className="min-w-0 flex-1 bg-transparent px-2 text-sm font-semibold outline-none placeholder:text-white/35"
          />
          <Button variant="ghost" size="sm" iconOnly onClick={onSend} className="mail-primary bg-[#0EA5E9]" aria-label="Enviar para a Nora">
            <Send size={16} />
          </Button>
        </div>
      </div>
    </aside>
  );
}
