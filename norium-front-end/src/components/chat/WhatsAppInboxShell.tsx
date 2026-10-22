import { useEffect, useState, type ReactNode } from "react";
import { Settings2, Users, X } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import { WhatsAppScopeProvider, type AttendanceFilter } from "./WhatsAppScope";

import "./whatsappTeam.css";

type Configuration = { id: string; enabled: boolean; revision: number; autoAssignOnSend: boolean; autoDistribute: boolean };
type Inboxes = { items: { id: string; name: string; canManage: boolean }[]; configuration: Configuration | null };

export default function WhatsAppInboxShell({ children }: { children: (key: string) => ReactNode }) {
  const scope = requestScope();
  const [data, setData] = useState<Inboxes>({ items: [], configuration: null });
  const [inboxId, setInboxId] = useState<string | undefined>();
  const [filter, setFilter] = useState<AttendanceFilter>({ responsavel: "all", estado: "" });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [settings, setSettings] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setInboxId(undefined); setSettings(false);
    setData({ items: [], configuration: null }); setError("");
    void apiRequest<Inboxes>("/api/chat/caixas", { signal: controller.signal, cache: "no-store" }).then(value => {
      if (!controller.signal.aborted && scope === requestScope() && Array.isArray(value?.items)) {
        setData(value);
        const requested = new URLSearchParams(window.location.search).get("inbox");
        if (requested && value.items.some(item => item.id === requested)) setInboxId(requested);
      }
    }).catch(() => {}); // Personal WhatsApp does not depend on an optional inbox.
    return () => controller.abort();
  }, [scope]);
  async function save(enabled: boolean, autoAssignOnSend: boolean, autoDistribute: boolean) {
    if (!data.configuration || busy) return;
    setBusy(true); setError("");
    try {
      const configuration = await apiRequest<Configuration>("/api/chat/caixas/configuracao", { method: "PATCH",
        body: JSON.stringify({ enabled, autoAssignOnSend, autoDistribute, expectedRevision: data.configuration.revision }) });
      if (requestScope() !== scope) return;
      const refreshed = await apiRequest<Inboxes>("/api/chat/caixas", { cache: "no-store" });
      if (requestScope() !== scope) return;
      setData({ ...refreshed, configuration }); setSettings(false);
      if (!enabled) setInboxId(undefined);
    } catch (failure) { if (requestScope() === scope) setError(failure instanceof Error ? failure.message : "Não foi possível salvar a caixa."); }
    finally { setBusy(false); }
  }
  const key = `${scope}:${inboxId || "personal"}:${JSON.stringify(filter)}`;
  return <WhatsAppScopeProvider inboxId={inboxId} filter={filter} setFilter={setFilter} counts={counts} onCounts={setCounts}>
    <div className="nx-whatsapp-inbox-shell nx-conv">
      {(data.items.length > 0 || data.configuration) && <div className="nx-whatsapp-inbox-picker">
        <Users size={16} /><label>Caixa <select aria-label="Caixa do WhatsApp" value={inboxId || ""} onChange={event => { setInboxId(event.target.value || undefined); setFilter({ responsavel: "all", estado: "" }); setCounts({}); }}>
          <option value="">Meu WhatsApp</option>{data.items.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>
        <small>{inboxId ? "Atendimento da equipe" : "Conta pessoal"}</small>
        {data.configuration && <button type="button" className="nx-conv-iconbtn" aria-label="Configurar caixa de equipe" onClick={() => setSettings(true)}><Settings2 size={16} /></button>}
      </div>}
      <div className="nx-whatsapp-inbox-content">{children(key)}</div>
      {settings && data.configuration && <SharingSettings configuration={data.configuration} busy={busy} error={error} onClose={() => setSettings(false)} onSave={save} />}
    </div>
  </WhatsAppScopeProvider>;
}

function SharingSettings({ configuration, busy, error, onClose, onSave }: { configuration: Configuration; busy: boolean; error: string;
  onClose: () => void; onSave: (enabled: boolean, autoAssign: boolean, autoDistribute: boolean) => Promise<void> }) {
  const [enabled, setEnabled] = useState(configuration.enabled), [autoAssign, setAutoAssign] = useState(configuration.autoAssignOnSend);
  const [autoDistribute, setAutoDistribute] = useState(configuration.autoDistribute === true);
  return <div className="fixed inset-0 z-[250] grid place-items-center bg-black/50 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="sharing-title" className="nx-card w-full max-w-lg p-5">
      <div className="flex items-center justify-between"><h3 id="sharing-title">Caixa de equipe</h3><button type="button" aria-label="Fechar caixa de equipe" className="nx-conv-iconbtn" disabled={busy} onClick={onClose}><X size={16} /></button></div>
      <p className="my-4 text-sm leading-6">Compartilhe esta instância neste workspace. Membros com permissão de atender acessam suas conversas e as não atribuídas. Gestores com “ver todas” podem reatribuir.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Compartilhar a instância do dono com a equipe</label>
      <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={autoAssign} onChange={event => setAutoAssign(event.target.checked)} />Quem enviar assume a conversa sem responsável</label>
      <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={autoDistribute} onChange={event => setAutoDistribute(event.target.checked)} />Distribuir conversas novas em rodízio entre atendentes online</label>
      {enabled && !configuration.enabled && <p className="mt-4 text-sm text-[var(--nx-warning)]">Ao salvar, os membros autorizados poderão ler o histórico desta instância. Contas pessoais dos membros permanecem privadas.</p>}
      {error && <p role="alert" className="mt-4 text-sm text-[var(--nx-danger)]">{error}</p>}
      <div className="mt-5 flex justify-end gap-2"><button className="nx-btn" disabled={busy} onClick={onClose}>Cancelar</button><button className="nx-btn is-primary" disabled={busy} onClick={() => void onSave(enabled, autoAssign, autoDistribute)}>{busy ? "Salvando…" : "Salvar compartilhamento"}</button></div>
    </section>
  </div>;
}
