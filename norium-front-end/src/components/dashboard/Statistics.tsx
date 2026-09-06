import { CheckCircle2, Clock3, Sparkles, TrendingUp } from "lucide-react";
import type { DashboardMetrics } from "./Dashboard";

type StatisticsProps = {
  metrics: DashboardMetrics;
  onOpenNora: () => void;
};

export default function Statistics({ metrics, onOpenNora }: StatisticsProps) {
  const stats = [
    {
      title: "Eventos monitorados",
      value: metrics.total,
      icon: TrendingUp,
      color: "text-blue-500",
      tone: "blue",
    },
    {
      title: "Tarefas movimentadas",
      value: metrics.tasks,
      icon: CheckCircle2,
      color: "text-emerald-500",
      tone: "emerald",
    },
    {
      title: "Canais ativos",
      value: 4,
      icon: Clock3,
      color: "text-cyan-500",
      tone: "cyan",
    },
  ];

  return (
    <section className="grid gap-5 xl:grid-cols-[420px_1fr]">
      <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-r from-blue-700 to-cyan-500 text-white">
            <Sparkles size={30} />
          </div>

          <div className="flex-1">
            <h3 className="font-bold text-[var(--text)]">Insight da Nora</h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              A Central ja consolidou {metrics.total} eventos recentes. Abra a Nora para transformar isso em plano de acao.
            </p>
          </div>
        </div>

        <button
          onClick={onOpenNora}
          className="mt-6 rounded-xl border border-blue-500 px-5 py-2 text-sm font-bold text-blue-500 transition hover:bg-blue-500 hover:text-white"
        >
          Ver insights
        </button>
      </div>

      <div className="grid gap-4 rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 md:grid-cols-3">
        {stats.map((item) => {
          const Icon = item.icon;

          return (
            <div key={item.title} data-metric-tone={item.tone} className="flex items-center justify-between rounded-2xl border border-[var(--border)] p-5">
              <div>
                <p className="text-sm font-semibold text-[var(--text-secondary)]">{item.title}</p>
                <h2 className="metric-value mt-2 text-4xl font-black">{item.value}</h2>
              </div>

              <div className={`flex h-14 w-14 items-center justify-center rounded-2xl bg-current/10 ${item.color}`}>
                <Icon className="metric-icon" size={26} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
