import { BarChart3, CalendarDays, CheckCircle2, Clock3, CreditCard, GitBranch, Lightbulb, Mail, MessageSquare, ShieldAlert, UsersRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { EventSource, OmnichannelEvent } from "../../types/omnichannel";

type RecentActivityProps = {
  events: OmnichannelEvent[];
  onNavigate: (tab: string) => void;
};

const config: Record<EventSource, { icon: LucideIcon; color: string; tab: string }> = {
  gmail: { icon: Mail, color: "bg-red-500/10 text-red-500", tab: "E-mails" },
  whatsapp: { icon: MessageSquare, color: "bg-emerald-500/10 text-emerald-500", tab: "Chat" },
  calendar: { icon: CalendarDays, color: "bg-blue-500/10 text-blue-500", tab: "Agenda" },
  kanban: { icon: CheckCircle2, color: "bg-cyan-500/10 text-cyan-500", tab: "Tarefas" },
  financeiro: { icon: CreditCard, color: "bg-teal-500/10 text-teal-500", tab: "Gastos" },
  equipe: { icon: UsersRound, color: "bg-indigo-500/10 text-indigo-500", tab: "Equipe" },
  automacoes: { icon: GitBranch, color: "bg-sky-500/10 text-sky-500", tab: "Automações" },
  brainstorm: { icon: Lightbulb, color: "bg-cyan-500/10 text-cyan-400", tab: "Brainstorm" },
  relatorios: { icon: BarChart3, color: "bg-amber-500/10 text-amber-500", tab: "Relatorios" },
  sistema: { icon: ShieldAlert, color: "bg-violet-500/10 text-violet-500", tab: "Central" },
};

function timeLabel(timestamp: string) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "agora";
  const diff = Math.max(0, Date.now() - parsed.getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export default function RecentActivity({ events, onNavigate }: RecentActivityProps) {
  return (
    <section className="norium-dashboard-card norium-recent-activity min-w-0 overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
      <div className="mb-5 flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-[var(--text)]">Atividade recente</h2>
          <p className="text-sm font-semibold text-[var(--text-secondary)]">Ultimas acoes recebidas em tempo real.</p>
        </div>
      </div>

      <div className="max-h-[318px] space-y-2 overflow-y-auto overscroll-contain pr-1">
        {events.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--border)] p-6 text-sm font-semibold text-[var(--text-secondary)]">
            Nenhuma atividade recente ainda.
          </div>
        ) : (
          events.map((event) => {
            const item = config[event.source];
            const Icon = item.icon;

            return (
              <button
                key={event.id}
                onClick={() => onNavigate(item.tab)}
                className="flex min-w-0 w-full items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3 text-left transition-all duration-300 hover:border-blue-500/45 hover:shadow-md"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${item.color}`}>
                    <Icon size={18} />
                  </div>

                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-bold text-[var(--text)]">{event.title}</h3>
                    <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">
                      {event.description || "Evento sem descricao"}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2 text-xs font-bold text-[var(--text-secondary)]">
                  <Clock3 size={14} />
                  {timeLabel(event.timestamp)}
                </div>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
