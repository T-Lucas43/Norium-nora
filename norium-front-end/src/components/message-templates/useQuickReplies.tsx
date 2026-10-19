import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import type { MessageChannel, MessageTemplate } from "../../features/message-templates/api";
import "../business/business.css";

type Options = { channel: MessageChannel; text: string; additionalText?: string; variables?: Record<string, string>;
  onApply: (value: { body: string; subject: string; missingVariables: string[] }) => void };

export function useQuickReplies({ channel, text, additionalText = "", variables = {}, onApply }: Options) {
  const listId = useId(); const scope = requestScope();
  const [data, setData] = useState<{ scope: string; templates: MessageTemplate[] } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [index, setIndex] = useState(0); const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => { const update = () => { setData(null); setRevision(value => value+1); }; window.addEventListener("norium:message-templates-changed", update); return () => window.removeEventListener("norium:message-templates-changed", update); }, []);
  const active = text.startsWith("/") && text.length <= 80 && !text.includes("\n");
  const query = text.slice(1).toLocaleLowerCase("pt-BR");
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setError("");
    void apiRequest<{ templates: MessageTemplate[] }>(`/api/message-templates?channel=${channel}`, { signal: controller.signal, cache: "no-store" })
      .then(result => { if (!controller.signal.aborted && requestScope() === scope) setData({ scope, templates: result.templates }); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Falha ao carregar atalhos."); });
    return () => controller.abort();
  }, [active, channel, scope, revision]);
  useEffect(() => setIndex(0), [query]);
  const matches = useMemo(() => data?.scope === scope ? data.templates.filter(item => item.shortcut &&
    `${item.shortcut} ${item.name}`.toLocaleLowerCase("pt-BR").includes(query)).slice(0, 8) : [], [data, scope, query]);
  const open = active && dismissed !== text && (matches.length > 0 || !!error);
  function choose(item: MessageTemplate) {
    const missing = new Set<string>();
    const render = (value: string) => value.replace(/\{\{([a-z_]+)\}\}/g, (original, key: string) => {
      const replacement = variables[key]?.trim(); if (!replacement) missing.add(key); return replacement || original;
    });
    const body = render(item.body); const subject = render(item.subject);
    onApply({ body, subject, missingVariables: [...missing] }); setDismissed(text);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); setDismissed(text); return true; }
    if (!matches.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); setIndex(current => (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length); return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault(); choose(matches[Math.min(index, matches.length - 1)]); return true;
    }
    return false;
  }
  const missingVariables = [...new Set([...`${text}\n${additionalText}`.matchAll(/\{\{([a-z_]+)\}\}/g)].map(match => match[1]))];
  const panel = open ? <div className="quick-replies-panel" role="listbox" id={listId} aria-label="Respostas rápidas">
    {error && <p role="alert">{error}</p>}
    {matches.map((item, position) => <button type="button" role="option" id={`${listId}-${position}`} aria-selected={index === position} key={item.id}
      onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}><strong>/{item.shortcut}</strong><span>{item.name}</span><small>{item.body.slice(0, 120)}</small></button>)}
    <p>↑ ↓ escolher · Enter inserir · Esc fechar</p>
  </div> : null;
  return { panel, onKeyDown, missingVariables,
    inputProps: { "aria-autocomplete": "list" as const, "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open && matches.length ? `${listId}-${Math.min(index, matches.length - 1)}` : undefined } };
}
