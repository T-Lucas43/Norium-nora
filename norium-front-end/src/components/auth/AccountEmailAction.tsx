import { useState } from "react";
import { ArrowLeft, KeyRound, LockKeyhole, Mail, MailCheck, MailOpen } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import AuthLayout from "./AuthLayout";

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
  const Icon = mode === "forgot" ? KeyRound : mode === "reset" ? LockKeyhole : MailOpen;

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

  return <AuthLayout>
    <div className="ac-icon"><Icon size={22} aria-hidden="true" /></div>
    <h1 className="ac-title">{title}</h1>
    <p className="ac-sub">{mode === "forgot" ? "Informe o e-mail da sua conta. Enviaremos um link para você redefinir a senha." : mode === "reset" ? "Use pelo menos 10 caracteres. Suas sessões anteriores serão encerradas." : "Confirme este endereço para receber os avisos de tarefas, reuniões e outras atualizações da sua conta."}</p>
    {message ? <p role="status" className="ac-ok"><MailCheck size={18} aria-hidden="true" /><span>{message}</span></p> : <form onSubmit={(event) => void submit(event)} className="ac-form" aria-busy={busy}>
      {mode === "forgot" && <div className="ac-field"><label className="ac-label" htmlFor="account-email">E-mail</label><span className="ac-input"><Mail size={16} aria-hidden="true" /><input id="account-email" name="email" type="email" inputMode="email" autoCapitalize="none" spellCheck={false} autoComplete="email" required maxLength={180} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@email.com" /></span></div>}
      {mode === "reset" && <>
        <div className="ac-field"><label className="ac-label" htmlFor="account-new-password">Nova senha</label><span className="ac-input"><LockKeyhole size={16} aria-hidden="true" /><input id="account-new-password" name="new-password" type="password" autoComplete="new-password" required minLength={10} maxLength={180} value={password} onChange={(event) => setPassword(event.target.value)} /></span></div>
        <div className="ac-field"><label className="ac-label" htmlFor="account-confirm-password">Repita a nova senha</label><span className="ac-input"><LockKeyhole size={16} aria-hidden="true" /><input id="account-confirm-password" name="confirm-password" type="password" autoComplete="new-password" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></span></div>
      </>}
      {error && <p role="alert" className="ac-alert">{error}</p>}
      <button disabled={busy} className="ac-btn is-primary">{busy ? "Aguarde..." : mode === "forgot" ? "Enviar link de recuperação" : mode === "reset" ? "Redefinir senha" : "Confirmar meu e-mail"}</button>
    </form>}
    <button type="button" onClick={onBack} className="ac-link ac-back" style={{ marginTop: 20 }}><ArrowLeft size={14} aria-hidden="true" />Voltar ao Norium</button>
  </AuthLayout>;
}
