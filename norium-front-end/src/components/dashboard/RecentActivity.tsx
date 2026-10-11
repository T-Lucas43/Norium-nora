import { BarChart3, CalendarDays, CheckCircle2, Clock3, CreditCard, GitBranch, Lightbulb, Mail, MessageSquare, ShieldAlert, UsersRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { EventSource, OmnichannelEvent } from "../../types/omnichannel";

type RecentActivityProps = {
  events: OmnichannelEvent[];
  onNavigate: (tab: string) => void;
};

const config: Record<EventSource, { icon: LucideIcon; color: string; tab: string }> = {
  gmail: { icon: Mail, color: "is-red", tab: "E-mails" },
  whatsapp: { icon: MessageSquare, color: "is-green", tab: "Chat" },
  calendar: { icon: CalendarDays, color: "is-blue", tab: "Agenda" },
  kanban: { icon: CheckCircle2, color: "is-amber", tab: "Tarefas" },
  financeiro: { icon: CreditCard, color: "is-cyan", tab: "Gastos" },
  equipe: { icon: UsersRound, color: "is-blue", tab: "Equipe" },
  automacoes: { icon: GitBranch, color: "is-violet", tab: "Automações" },
  brainstorm: { icon: Lightbulb, color: "is-cyan", tab: "Brainstorm" },
  relatorios: { icon: BarChart3, color: "is-amber", tab: "Relatorios" },
  sistema: { icon: ShieldAlert, color: "", tab: "Central" },
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
    <section className="nx-card nxd-card nxd-activity min-w-0">
      <div className="nx-card-h">
        <div className="nxd-card-h-col">
          <h2>Atividade recente</h2>
          <p className="nxd-card-sub">Últimas ações recebidas em tempo real.</p>
        </div>
      </div>

      <div className="nx-card-b">
        <div className="nxd-list">
          {events.length === 0 ? (
            <div className="nxd-empty">
              Nenhuma atividade recente ainda.
            </div>
          ) : (
            events.map((event) => {
              const item = config[event.source];
              const Icon = item.icon;

              return (
                <button
                  type="button"
                  key={event.id}
                  onClick={() => onNavigate(item.tab)}
                  className="nx-row nxd-row"
                >
                  <span className={`nxd-ico ${item.color}`}>
                    <Icon size={16} strokeWidth={1.75} />
                  </span>

                  <span className="nx-grow">
                    <strong className="nx-row-t nx-ell block">{event.title}</strong>
                    <small className="nx-row-sub block">
                      {event.description || "Evento sem descrição"}
                    </small>
                  </span>

                  <span className="nxd-date inline-flex items-center gap-1">
                    <Clock3 size={14} strokeWidth={1.75} />
                    {timeLabel(event.timestamp)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}