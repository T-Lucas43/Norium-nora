import { CheckCheck, Clock3, X } from "lucide-react";
import Button from "../shared/Button";

type ReadReceipt = {
  userId: string;
  userName: string;
  viewedAt: string;
};

function formatViewedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Horário não informado";
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function MessageReadReceiptsDialog({
  messageText,
  readBy,
  onClose,
}: {
  messageText: string;
  readBy: ReadReceipt[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[180] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Confirmações de leitura" className="w-full max-w-sm nx-card p-5 text-[var(--nx-text)] shadow-[0_24px_64px_rgba(15,23,42,.3)]" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3"><div><p className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--nx-text-3)]"><CheckCheck size={15} /> Confirmações de leitura</p><h2 className="mt-1 text-lg font-semibold">{readBy.length} pessoa(s) viram</h2></div><Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Fechar confirmações de leitura"><X size={18} /></Button></div>
        <p className="mt-4 rounded-[10px] border border-[var(--nx-border)] bg-[var(--nx-surface-2)] p-3 text-[13px] leading-5 text-[var(--nx-text-2)]">“{messageText || "Mensagem sem texto"}”</p>
        <div className="mt-4 grid max-h-60 gap-2 overflow-y-auto">
          {readBy.length ? readBy.map((receipt) => <div key={receipt.userId} className="flex items-center gap-3 rounded-[10px] border border-[var(--nx-border)] bg-[var(--nx-surface-2)] p-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--nx-success-soft)] text-[var(--nx-success)]"><CheckCheck size={15} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{receipt.userName}</strong><small className="mt-1 flex items-center gap-1 text-[12px] text-[var(--nx-text-3)]"><Clock3 size={12} /> {formatViewedAt(receipt.viewedAt)}</small></span></div>) : <p className="py-5 text-center text-sm text-[var(--nx-text-2)]">Ninguém viu esta mensagem ainda.</p>}
        </div>
      </section>
    </div>
  );
}
