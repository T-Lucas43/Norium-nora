import { useState } from "react";
import { BarChart3 } from "lucide-react";

export type TeamPoll = { question: string; multiple: boolean; options: { id: string; text: string; userIds: string[] }[] };
export default function TeamPollCard({ poll, userId, onVote }: { poll: TeamPoll; userId: string; onVote: (choices: string[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const choices = poll.options.filter((option) => option.userIds.includes(userId)).map((option) => option.id);
  const votes = new Set(poll.options.flatMap((option) => option.userIds)).size;
  async function vote(id: string) { if (busy) return; setBusy(true); try { await onVote(poll.multiple ? choices.includes(id) ? choices.filter((value) => value !== id) : [...choices, id] : choices.includes(id) ? [] : [id]); } finally { setBusy(false); } }
  return <section className="team-v3-poll" aria-label={`Enquete: ${poll.question}`}><strong><BarChart3 size={15} />{poll.question}</strong><small>{poll.multiple ? "Escolha uma ou mais opções" : "Escolha uma opção"}</small>{poll.options.map((option) => <button key={option.id} type="button" disabled={busy} aria-label={`${option.text} ${option.userIds.length}`} aria-pressed={choices.includes(option.id)} onClick={() => void vote(option.id)}><span>{option.text}</span><b>{option.userIds.length}</b><i style={{ width: `${votes ? option.userIds.length/votes*100 : 0}%` }} /></button>)}<small>{votes} pessoa(s) votaram · resultados ao vivo</small></section>;
}
