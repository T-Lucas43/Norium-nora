import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  Gauge,
  KeyRound,
  Network,
  Plus,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  TestTube2,
} from "lucide-react";
import { apiRequest } from "../../core/api/client";
import Button from "../shared/Button";
import openAiLogo from "../../assets/ai-providers/openai.webp";
import geminiLogo from "../../assets/ai-providers/gemini.webp";
import groqLogo from "../../assets/ai-providers/groq.png";
import claudeLogo from "../../assets/ai-providers/claude.webp";

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

function ProviderLogo({ provider, size = 46 }: { provider: string; size?: number }) {
  const key = provider.toLowerCase();
  const asset = key.includes("google") || key.includes("gemini") ? geminiLogo
    : key.includes("groq") ? groqLogo
      : key.includes("anthropic") || key.includes("claude") ? claudeLogo
        : key.includes("openai") && !key.includes("compatible") ? openAiLogo
          : null;
  if (asset) return <span className={`ai-provider-logo is-image is-${key.includes("google") || key.includes("gemini") ? "gemini" : key.includes("groq") ? "groq" : key.includes("anthropic") || key.includes("claude") ? "anthropic" : "openai"}`} style={{ width: size, height: size }} aria-hidden="true"><img src={asset} alt="" /></span>;
  return <span className="ai-provider-logo is-compatible" style={{ width: size, height: size }} aria-hidden="true"><Network size={Math.round(size * .48)} /></span>;
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
  return (
    <main className="models-page mx-auto w-full max-w-[1720px] space-y-5 p-4 text-[var(--text)] sm:p-6">
      <header className="models-hero">
        <div><span>Inteligência conectada</span><h1>IA e Modelos</h1><p>Escolha os melhores modelos para cada trabalho, acompanhe disponibilidade, privacidade e custo em uma visão clara.</p></div>
        <div className="models-brand-row" aria-label="Provedores compatíveis">
          {providerOptions.slice(0, 4).map((item) => <span key={item.id}><ProviderLogo provider={item.id} size={40} /><small>{item.name}</small></span>)}
        </div>
        <Button variant="primary" onClick={() => setSetupOpen((current) => !current)}><Plus size={16} /> Conectar provedor</Button>
      </header>

      <section className="models-metrics">
        <article><Network size={18}/><div><strong>{data.providers.length}</strong><span>provedores</span></div><small>{data.providers.filter((item) => item.configured).length} configurados</small></article>
        <article><Route size={18}/><div><strong>{data.policies.length}</strong><span>políticas</span></div><small>roteamento controlado</small></article>
        <article><Gauge size={18}/><div><strong>{data.usage.requests}</strong><span>requisições</span></div><small>{data.usage.inputTokens + data.usage.outputTokens} tokens medidos</small></article>
        <article><CircleDollarSign size={18}/><div><strong>US$ {data.usage.estimatedCost.toFixed(4)}</strong><span>custo estimado</span></div><small>conforme tarifas cadastradas</small></article>
      </section>

      {error && <div role="alert" className="models-notice is-error">{error}</div>}
      {message && <div role="status" className="models-notice">{message}</div>}

      {setupOpen && <form onSubmit={saveProvider} className="models-setup">
        <div className="models-section-heading"><div><span><KeyRound size={15}/> Nova conexão</span><h2>Conectar um provedor</h2><p>A credencial é criptografada e nunca volta pela API.</p></div></div>
        <div className="models-provider-picker">
          {providerOptions.map((option) => <button key={option.id} type="button" className={providerForm.provider === option.id ? "is-selected" : ""} onClick={() => setProviderForm({ ...providerForm, provider: option.id })}><ProviderLogo provider={option.id} size={38}/><span>{option.name}</span></button>)}
        </div>
        <div className="models-form-grid">
          <label><span>Nome interno</span><input required value={providerForm.name} onChange={(event) => setProviderForm({ ...providerForm, name: event.target.value })} placeholder="Ex.: Produção principal" /></label>
          <label><span>ID do modelo</span><input required value={providerForm.model} onChange={(event) => setProviderForm({ ...providerForm, model: event.target.value })} placeholder="Ex.: gpt-5.2" /></label>
          <label><span>URL base opcional</span><input value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} placeholder="Preenchida automaticamente nos oficiais" /></label>
          <label><span>Chave secreta</span><input required type="password" autoComplete="new-password" value={providerForm.secret} onChange={(event) => setProviderForm({ ...providerForm, secret: event.target.value })} placeholder="••••••••••••" /></label>
        </div>
        <label className="models-enable"><span><strong>Habilitar depois de salvar</strong><small>O modelo poderá ser selecionado pela Nora e pelas automações.</small></span><input type="checkbox" checked={providerForm.enabled} onChange={(event) => setProviderForm({ ...providerForm, enabled: event.target.checked })}/></label>
        <div className="models-form-actions"><Button onClick={() => setSetupOpen(false)}>Cancelar</Button><Button type="submit" variant="primary" disabled={busy}><ShieldCheck size={16}/> Salvar conexão segura</Button></div>
      </form>}

      <section className="models-registry">
        <div className="models-section-heading"><div><span><Sparkles size={15}/> Modelos conectados</span><h2>Seu stack de inteligência</h2><p>Status, capacidade e política de dados sem esconder detalhes importantes.</p></div><Button iconOnly onClick={() => void load()} aria-label="Atualizar modelos"><RefreshCw size={16}/></Button></div>
        <div className="models-provider-grid">
          {data.providers.map((provider) => <article key={provider.id} className={provider.enabled && provider.configured ? "is-ready" : ""}>
            <div className="models-provider-card-top"><ProviderLogo provider={provider.provider} /><span className={provider.enabled && provider.configured ? "is-ready" : ""}>{provider.enabled && provider.configured ? <><CheckCircle2 size={13}/> Disponível</> : "Configuração pendente"}</span></div>
            <p>{provider.provider} · {provider.dataPolicy}</p><h3>{provider.name}</h3><code>{provider.model}</code>
            <div className="models-capabilities">{provider.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>
            <dl><div><dt>Contexto</dt><dd>{provider.contextWindow ? `${Math.round(provider.contextWindow / 1000)}k` : "—"}</dd></div><div><dt>Entrada / 1M</dt><dd>{provider.inputCostPerMillion != null ? `US$ ${provider.inputCostPerMillion}` : "—"}</dd></div></dl>
            <Button disabled={busy || (!provider.configured && !provider.managed)} onClick={() => void testProvider(provider)}><TestTube2 size={14}/> Testar configuração</Button>
          </article>)}
          {!data.providers.length && <div className="models-empty">Nenhum provedor cadastrado.</div>}
        </div>
      </section>

      <section className="models-routing">
        <div className="models-section-heading"><div><span><Route size={15}/> Controle de rota</span><h2>Política principal</h2><p>Defina preferência, privacidade e teto de custo antes de usar.</p></div></div>
        <form onSubmit={savePolicy}>
          <label><span>Nome</span><input required value={policyForm.name} onChange={(event) => setPolicyForm({ ...policyForm, name: event.target.value })}/></label>
          <label><span>Seleção</span><select value={policyForm.mode} onChange={(event) => setPolicyForm({ ...policyForm, mode: event.target.value })}><option value="automatic">Automática</option><option value="manual">Manual</option></select></label>
          <label><span>Preferência</span><select value={policyForm.preferredProviderId} onChange={(event) => setPolicyForm({ ...policyForm, preferredProviderId: event.target.value })}><option value="">Menor custo elegível</option>{data.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} / {provider.model}</option>)}</select></label>
          <label><span>Privacidade</span><select value={policyForm.privacy} onChange={(event) => setPolicyForm({ ...policyForm, privacy: event.target.value })}><option value="any">Qualquer permitido</option><option value="private">Privado ou local</option><option value="local">Somente local</option></select></label>
          <label><span>Custo máx. entrada / 1M</span><input type="number" min="0" step="0.01" value={policyForm.maxInputCostPerMillion} onChange={(event) => setPolicyForm({ ...policyForm, maxInputCostPerMillion: event.target.value })} placeholder="Sem limite"/></label>
          <div className="models-routing-actions"><Button type="button" onClick={() => void simulateRoute()} disabled={busy}><Gauge size={15}/> Simular</Button><Button type="submit" variant="primary" disabled={busy}>Salvar política <ArrowRight size={15}/></Button></div>
        </form>
        {routeResult && <div className={`models-route-result ${selected ? "is-success" : ""}`}>{selected ? <>Rota selecionada: <strong>{selected.name} / {selected.model}</strong>. Custo estimado US$ {Number(routeResult.estimatedCost || 0).toFixed(6)}.</> : String(routeResult.reason || "Nenhum provedor atende à política.")}</div>}
      </section>
    </main>
  );
}
