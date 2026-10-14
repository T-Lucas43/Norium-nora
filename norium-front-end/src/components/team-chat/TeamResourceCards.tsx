import { CalendarDays, CheckSquare, FileText, LockKeyhole, Users, Wallet } from "lucide-react";
import type { TeamResourceCard } from "./teamChatTypes";

export default function TeamResourceCards({ cards }: { cards: TeamResourceCard[] }) {
  return <div className="team-v3-resource-cards">{cards.map((card) => { const Icon = card.restricted ? LockKeyhole : card.type === "task" ? CheckSquare : card.type === "client" ? Users : card.type === "meeting" ? CalendarDays : card.type === "finance" ? Wallet : FileText; return <article key={`${card.type}:${card.id}`} className="team-v3-resource"><Icon size={18} /><div><small>{card.restricted ? "Acesso limitado" : card.label}</small><strong>{card.title}</strong>{!card.restricted && <><span>{card.status}{card.dueDate ? ` · ${new Date(card.dueDate).toLocaleDateString("pt-BR")}` : ""}</span>{card.deepLink && <button type="button" className="nx-btn is-sm" onClick={() => window.dispatchEvent(new CustomEvent("norium:deep-link", { detail: card.deepLink }))}>Abrir</button>}</>}</div></article>; })}</div>;
}
