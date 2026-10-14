import type { NoriumUser } from "../../types/auth";
import type { TeamMessage } from "./teamChatTypes";
export default function TeamReplySummary({ message, members }: { message: TeamMessage; members: NoriumUser[] }) {
  const metadata = message.metadata || {};
  const userIds = Array.isArray(metadata.replyUserIds) ? metadata.replyUserIds.map(String) : [];
  const participants = members.filter((member) => userIds.includes(member.id)).slice(0, 4);
  const count = Number(metadata.replyCount || 0), unread = Number(metadata.replyUnreadCount || 0);
  return <span className="team-v3-reply-summary"><span className="team-v3-reply-avatars">{participants.map((member) => <span key={member.id} title={member.nome}>{member.fotoUrl ? <img src={member.fotoUrl} alt={member.nome} loading="lazy" /> : member.nome[0]}</span>)}</span><span>{count} {count === 1 ? "resposta" : "respostas"}{metadata.lastReplyAt ? ` · ${new Date(String(metadata.lastReplyAt)).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : ""}</span>{unread > 0 && <b>{unread} {unread === 1 ? "nova" : "novas"}</b>}</span>;
}
