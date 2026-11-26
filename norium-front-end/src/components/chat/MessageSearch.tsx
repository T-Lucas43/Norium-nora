import { useLayoutEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { MsgConteudo } from "./types";

export function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return <>{text}</>;
  const lowered = text.toLocaleLowerCase();
  const pieces = [];
  let start = 0;
  let match = lowered.indexOf(needle);
  while (match >= 0) {
    pieces.push(text.slice(start, match), <mark key={match}>{text.slice(match, match + needle.length)}</mark>);
    start = match + needle.length;
    match = lowered.indexOf(needle, start);
  }
  pieces.push(text.slice(start));
  return <>{pieces}</>;
}

export function useMessageSearch(messages: MsgConteudo[], conversationId: string | undefined,
  container: RefObject<HTMLDivElement | null>) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? messages.filter(row => row.texto?.toLocaleLowerCase().includes(needle)).map(row => row.id) : [];
  }, [messages, query]);
  const index = matches.length ? Math.min(selection, matches.length - 1) : 0;
  const activeId = matches[index];
  useLayoutEffect(() => { setQuery(""); setSelection(0); }, [conversationId]);
  useLayoutEffect(() => {
    if (!activeId) return;
    const row = [...(container.current?.querySelectorAll<HTMLElement>("[data-message-id]") || [])]
      .find(element => element.dataset.messageId === activeId);
    row?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [activeId, container]);
  return { query, activeId, count: matches.length, index,
    setQuery: (value: string) => { setQuery(value); setSelection(0); },
    move: (direction: number) => setSelection(current => matches.length ? (current + direction + matches.length) % matches.length : 0) };
}

export default function MessageSearch({ search, hasOlder, onClose }: {
  search: ReturnType<typeof useMessageSearch>; hasOlder: boolean; onClose: () => void;
}) {
  return <div className="nx-whatsapp-message-search">
    <label className="nx-conv-search min-w-0 flex-1"><Search size={15} />
      <input type="text" autoFocus placeholder="Buscar nesta conversa" value={search.query}
        aria-label="Buscar nesta conversa" onChange={event => search.setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); search.move(event.shiftKey ? -1 : 1); } }} />
    </label>
    <span role="status" className="nx-whatsapp-search-count" title={hasOlder ? "Resultados nas mensagens carregadas. Carregue o histórico para buscar nas anteriores." : undefined}>
      {search.count ? `${search.index + 1} de ${search.count}` : "0 de 0"}
    </span>
    <button className="nx-conv-iconbtn" type="button" disabled={!search.count} aria-label="Resultado anterior" onClick={() => search.move(-1)}><ChevronUp size={16} /></button>
    <button className="nx-conv-iconbtn" type="button" disabled={!search.count} aria-label="Próximo resultado" onClick={() => search.move(1)}><ChevronDown size={16} /></button>
    <button className="nx-conv-iconbtn" type="button" aria-label="Fechar busca" onClick={onClose}><X size={15} /></button>
  </div>;
}
