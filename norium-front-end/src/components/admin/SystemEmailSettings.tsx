import { useEffect, useState } from "react";
import { Mail, RefreshCw } from "lucide-react";
import { apiRequest } from "../../core/api/client";

type Delivery = { available?: boolean; error?: string; counts: Record<string, number>; recent: Array<{ kind: string; state: string; attempts: number; error: string | null; created: number }>; welcome: { title: string; description: string } };
type Configuration = { sender: string; enabled: boolean; passwordConfigured: boolean; publicUrl: string; ready: boolean; delivery?: Delivery };
const states: Record<string, string> = { pending: "Na fila", sending: "Enviando", sent: "Aceitos pelo servidor de e-mail", failed: "Falharam", skipped: "Ignorados", expired: "Expirados" };

export default function SystemEmailSettings({ token }: { token: string }) {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<Configuration>("/api/auth/admin/system-email", { token, signal: controller.signal }).then((value) => setConfig({ ...value, publicUrl: value.publicUrl || window.location.origin })).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Não foi possível carregar."); });
    return () => controller.abort();
  }, [token]);
  async function action(kind: "save" | "test" | "welcome" | "refresh") {
    if (!config) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (kind === "save") {
        await apiRequest("/api/auth/admin/system-email", { token, method: "PUT", body: JSON.stringify({ password, enabled: config.enabled, publicUrl: config.publicUrl }) });
        setPassword(""); setMessage("Configuração salva. Use o teste para verificar a autenticação SMTP.");
      } else if (kind !== "refresh") {
        const result = await apiRequest<{ message: string; queued?: number; alreadyQueued?: number; skipped?: number }>(`/api/auth/admin/system-email/${kind}`, { token, method: "POST" });
        setMessage(kind === "welcome" ? `${result.queued} e-mail(s) na fila; ${result.alreadyQueued} já incluído(s); ${result.skipped} conta(s) inativa(s) ou com notificações desativadas. Acompanhe a entrega abaixo.` : result.message);
      }
      setConfig(await apiRequest<Configuration>("/api/auth/admin/system-email", { token }));
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível concluir."); }
    finally { setBusy(false); }
  }
  const field = "mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm outline-none focus:border-[var(--primary)]";
  return <section className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
    <h2 className="flex items-center gap-2 text-lg font-bold"><Mail size={21} className="text-cyan-400" /> E-mail do sistema</h2>
    <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">Notificações individuais, confirmação de conta e recuperação de senha pelo suporte do Norium.</p>
    {config?.delivery?.error && <p role="alert" className="mt-4 rounded-lg border border-amber-500/30 p-4 text-sm text-amber-300">{config.delivery.error}</p>}
    {config && <><div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--background)] p-4 text-sm"><p className="break-all font-bold">{config.sender}</p><p className="mt-1 text-[var(--text-secondary)]">Hostinger · smtp.hostinger.com · TLS, porta 465</p></div>
      <form onSubmit={(event) => { event.preventDefault(); void action("save"); }} className="mt-5 space-y-4">
        <div className="grid gap-4 md:grid-cols-2"><label className="text-sm font-semibold">Endereço público do Norium<input type="url" required value={config.publicUrl} onChange={(event) => setConfig({ ...config, publicUrl: event.target.value })} className={field} placeholder="https://seu-norium.com" /></label>
        <label className="text-sm font-semibold">Senha da caixa de suporte<input type="password" autoComplete="new-password" maxLength={300} value={password} onChange={(event) => setPassword(event.target.value)} className={field} placeholder={config.passwordConfigured ? "Já configurada; preencha apenas para trocar" : "Senha criada na Hostinger"} /></label></div>
        <p className="text-xs leading-5 text-[var(--text-secondary)]">A senha fica criptografada no servidor e não é exibida novamente.</p>
        <label className="flex items-center gap-3 text-sm font-semibold"><input type="checkbox" checked={config.enabled} onChange={(event) => setConfig({ ...config, enabled: event.target.checked })} /> Ativar envios de e-mail</label>
        <div className="flex flex-wrap gap-3"><button disabled={busy} className="rounded-lg bg-[var(--primary)] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">Salvar configuração</button><button type="button" disabled={busy || !config.ready} onClick={() => void action("test")} className="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm font-bold disabled:opacity-50">Enviar teste para minha conta</button></div>
      </form>
      {config.delivery && <><div className="mt-7 rounded-xl border border-blue-500/25 bg-blue-500/5 p-5"><h3 className="text-base font-bold">{config.delivery.welcome.title}</h3><p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--text-secondary)]">{config.delivery.welcome.description}</p><p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">Envio individual para as contas ativas cadastradas que recebem notificações. Cada endereço entra uma única vez nesta campanha.</p><button type="button" disabled={busy || !config.ready} onClick={() => void action("welcome")} className="mt-4 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">Enviar boas-vindas aos cadastrados</button></div>
        <div className="mb-3 mt-6 flex items-center justify-between gap-3"><h3 className="text-sm font-bold">Acompanhamento dos envios</h3><button type="button" aria-label="Atualizar status dos envios" disabled={busy} onClick={() => void action("refresh")} className="rounded-lg border border-[var(--border)] p-2"><RefreshCw size={16} /></button></div>
        <div className="grid gap-3 sm:grid-cols-3">{Object.entries(states).map(([state, label]) => <div key={state} className="rounded-lg border border-[var(--border)] p-3"><p className="text-xl font-bold">{config.delivery?.counts[state] || 0}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{label}</p></div>)}</div>
        {config.delivery.recent.some((item) => item.error) && <p className="mt-3 text-sm text-amber-300">{config.delivery.recent.some((item) => item.error === "authentication") ? "A Hostinger recusou a autenticação. Confira a senha da caixa de suporte." : "Há envios com falha. A fila repete tentativas temporárias automaticamente; confira a configuração SMTP."}</p>}
        <p className="mt-3 text-xs text-[var(--text-secondary)]">Aceito pelo servidor significa que o SMTP recebeu a mensagem. A entrega na caixa de entrada pode depender do provedor do destinatário.</p>
      </>}
    </>}
    {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}{message && <p role="status" className="mt-4 text-sm leading-6 text-emerald-300">{message}</p>}
  </section>;
}
