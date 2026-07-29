import { CalendarDays, CheckCircle2, Mail, MessageSquare } from "lucide-react";
import type { DashboardMetrics } from "./Dashboard";

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
      icon: Mail,
      color: "bg-red-500/10 text-red-500",
      tab: "E-mails",
    },
    {
      title: "WhatsApp",
      value: metrics.whatsapp,
      subtitle: "Abrir conversas",
      icon: MessageSquare,
      color: "bg-emerald-500/10 text-emerald-500",
      tab: "Chat",
    },
    {
      title: "Agenda",
      value: metrics.calendar,
      subtitle: "Ver compromissos",
      icon: CalendarDays,
      color: "bg-blue-500/10 text-blue-500",
      tab: "Agenda",
    },
    {
      title: "Tarefas",
      value: metrics.tasks,
      subtitle: "Abrir Kanban",
      icon: CheckCircle2,
      color: "bg-cyan-500/10 text-cyan-500",
      tab: "Tarefas",
    },
  ];

  return (
    <section className="norium-dashboard-summary grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {stats.map((item) => {
        const Icon = item.icon;

        return (
          <button
            key={item.title}
            onClick={() => onNavigate(item.tab)}
            className="norium-dashboard-stat rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition-all duration-300 hover:-translate-y-1 hover:border-blue-500/45 hover:shadow-lg"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-[var(--text-secondary)]">{item.title}</p>
                <h3 className="mt-2 text-3xl font-black text-[var(--text)]">{item.value}</h3>
                <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">{item.subtitle}</p>
              </div>

              <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${item.color}`}>
                <Icon size={24} />
              </div>
            </div>
          </button>
        );
      })}
    </section>
  );
}
