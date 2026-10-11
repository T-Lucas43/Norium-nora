import { useEffect, useState } from "react";
import { automationsApiRequest } from "../../features/automations/api";
import type { Automation } from "../../features/automations/types";
type Job = { id: string; automation_id: string; status: string; created_at: string; error?: string };
const labels: Record<string, string> = { pending: "Na fila", running: "Em execução / aguardando confirmação", done: "Concluído", failed: "Falhou", interrupted: "Interrompido", cancelled: "Cancelado após alteração do fluxo" };
export default function AutomaticEventHistory({ automations }: { automations: Automation[] }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = await automationsApiRequest<{ jobs: Job[] }>("/eventos/fila");
        if (alive) { setJobs(data.jobs || []); setError(""); }
      } catch { if (alive) setError("Não foi possível consultar os disparos automáticos."); }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refresh]);
  return <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-bold">Disparos por eventos</h2><button className="text-xs text-[var(--primary)]" onClick={() => setRefresh(value => value + 1)}>Atualizar</button></div>
    <p className="mt-2 text-xs text-[var(--text-secondary)]">Atualização a cada 30 segundos. Envios com falha ou interrupção não são repetidos automaticamente.</p>
    {error && <p role="alert" className="mt-3 text-xs text-[var(--danger)]">{error}</p>}
    {!error && !jobs.length && <p className="mt-4 text-sm text-[var(--text-secondary)]">Nenhum evento disparou uma automação ainda.</p>}
    <div className="mt-3 max-h-80 space-y-2 overflow-auto">{jobs.map(job => <article key={job.id} className="rounded-lg border border-[var(--border)] p-3"><strong className="block text-sm">{automations.find(item => item.id === job.automation_id)?.name || "Automação removida"}</strong><span className="text-xs text-[var(--primary)]">{labels[job.status] || job.status}</span><p className="text-xs text-[var(--text-secondary)]">{new Date(job.created_at).toLocaleString("pt-BR")}</p>{job.error && <p className="mt-1 text-xs text-[var(--danger)]">{job.error}</p>}</article>)}</div>
  </section>;
}
