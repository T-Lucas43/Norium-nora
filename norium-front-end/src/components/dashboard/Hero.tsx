import {
  CheckSquare,
  Sparkles,
} from "lucide-react";
import type { PerfilOperador } from "../../types/omnichannel";
import DashboardSignal from "./DashboardSignal";
import type { DashboardMetrics } from "./Dashboard";

type HeroProps = {
  metrics: DashboardMetrics;
  profile: PerfilOperador | null;
  connected: boolean;
  onOpenNora: () => void;
  onNavigate: (tab: string) => void;
};

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

export default function Hero({ metrics, profile, connected, onOpenNora, onNavigate }: HeroProps) {
  const firstName = profile?.nome?.trim().split(/\s+/)[0] || "";

  return (
    <section className="norium-dashboard-hero">
      <div className="norium-dashboard-hero-copy">
        <h1>
          {greeting()}{firstName ? <>, <span>{firstName}</span></> : null}
        </h1>
        <p>
          Aqui está o que está acontecendo no seu mundo hoje.
          {!connected && " O tempo real está se reconectando."}
        </p>

        <div className="norium-dashboard-hero-actions">
          <button type="button" className="is-primary" onClick={onOpenNora}>
            <Sparkles size={17} />
            Perguntar à Nora
          </button>
          <button type="button" onClick={() => onNavigate("Tarefas")}>
            <CheckSquare size={17} />
            Nova tarefa
          </button>
        </div>
      </div>

      <DashboardSignal />

      <span className="sr-only">{metrics.total} eventos monitorados</span>
    </section>
  );
}
