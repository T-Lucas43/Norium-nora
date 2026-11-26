import { useCallback, useEffect, useRef, useState } from "react";
import { Check, History, UserRound, X } from "lucide-react";
import { ApiError, apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import type { ChatConversa } from "./types";
import { useWhatsAppScope } from "./WhatsAppScope";
import { useWhatsAppLiveRefresh } from "./useWhatsAppLiveRefresh";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";
import ConfirmDialog from "../shared/ConfirmDialog";

export type TeamMember = { id: string; name: string; avatar: string; online?: boolean; canManage?: boolean };
export type TeamNote = { id: string; body: string; authorUserId: string; createdAt: number; editedAt: number | null; mentions: string[]; version: number };
type Event = { id: string; kind: string; actorUserId: string; createdAt: number; payload: { status?: string; assigneeUserId?: string; operation?: string } };
type Page<T> = { items: T[]; cursor: [number, string] | null; hasMore: boolean };
type Assignment = NonNullable<ChatConversa["assignee"]>;
const empty = { items: [], cursor: null, hasMore: false };
export const statusLabels: Record<string, string> = { open: "Aberta", waiting_customer: "Aguardando cliente", resolved: "Resolvida" };

export function useTeamAttendance(inboxId: string | undefined, conversation: ChatConversa | undefined, actorId: string, onAccessLost?: () => void) {
  const scope = requestScope(), cid = conversation?.id;
  const key = `${scope}:${inboxId || ""}:${cid || ""}`;
  const prefix = `/api/chat/caixas/${encodeURIComponent(inboxId || "")}/conversas/${encodeURIComponent(cid || "")}`;
  const [assignment, setAssignment] = useState<Assignment | undefined>(conversation?.assignee);
  const [members, setMembers] = useState<TeamMember[]>([]), [canManage, setCanManage] = useState(false);
  const [viewers, setViewers] = useState<string[]>([]);
  const [notes, setNotes] = useState<Page<TeamNote>>(empty), [events, setEvents] = useState<Page<Event>>(empty);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const lost = useRef(onAccessLost); lost.current = onAccessLost;
  const lifecycle = useRef({ key, active: true }); lifecycle.current.key = key;
  const revision = useRef(0), inFlight = useRef(false);
  useEffect(() => { const life = lifecycle.current; life.active = true; return () => { life.active = false; }; }, []);
  const valid = useCallback(() => lifecycle.current.active && lifecycle.current.key === key && requestScope() === scope, [key, scope]);
  const refresh = useCallback(async () => {
    if (!inboxId || !cid) return;
    const generation = ++revision.current;
    try {
      const data = await apiRequest<{ assignment: Assignment; members: TeamMember[]; canManage: boolean; viewers?: string[]; notes: Page<TeamNote>; events: Page<Event> }>(`${prefix}/atendimento`);
      if (!valid() || generation !== revision.current) return;
      setAssignment(data.assignment); setMembers(data.members); setCanManage(data.canManage); setError("");
      setViewers(data.viewers || []);
      setNotes(data.notes); setEvents(data.events);
    } catch (failure) {
      if (valid() && generation === revision.current) { setNotes(empty); setEvents(empty); setAssignment(undefined); setError(failure instanceof Error ? failure.message : "Atendimento indisponível."); if (failure instanceof ApiError && [403, 404].includes(failure.status)) lost.current?.(); }
    }
  }, [inboxId, cid, prefix, valid]);
  useEffect(() => { setNotes(empty); setEvents(empty); setMembers([]); setAssignment(conversation?.assignee); setError(""); void refresh(); }, [key, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!inboxId || !conversation?.attendanceRef) return;
    const timer = setTimeout(() => window.dispatchEvent(new CustomEvent("norium:presence-context", { detail: { type: "whatsapp", id: `${inboxId}:${conversation.attendanceRef}` } })), 0);
    let pending: ReturnType<typeof setTimeout> | undefined;
    const update = () => { clearTimeout(pending); pending = setTimeout(() => void refresh(), 180); };
    window.addEventListener("norium:team-presence-changed", update);
    return () => { clearTimeout(timer); clearTimeout(pending); window.dispatchEvent(new CustomEvent("norium:presence-context", { detail: null })); window.removeEventListener("norium:team-presence-changed", update); };
  }, [inboxId, conversation?.attendanceRef, refresh]);
  useWhatsAppLiveRefresh({ active: Boolean(inboxId && cid), ownerId: actorId, inboxId, onChange: () => void refresh() });
  async function action<T>(path: string, method: string, payload: unknown) {
    if (!valid() || inFlight.current) throw new Error("Aguarde a atualização deste atendimento.");
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await apiRequest<T>(`${prefix}${path}`, { method, body: JSON.stringify(payload) });
      if (!valid()) return;
      await refresh();
      window.dispatchEvent(new CustomEvent("norium:whatsapp-event", { detail: { inboxId, ownerId: actorId, area: "attendance" } }));
      return result;
    } catch (failure) { if (valid()) { await refresh(); setError(failure instanceof Error ? failure.message : "Não foi possível atualizar."); } throw failure; }
    finally { inFlight.current = false; if (valid()) setBusy(false); }
  }
  async function more(kind: "notes" | "events") {
    const page = kind === "notes" ? notes : events;
    if (!page.cursor || busy) return;
    const [before, beforeId] = page.cursor; const params = new URLSearchParams({ before: String(before), beforeId, limit: "50" });
    setBusy(true);
    try {
      if (kind === "notes") { const next = await apiRequest<Page<TeamNote>>(`${prefix}/notas?${params}`); if (valid()) setNotes(current => ({ ...next, items: [...new Map([...current.items, ...next.items].map(row => [row.id, row])).values()] })); }
      else { const next = await apiRequest<Page<Event>>(`${prefix}/historico?${params}`); if (valid()) setEvents(current => ({ ...next, items: [...current.items, ...next.items] })); }
    } catch (failure) { if (valid()) setError(failure instanceof Error ? failure.message : "Histórico indisponível."); }
    finally { if (valid()) setBusy(false); }
  }
  if (!inboxId || !cid) return null;
  return { actorId, assignment, members, canManage, viewers, notes, events, error, busy, refresh, more,
    assign: (change: Partial<Assignment>) => action("/atendimento", "PATCH", { ...change, expectedVersion: assignment?.version ?? 0 }),
    addNote: (body: string, mentions: string[]) => action("/notas", "POST", { body, mentions }),
    changeNote: (note: TeamNote, body: string | null) => action(`/notas/${encodeURIComponent(note.id)}`, body === null ? "DELETE" : "PATCH", { expectedVersion: note.version, ...(body === null ? {} : { body }) }),
  };
}
export type Attendance = NonNullable<ReturnType<typeof useTeamAttendance>>;

