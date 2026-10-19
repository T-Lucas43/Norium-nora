import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CirclePause, RefreshCw } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import Button from "../shared/Button";

type Feature = { id: string; name: string; enabled: boolean; configurationReady: boolean;
  checks: { label: string; ready: boolean }[]; note: string };

export default function NoraOperationsSettings() {
  const scope = requestScope();
  const [features, setFeatures] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const data = await apiRequest<{ features: Feature[] }>("/api/nora/operations/readiness", { signal });
      if (!signal?.aborted && requestScope() === scope) setFeatures(data.features);
    } catch (err) {
      if (!signal?.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível consultar os serviços.");
    } finally { if (!signal?.aborted && requestScope() === scope) setLoading(false); }
  }, [scope]);
  useEffect(() => { const controller = new AbortController(); setFeatures([]); void refresh(controller.signal);
    return () => controller.abort(); }, [refresh]);
  return <section className="nx-card nxi-card-pad" aria-label="Operação da Nora">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="nxi-card-title">Serviços da Nora</h3>
        <p className="nxi-card-sub">Confira a configuração antes de ativar cada recurso no servidor.</p></div>
      <Button size="sm" disabled={loading} onClick={() => void refresh()}><RefreshCw size={16} />{loading ? "Consultando…" : "Atualizar"}</Button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!features.length && loading && <p role="status">Consultando a configuração…</p>}
    <div className="grid gap-3" style={{ marginTop: 16 }}>
      {features.map(feature => <article key={feature.id} className="nx-card nxi-card-pad">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4>{feature.name}</h4>
          <span className="nx-badge">{feature.enabled ? "Habilitado no servidor" : "Desativado"}</span></div>
        <p className="nxi-card-sub">{feature.note}</p>
        {feature.checks.length > 0 && <ul className="grid gap-2" style={{ marginTop: 12 }}>
          {feature.checks.map(check => <li className="flex items-center gap-2" key={check.label}>
            {check.ready ? <CheckCircle2 size={16} aria-hidden="true" /> : <CirclePause size={16} aria-hidden="true" />}
            {check.label}: {check.ready ? "configurado" : "pendente"}</li>)}</ul>}
      </article>)}
    </div>
    <p className="nxi-card-sub" style={{ marginTop: 12 }}>Esta consulta não envia dados à IA e não ativa serviços. Credenciais nunca são exibidas aqui.</p>
  </section>;
}
