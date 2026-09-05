import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { apiRequest } from "../../core/api/client";

const sources: Record<string, string> = { calendar: "Agenda e reuniões", kanban: "Tarefas", financeiro: "Financeiro", equipe: "Equipe", automacoes: "Automações", brainstorm: "Estúdio", relatorios: "Relatórios", sistema: "Avisos do sistema", clientes: "Clientes" };
type Preferences = { enabled: boolean; sources: Record<string, boolean>; email: string; verified: boolean; deliveryConfigured: boolean };

export default function EmailPreferences() {
  const [data, setData] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<Preferences>("/api/auth/email-preferences", { signal: controller.signal }).then(setData).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Não foi possível carregar as preferências."); });
    return () => controller.abort();
  }, []);
  async function update(verify = false) {
    if (!data) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (verify) {
        const result = await apiRequest<{ message: string }>("/api/auth/resend-verification", { method: "POST" }); setMessage(result.message);
      } else {
        setData(await apiRequest<Preferences>("/api/auth/email-preferences", { method: "PATCH", body: JSON.stringify({ enabled: data.enabled, sources: data.sources }) })); setMessage("Preferências de e-mail salvas.");
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível concluir."); }
    finally { setBusy(false); }
  }
  return <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
    <h2 className="flex items-center gap-2 text-base font-bold"><Mail size={19} className="text-cyan-400" /> Notificações por e-mail</h2>
    {data ? <><p className="mt-3 break-all text-sm text-[var(--text-secondary)]">{data.email} · {data.verified ? "Confirmado" : "Confirmação pendente"}</p>
      {!data.deliveryConfigured && <p className="mt-3 text-sm text-amber-300">O administrador ainda precisa ativar o envio pelo e-mail de suporte.</p>}
      {!data.verified && <button type="button" disabled={busy || !data.deliveryConfigured} onClick={() => void update(true)} className="mt-3 text-sm font-bold text-[var(--primary)] disabled:opacity-50">Enviar confirmação de e-mail</button>}
      <label className="my-5 flex items-center gap-3 text-sm font-semibold"><input type="checkbox" checked={data.enabled} onChange={(event) => setData({ ...data, enabled: event.target.checked })} /> Receber notificações da minha conta</label>
      <fieldset disabled={!data.enabled || busy} className="grid gap-3 text-sm sm:grid-cols-2 disabled:opacity-50">{Object.entries(sources).map(([key, label]) => <label key={key} className="flex items-center gap-3"><input type="checkbox" checked={data.sources[key] ?? true} onChange={(event) => setData({ ...data, sources: { ...data.sources, [key]: event.target.checked } })} />{label}</label>)}</fieldset>
      <p className="mt-5 text-xs leading-5 text-[var(--text-secondary)]">Mensagens do WhatsApp e e-mails recebidos ficam fora destes envios. Confirmação de conta e recuperação de senha continuam disponíveis independentemente destas preferências.</p>
      <button type="button" disabled={busy} onClick={() => void update()} className="mt-5 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? "Aguarde..." : "Salvar notificações"}</button>
    </> : !error && <p className="mt-3 text-sm">Carregando preferências...</p>}
    {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}{message && <p role="status" className="mt-3 text-sm text-emerald-300">{message}</p>}
  </section>;
}
