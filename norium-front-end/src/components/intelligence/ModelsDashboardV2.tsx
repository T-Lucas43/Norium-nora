import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  FlaskConical,
  Gauge,
  KeyRound,
  Network,
  Plus,
  RefreshCw,
  Route,
  ShieldCheck,
  TestTube2,
} from "lucide-react";
import { apiRequest } from "../../core/api/client";
import Button from "../shared/Button";
import openAiLogo from "../../assets/ai-providers/openai.webp";
import geminiLogo from "../../assets/ai-providers/gemini.webp";
import groqLogo from "../../assets/ai-providers/groq.png";
import claudeLogo from "../../assets/ai-providers/claude.webp";
import "../../styles/screens/inteligencia-equipe-conta.css";

type Provider = {
  id: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  configured: boolean;
  managed?: boolean;
  capabilities: string[];
  dataPolicy: string;
  contextWindow?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
};

type Policy = { id: string; name?: string; enabled?: boolean };
type ModelsOverview = {
  providers: Provider[];
  policies: Policy[];
  usage: { requests: number; inputTokens: number; outputTokens: number; estimatedCost: number };
};

const providerOptions = [
  { id: "groq", name: "Groq" },
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "google", name: "Google Gemini" },
  { id: "openai-compatible", name: "Compatível" },
];

