import {
  CheckSquare,
  Grid2X2,
  Mail,
  MessageSquare,
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
  const firstName = profile?.nome?.trim().split(/\s+/)[0] || "Tarcisio";

  return (
    <section className="norium-dashboard-hero">
      <div className="norium-dashboard-hero-copy">
        <h1>
          {greeting()}, <span>{firstName}</span>
        </h1>
        <p>
          Aqui está o que está acontecendo no seu mundo hoje.
          {!connected && " O tempo real está se reconectando."}
        </p>

        <div className="norium-dashboard-hero-actions">
          <button type="button" className="is-primary" onClick={onOpenNora}>
            <MessageSquare size={17} />
            Conversar com a Nora
          </button>
          <button type="button" onClick={() => onNavigate("Central")}>
            <Grid2X2 size={17} />
            Ver central
          </button>
          <button type="button" onClick={() => onNavigate("Tarefas")}>
            <CheckSquare size={17} />
            Nova tarefa
          </button>
          <button
            type="button"
            onClick={() => {
              onNavigate("E-mails");
              window.setTimeout(() => window.dispatchEvent(new Event("emails:compose")), 80);
            }}
          >
            <Mail size={17} />
            Enviar e-mail
          </button>
        </div>
      </div>

      <DashboardSignal />

      <span className="sr-only">{metrics.total} eventos monitorados</span>
    </section>
  );
}
