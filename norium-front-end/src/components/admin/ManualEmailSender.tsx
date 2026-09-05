import { useEffect, useRef, useState } from "react";
import { Mail, Send } from "lucide-react";
import { apiRequest } from "../../core/api/client";

type Recipient = { id: string; name: string; email: string; enabled: boolean };
export default function ManualEmailSender({ token }: { token: string }) {
  const [users, setUsers] = useState<Recipient[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dispatch = useRef(crypto.randomUUID());
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<{ users: Recipient[] }>("/api/auth/admin/system-email/recipients", { token, signal: controller.signal }).then((value) => setUsers(value.users)).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Não foi possível carregar os usuários."); });
    return () => controller.abort();
  }, [token]);
  function edit() { setPreview(false); setMessage(""); dispatch.current = crypto.randomUUID(); }
  async function send() {
    setBusy(true); setError("");
    try {
      const result = await apiRequest<{ queued: number; alreadyQueued: number; skipped: number }>("/api/auth/admin/system-email/send", { token, method: "POST", body: JSON.stringify({ recipientIds: selected, subject, message: body, dispatchId: dispatch.current }) });
      setMessage(`${result.queued} e-mail(s) na fila, ${result.alreadyQueued} já incluído(s) e ${result.skipped} ignorado(s). Atualize o acompanhamento abaixo para conferir a entrega.`);
      setPreview(false);
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível enviar. Tente novamente."); }
    finally { setBusy(false); }
  }
  const recipients = users.filter((user) => `${user.name} ${user.email}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const input = "mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm outline-none focus:border-[var(--primary)]";
  return <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
    <h1 className="flex items-center gap-2 text-xl font-bold"><Mail className="text-cyan-400" /> Enviar e-mail aos usuários</h1>
    <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">Escreva um aviso e escolha quem deve recebê-lo. O Norium envia uma mensagem separada para cada pessoa.</p>
    <fieldset disabled={busy} className="mt-6 grid gap-6 disabled:opacity-60 lg:grid-cols-[minmax(240px,1fr)_minmax(0,1.6fr)]">
      <div><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-bold">Destinatários · {selected.length}</h2><button type="button" onClick={() => { edit(); setSelected(selected.length ? [] : users.filter((user) => user.enabled).slice(0, 200).map((user) => user.id)); }} className="text-xs font-semibold text-[var(--primary)]">{selected.length ? "Limpar seleção" : "Selecionar todos"}</button></div>
        <input aria-label="Buscar destinatários" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar nome ou e-mail" className={input} />
        <div className="mt-3 max-h-80 space-y-2 overflow-auto">{recipients.map((user) => <label key={user.id} className={`flex gap-3 rounded-lg border border-[var(--border)] p-3 ${!user.enabled ? "opacity-50" : ""}`}><input type="checkbox" disabled={!user.enabled} checked={selected.includes(user.id)} onChange={(event) => { edit(); setSelected((current) => event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id)); }} /><span className="min-w-0"><span className="block text-sm font-semibold">{user.name}</span><span className="block break-all text-xs text-[var(--text-secondary)]">{user.email}</span>{!user.enabled && <span className="text-xs">Notificações desativadas</span>}</span></label>)}{!recipients.length && <p className="py-4 text-sm text-[var(--text-secondary)]">Nenhum usuário nesta busca.</p>}</div>
      </div>
      <div className="space-y-4"><label className="block text-sm font-bold">Assunto<input value={subject} maxLength={140} onChange={(event) => { edit(); setSubject(event.target.value); }} className={input} placeholder="Ex.: Novidades do Norium" /></label><label className="block text-sm font-bold">Mensagem<textarea value={body} maxLength={10000} rows={8} onChange={(event) => { edit(); setBody(event.target.value); }} className={`${input} resize-y font-normal leading-6`} placeholder="Escreva o conteúdo do e-mail..." /></label><p className="text-xs leading-5 text-[var(--text-secondary)]">A saudação com o nome de cada pessoa, a identidade Norium e o botão de acesso são adicionados automaticamente.</p><button type="button" disabled={!selected.length || !subject.trim() || !body.trim() || Boolean(message)} onClick={() => setPreview(true)} className="rounded-lg border border-[var(--primary)] px-4 py-2.5 text-sm font-bold text-[var(--primary)] disabled:opacity-50">Pré-visualizar e-mail</button></div>
    </fieldset>
    {preview && <div className="mt-6 rounded-xl border border-blue-500/30 bg-[var(--background)] p-5 sm:p-7"><p className="text-xs font-bold uppercase tracking-widest text-cyan-400">Prévia · {selected.length} destinatário(s)</p><p className="mt-5 text-sm text-[var(--text-secondary)]">Olá, {users.find((user) => selected.includes(user.id))?.name || "usuário"}.</p><h2 className="mt-3 text-xl font-bold">{subject}</h2><p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">{body}</p><p className="mt-5 text-xs text-[var(--text-secondary)]">Norium · suporte@norium-ai.com · Botão: Abrir Norium</p><button type="button" disabled={busy} onClick={() => void send()} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-5 py-3 text-sm font-bold text-white disabled:opacity-50"><Send size={16} />{busy ? "Enfileirando..." : "Enviar aos selecionados"}</button></div>}
    {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}{message && <p role="status" className="mt-4 text-sm leading-6 text-emerald-300">{message}</p>}
  </section>;
}
