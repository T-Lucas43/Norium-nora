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
  if (!value) return "Ainda nao executada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Ainda nao executada";
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
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
        if (!response.ok) throw new Error("Nao foi possivel carregar automacoes.");
        if (cancelled) return;
        setAutomations(Array.isArray(data.automations) ? data.automations : []);
        setMetrics(data.metrics || {});
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Falha ao buscar automacoes.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadAutomations();
    const interval = window.setInterval(loadAutomations, 60_000);
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
    <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-xs font-bold text-cyan-300">
            <GitBranch size={14} />
            Automacoes ativas
          </div>
          <h2 className="text-xl font-black text-[var(--text)]">Fluxos rodando no Norium</h2>
          <p className="text-sm font-semibold text-[var(--text-secondary)]">
            {activeCount} ativa(s), {metrics?.runsToday || 0} execucao(oes) hoje e {formatSavedMinutes(metrics?.savedMinutes)} economizados.
          </p>
        </div>

        <button
          onClick={() => onNavigate("Automações")}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] px-4 text-xs font-bold text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
        >
          Abrir automacoes
          <ArrowRight size={15} />
        </button>
      </div>

      {loading ? (
        <div className="grid min-h-28 place-items-center rounded-2xl border border-[var(--border)] bg-[var(--background)] text-sm font-bold text-[var(--text-secondary)]">
          Carregando automacoes...
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 p-4 text-sm font-bold text-amber-200">{error}</div>
      ) : activeAutomations.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--background)] p-5">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-blue-500/10 text-blue-400">
              <Zap size={22} />
            </div>
            <div>
              <h3 className="font-black text-[var(--text)]">Nenhuma automacao ativa</h3>
              <p className="text-sm font-semibold text-[var(--text-secondary)]">Ative um fluxo para acompanhar por aqui.</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {activeAutomations.map((automation) => (
            <button
              key={automation.id}
              onClick={() => onNavigate("Automações")}
              className="group rounded-2xl border border-[var(--border)] bg-[var(--background)] p-4 text-left transition hover:-translate-y-0.5 hover:border-cyan-300/35 hover:bg-[var(--surface-hover)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-black text-[var(--text)]">{automation.name}</p>
                  <p className="mt-1 line-clamp-2 text-xs font-semibold text-[var(--text-secondary)]">
                    {automation.description || automation.trigger || "Fluxo operacional ativo."}
                  </p>
                </div>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-400">
                  <CheckCircle2 size={19} />
                </span>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2.5 py-1 text-xs font-bold text-blue-300">
                  <PlayCircle size={12} />
                  {automation.executions || 0} exec.
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2.5 py-1 text-xs font-bold text-cyan-300">
                  <Clock3 size={12} />
                  {formatDateTime(automation.lastRunAt || automation.updatedAt)}
                </span>
              </div>

              <p className="mt-3 truncate text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                {automation.trigger || "Manual"} {"->"} {(automation.actions || []).slice(0, 2).join(", ") || "Nora operacional"}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
