import {
  CheckSquare,
  Sparkles,
} from "lucide-react";
import type { PerfilOperador } from "../../types/omnichannel";
import type { DashboardMetrics } from "./Dashboard";

type HeroProps = {
  metrics: DashboardMetrics;
  profile: PerfilOperador | null;
  connected: boolean;
  onOpenNora: () => void;
  onNavigate: (tab: string) => void;
  /** Resumo do dia já calculado com dados reais (ex.: "3 compromissos e 6 tarefas para hoje"). */
  daySummary?: string;
};

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function todayLabel() {
  const now = new Date();
  const weekday = now.toLocaleDateString("pt-BR", { weekday: "long" });
  const date = now.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${weekday.charAt(0).toLocaleUpperCase("pt-BR")}${weekday.slice(1)}, ${date}`;
}

export default function Hero({ metrics, profile, connected, onOpenNora, onNavigate, daySummary }: HeroProps) {
  const firstName = profile?.nome?.trim().split(/\s+/)[0] || "";

  return (
    <header className="nx-ph nxd-hero">
      <div className="min-w-0">
        <h1>
          {greeting()}{firstName ? <>, <span>{firstName}</span></> : null}
        </h1>
        <p>
          {todayLabel()}
          {daySummary ? ` · ${daySummary}` : ""}
          {!connected && " · O tempo real está se reconectando."}
        </p>
      </div>

      <div className="nx-ph-actions">
        <button type="button" className="nx-btn" onClick={() => onNavigate("Tarefas")}>
          <CheckSquare size={16} strokeWidth={1.75} />
          Nova tarefa
        </button>
        <button type="button" className="nx-btn is-primary" onClick={onOpenNora}>
          <Sparkles size={16} strokeWidth={1.75} />
          Perguntar à Nora
        </button>
      </div>

      <span className="sr-only">{metrics.total} eventos monitorados</span>
    </header>
  );
}
