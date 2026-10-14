import { useEffect, useState } from "react";
import { HardDrive, RefreshCw } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { workspaceScope } from "../../core/api/sessionScope";

type StorageUsage = { usedBytes: number; quotaBytes: number; percent: number; warning: boolean };
const size = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;

export default function PrivacyStorageCard() {
  const workspace = workspaceScope();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setUsage(null);
    setError("");
    async function load() {
      try {
        const result = await apiRequest<StorageUsage>("/api/auth/privacy/storage");
        if (active) setUsage(result);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Não foi possível consultar o armazenamento.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [version, workspace]);
  return <section className="nx-card nxi-card-pad" aria-label="Armazenamento do workspace">
    <div className="flex items-center justify-between gap-3">
      <h3 className="nxi-card-title flex items-center gap-2"><HardDrive size={17} /> Armazenamento do workspace</h3>
      <button type="button" className="nx-btn is-sm" onClick={() => setVersion(value => value + 1)} disabled={loading} aria-label="Atualizar uso de armazenamento"><RefreshCw size={15} /></button>
    </div>
    <p className="nxi-card-sub">Documentos e anexos de equipe, financeiro e tarefas deste ambiente.</p>
    {loading && <p role="status" className="mt-3 text-sm">Consultando armazenamento…</p>}
    {error && <p role="alert" className="nxi-alert is-error mt-3">{error}</p>}
    {usage && !loading && <>
      <p className="mt-3 text-sm font-semibold">{size(usage.usedBytes)} de {size(usage.quotaBytes)} · {usage.percent.toLocaleString("pt-BR")}%</p>
      <progress aria-label="Uso da cota do workspace" className="mt-2 w-full" value={Math.min(100, usage.percent)} max={100} />
      {usage.warning && <p role="status" className="nxi-alert mt-3">O armazenamento está próximo do limite. Exporte seus dados e revise os anexos antes de enviar novos arquivos.</p>}
    </>}
  </section>;
}
