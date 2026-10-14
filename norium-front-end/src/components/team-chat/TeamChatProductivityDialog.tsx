import { useEffect, useRef, useState } from "react";
import TeamChatDialog from "./TeamChatDialog";
import type { TeamMessage } from "./teamChatTypes";
import type { NoriumUser } from "../../types/auth";
import type { ConversationListItem } from "./TeamConversationList";
import type { TeamThreadScope } from "./useTeamCall";

export type ProductivityAction = "task" | "reminder" | "schedule" | "poll" | "forward";
export type ScheduleItem = { id: string; dueAt: string; state: string; message: TeamMessage };
type Request = (path: string, init?: RequestInit) => Promise<Record<string, unknown> & { projects?: { id: string; name: string }[] }>;
function localDate(value: Date) { return new Date(value.getTime() - value.getTimezoneOffset()*60000).toISOString().slice(0, 16); }

export default function TeamChatProductivityDialog({ action, source, draft, members, conversations, target, request, onClose, onDone, attachments, scheduled }: {
  action: ProductivityAction; source?: TeamMessage; draft: string; members: NoriumUser[]; conversations: ConversationListItem[];
  target: { scope: TeamThreadScope; recipientId?: string | null; subteamId?: string | null };
  request: Request; onClose: () => void; onDone: (data: Record<string, unknown>) => void;
  attachments?: () => Promise<unknown[]>; scheduled?: ScheduleItem;
}) {
  const [title, setTitle] = useState((source?.text || draft).slice(0, 160));
  const [body, setBody] = useState(scheduled?.message.text || draft);
  const [due, setDue] = useState(localDate(scheduled ? new Date(scheduled.dueAt) : new Date(Date.now()+3600000)));
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [project, setProject] = useState("");
  const [assignee, setAssignee] = useState("");
  const [taskDate, setTaskDate] = useState("");
  const [options, setOptions] = useState("");
  const [multiple, setMultiple] = useState(false);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const requestRef = useRef(request); requestRef.current = request;
  useEffect(() => {
    if (action !== "task") return;
    let cancelled = false;
    void requestRef.current("/task-options").then((data) => { if (!cancelled) { setProjects(data.projects || []); setProject(data.projects?.[0]?.id || ""); } }).catch((error) => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [action]);
  function preset(kind: "hour" | "tomorrow" | "monday") {
    const date = new Date();
    if (kind === "hour") date.setHours(date.getHours()+1);
    else { date.setDate(date.getDate() + (kind === "tomorrow" ? 1 : (8-date.getDay())%7 || 7)); date.setHours(9, 0, 0, 0); }
    setDue(localDate(date));
  }
  async function save() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      let data: Record<string, unknown>;
      if (action === "task" && source) data = await request(`/messages/${encodeURIComponent(source.id)}/task`, { method: "POST", body: JSON.stringify({ title, projectId: project, assigneeId: assignee || null, dueDate: taskDate || null }) });
      else if (action === "reminder" && source) data = await request(`/messages/${encodeURIComponent(source.id)}/reminder`, { method: "POST", body: JSON.stringify({ dueAt: new Date(due).toISOString() }) });
      else if (action === "schedule") data = await request(scheduled ? `/scheduled-messages/${encodeURIComponent(scheduled.id)}` : "/scheduled-messages", { method: scheduled ? "PATCH" : "POST", body: JSON.stringify(scheduled ? { text: body, dueAt: new Date(due).toISOString() } : { ...target, requestId: requestId.current, text: body, dueAt: new Date(due).toISOString(), attachments: attachments ? await attachments() : [] }) });
      else if (action === "poll") data = await request("/polls", { method: "POST", body: JSON.stringify({ ...target, question: title, options: options.split("\n").map((value) => value.trim()).filter(Boolean), multiple }) });
      else if (action === "forward" && source) data = await request(`/messages/${encodeURIComponent(source.id)}/forward`, { method: "POST", body: JSON.stringify({ threadId: destination }) });
      else throw new Error("Selecione uma mensagem.");
      onDone(data); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível concluir esta ação."); }
    finally { setBusy(false); }
  }
  const label = { task: "Transformar em tarefa", reminder: "Lembrar-me disto", schedule: scheduled ? "Editar envio agendado" : "Agendar envio", poll: "Criar enquete", forward: "Encaminhar mensagem" }[action];
  return <TeamChatDialog title={label} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void save(); }}>
    {source && <blockquote className="team-v3-dialog-source"><strong>{source.senderName}</strong><p>{source.text}</p>{Boolean(source.attachments?.length) && <small>{source.attachments.length} anexo(s)</small>}</blockquote>}
    {(action === "task" || action === "poll") && <label>{action === "task" ? "Título" : "Pergunta"}<input aria-label={action === "task" ? "Título da tarefa" : "Pergunta da enquete"} required maxLength={action === "task" ? 160 : 200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>}
    {action === "task" && <><label>Projeto<select aria-label="Projeto da tarefa" value={project} required onChange={(event) => setProject(event.target.value)}><option value="">Selecione um projeto</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Responsável<select aria-label="Responsável pela tarefa" value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">Sem responsável</option>{members.map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}</select></label><label>Prazo<input aria-label="Prazo da tarefa" type="date" value={taskDate} onChange={(event) => setTaskDate(event.target.value)} /></label><p>A tarefa terá o autor e o link da mensagem de origem.</p></>}
    {action === "poll" && <><label>Opções, uma por linha<textarea aria-label="Opções da enquete" required rows={5} value={options} onChange={(event) => setOptions(event.target.value)} /></label><label className="team-v3-check"><input type="checkbox" checked={multiple} onChange={(event) => setMultiple(event.target.checked)} />Permitir mais de um voto</label></>}
    {action === "schedule" && <label>Mensagem<textarea aria-label="Mensagem agendada" required={!attachments} maxLength={2000} rows={4} value={body} onChange={(event) => setBody(event.target.value)} /></label>}
    {action === "reminder" && <div className="team-v3-presets"><button type="button" className="nx-btn is-sm" onClick={() => preset("hour")}>Em 1 hora</button><button type="button" className="nx-btn is-sm" onClick={() => preset("tomorrow")}>Amanhã</button><button type="button" className="nx-btn is-sm" onClick={() => preset("monday")}>Segunda-feira</button></div>}
    {(action === "schedule" || action === "reminder") && <label>Data e hora<input aria-label="Data e hora da ação" required type="datetime-local" value={due} min={localDate(new Date(Date.now()+60000))} onChange={(event) => setDue(event.target.value)} /></label>}
    {action === "forward" && <label>Conversa de destino<select aria-label="Conversa para encaminhar" required value={destination} onChange={(event) => setDestination(event.target.value)}><option value="">Selecione</option>{conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
    {error && <p role="alert" className="team-v3-dialog-error">{error}</p>}<footer><button type="button" className="nx-btn" onClick={onClose}>Cancelar</button><button type="submit" className="nx-btn is-primary" disabled={busy || action === "task" && !project}>{busy ? "Salvando…" : action === "forward" ? "Encaminhar para a equipe" : "Confirmar"}</button></footer>
  </form></TeamChatDialog>;
}
