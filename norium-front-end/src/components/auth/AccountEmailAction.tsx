import { useState } from "react";
import { Mail, ShieldCheck } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import BrandLogo from "../layout/BrandLogo";

export type EmailActionMode = "forgot" | "reset" | "verify";

export default function AccountEmailAction({ mode, token = "", onBack, onReset }: {
  mode: EmailActionMode; token?: string; onBack: () => void; onReset?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const title = mode === "forgot" ? "Recupere seu acesso" : mode === "reset" ? "Crie uma nova senha" : "Confirme seu e-mail";
  const inputClass = "mt-2 h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm outline-none focus:border-[var(--primary)]";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mode === "reset" && password !== confirmation) { setError("As senhas precisam ser iguais."); return; }
    setBusy(true); setError("");
    try {
      const result = await apiRequest<{ message: string }>(`/api/auth/${mode === "forgot" ? "forgot-password" : mode === "reset" ? "reset-password" : "verify-email"}`, {
        method: "POST", token: null,
        body: JSON.stringify(mode === "forgot" ? { email } : mode === "reset" ? { token, password } : { token }),
      });
      setMessage(result.message); setPassword(""); setConfirmation("");
      if (mode === "reset") onReset?.();
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível concluir. Tente novamente."); }
    finally { setBusy(false); }
  }

  return <main className="norium-modern-shell norium-auth-shell norium-auth-dark grid min-h-dvh place-items-center bg-[var(--background)] p-5 text-[var(--text)]">
    <section className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl sm:p-9">
      <BrandLogo className="h-12 w-36" />
      <div className="mb-5 mt-8 grid h-12 w-12 place-items-center rounded-xl bg-blue-500/15 text-cyan-400">{message ? <ShieldCheck /> : <Mail />}</div>
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{mode === "forgot" ? "Informe o e-mail da sua conta. Enviaremos um link para você redefinir a senha." : mode === "reset" ? "Use pelo menos 10 caracteres. Suas sessões anteriores serão encerradas." : "Confirme este endereço para receber os avisos de tarefas, reuniões e outras atualizações da sua conta."}</p>
      {message ? <p role="status" className="mt-5 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm leading-6 text-emerald-300">{message}</p> : <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-4">
        {mode === "forgot" && <label className="block text-sm font-semibold">E-mail<input type="email" autoComplete="email" required maxLength={180} value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} /></label>}
        {mode === "reset" && <><label className="block text-sm font-semibold">Nova senha<input type="password" autoComplete="new-password" required minLength={10} maxLength={180} value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} /></label><label className="block text-sm font-semibold">Repita a nova senha<input type="password" autoComplete="new-password" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={inputClass} /></label></>}
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <button disabled={busy} className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 px-5 py-3 text-sm font-bold text-white disabled:opacity-50">{busy ? "Aguarde..." : mode === "forgot" ? "Enviar link de recuperação" : mode === "reset" ? "Redefinir senha" : "Confirmar meu e-mail"}</button>
      </form>}
      <button type="button" onClick={onBack} className="mt-6 w-full py-2 text-sm font-semibold text-[var(--text-secondary)]">Voltar ao Norium</button>
    </section>
  </main>;
}
