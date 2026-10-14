import { Copy, Edit3, MessagesSquare, MoreHorizontal, Pin, Reply, SmilePlus, Trash2 } from "lucide-react";
import { AlarmClock, CheckSquare, Forward, Sparkles, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export default function TeamMessageActions({ mine, onReply, onReact, onMoreReaction, onCopy, onEdit, onDelete, onThread, onPin, pinned, onTask, onReminder, onForward, onNora, onClient }: {
  mine: boolean; onReply: () => void; onReact: (emoji: string) => void; onMoreReaction: () => void;
  onCopy: () => void; onEdit: () => void; onDelete: () => void;
  onThread: () => void; onPin: () => void; pinned: boolean;
  onTask?: () => void; onReminder?: () => void; onForward: () => void;
  onNora?: () => void; onClient?: () => void;
}) {
  const [more, setMore] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return;
    function outside(event: MouseEvent) { if (!root.current?.contains(event.target as Node)) setMore(false); }
    function key(event: KeyboardEvent) { if (event.key === "Escape") setMore(false); }
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", key); };
  }, [more]);
  return <div ref={root} className="team-v3-message-actions"><div className="team-v3-message-toolbar">{['👍', '❤️', '✅'].map((emoji) => <button type="button" key={emoji} aria-label={`Reação rápida ${emoji}`} onClick={() => onReact(emoji)}>{emoji}</button>)}<button type="button" onClick={onMoreReaction} aria-label="Mais reações"><SmilePlus size={16} /></button><button type="button" onClick={onReply} aria-label="Responder citando"><Reply size={16} /></button><button type="button" onClick={() => setMore(!more)} aria-label="Mais ações da mensagem" aria-expanded={more}><MoreHorizontal size={16} /></button></div>
    {more && <div className="team-v3-message-menu">{onNora && <button type="button" onClick={() => { onNora(); setMore(false); }}><Sparkles size={16} />Pedir à Nora sobre isto</button>}{onClient && <button type="button" onClick={() => { onClient(); setMore(false); }}><Send size={16} />Enviar para um cliente</button>}<button type="button" onClick={() => { onThread(); setMore(false); }}><MessagesSquare size={16} />Responder em fio</button><button type="button" onClick={() => { onReply(); setMore(false); }}><Reply size={16} />Responder citando</button>{onTask && <button type="button" onClick={() => { onTask(); setMore(false); }}><CheckSquare size={16} />Transformar em tarefa</button>}{onReminder && <button type="button" onClick={() => { onReminder(); setMore(false); }}><AlarmClock size={16} />Lembrar-me disto</button>}<button type="button" onClick={() => { onForward(); setMore(false); }}><Forward size={16} />Encaminhar</button><button type="button" onClick={() => { onPin(); setMore(false); }}><Pin size={16} />{pinned ? "Desafixar mensagem" : "Fixar na conversa"}</button><button type="button" onClick={() => { onCopy(); setMore(false); }}><Copy size={16} />Copiar link</button>{mine && <><button type="button" onClick={() => { onEdit(); setMore(false); }}><Edit3 size={16} />Editar</button><button type="button" onClick={() => { onDelete(); setMore(false); }}><Trash2 size={16} />Apagar</button></>}</div>}
  </div>;
}
