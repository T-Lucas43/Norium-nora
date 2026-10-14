import { useEffect, useState } from "react";
import TeamChatDialog from "./TeamChatDialog";
import { NoraMarkdown } from "../nora/NoraResponseContent";
import NoraApprovalCard, { normalizeApprovalCard, type NoraApprovalSnapshot } from "../nora/NoraApprovalCard";
import TeamResourceCards from "./TeamResourceCards";
import type { TeamMessage, TeamResourceCard } from "./teamChatTypes";

export type NoraSource = { messageId: string; threadId: string; label: string };
export type NoraDialogInput = { mode: "ask" | "catch-up" | "search" | "client"; source?: TeamMessage; question?: string };
type NoraResult = { text?: string; message?: TeamMessage; sources?: NoraSource[]; through?: string; messageCount?: number; cards?: TeamResourceCard[] };
type Client = { id: string; name: string; email: string; phone: string };

export default function TeamNoraDialog({ input, request, onClose, onSource, onMessage, onTask, onSchedule }: {
  input: NoraDialogInput; request: (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;
  onClose: () => void; onSource: (source: NoraSource) => void; onMessage: (message: TeamMessage) => void;
  onTask?: (message: TeamMessage) => void; onSchedule?: (message: TeamMessage) => void;
}) {
  const [question, setQuestion] = useState(input.question || (input.mode === "search" ? "" : "Explique esta mensagem e sugira uma resposta."));
  const [hours, setHours] = useState("8");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NoraResult | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [client, setClient] = useState("");
  const [clientQuery, setClientQuery] = useState("");
  const [channel, setChannel] = useState("email");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState(input.source?.text || "");
  const [approval, setApproval] = useState<NoraApprovalSnapshot | null>(null);
  useEffect(() => {
    if (input.mode !== "client") return;
    let cancelled = false;
    void request("/nora/clients").then(data => { if (!cancelled) setClients((data.clients || []) as Client[]); }).catch(reason => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [input.mode, request]);
  async function run() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (input.mode === "client" && input.source) {
        const data = await request(`/messages/${encodeURIComponent(input.source.id)}/client-approval`, { method: "POST", body: JSON.stringify({ clientId: client, channel, subject, body }) });
        const prepared = normalizeApprovalCard(data.approval);
        if (!prepared?.digest) throw new Error("Não foi possível confirmar o conteúdo exato da aprovação.");
        setApproval(prepared);
      } else {
        const data = input.mode === "catch-up" ? await request("/nora/catch-up", { method: "POST", body: JSON.stringify({ hours: Number(hours) }) })
          : input.mode === "search" ? await request(`/nora/search?q=${encodeURIComponent(question)}`)
          : await request(`/messages/${encodeURIComponent(input.source?.id || "")}/nora`, { method: "POST", body: JSON.stringify({ question }) });
        const answer = data as NoraResult;
        if (answer.message) onMessage(answer.message);
        setResult(answer);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "A Nora não conseguiu concluir este pedido."); }
    finally { setBusy(false); }
  }
  async function markRead() {
    if (!result?.through || busy) return;
    setBusy(true);
    try { await request("/nora/catch-up/read", { method: "POST", body: JSON.stringify({ through: result.through }) }); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao marcar como lido."); }
    finally { setBusy(false); }
  }
  const title = { ask: "Nora nesta conversa", "catch-up": "O que você perdeu", search: "Buscar com a Nora", client: "Enviar para um cliente" }[input.mode];
  const citations = result?.sources || result?.message?.metadata?.noraSources as NoraSource[] || [];
  return <TeamChatDialog title={title} onClose={onClose}>
    {input.mode === "client" ? approval ? <><p>Prévia preparada. O envio depende da decisão abaixo sobre este conteúdo exato.</p><NoraApprovalCard approval={approval} onDecision={setApproval} /></> : <form onSubmit={event => { event.preventDefault(); void run(); }}>
      <label>Buscar cliente<div className="team-v3-presets"><input aria-label="Buscar cliente para envio" value={clientQuery} onChange={event => setClientQuery(event.target.value)} maxLength={160} /><button type="button" className="nx-btn is-sm" disabled={busy} onClick={() => { void request(`/nora/clients?q=${encodeURIComponent(clientQuery)}`).then(data => setClients((data.clients || []) as Client[])).catch(reason => setError(reason.message)); }}>Buscar</button></div></label>
      <label>Cliente<select aria-label="Cliente destinatário" required value={client} onChange={event => setClient(event.target.value)}><option value="">Selecione</option>{clients.map(item => <option key={item.id} value={item.id}>{item.name} · {channel === "email" ? item.email || "sem e-mail" : item.phone || "sem telefone"}</option>)}</select></label>
      <label>Canal<select aria-label="Canal de envio ao cliente" value={channel} onChange={event => setChannel(event.target.value)}><option value="email">E-mail</option><option value="whatsapp">WhatsApp</option></select></label>
      {channel === "email" && <label>Assunto<input aria-label="Assunto para o cliente" required maxLength={180} value={subject} onChange={event => setSubject(event.target.value)} /></label>}
      <label>Mensagem<textarea aria-label="Texto para o cliente" required rows={6} maxLength={channel === "email" ? 12000 : 1200} value={body} onChange={event => setBody(event.target.value)} /></label>
      <p>Revise o destinatário e o conteúdo. Preparar gera uma aprovação; o envio exige “Permitir”.</p>
      <footer><button type="button" className="nx-btn" onClick={onClose}>Cancelar</button><button type="submit" className="nx-btn is-primary" disabled={busy || !client}>{busy ? "Preparando…" : "Preparar aprovação"}</button></footer>
    </form> : <>
      {input.source && <blockquote className="team-v3-dialog-source"><strong>{input.source.senderName}</strong><p>{input.source.text.slice(0, 500)}</p></blockquote>}
      <form onSubmit={event => { event.preventDefault(); void run(); }}>
        {input.mode === "catch-up" ? <label>Período<select aria-label="Período do resumo" value={hours} onChange={event => setHours(event.target.value)}>{[1, 4, 8, 24, 48, 168].map(value => <option key={value} value={value}>Últimas {value} horas</option>)}</select></label> : <label>{input.mode === "search" ? "Nome do cliente, proposta ou tarefa" : "Seu pedido"}<textarea aria-label="Pedido à Nora no chat" required minLength={input.mode === "search" ? 2 : 1} maxLength={1000} rows={3} value={question} onChange={event => setQuestion(event.target.value)} /></label>}
        <p>{input.mode === "search" ? "Busca nos itens que sua conta pode acessar." : "Até 12 mensagens acessíveis serão analisadas. A resposta é privada e o consumo usa sua franquia de tokens."}</p>
        <footer><button type="button" className="nx-btn" onClick={onClose}>Fechar</button><button type="submit" className="nx-btn is-primary" disabled={busy}>{busy ? "Consultando…" : input.mode === "catch-up" ? "Gerar resumo" : "Consultar"}</button></footer>
      </form>
      {result && <section className="team-v3-nora-result" aria-label="Resultado da Nora"><NoraMarkdown allowImages={false} text={result.message?.text || result.text || ""} /><TeamResourceCards cards={result.cards || []} />{citations.length > 0 && <details><summary>Fontes consultadas ({citations.length})</summary><div className="team-v3-presets">{citations.map((source, index) => <button className="nx-btn is-sm" key={source.messageId} type="button" onClick={() => onSource(source)}>{source.label} · {index+1}</button>)}</div></details>}
        {result.message && <footer>{onTask && <button type="button" className="nx-btn" onClick={() => onTask(result.message!)}>Revisar tarefa</button>}{onSchedule && <button type="button" className="nx-btn" onClick={() => onSchedule(result.message!)}>Revisar agendamento</button>}</footer>}
        {result.through && <button type="button" className="nx-btn" disabled={busy} onClick={() => void markRead()}>Marcar tudo como lido até este resumo</button>}
      </section>}
    </>}
    {error && <p role="alert" className="team-v3-dialog-error">{error}</p>}
  </TeamChatDialog>;
}
