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
    <div className="fixed inset-0 z-[180] grid place-items-center bg-black/80 p-4" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Confirmações de leitura" className="w-full max-w-sm rounded-2xl border border-blue-500/35 bg-[#070b12] p-5 text-white shadow-2xl shadow-black/70" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3"><div><p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-blue-300"><CheckCheck size={15} /> Confirmações de leitura</p><h2 className="mt-1 text-lg font-black">{readBy.length} pessoa(s) viram</h2></div><Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Fechar confirmações de leitura"><X size={18} /></Button></div>
        <p className="mt-4 rounded-xl border border-white/10 bg-[#0c121c] p-3 text-xs font-semibold leading-5 text-slate-300">“{messageText || "Mensagem sem texto"}”</p>
        <div className="mt-4 grid max-h-60 gap-2 overflow-y-auto">
          {readBy.length ? readBy.map((receipt) => <div key={receipt.userId} className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0c121c] p-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-emerald-400/15 text-emerald-300"><CheckCheck size={15} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{receipt.userName}</strong><small className="mt-1 flex items-center gap-1 text-xs font-semibold text-slate-400"><Clock3 size={12} /> {formatViewedAt(receipt.viewedAt)}</small></span></div>) : <p className="py-5 text-center text-sm font-semibold text-slate-400">Ninguém viu esta mensagem ainda.</p>}
        </div>
      </section>
    </div>
  );
}
