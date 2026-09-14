import type { DashboardMetrics } from "./Dashboard";
import noriumMailIcon from "../../assets/generated/norium-mail.png";
import whatsappIcon from "../../assets/generated/whatsapp-premium.png";
import noriumAgendaIcon from "../../assets/generated/norium-agenda.png";
import noriumTasksIcon from "../../assets/generated/norium-tasks.png";

type SummaryProps = {
  metrics: DashboardMetrics;
  onNavigate: (tab: string) => void;
};

export default function Summary({ metrics, onNavigate }: SummaryProps) {
  const stats = [
    {
      title: "E-mails",
      value: metrics.emails,
      subtitle: "Abrir Norium Mail",
      icon: noriumMailIcon,
      color: "bg-red-500/10 text-red-500",
      tone: "rose",
      tab: "E-mails",
    },
    {
      title: "WhatsApp",
      value: metrics.whatsapp,
      subtitle: "Abrir conversas",
      icon: whatsappIcon,
      color: "bg-emerald-500/10 text-emerald-500",
      tone: "emerald",
      tab: "Chat",
    },
    {
      title: "Agenda",
      value: metrics.calendar,
      subtitle: "Ver compromissos",
      icon: noriumAgendaIcon,
      color: "bg-blue-500/10 text-blue-500",
      tone: "blue",
      tab: "Agenda",
    },
    {
      title: "Tarefas",
      value: metrics.tasks,
      subtitle: "Abrir Kanban",
      icon: noriumTasksIcon,
      color: "bg-cyan-500/10 text-cyan-500",
      tone: "cyan",
      tab: "Tarefas",
    },
  ];

  return (
    <section className="norium-dashboard-summary grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {stats.map((item) => {
        return (
          <button
            key={item.title}
            data-metric-tone={item.tone}
            onClick={() => onNavigate(item.tab)}
            className="norium-dashboard-stat rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition-all duration-300 hover:-translate-y-1 hover:border-blue-500/45 hover:shadow-lg"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-[var(--text-secondary)]">{item.title}</p>
                <h3 className="metric-value mt-2 text-3xl font-black">{item.value}</h3>
                <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">{item.subtitle}</p>
              </div>

              <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${item.color}`}>
                <img src={item.icon} className="metric-icon norium-suite-icon h-8 w-8 object-contain" alt="" />
              </div>
            </div>
          </button>
        );
      })}
    </section>
  );
}
