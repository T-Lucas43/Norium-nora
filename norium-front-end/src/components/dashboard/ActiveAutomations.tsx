import { ArrowRight, CheckCircle2, Clock3, GitBranch, PlayCircle, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiBaseUrl, authToken } from "../../utils/api";

type DashboardAutomation = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  trigger?: string;
  actions?: string[];
  active?: boolean;
  executions?: number;
  savedMinutes?: number;
  lastRunAt?: string | null;
  updatedAt?: string;
};

type AutomationsResponse = {
  automations?: DashboardAutomation[];
  metrics?: {
    total?: number;
    active?: number;
    runsToday?: number;
    savedMinutes?: number;
  };
};

type ActiveAutomationsProps = {
  onNavigate: (tab: string) => void;
};

function authHeaders(): HeadersInit {
  const token = authToken();
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function formatSavedMinutes(value?: number) {
  const minutes = Number(value || 0);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "Ainda não executada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Ainda não executada";
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ActiveAutomations({ onNavigate }: ActiveAutomationsProps) {
  const [automations, setAutomations] = useState<DashboardAutomation[]>([]);
  const [metrics, setMetrics] = useState<AutomationsResponse["metrics"]>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadAutomations() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${apiBaseUrl()}/api/automacoes`, {
          cache: "no-store",
          headers: authHeaders(),
        });
        const data = (await response.json().catch(() => ({}))) as AutomationsResponse;
        if (!response.ok) throw new Error("Não foi possível carregar as automações.");
        if (cancelled) return;
        setAutomations(Array.isArray(data.automations) ? data.automations : []);
        setMetrics(data.metrics || {});
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Falha ao buscar automações.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadAutomations();
    const interval = window.setInterval(() => { if (!document.hidden) void loadAutomations(); }, 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const activeAutomations = useMemo(
    () =>
      automations
        .filter((automation) => automation.active)
        .sort((a, b) => Number(Boolean(b.lastRunAt)) - Number(Boolean(a.lastRunAt)) || Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""))
        .slice(0, 4),
    [automations],
  );

  const activeCount = metrics?.active ?? activeAutomations.length;

  return (
    <section className="nx-card nxd-card">
      <div className="nx-card-h flex-wrap">
        <div className="nxd-card-h-col">
          <span className="nx-badge is-violet mb-2"><GitBranch size={12} strokeWidth={1.75} />Automações ativas</span>
          <h2>Fluxos rodando no Norium</h2>
          <p className="nxd-card-sub">
            {activeCount} ativa(s), {metrics?.runsToday || 0} execução(ões) hoje e {formatSavedMinutes(metrics?.savedMinutes)} economizados.
          </p>
        </div>

        <button type="button" className="nx-btn is-sm ml-auto" onClick={() => onNavigate("Automações")}>
          Abrir automações
          <ArrowRight size={14} strokeWidth={1.75} />
        </button>
      </div>

      <div className="nx-card-b">
        {loading ? (
          <div className="nxd-empty">
            Carregando automações...
          </div>
        ) : error ? (
          <div className="nxd-notice">{error}</div>
        ) : activeAutomations.length === 0 ? (
          <div className="nx-row">
            <span className="nxd-ico is-blue"><Zap size={16} strokeWidth={1.75} /></span>
            <div className="nx-grow">
              <div className="nx-row-t">Nenhuma automação ativa</div>
              <div className="nx-row-sub">Ative um fluxo para acompanhar por aqui.</div>
            </div>
          </div>
        ) : (
          <div className="nxd-automations">
            {activeAutomations.map((automation) => (
              <button
                type="button"
                key={automation.id}
                onClick={() => onNavigate("Automações")}
                className="nxd-automation"
              >
                <span className="flex w-full items-start gap-3">
                  <span className="nx-grow">
                    <span className="nx-row-t nx-ell block">{automation.name}</span>
                    <span className="nxd-automation-desc mt-1">
                      {automation.description || automation.trigger || "Fluxo operacional ativo."}
                    </span>
                  </span>
                  <span className="nxd-ico is-green"><CheckCircle2 size={16} strokeWidth={1.75} /></span>
                </span>

                <span className="nxd-badges">
                  <span className="nx-badge is-blue">
                    <PlayCircle size={12} strokeWidth={1.75} />
                    {automation.executions || 0} exec.
                  </span>
                  <span className="nx-badge">
                    <Clock3 size={12} strokeWidth={1.75} />
                    {formatDateTime(automation.lastRunAt || automation.updatedAt)}
                  </span>
                </span>

                <span className="nx-row-sub nx-ell block w-full">
                  {automation.trigger || "Manual"} {"→"} {(automation.actions || []).slice(0, 2).join(", ") || "Nora operacional"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}