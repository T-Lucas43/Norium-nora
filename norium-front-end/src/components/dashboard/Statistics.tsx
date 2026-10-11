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
      tone: "is-blue",
    },
    {
      title: "Tarefas movimentadas",
      value: metrics.tasks,
      hint: "no Kanban recente",
      icon: CheckCircle2,
      tone: "is-green",
    },
    {
      title: "Canais ativos",
      value: 4,
      hint: "integrações ligadas",
      icon: Clock3,
      tone: "is-cyan",
    },
  ];

  return (
    <section className="nxd-stats" aria-label="Indicadores da operação">
      {stats.map((item) => {
        const Icon = item.icon;

        return (
          <div key={item.title} className="nx-card nxd-stat">
            <span className={`nxd-ico ${item.tone}`}>
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="nxd-stat-l">{item.title}</p>
              <h2 className="nxd-stat-v">{item.value} <small>{item.hint}</small></h2>
            </div>
          </div>
        );
      })}
    </section>
  );
}