const usd = (value: number, digits: number) => `US$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

function ProviderLogo({ provider, size = 46 }: { provider: string; size?: number }) {
  const key = provider.toLowerCase();
  const asset = key.includes("google") || key.includes("gemini") ? geminiLogo
    : key.includes("groq") ? groqLogo
      : key.includes("anthropic") || key.includes("claude") ? claudeLogo
        : key.includes("openai") && !key.includes("compatible") ? openAiLogo
          : null;
  if (asset) return <span className={`nxi-provider-logo ai-provider-logo is-image is-${key.includes("google") || key.includes("gemini") ? "gemini" : key.includes("groq") ? "groq" : key.includes("anthropic") || key.includes("claude") ? "anthropic" : "openai"}`} style={{ width: size, height: size }} aria-hidden="true"><img src={asset} alt="" /></span>;
  return <span className="nxi-provider-logo ai-provider-logo is-compatible" style={{ width: size, height: size }} aria-hidden="true"><Network size={Math.round(size * .48)} /></span>;
}

export default function ModelsDashboardV2() {
  const [data, setData] = useState<ModelsOverview>({ providers: [], policies: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 } });
  const [setupOpen, setSetupOpen] = useState(false);
  const [providerForm, setProviderForm] = useState({ name: "", provider: "groq", model: "", baseUrl: "", secret: "", enabled: false, capabilities: ["text"], contextWindow: 8192, inputCostPerMillion: 0, outputCostPerMillion: 0, dataPolicy: "external" });
  const [policyForm, setPolicyForm] = useState({ name: "Roteamento principal", mode: "automatic", preferredProviderId: "", maxInputCostPerMillion: "", privacy: "any" });
  const [routeResult, setRouteResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setData(await apiRequest<ModelsOverview>("/api/modelos-ia")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível carregar os modelos."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveProvider(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await apiRequest("/api/modelos-ia/providers", { method: "POST", body: JSON.stringify(providerForm) });
      setProviderForm((current) => ({ ...current, name: "", model: "", baseUrl: "", secret: "", enabled: false }));
      setMessage("Provedor salvo. A chave ficou protegida e não será exibida novamente."); setSetupOpen(false); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível salvar o provedor."); }
    finally { setBusy(false); }
  }

  async function savePolicy(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await apiRequest("/api/modelos-ia/policies", { method: "POST", body: JSON.stringify({
        name: policyForm.name, mode: policyForm.mode, preferredProviderId: policyForm.preferredProviderId || null,
        fallbackProviderIds: [], requireCapabilities: ["text"],
        maxInputCostPerMillion: policyForm.maxInputCostPerMillion === "" ? null : Number(policyForm.maxInputCostPerMillion),
        privacy: policyForm.privacy, monthlyBudget: null, enabled: true,
      }) });
      setMessage("Política de roteamento salva."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível salvar a política."); }
    finally { setBusy(false); }
  }

  async function testProvider(provider: Provider) {
    setBusy(true); setError("");
    try {
      const result = await apiRequest<{ detail: string }>(`/api/modelos-ia/providers/${provider.id}/test`, { method: "POST", body: JSON.stringify({ timeoutSeconds: 10 }) });
      setMessage(`${provider.name}: ${result.detail}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "O teste do provedor falhou."); }
    finally { setBusy(false); }
  }

  async function simulateRoute() {
    setBusy(true); setError("");
    try {
      const result = await apiRequest<Record<string, unknown>>("/api/modelos-ia/route", { method: "POST", body: JSON.stringify({
        policyId: data.policies[0]?.id || null, preferredProviderId: policyForm.preferredProviderId || null,
        requiredCapabilities: ["text"], estimatedInputTokens: 1000, estimatedOutputTokens: 500,
        privacy: policyForm.privacy, externalActionCommitted: false,
      }) });
      setRouteResult(result); setMessage("Simulação concluída sem consumir tokens.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível simular a rota."); }
    finally { setBusy(false); }
  }

  const selected = routeResult?.selected as Provider | null | undefined;
  const totalTokens = data.usage.inputTokens + data.usage.outputTokens;
  return (
    <main className="nx-page nxi-screen">
      <header className="nx-ph">
        <div><h1>IA e modelos</h1><p>Quais modelos a Nora usa e como escolhe entre eles</p></div>
        <div className="nx-ph-actions">
          <button type="button" className="nx-btn" onClick={() => void simulateRoute()} disabled={busy}><FlaskConical size={16} /> Simular</button>
          <button type="button" className="nx-btn is-primary" aria-expanded={setupOpen} onClick={() => setSetupOpen((current) => !current)}><Plus size={16} /> Conectar provedor</button>
        </div>
      </header>

      <section className="nx-kpis">
        <article className="nx-card nx-kpi"><div className="nx-kpi-l"><Network size={16} /> Provedores</div><div className="nx-kpi-v">{data.providers.length}</div><div className="nx-kpi-s">{data.providers.filter((item) => item.configured).length} configurados</div></article>
        <article className="nx-card nx-kpi"><div className="nx-kpi-l"><Route size={16} /> Políticas</div><div className="nx-kpi-v">{data.policies.length}</div><div className="nx-kpi-s">roteamento controlado</div></article>
        <article className="nx-card nx-kpi"><div className="nx-kpi-l"><Gauge size={16} /> Requisições</div><div className="nx-kpi-v">{data.usage.requests.toLocaleString("pt-BR")}</div><div className="nx-kpi-s">{totalTokens.toLocaleString("pt-BR")} tokens medidos</div></article>
        <article className="nx-card nx-kpi"><div className="nx-kpi-l"><CircleDollarSign size={16} /> Custo estimado</div><div className="nx-kpi-v">{usd(data.usage.estimatedCost, 4)}</div><div className="nx-kpi-s">conforme tarifas cadastradas</div></article>
      </section>

      {error && <div role="alert" className="nxi-alert is-error">{error}</div>}
      {message && <div role="status" className="nxi-alert is-success">{message}</div>}

      {setupOpen && <form onSubmit={saveProvider} className="nx-card nxi-card-pad nxi-stack">
        <div><h2 className="nxi-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}><KeyRound size={15} /> Conectar um provedor</h2><p className="nxi-card-sub">A credencial é criptografada e nunca volta pela API.</p></div>
        <div className="nxi-picker" role="group" aria-label="Provedor">
          {providerOptions.map((option) => <button key={option.id} type="button" aria-pressed={providerForm.provider === option.id} className={providerForm.provider === option.id ? "is-selected" : ""} onClick={() => setProviderForm({ ...providerForm, provider: option.id })}><ProviderLogo provider={option.id} size={30} /><span>{option.name}</span></button>)}
        </div>
        <div className="nxi-cols">
          <label className="nxi-label">Nome interno<input className="nxi-field" required value={providerForm.name} onChange={(event) => setProviderForm({ ...providerForm, name: event.target.value })} placeholder="Ex.: Produção principal" /></label>
          <label className="nxi-label">ID do modelo<input className="nxi-field" required value={providerForm.model} onChange={(event) => setProviderForm({ ...providerForm, model: event.target.value })} placeholder="Ex.: gpt-5.2" /></label>
          <label className="nxi-label">URL base opcional<input className="nxi-field" value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} placeholder="Preenchida automaticamente nos oficiais" /></label>
          <label className="nxi-label">Chave secreta<input className="nxi-field" required type="password" autoComplete="new-password" value={providerForm.secret} onChange={(event) => setProviderForm({ ...providerForm, secret: event.target.value })} placeholder="••••••••••••" /></label>
        </div>
        <label className="nxi-swrow"><span className="nx-grow"><span className="nxi-swrow-t">Habilitar depois de salvar</span><span className="nxi-swrow-d">O modelo poderá ser selecionado pela Nora e pelas automações.</span></span><input type="checkbox" className="nxi-switch" checked={providerForm.enabled} onChange={(event) => setProviderForm({ ...providerForm, enabled: event.target.checked })} /></label>
        <div className="nxi-actions is-end"><Button onClick={() => setSetupOpen(false)}>Cancelar</Button><Button type="submit" variant="primary" disabled={busy}><ShieldCheck size={16} /> Salvar conexão segura</Button></div>
      </form>}

      <section className="nxi-split is-380">
        <div className="nx-card" style={{ overflow: "hidden" }}>
          <div className="nx-card-h"><h2>Modelos conectados</h2><span className="nx-faint nx-small">Status, capacidade e política de dados</span><Button iconOnly size="sm" variant="ghost" className="ml-auto" onClick={() => void load()} aria-label="Atualizar modelos"><RefreshCw size={15} /></Button></div>
          <div className="nxi-table-wrap"><table className="nx-table"><thead><tr><th>Modelo</th><th>Uso</th><th>Contexto</th><th>Entrada / 1M</th><th>Status</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>
            {data.providers.map((provider) => { const ready = provider.enabled && provider.configured; return <tr key={provider.id}>
              <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><ProviderLogo provider={provider.provider} size={32} /><div className="nx-grow"><div style={{ fontWeight: 500 }}>{provider.name}</div><div className="nxi-code">{provider.model}</div><div className="nx-faint nx-small">{provider.provider} · {provider.dataPolicy}</div></div></div></td>
              <td className="nx-muted">{provider.capabilities.join(", ") || "—"}</td>
              <td className="nx-muted">{provider.contextWindow ? `${Math.round(provider.contextWindow / 1000)}k` : "—"}</td>
              <td className="nx-muted">{provider.inputCostPerMillion != null ? usd(provider.inputCostPerMillion, 2) : "—"}</td>
              <td><span className={`nx-badge ${ready ? "is-green" : "is-amber"}`}>{ready ? <><CheckCircle2 size={12} /> Disponível</> : "Configuração pendente"}</span></td>
              <td><button type="button" className="nx-btn is-sm" disabled={busy || (!provider.configured && !provider.managed)} onClick={() => void testProvider(provider)}><TestTube2 size={13} /> Testar configuração</button></td>
            </tr>; })}
          </tbody></table></div>
          {!data.providers.length && <p className="nxi-empty">Nenhum provedor cadastrado.</p>}
          <div className="nx-faint nx-small" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, borderTop: "1px solid var(--nx-border)", padding: "12px 18px" }} aria-label="Provedores compatíveis">
            Compatível com {providerOptions.slice(0, 4).map((item) => <span key={item.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><ProviderLogo provider={item.id} size={22} />{item.name}</span>)}
          </div>
        </div>

        <form onSubmit={savePolicy} className="nx-card nxi-card-pad is-sm nxi-stack is-sm">
          <div><h2 className="nxi-card-title">Política de escolha</h2><p className="nxi-card-sub">Vale para toda a empresa · preferência, privacidade e teto de custo</p></div>
          <label className="nxi-label">Nome<input className="nxi-field" required value={policyForm.name} onChange={(event) => setPolicyForm({ ...policyForm, name: event.target.value })} /></label>
          <label className="nxi-label">Seleção<select className="nxi-field" value={policyForm.mode} onChange={(event) => setPolicyForm({ ...policyForm, mode: event.target.value })}><option value="automatic">Automática</option><option value="manual">Manual</option></select></label>
          <label className="nxi-label">Preferência<select className="nxi-field" value={policyForm.preferredProviderId} onChange={(event) => setPolicyForm({ ...policyForm, preferredProviderId: event.target.value })}><option value="">Menor custo elegível</option>{data.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} / {provider.model}</option>)}</select></label>
          <label className="nxi-label">Privacidade<select className="nxi-field" value={policyForm.privacy} onChange={(event) => setPolicyForm({ ...policyForm, privacy: event.target.value })}><option value="any">Qualquer permitido</option><option value="private">Privado ou local</option><option value="local">Somente local</option></select></label>
          <label className="nxi-label">Custo máx. entrada / 1M<input className="nxi-field" type="number" min="0" step="0.01" value={policyForm.maxInputCostPerMillion} onChange={(event) => setPolicyForm({ ...policyForm, maxInputCostPerMillion: event.target.value })} placeholder="Sem limite" /></label>
          <div className="nxi-actions is-end"><Button type="button" onClick={() => void simulateRoute()} disabled={busy}><Gauge size={15} /> Simular rota</Button><Button type="submit" variant="primary" disabled={busy}>Salvar política <ArrowRight size={15} /></Button></div>
          {routeResult && <div className={`nxi-alert ${selected ? "is-success" : "is-warning"}`}>{selected ? <span>Rota selecionada: <strong>{selected.name} / {selected.model}</strong>. Custo estimado {usd(Number(routeResult.estimatedCost || 0), 6)}.</span> : <span>{String(routeResult.reason || "Nenhum provedor atende à política.")}</span>}</div>}
        </form>
      </section>
    </main>
  );
}
