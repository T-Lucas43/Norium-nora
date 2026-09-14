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
    <aside className="mail-modal nora-mail-drawer fixed bottom-4 right-4 top-20 z-50 flex w-[min(700px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-white/12 bg-[#18181B] shadow-2xl sm:bottom-6 sm:right-6 sm:top-24" aria-label="Nora para E-mails">
      <div className="flex min-h-16 items-center justify-between border-b border-white/10 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3">
          <NoraAvatar className="h-10 w-10" />
          <div>
            <h3 className="text-base font-black">Nora para E-mails</h3>
            <p className="max-w-[480px] truncate text-xs font-semibold text-white/55">
              {selectedMessage ? `Contexto: ${selectedMessage.subject}` : "Caixa de entrada e novos envios"}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" iconOnly onClick={onClose} className="hover:bg-white/7" aria-label="Fechar">
          <X size={17} />
        </Button>
      </div>

      <div className="nora-native-scroll flex gap-2 overflow-x-auto border-b border-white/10 p-3 sm:px-5">
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

      <div ref={scrollRef} className="nora-native-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={cn(
              "min-w-0 whitespace-pre-wrap rounded-2xl border px-4 py-3 text-sm font-semibold leading-6 sm:px-5 sm:py-4",
              message.role === "user"
                ? "mail-primary ml-auto max-w-[88%] border-transparent bg-gradient-to-r from-blue-600 to-cyan-500 text-white"
                : "mail-card w-full border-white/10 bg-[#121217] text-white",
            )}
          >
            {message.role === "ai" ? <div className="nora-mail-answer min-w-0"><NoraMarkdown text={message.text} /></div> : message.text}
          </div>
        ))}
        {loading && <div className="text-sm font-bold text-white/50">Nora lendo seus e-mails...</div>}
      </div>

      <div className="border-t border-white/10 p-3 sm:p-4">
        <div className="mail-input flex items-end gap-2 rounded-2xl border border-white/12 bg-[#121217] p-2.5">
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
            placeholder="Peça um resumo executivo, uma prioridade ou uma resposta…"
            className="max-h-32 min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm font-semibold leading-5 outline-none placeholder:text-white/35"
          />
          <Button variant="ghost" size="sm" iconOnly onClick={onSend} disabled={loading || !input.trim()} className="mail-primary bg-[#0EA5E9]" aria-label="Enviar para a Nora">
            <Send size={16} />
          </Button>
        </div>
      </div>
    </aside>
  );
}
