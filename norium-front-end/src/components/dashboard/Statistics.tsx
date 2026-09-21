import { CheckCircle2, Clock3, TrendingUp } from "lucide-react";
import type { DashboardMetrics } from "./Dashboard";

type StatisticsProps = {
  metrics: DashboardMetrics;
};

export default function Statistics({ metrics }: StatisticsProps) {
  const stats = [
    {
      title: "Eventos monitorados",
      value: metrics.total,
      hint: "consolidados na Central",
      icon: TrendingUp,
      color: "text-blue-500",
      tone: "blue",
    },
    {
      title: "Tarefas movimentadas",
      value: metrics.tasks,
      hint: "no Kanban recente",
      icon: CheckCircle2,
      color: "text-emerald-500",
      tone: "emerald",
    },
    {
      title: "Canais ativos",
      value: 4,
      hint: "integrações ligadas",
      icon: Clock3,
      color: "text-cyan-500",
      tone: "cyan",
    },
  ];

  return (
    <section className="norium-dashboard-stats" aria-label="Indicadores da operação">
      {stats.map((item) => {
        const Icon = item.icon;

        return (
          <div key={item.title} data-metric-tone={item.tone} className="norium-dashboard-stat-flat">
            <div className={`flex h-11 w-11 items-center justify-center rounded-xl bg-current/10 ${item.color}`}>
              <Icon className="metric-icon" size={22} aria-hidden="true" />
            </div>
            <div>
              <p>{item.title}</p>
              <h2 className="metric-value">{item.value} <small>{item.hint}</small></h2>
            </div>
          </div>
        );
      })}
    </section>
  );
}