export function MemberPhoto({ member }: { member?: TeamMember }) {
  const source = useAuthenticatedMedia(member?.avatar); const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  return <span className="nx-whatsapp-member-photo">{source && !failed ? <img src={source} alt="" onError={() => setFailed(true)} /> : <UserRound size={14} />}</span>;
}

export function TeamAttendanceHeader({ attendance: a }: { attendance: Attendance }) {
  const [confirm, setConfirm] = useState(false), [history, setHistory] = useState(false);
  const row = a.assignment, member = a.members.find(item => item.id === row?.assigneeUserId);
  const label = (id: string) => a.members.find(item => item.id === id)?.name || (id === "system-whatsapp" ? "Cliente" : "Membro");
  return <div className="nx-whatsapp-attendance">
    <MemberPhoto member={member} /><label className="min-w-0">Responsável <select aria-label="Responsável pelo atendimento" value={row?.assigneeUserId || ""} disabled={a.busy || !row} onChange={event => void a.assign({ assigneeUserId: event.target.value || null, assigneeKind: event.target.value ? "user" : "none" }).catch(() => {})}>
      <option value="">Sem responsável</option>{a.members.filter(item => a.canManage || item.id === a.actorId || item.id === row?.assigneeUserId).map(item => <option value={item.id} key={item.id}>{item.name}{item.online ? " · online" : ""}</option>)}
    </select></label>
    <select aria-label="Estado do atendimento" value={row?.status || "open"} disabled={!row || a.busy} onChange={event => { if (event.target.value === "resolved") setConfirm(true); else void a.assign({ status: event.target.value as Assignment["status"] }).catch(() => {}); }}>
      {Object.entries(statusLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>
    <button className="nx-btn is-sm" disabled={!row || a.busy} onClick={() => row?.status === "resolved" ? void a.assign({ status: "open" }).catch(() => {}) : setConfirm(true)}><Check size={14} />{row?.status === "resolved" ? "Reabrir" : "Resolver"}</button>
    <button className="nx-conv-iconbtn" aria-label="Histórico do atendimento" onClick={() => setHistory(!history)}><History size={15} /></button>
    {a.error && <p role="alert" className="nx-whatsapp-attendance-error">{a.error}</p>}
    {a.viewers.length > 0 && <small className="basis-full">{a.viewers.map(id => label(id)).join(", ")} também está nesta conversa</small>}
    {confirm && <ConfirmDialog title="Resolver atendimento" description="Marcar esta conversa como resolvida? Uma nova mensagem do cliente reabrirá o atendimento." confirmLabel="Resolver" onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void a.assign({ status: "resolved" }).catch(() => {}); }} />}
    {history && <div className="nx-whatsapp-attendance-history"><div className="flex items-center justify-between"><strong>Histórico do atendimento</strong><button className="nx-conv-iconbtn" aria-label="Fechar histórico do atendimento" onClick={() => setHistory(false)}><X size={14} /></button></div>
      {a.events.items.length === 0 && <p>Nenhuma alteração registrada.</p>}
      {a.events.items.map(event => <p key={event.id}><strong>{label(event.actorUserId)}</strong> · {event.kind === "status" ? statusLabels[event.payload.status || ""] : ({ assigned: `Atribuiu a ${label(event.payload.assigneeUserId || "")}`, unassigned: "Removeu o responsável", sent: "Enviou uma mensagem", note: "Atualizou uma nota interna" }[event.kind] || "Atualizou o atendimento")} <small>{new Date(event.createdAt * 1000).toLocaleString("pt-BR")}</small></p>)}
      {a.events.hasMore && <button className="nx-btn is-sm" disabled={a.busy} onClick={() => void a.more("events")}>Histórico anterior</button>}
    </div>}
  </div>;
}

export function TeamAttendanceFilters() {
  const { filter, setFilter, counts } = useWhatsAppScope();
  if (!filter || !setFilter) return null;
  return <div className="nx-whatsapp-attendance-filters"><div role="group" aria-label="Filtrar por responsável">
    {([["me", "Minhas"], ["none", "Não atribuídas"], ["nora", "Nora"], ["all", "Todas"]] as const).map(([value, text]) => <button type="button" className="nx-btn is-sm" aria-pressed={filter.responsavel === value} key={value} onClick={() => setFilter({ ...filter, responsavel: value })}>{text} <small>{counts?.[value] ?? 0}</small></button>)}
    </div><select aria-label="Filtrar estado do atendimento" value={filter.estado} onChange={event => setFilter({ ...filter, estado: event.target.value })}><option value="">Todos os estados</option>{Object.entries(statusLabels).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select>
  </div>;
}
