import { useState } from "react";
import { LockKeyhole, PencilLine, SendHorizontal, Trash2, X } from "lucide-react";
import { MemberPhoto, type Attendance, type TeamNote } from "./TeamAttendance";

export function InternalNoteCard({ note, attendance: a }: { note: TeamNote; attendance: Attendance }) {
  const [editing, setEditing] = useState(false), [body, setBody] = useState(note.body), [deleting, setDeleting] = useState(false);
  const author = a.members.find(member => member.id === note.authorUserId);
  const permitted = a.canManage || a.actorId === note.authorUserId;
  return <article className="nx-whatsapp-internal-note" aria-label="Nota interna">
    <div className="nx-whatsapp-note-head"><LockKeyhole size={13} /><strong>Nota interna — o cliente não vê</strong><span>· {author?.name || "Membro removido"} · {new Date(note.createdAt * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}{note.editedAt ? " · editada" : ""}</span>
      {permitted && <><button type="button" disabled={a.busy} aria-label="Editar nota interna" onClick={() => { setBody(note.body); setEditing(true); }}><PencilLine size={13} /></button><button type="button" disabled={a.busy} aria-label="Excluir nota interna" onClick={() => setDeleting(true)}><Trash2 size={13} /></button></>}
    </div>
    {editing ? <form onSubmit={event => { event.preventDefault(); void a.changeNote(note, body).then(() => setEditing(false)).catch(() => {}); }}>
      <textarea aria-label="Editar texto da nota interna" value={body} onChange={event => setBody(event.target.value)} maxLength={8000} />
      <button className="nx-btn is-sm" disabled={a.busy || !body.trim()}>Salvar nota</button><button className="nx-btn is-sm" type="button" onClick={() => setEditing(false)}>Cancelar</button>
    </form> : <p>{note.body}</p>}
    {note.mentions.length > 0 && <small>{note.mentions.map(id => `@${a.members.find(member => member.id === id)?.name || "Membro"}`).join(" · ")}</small>}
    {deleting && <div role="alertdialog" aria-label="Excluir nota interna"><p>Excluir esta nota interna?</p><button className="nx-btn is-sm" disabled={a.busy} onClick={() => void a.changeNote(note, null).then(() => setDeleting(false)).catch(() => {})}>Excluir nota</button><button className="nx-btn is-sm" onClick={() => setDeleting(false)}>Cancelar</button></div>}
  </article>;
}

export function InternalNoteComposer({ attendance: a }: { attendance: Attendance }) {
  const [body, setBody] = useState(""), [mentions, setMentions] = useState<string[]>([]), [open, setOpen] = useState(false);
  const eligible = a.members.filter(member => a.assignment?.assigneeKind === "none" || member.id === a.assignment?.assigneeUserId || member.canManage);
  async function submit() {
    if (!body.trim() || a.busy) return;
    try { await a.addNote(body, mentions); setBody(""); setMentions([]); setOpen(false); } catch { /* shared error remains visible */ }
  }
  return <div className="nx-whatsapp-note-composer">
    {mentions.length > 0 && <div className="flex flex-wrap gap-1">{mentions.map(id => <button type="button" key={id} onClick={() => setMentions(current => current.filter(value => value !== id))}>@{a.members.find(member => member.id === id)?.name}<X size={12} /></button>)}</div>}
    <div className="flex min-w-0 items-end gap-2"><textarea aria-label="Nota interna para a equipe" placeholder="Nota para a equipe · @ para mencionar" value={body} maxLength={8000} rows={2}
      onChange={event => { setBody(event.target.value); if (event.target.value.endsWith("@")) setOpen(true); }}
      onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }} />
      <button type="button" className="nx-conv-iconbtn" aria-label="Mencionar membro na nota" onClick={() => setOpen(!open)}>@</button>
      <button type="button" className="nx-conv-send" aria-label="Salvar nota interna" disabled={!body.trim() || !a.assignment || a.busy} onClick={() => void submit()}><SendHorizontal size={18} /></button></div>
    <small>Somente no Norium · Ctrl+Enter para salvar</small>
    {open && <div className="nx-whatsapp-mention-picker" role="group" aria-label="Membros que podem ler esta conversa">{eligible.map(member => <button type="button" key={member.id} disabled={mentions.includes(member.id) || mentions.length >= 20} onClick={() => { setMentions(current => [...current, member.id]); setBody(current => current.endsWith("@") ? current.slice(0, -1) : current); setOpen(false); }}><MemberPhoto member={member} />{member.name}</button>)}<button type="button" onClick={() => setOpen(false)}>Fechar menções</button></div>}
  </div>;
}
