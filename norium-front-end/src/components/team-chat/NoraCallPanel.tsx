import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import noraBrand from "../../assets/nora-brand.png";
import type { NoraCallSnapshot } from "./useTeamCall";
import { useTeamApiRequest } from "./CallSession";
import { mergeMeetingTranscript, type MeetingFact, type MeetingNoraView, type MeetingPrivateAnswer, type MeetingTranscriptSegment, type MeetingUnderstanding } from "./meetingNoraTypes";

const LABELS = { paused: "Pausada", awaiting_consent: "Aguardando consentimento", awaiting_agent: "Aguardando conexão", listening: "Ouvindo", thinking: "Pensando", speaking: "Falando" };

export default function NoraCallPanel({ state, currentUserId, isHost, update, clientId, members = [], transcript = [], understanding, captions = false, onCaptions }: {
  state: NoraCallSnapshot;
  currentUserId: string;
  isHost: boolean;
  update: (action: { type: "control"; enabled: boolean } | { type: "consent"; accepted: boolean; revision: number }) => void;
  clientId?: string;
  members?: Array<{ id: string; nome: string }>;
  transcript?: MeetingTranscriptSegment[];
  understanding?: MeetingUnderstanding | null;
  captions?: boolean;
  onCaptions?: (enabled: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"now" | "transcript" | "ask">("now");
  const [history, setHistory] = useState<MeetingNoraView | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<MeetingPrivateAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useTeamApiRequest();
  const generation = useRef(0);
  const lifecycle = useRef(0);
  const invalidateSession = useCallback(() => { generation.current++; lifecycle.current++; }, []);
  const pendingRequest = useRef<{ question: string; id: string } | null>(null);
  useEffect(() => {
    invalidateSession();
    setHistory(null); setAnswer(null); setQuestion(""); setError(""); setBusy(false); pendingRequest.current = null;
    return invalidateSession;
  }, [state.callId, clientId, invalidateSession]);
  useEffect(() => {
    if (!expanded || !clientId) return;
    let active = true;
    const epoch = ++generation.current;
    void request<MeetingNoraView>(`/api/team-chat/calls/${encodeURIComponent(state.callId)}/nora/session?clientId=${encodeURIComponent(clientId)}`)
      .then((value) => { if (active && epoch === generation.current && value.callId === state.callId) setHistory(value); })
      .catch((cause) => { if (active && epoch === generation.current) setError(cause instanceof Error ? cause.message : "Não foi possível carregar a transcrição."); });
    return () => { active = false; };
  }, [expanded, clientId, request, state.callId, state.revision]);
  const segments = mergeMeetingTranscript(history?.segments || [], transcript, state.callId);
  const facts = understanding || history?.understanding;
  const name = (userId: string) => userId === currentUserId ? "Você" : members.find((member) => member.id === userId)?.nome || "Participante";
  const timestamp = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
  async function ask(event?: FormEvent) {
    event?.preventDefault();
    const value = question.trim();
    if (!value || busy || !clientId) return;
    if (pendingRequest.current?.question !== value) pendingRequest.current = { question: value, id: crypto.randomUUID() };
    const epoch = lifecycle.current;
    setBusy(true); setError(""); setAnswer(null);
    try {
      const result = await request<MeetingPrivateAnswer>(`/api/team-chat/calls/${encodeURIComponent(state.callId)}/nora/question`, {
        method: "POST", body: JSON.stringify({ clientId, requestId: pendingRequest.current.id, question: value }), timeoutMs: 65_000,
      });
      if (epoch === lifecycle.current && result.private === true && result.recipientUserId === currentUserId) setAnswer(result);
    } catch (cause) {
      if (epoch === lifecycle.current) setError(cause instanceof Error ? cause.message : "Não foi possível concluir a pergunta.");
    } finally { if (epoch === lifecycle.current) setBusy(false); }
  }
  function FactList({ title, values }: { title: string; values: MeetingFact[] }) {
    return <section className="team-call-nora-facts"><h4>{title}</h4>{values.length ? <ul>{values.map((fact) => <li key={`${fact.segment_id}:${fact.quote}`}>
      <p>{fact.quote}</p><small>Fonte: Transcrição · {name(fact.user_id)} · {timestamp(fact.start)}</small>
      {title === "Tarefas sugeridas" && <p className="team-call-nora-task-note">{fact.assignee_id ? `Responsável sugerido: ${name(fact.assignee_id)}` : "Responsável não definido"} · {fact.deadline_text || "Prazo não definido"} · Proposta para revisão</p>}
    </li>)}</ul> : <p>Nenhum registro ainda.</p>}</section>;
  }
  const pending = state.pendingUserIds.includes(currentUserId);
  return <section className="team-call-nora" aria-label="Nora na reunião" data-state={state.state}>
    <header><img src={noraBrand} alt="Nora" /><button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>Nora · {LABELS[state.state]}</button>
      {isHost && <button type="button" disabled={!state.available && !state.requested} onClick={() => update({ type: "control", enabled: !state.requested })}>{state.requested ? "Pausar Nora" : "Ativar Nora"}</button>}
    </header>
    {expanded && <div className="team-call-nora-body">
      {!state.available && <p>Transcrição indisponível nesta chamada.</p>}
      {state.requested && <><p>{state.notice}</p><button type="button" onClick={() => update({ type: "consent", accepted: pending, revision: state.revision })}>{pending ? "Autorizar transcrição nesta reunião" : "Retirar autorização da transcrição"}</button>
        {state.state === "awaiting_agent" && <p role="status">Todos autorizaram. A transcrição começará quando o agente conectar.</p>}</>}
      {onCaptions && <label className="team-call-nora-captions"><input type="checkbox" checked={captions} onChange={(event) => onCaptions(event.target.checked)} />Legendas só para mim</label>}
      <nav aria-label="Painel da Nora">{([["now", "Agora"], ["transcript", "Transcrição"], ["ask", "Perguntar"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}</nav>
      {error && <p role="alert">{error}</p>}
      {tab === "now" && <div><FactList title="Resumo até agora" values={facts?.summary || []} /><FactList title="Decisões" values={facts?.decisions || []} /><FactList title="Tarefas sugeridas" values={facts?.tasks || []} /><FactList title="Perguntas em aberto" values={facts?.questions || []} /></div>}
      {tab === "transcript" && <section aria-label="Transcrição da reunião">{segments.length ? <ol>{segments.map((segment) => <li key={segment.id}><small>{timestamp(segment.start)} · {name(segment.userId)}</small><p>{segment.text}</p></li>)}</ol> : <p>Ainda não há falas transcritas disponíveis para você.</p>}<p className="team-call-nora-task-note">Histórico temporário disponível durante esta chamada.</p></section>}
      {tab === "ask" && <section aria-label="Pergunta privada para a Nora"><p>Somente você vê a resposta. A Nora usa as falas disponíveis para você nesta reunião.</p><div className="team-call-nora-suggestions">{["Resuma os últimos 10 minutos", "Quem ficou responsável por cada tarefa?"].map((value) => <button key={value} type="button" disabled={busy} onClick={() => { pendingRequest.current = null; setQuestion(value); }}>{value}</button>)}</div>
        <form onSubmit={(event) => void ask(event)}><label>O que deseja perguntar?<textarea aria-label="Pergunte à Nora só para você" value={question} maxLength={1000} disabled={busy} onChange={(event) => { pendingRequest.current = null; setQuestion(event.target.value); }} /></label><button type="submit" disabled={busy || !question.trim() || !clientId}>{busy ? "Preparando resposta…" : "Perguntar à Nora"}</button></form>
        {answer && <article aria-label="Resposta privada da Nora"><p>{answer.text}</p>{answer.sources.map((source) => <p key={source.segmentId} className="team-call-nora-task-note">Fonte: {source.module} · {name(source.userId)} · {timestamp(source.start)}</p>)}</article>}
      </section>}
    </div>}
  </section>;
}
