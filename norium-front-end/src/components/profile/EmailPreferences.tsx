import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { apiRequest } from "../../core/api/client";

const events: Record<string, string> = {
  meeting_scheduled: "Reuniões agendadas",
  meeting_reminder: "Lembretes antes de reuniões",
  task_due: "Tarefas prestes a vencer",
  chat_mention: "Menções no chat da equipe",
  finance_due: "Contas a pagar",
  client_follow_up: "Acompanhamentos de clientes",
  client_shared: "Clientes compartilhados comigo",
};
const sources: Record<string, string> = {
  calendar: "Outras atualizações da agenda",
  kanban: "Outras atualizações de tarefas",
  financeiro: "Outras atualizações financeiras",
  equipe: "Outras atualizações da equipe",
  automacoes: "Automações",
  brainstorm: "Estúdio",
  relatorios: "Relatórios",
  sistema: "Avisos do sistema",
  clientes: "Outras atualizações de clientes",
};
type Preferences = { enabled: boolean; sources: Record<string, boolean>; events: Record<string, boolean>; email: string; verified: boolean; deliveryConfigured: boolean };

export default function EmailPreferences() {
  const [data, setData] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<Preferences>("/api/auth/email-preferences", { signal: controller.signal }).then((value) => setData({ ...value, sources: value.sources || {}, events: value.events || {} })).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Não foi possível carregar as preferências."); });
    return () => controller.abort();
  }, []);
  async function update(verify = false) {
    if (!data) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (verify) {
        const result = await apiRequest<{ message: string }>("/api/auth/resend-verification", { method: "POST" }); setMessage(result.message);
      } else {
        setData(await apiRequest<Preferences>("/api/auth/email-preferences", { method: "PATCH", body: JSON.stringify({ enabled: data.enabled, sources: data.sources, events: data.events }) })); setMessage("Preferências de e-mail salvas.");
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível concluir."); }
    finally { setBusy(false); }
  }
  return <section className="nx-card" style={{ padding: "18px 22px" }}>
    <h2 className="nxi-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}><Mail size={16} style={{ color: "var(--nx-primary)" }} /> Notificações por e-mail</h2>
    {data ? <><p className="nx-muted nx-small mt-1 break-all">{data.email} · <span className={`nx-badge ${data.verified ? "is-green" : "is-amber"}`}>{data.verified ? "Confirmado" : "Confirmação pendente"}</span></p>
      {!data.deliveryConfigured && <p className="nxi-alert is-warning mt-3">O administrador ainda precisa ativar o envio pelo e-mail de suporte.</p>}
      {!data.verified && <button type="button" disabled={busy || !data.deliveryConfigured} onClick={() => void update(true)} className="nxi-link mt-3">Enviar confirmação de e-mail</button>}
      <label className="nxi-swrow" style={{ marginTop: 12, borderTop: "1px solid var(--nx-border)" }}><span className="nxi-swrow-t nx-grow">Receber notificações da minha conta</span><input type="checkbox" className="nxi-switch" checked={data.enabled} onChange={(event) => setData({ ...data, enabled: event.target.checked })} /></label>
      <fieldset disabled={!data.enabled || busy} className="disabled:opacity-50" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="mb-3 mt-2 text-[13.5px] font-semibold">Alertas automáticos</legend>
        <div className="grid gap-3 text-[13px] sm:grid-cols-2">{Object.entries(events).map(([key, label]) => <label key={key} className="flex items-center gap-3"><input type="checkbox" checked={data.events[key] ?? true} onChange={(event) => setData({ ...data, events: { ...data.events, [key]: event.target.checked } })} />{label}</label>)}</div>
        <p className="mb-3 mt-5 text-[13.5px] font-semibold">Outras atualizações</p>
        <div className="grid gap-3 text-[13px] sm:grid-cols-2">{Object.entries(sources).map(([key, label]) => <label key={key} className="flex items-center gap-3"><input type="checkbox" checked={data.sources[key] ?? true} onChange={(event) => setData({ ...data, sources: { ...data.sources, [key]: event.target.checked } })} />{label}</label>)}</div>
      </fieldset>
      <p className="nx-faint nx-small mt-5" style={{ lineHeight: 1.5 }}>Mensagens do WhatsApp e e-mails recebidos ficam fora destes envios. Confirmação de conta e recuperação de senha continuam disponíveis independentemente destas preferências.</p>
      <div className="nxi-actions is-end mt-4"><button type="button" disabled={busy} onClick={() => void update()} className="nx-btn is-primary">{busy ? "Aguarde..." : "Salvar notificações"}</button></div>
    </> : !error && <p className="nx-muted nx-small mt-3">Carregando preferências...</p>}
    {error && <p role="alert" className="nxi-alert is-error mt-3">{error}</p>}{message && <p role="status" className="nxi-alert is-success mt-3">{message}</p>}
  </section>;
}
