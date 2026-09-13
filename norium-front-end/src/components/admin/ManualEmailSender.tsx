import { useEffect, useRef, useState } from "react";
import { Loader2, Mail, Send, Sparkles } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import noraLogo from "../../assets/nora-brand.png";

type Recipient = { id: string; name: string; email: string; enabled: boolean };
type EmailTone = "profissional" | "cordial" | "direto" | "comercial";
type GeneratedDraft = { subject: string; message: string; provider: string };

const input = "mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm outline-none transition-colors focus:border-[var(--primary)]";

export default function ManualEmailSender({ token }: { token: string }) {
  const [users, setUsers] = useState<Recipient[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [aiContext, setAiContext] = useState("");
  const [aiTone, setAiTone] = useState<EmailTone>("profissional");
  const [aiProvider, setAiProvider] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dispatch = useRef(crypto.randomUUID());

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<{ users: Recipient[] }>("/api/auth/admin/system-email/recipients", { token, signal: controller.signal })
      .then((value) => setUsers(value.users))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Não foi possível carregar os usuários.");
      });
    return () => controller.abort();
  }, [token]);

  function edit() {
    setPreview(false);
    setMessage("");
    dispatch.current = crypto.randomUUID();
  }

  async function generateDraft() {
    setAiBusy(true);
    setError("");
    setMessage("");
    setPreview(false);
    try {
      const result = await apiRequest<GeneratedDraft>("/api/auth/admin/system-email/draft", {
        token,
        method: "POST",
        body: JSON.stringify({ context: aiContext, tone: aiTone }),
      });
      setSubject(result.subject);
      setBody(result.message);
      setAiProvider(result.provider);
      dispatch.current = crypto.randomUUID();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível gerar o rascunho agora.");
    } finally {
      setAiBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<{ queued: number; alreadyQueued: number; skipped: number }>("/api/auth/admin/system-email/send", {
        token,
        method: "POST",
        body: JSON.stringify({ recipientIds: selected, subject, message: body, dispatchId: dispatch.current }),
      });
      setMessage(`${result.queued} e-mail(s) na fila, ${result.alreadyQueued} já incluído(s) e ${result.skipped} ignorado(s). Atualize o acompanhamento abaixo para conferir a entrega.`);
      setPreview(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível enviar. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  const recipients = users.filter((user) => `${user.name} ${user.email}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  return <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
    <h1 className="flex items-center gap-2 text-xl font-bold"><Mail className="text-cyan-400" /> Enviar e-mail aos usuários</h1>
    <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">Crie a mensagem, revise o resultado e escolha quem deve recebê-la. O Norium envia um e-mail separado para cada pessoa.</p>

    <fieldset disabled={busy || aiBusy} className="mt-6 grid gap-6 disabled:opacity-60 lg:grid-cols-[minmax(240px,1fr)_minmax(0,1.6fr)]">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold">Destinatários · {selected.length}</h2>
          <button type="button" onClick={() => {
            edit();
            setSelected(selected.length ? [] : users.filter((user) => user.enabled).slice(0, 200).map((user) => user.id));
          }} className="text-xs font-semibold text-[var(--primary)]">{selected.length ? "Limpar seleção" : "Selecionar todos"}</button>
        </div>
        <input aria-label="Buscar destinatários" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar nome ou e-mail" className={input} />
        <div className="mt-3 max-h-80 space-y-2 overflow-auto">
          {recipients.map((user) => <label key={user.id} className={`flex gap-3 rounded-lg border border-[var(--border)] p-3 ${!user.enabled ? "opacity-50" : ""}`}>
            <input type="checkbox" disabled={!user.enabled} checked={selected.includes(user.id)} onChange={(event) => {
              edit();
              setSelected((current) => event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id));
            }} />
            <span className="min-w-0"><span className="block text-sm font-semibold">{user.name}</span><span className="block break-all text-xs text-[var(--text-secondary)]">{user.email}</span>{!user.enabled && <span className="text-xs">Notificações desativadas</span>}</span>
          </label>)}
          {!recipients.length && <p className="py-4 text-sm text-[var(--text-secondary)]">Nenhum usuário nesta busca.</p>}
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-cyan-400/25 bg-cyan-400/5 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-400/10 text-cyan-300"><Sparkles size={19} /></span>
            <div><h2 className="font-bold">Escrever com a Nora</h2><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">Informe os fatos e o objetivo. A IA prepara um assunto e um texto para você revisar.</p></div>
          </div>
          <label className="mt-4 block text-sm font-bold">Contexto para a IA
            <textarea aria-label="Contexto para a IA" value={aiContext} maxLength={6000} rows={5} onChange={(event) => setAiContext(event.target.value)} className={`${input} resize-y font-normal leading-6`} placeholder="Ex.: Avise que a nova área financeira entra no ar na segunda-feira e destaque que os dados anteriores continuam disponíveis." />
          </label>
          <div className="mt-4 grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="text-sm font-bold">Tom do e-mail
              <select aria-label="Tom do e-mail" value={aiTone} onChange={(event) => setAiTone(event.target.value as EmailTone)} className={input}>
                <option value="profissional">Profissional</option>
                <option value="cordial">Cordial</option>
                <option value="direto">Direto</option>
                <option value="comercial">Comercial</option>
              </select>
            </label>
            <button type="button" disabled={aiContext.trim().length < 10 || aiBusy || busy} onClick={() => void generateDraft()} className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-5 text-sm font-bold text-white disabled:opacity-50">
              {aiBusy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}{aiBusy ? "Redigindo..." : "Gerar rascunho"}
            </button>
          </div>
          <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">A geração não envia nada. Você pode alterar livremente o rascunho antes da pré-visualização.</p>
          {aiProvider && <p aria-live="polite" className="mt-2 text-xs font-semibold text-cyan-300">Rascunho gerado por {aiProvider}. Revise antes de enviar.</p>}
        </div>

        <label className="block text-sm font-bold">Assunto
          <input value={subject} maxLength={140} onChange={(event) => { edit(); setSubject(event.target.value); }} className={input} placeholder="Ex.: Novidades do Norium" />
        </label>
        <label className="block text-sm font-bold">Mensagem
          <textarea value={body} maxLength={10000} rows={8} onChange={(event) => { edit(); setBody(event.target.value); }} className={`${input} resize-y font-normal leading-6`} placeholder="Escreva o conteúdo do e-mail..." />
        </label>
        <p className="text-xs leading-5 text-[var(--text-secondary)]">A saudação com o nome de cada pessoa, a identidade Norium e o botão de acesso são adicionados automaticamente.</p>
        <button type="button" disabled={!selected.length || !subject.trim() || !body.trim() || Boolean(message)} onClick={() => setPreview(true)} className="rounded-lg border border-[var(--primary)] px-4 py-2.5 text-sm font-bold text-[var(--primary)] disabled:opacity-50">Pré-visualizar e-mail</button>
      </div>
    </fieldset>

    {preview && <div className="mt-6 rounded-xl border border-blue-500/30 bg-[var(--background)] p-5 sm:p-7">
      <p className="text-xs font-bold uppercase tracking-widest text-cyan-400">Prévia · {selected.length} destinatário(s)</p>
      <p className="mt-5 text-sm text-[var(--text-secondary)]">Olá, {users.find((user) => selected.includes(user.id))?.name || "usuário"}.</p>
      <h2 className="mt-3 text-xl font-bold">{subject}</h2>
      <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">{body}</p>
      <div role="group" aria-label="Assinatura da Nora" className="mt-6 rounded-lg border-t border-[var(--border)] bg-[#0b1423] p-4">
        <div className="flex items-center gap-3">
          <img src={noraLogo} alt="Nora" className="h-14 w-14 rounded-xl object-cover" />
          <span><strong className="block text-xl text-slate-50">Nora</strong><span className="block text-xs leading-5 text-slate-300">Assistente virtual</span><span className="text-[10px] font-bold tracking-[0.18em] text-blue-300">NORIUM</span></span>
        </div>
        <div className="mt-3 border-t border-slate-700 pt-3">
          <img src="/norium-logo.png" alt="Norium" className="h-auto w-24 max-w-full" />
        </div>
      </div>
      <p className="mt-4 text-xs text-[var(--text-secondary)]">Botão incluído no e-mail: Abrir Norium</p>
      <button type="button" disabled={busy} onClick={() => void send()} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-5 py-3 text-sm font-bold text-white disabled:opacity-50"><Send size={16} />{busy ? "Enfileirando..." : "Enviar aos selecionados"}</button>
    </div>}
    {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
    {message && <p role="status" className="mt-4 text-sm leading-6 text-emerald-300">{message}</p>}
  </section>;
}
