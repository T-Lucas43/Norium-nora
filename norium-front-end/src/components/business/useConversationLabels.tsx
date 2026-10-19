import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tag } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import Button from "../shared/Button";
import TagManager, { type BusinessTag } from "./TagManager";

type Matches = { ids: string[]; total: number; nextOffset: number | null };

export function useConversationLabels() {
  const scope = requestScope(); const [labels, setLabels] = useState<BusinessTag[]>([]);
  const [selected, setSelected] = useState<string[]>([]); const [manage, setManage] = useState(false);
  const [revision, setRevision] = useState(0); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const [matches, setMatches] = useState<Matches>({ ids: [], total: 0, nextOffset: null });
  const signature = selected.join(","); const key = `${scope}|${signature}|${revision}`;
  const matching = useMemo(() => signature ? new Set(matches.ids) : null, [signature, matches.ids]);
  const activeKey = useRef(key); activeKey.current = key;
  useEffect(() => { setSelected([]); setMatches({ ids: [], total: 0, nextOffset: null }); setManage(false); setError(""); }, [scope]);
  useEffect(() => {
    const controller = new AbortController(); setLabels([]);
    void apiRequest<{ items: BusinessTag[] }>("/api/business/tags?scope=contact", { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted && requestScope() === scope) setLabels(data.items); })
      .catch(err => { if (!controller.signal.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível carregar as etiquetas."); });
    return () => controller.abort();
  }, [scope, revision]);
  useEffect(() => { const update = () => setRevision(value => value+1);
    window.addEventListener("norium:conversation-tags-changed", update);
    return () => window.removeEventListener("norium:conversation-tags-changed", update);
  }, []);
  const load = useCallback(async (offset: number, signal?: AbortSignal) => {
    if (!signature || activeKey.current !== key || requestScope() !== scope) return;
    setLoading(true); setError("");
    try { const page = await apiRequest<Matches>(`/api/business/tagged-conversations?tagIds=${encodeURIComponent(signature)}&offset=${offset}&limit=200`, { signal });
      if (!signal?.aborted && activeKey.current === key && requestScope() === scope) setMatches(current => ({ ...page, ids: offset ? [...new Set([...current.ids, ...page.ids])] : page.ids }));
    } catch (err) { if (!signal?.aborted && activeKey.current === key && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível filtrar as conversas."); }
    finally { if (!signal?.aborted && activeKey.current === key && requestScope() === scope) setLoading(false); }
  }, [signature, key, scope]);
  useEffect(() => { const controller = new AbortController(); setMatches({ ids: [], total: 0, nextOffset: null });
    if (signature) void load(0, controller.signal); else setLoading(false);
    return () => controller.abort();
  }, [load, signature]);
  const toolbar = <div className="business-conversation-labels">
    <div className="flex flex-wrap items-center gap-2"><details><summary className="nx-btn is-sm"><Tag size={14} />Etiquetas{selected.length ? ` (${selected.length})` : ""}</summary>
      <div className="business-tag-filter">{labels.length ? labels.map(label => <label className="flex items-center gap-2" key={label.id}>
        <input type="checkbox" checked={selected.includes(label.id)} disabled={!selected.includes(label.id) && selected.length >= 20} onChange={event => setSelected(current => event.target.checked ? [...current, label.id] : current.filter(id => id !== label.id))} /><span className="business-color-dot" style={{ background: label.color }} />{label.name}
      </label>) : <p className="business-note">Crie etiquetas na ficha de um contato.</p>}</div></details>
      <Button size="sm" onClick={() => setManage(true)}>Gerenciar</Button>
      {selected.length > 0 && <Button size="sm" onClick={() => setSelected([])}>Limpar etiquetas</Button>}
    </div>
    {loading && <p className="business-note" role="status">Filtrando etiquetas…</p>}
    {!loading && !!selected.length && <p className="business-note">{matches.total} conversas com todas as etiquetas selecionadas.</p>}
    {error && <p role="alert" className="business-error">{error}</p>}
    {manage && <TagManager tagScope="contact" onClose={() => setManage(false)} />}
  </div>;
  return { toolbar, signature, matching, loading,
    more: matches.nextOffset != null ? <Button size="sm" disabled={loading} onClick={() => void load(matches.nextOffset!)}>Carregar mais correspondências por etiqueta</Button> : null };
}
