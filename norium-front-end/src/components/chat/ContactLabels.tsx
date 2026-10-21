import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Plus } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import BusinessDialog from "../business/BusinessDialog";
import ClientTagsPanel from "../business/ClientTagsPanel";
import { useWhatsAppScope } from "./WhatsAppScope";

type Label = { id: string; name: string; color: string };
type LabelsContext = { values: Record<string, Label[]>; errors: Record<string, boolean>; ensure: (id: string) => void; revision: number };
const Context = createContext<LabelsContext>({ values: {}, errors: {}, ensure: () => {}, revision: 0 });

/** Batch only visible contacts. The existing tag registry remains the source. */
export function ContactLabelsProvider({ children }: { children: ReactNode }) {
  const { inboxId, prefix } = useWhatsAppScope();
  const scope = requestScope();
  const [values, setValues] = useState<Record<string, Label[]>>({});
  const [revision, setRevision] = useState(0);
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const cached = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lifecycle = useRef({ active: true, epoch: 0, controller: new AbortController() });
  const ensure = useCallback((id: string) => {
    if (!id || cached.current.has(id) || pending.current.has(id)) return;
    pending.current.add(id);
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (!lifecycle.current.active || requestScope() !== scope) return;
      const ids = [...pending.current]; pending.current.clear();
      const epoch = lifecycle.current.epoch;
      for (let offset = 0; offset < ids.length; offset += 100) {
        const chunk = ids.slice(offset, offset + 100);
        chunk.forEach(id => cached.current.add(id));
        void apiRequest<{ items: { id: string; tags: Label[] }[] }>(inboxId ? `${prefix}/contact-labels` : "/api/business/whatsapp/contact-labels", {
          method: "POST", body: JSON.stringify({ contactIds: chunk }), signal: lifecycle.current.controller.signal,
        }).then(data => {
          if (!lifecycle.current.active || epoch !== lifecycle.current.epoch || requestScope() !== scope) return;
          const result = Object.fromEntries(chunk.map(id => [id, [] as Label[]]));
          for (const item of data.items || []) if (chunk.includes(item.id) && Array.isArray(item.tags)) result[item.id] = item.tags;
          setValues(current => ({ ...current, ...result }));
        }).catch(() => {
          // Do not invent a tag on errors, or retry once per rendered row.
          // A user refresh/tag event invalidates this bounded snapshot.
          if (lifecycle.current.active && epoch === lifecycle.current.epoch && requestScope() === scope)
            setErrors(current => ({ ...current, ...Object.fromEntries(chunk.map(id => [id, true])) }));
        });
      }
    }, 35);
  }, [scope, inboxId, prefix]);
  useEffect(() => {
    const life = lifecycle.current;
    const queued = pending.current;
    const known = cached.current;
    life.active = true;
    life.controller = new AbortController();
    const invalidate = () => {
      lifecycle.current.epoch++; cached.current.clear();
      setValues({}); setErrors({}); setRevision(value => value + 1);
    };
    const live = (event: Event) => { if ((event as CustomEvent).detail?.area === "labels") invalidate(); };
    window.addEventListener("norium:conversation-tags-changed", invalidate);
    window.addEventListener("norium:business-tags-changed", invalidate);
    window.addEventListener("norium:whatsapp-event", live);
    return () => {
      life.active = false; life.controller.abort(); clearTimeout(timer.current);
      timer.current = undefined; queued.clear(); known.clear();
      window.removeEventListener("norium:conversation-tags-changed", invalidate);
      window.removeEventListener("norium:business-tags-changed", invalidate);
      window.removeEventListener("norium:whatsapp-event", live);
    };
  }, [scope]);
  return <Context.Provider value={{ values, errors, ensure, revision }}>{children}</Context.Provider>;
}

export function ContactLabels({ contactId, editable = false, limit = 2 }: {
  contactId: string; editable?: boolean; limit?: number;
}) {
  const { inboxId } = useWhatsAppScope();
  editable = editable && !inboxId;
  const { values, errors, ensure, revision } = useContext(Context);
  const [open, setOpen] = useState(false);
  useEffect(() => { ensure(contactId); }, [contactId, ensure, revision]);
  useEffect(() => setOpen(false), [contactId]);
  const labels = values[contactId] || [];
  return <span className="nx-whatsapp-labels" aria-label="Etiquetas do contato">
    {labels.slice(0, limit).map(label => <span className="nx-whatsapp-tag" key={label.id}
      style={{ "--contact-tag-color": label.color } as CSSProperties}>{label.name}</span>)}
    {labels.length > limit && <span className="nx-whatsapp-tag-overflow" title={labels.slice(limit).map(label => label.name).join(", ")}>+{labels.length - limit}</span>}
    {editable && errors[contactId] && <span className="business-note" role="status">Etiquetas indisponíveis</span>}
    {editable && <button type="button" className="nx-whatsapp-add-tag" aria-label="Editar etiquetas do contato" title="Etiquetas do contato" onClick={event => { event.stopPropagation(); setOpen(true); }}><Plus size={13} /></button>}
    {open && <BusinessDialog title="Etiquetas do contato" onClose={() => setOpen(false)}>
      <ClientTagsPanel conversationId={contactId} canEdit />
    </BusinessDialog>}
  </span>;
}
