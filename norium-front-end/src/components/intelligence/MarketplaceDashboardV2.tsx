import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  Database,
  ExternalLink,
  FileStack,
  Globe2,
  Info,
  LibraryBig,
  MapPin,
  Network,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
  Workflow,
  X,
} from "lucide-react";
import { apiRequest } from "../../core/api/client";
import noriumAgendaIcon from "../../assets/generated/norium-agenda.png";
import noriumMailIcon from "../../assets/generated/norium-mail.png";
import whatsappIcon from "../../assets/generated/whatsapp-premium.png";
import Button from "../shared/Button";
import { showConfirm } from "../shared/AppDialogProvider";
import "../../styles/screens/inteligencia-equipe-conta.css";

type CatalogItem = {
  id: string;
  type: string;
  name: string;
  description: string;
  details?: string;
  features?: string[];
  version: string;
  author: string;
  verified: boolean;
  permissions: string[];
  dependencies: string[];
  category: string;
  icon?: string;
  destination?: string;
  dataAccess?: string[];
  setupSteps?: string[];
  limitations?: string[];
  activationBehavior?: string;
};

type Installation = {
  id: string;
  catalogId: string;
  version: string;
  status: string;
  enabled: boolean;
};

type MarketplaceOverview = { catalog: CatalogItem[]; installations: Installation[] };

function ProductIcon({ item }: { item: CatalogItem }) {
  const image = item.icon === "norium-mail"
      ? noriumMailIcon
      : item.icon === "whatsapp"
        ? whatsappIcon
        : item.icon === "calendar"
          ? noriumAgendaIcon
          : null;
  if (image) return <img src={image} alt="" />;
  const Icon = item.icon === "document-models" ? FileStack
    : item.icon === "browser" ? Globe2
      : item.icon === "knowledge-web" || item.icon === "knowledge" ? LibraryBig
        : item.icon === "automation" ? Workflow
          : item.icon === "models" || item.icon === "nora-model" ? Network
            : item.icon === "clients" ? UserRoundCheck
              : Boxes;
  return <Icon size={20} strokeWidth={1.75} />;
}

const itemTypeLabels: Record<string, string> = {
  agent: "Agente",
  automation: "Automação",
  connector: "Pacote",
  extension: "Extensão",
  integration: "Integração",
  model: "Modelo de IA",
  package: "Política",
  template: "Modelo",
  "template-pack": "Pacote de modelos",
};

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="nxi-switch"
    />
  );
}

export default function MarketplaceDashboardV2() {
  const [data, setData] = useState<MarketplaceOverview>({ catalog: [], installations: [] });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Todos");
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await apiRequest<MarketplaceOverview>("/api/marketplace"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível carregar o marketplace.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const installedIds = useMemo(() => new Set(
    data.installations
      .filter((item) => item.status === "installed")
      .map((item) => item.catalogId),
  ), [data.installations]);
  const categories = useMemo(() => ["Todos", "Instalados", ...Array.from(new Set(data.catalog.map((item) => item.category)))], [data.catalog]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return data.catalog.filter((item) => {
      const categoryMatches = category === "Todos"
        || (category === "Instalados" ? installedIds.has(item.id) : item.category === category);
      const searchable = [item.name, item.description, item.details, item.category, item.destination, ...(item.features || []), ...(item.dataAccess || []), ...(item.limitations || [])].filter(Boolean).join(" ");
      const textMatches = !normalized || searchable.toLocaleLowerCase("pt-BR").includes(normalized);
      return categoryMatches && textMatches;
    });
  }, [category, data.catalog, installedIds, query]);

  const installationFor = (catalogId: string) => data.installations.find((item) => item.catalogId === catalogId && item.status === "installed");
  const selectedInstallation = selected ? installationFor(selected.id) : undefined;

  async function install(item: CatalogItem) {
    setBusyId(item.id); setError("");
    try {
      await apiRequest(`/api/marketplace/${item.id}/install`, {
        method: "POST",
        body: JSON.stringify({ confirm: confirmed, version: item.version }),
      });
      setMessage(`${item.name} foi instalado e ativado. Você já pode usar.`);
      setSelected(null); setConfirmed(false); await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "A instalação falhou.");
    } finally { setBusyId(""); }
  }

  async function toggle(installation: Installation, item: CatalogItem) {
    setBusyId(item.id); setError("");
    try {
      await apiRequest(`/api/marketplace/installations/${installation.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !installation.enabled }),
      });
      setMessage(`${item.name} ${installation.enabled ? "desativado" : "ativado"}.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível alterar a ativação.");
    } finally { setBusyId(""); }
  }

  async function uninstall(installation: Installation, item: CatalogItem) {
    const allowed = await showConfirm({
      title: `Desinstalar ${item.name}?`,
      description: "O acesso será removido. Recursos e histórico existentes permanecerão preservados e desativados.",
      confirmLabel: "Desinstalar",
      tone: "danger",
    });
    if (!allowed) return;
    setBusyId(item.id); setError("");
    try {
      await apiRequest(`/api/marketplace/installations/${installation.id}`, { method: "DELETE" });
      setMessage(`${item.name} foi desinstalado.`); await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível desinstalar.");
    } finally { setBusyId(""); }
  }

  const installedCount = data.installations.filter((item) => item.status === "installed").length;
  const activeCount = data.installations.filter((item) => item.status === "installed" && item.enabled).length;

  return (
    <main className="nx-page nxi-screen">
      <header className="nx-ph">
        <div>
          <h1>Marketplace</h1>
          <p>Agentes, automações e integrações prontos para instalar · {data.catalog.length} {data.catalog.length === 1 ? "disponível" : "disponíveis"} · {installedCount} {installedCount === 1 ? "instalado" : "instalados"} · {activeCount} {activeCount === 1 ? "ativo" : "ativos"}</p>
        </div>
      </header>

      {error && <div role="alert" className="nxi-alert is-error">{error}</div>}
      {message && <div role="status" className="nxi-alert is-success">{message}</div>}

      <section className="nxi-actions" style={{ alignItems: "center" }}>
        <div className="nxi-chips" aria-label="Categorias do marketplace" style={{ flex: "1 1 320px" }}>
          {categories.map((item) => <button key={item} type="button" aria-pressed={category === item} className={`nxi-chip ${category === item ? "is-active" : ""}`} onClick={() => setCategory(item)}>{item}</button>)}
        </div>
        <label className="nxi-search" style={{ flex: "0 1 260px", minWidth: 200, marginLeft: "auto" }}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar" aria-label="Buscar conectores, agentes e modelos" /></label>
      </section>

      <section className="nxi-cards">
        {visible.map((item) => {
          const installation = installationFor(item.id);
          return (
            <article key={item.id} className={`nx-card nxi-product ${installation?.enabled ? "is-enabled" : ""}`}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span className="nxi-tile"><ProductIcon item={item} /></span>
                <div className="nx-grow">
                  <h2 className="nxi-product-name">{item.name}</h2>
                  <div className="nx-faint nx-small">{itemTypeLabels[item.type] || item.type} · {item.category} · v{item.version}{item.verified && <> · <span style={{ color: "var(--nx-primary-text)" }}>Verificado</span></>}</div>
                </div>
              </div>
              <p className="nxi-product-desc">{item.description}</p>
              {!!item.features?.length && <ul className="nxi-product-feats">
                {item.features.slice(0, 3).map((feature) => <li key={feature}><CheckCircle2 size={12} /> {feature}</li>)}
              </ul>}
              <div className="nx-faint nx-small" style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}><MapPin size={12} /> Onde aparece: {item.destination || "Workspace Norium"}</div>
              <button type="button" className="nxi-link" style={{ marginTop: 10, alignSelf: "flex-start" }} onClick={() => { setSelected(item); setConfirmed(false); }}>
                <Info size={14} /> Ver ficha completa
              </button>
              <div className="nxi-product-foot">
                {installation ? (
                  <>
                    <span className={`nx-badge ${installation.enabled ? "is-green" : ""}`}><CheckCircle2 size={12} /> Instalado</span>
                    <div className="nxi-product-state"><strong>{installation.enabled ? "Instalado e ativo" : "Instalado e desativado"}</strong><small>{installation.enabled ? `Disponível em ${item.destination || "Norium"}` : "Não aparece nos módulos até ser ativado"}</small></div>
                    <Switch checked={installation.enabled} disabled={busyId === item.id} label={`${installation.enabled ? "Desativar" : "Ativar"} ${item.name}`} onChange={() => void toggle(installation, item)} />
                    <button type="button" className="nxi-icon-btn is-danger" disabled={busyId === item.id} onClick={() => void uninstall(installation, item)} aria-label={`Desinstalar ${item.name}`} title={`Desinstalar ${item.name}`}><Trash2 size={14} /></button>
                  </>
                ) : <>
                  {item.verified ? <span className="nx-badge is-blue"><ShieldCheck size={12} /> Verificado</span> : <span className="nx-faint nx-small">Disponível</span>}
                  <button type="button" className="nx-btn is-primary is-sm" style={{ marginLeft: "auto" }} onClick={() => { setSelected(item); setConfirmed(false); }}><Plus size={14} /> Ver detalhes e instalar</button>
                </>}
              </div>
            </article>
          );
        })}
      </section>
      {!visible.length && <div className="nx-card nxi-empty"><Boxes size={28} /><strong>Nenhum recurso encontrado</strong><span>Tente outro termo ou categoria.</span></div>}

      {selected && (
        <div className="nxi-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Detalhes de ${selected.name}`}>
          <section className="nxi-modal">
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <span className="nxi-tile" style={{ width: 48, height: 48 }}><ProductIcon item={selected} /></span>
              <div className="nx-grow"><p className="nx-faint nx-small" style={{ margin: 0 }}>{itemTypeLabels[selected.type] || selected.type} · {selected.category} · v{selected.version} · por {selected.author}</p><h2 style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 600 }}>{selected.name}</h2><span className={`nx-badge ${selectedInstallation?.enabled ? "is-green" : "is-blue"}`} style={{ marginTop: 8 }}><ShieldCheck size={12} /> {selectedInstallation ? `Instalado e ${selectedInstallation.enabled ? "ativo" : "desativado"}` : "Componente verificado"}</span></div>
              <button type="button" className="nxi-icon-btn is-plain" onClick={() => setSelected(null)} aria-label="Fechar ficha"><X size={18} /></button>
            </div>
            <p className="nx-muted" style={{ margin: "16px 0 0", lineHeight: 1.55 }}>{selected.details || selected.description}</p>
            <div className="nxi-sheet">
              <section><h3>O que será adicionado</h3>{(selected.features || []).map((feature) => <p key={feature}><CheckCircle2 size={15} /> {feature}</p>)}</section>
              <section><h3>Onde atua</h3><p><MapPin size={15} /> {selected.destination || "Workspace Norium"}</p>{selected.activationBehavior && <p><CheckCircle2 size={15} /> {selected.activationBehavior}</p>}</section>
              <section><h3>Dados que pode acessar</h3>{(selected.dataAccess || ["Somente os dados autorizados nas permissões abaixo."]).map((entry) => <p key={entry}><Database size={15} /> {entry}</p>)}</section>
              <section><h3>Permissões exigidas</h3>{selected.permissions.map((permission) => <p key={permission}><ShieldCheck size={15} /> {permission}</p>)}</section>
              <section><h3>Pré-requisitos</h3>{selected.dependencies.length ? selected.dependencies.map((dependency) => <p key={dependency}><ExternalLink size={15} /> {dependency}</p>) : <p><CheckCircle2 size={15} /> Nenhum pré-requisito adicional</p>}</section>
              <section><h3>Como configurar</h3><ol>{(selected.setupSteps || ["Instale o recurso.", "Revise as permissões e ative quando estiver pronto."]).map((step) => <li key={step}>{step}</li>)}</ol></section>
              <section><h3>Limites e proteções</h3>{(selected.limitations || ["Ações externas continuam protegidas pelas confirmações do Norium."]).map((entry) => <p key={entry}><AlertCircle size={15} /> {entry}</p>)}</section>
            </div>
            <div className="nxi-alert is-info" style={{ marginTop: 16, alignItems: "flex-start", flexWrap: "nowrap" }}><ShieldCheck size={16} /><span><strong>Você mantém o controle.</strong> {selectedInstallation ? "Este recurso já está instalado. Você pode ativá-lo ou desativá-lo sem perder os dados que ele criou." : `O recurso será instalado já ativo e ficará disponível em ${selected.destination || "seu destino"}. Você poderá desativá-lo quando quiser.`}</span></div>
            {selectedInstallation ? (
              <div className="nxi-actions" style={{ marginTop: 16, justifyContent: "space-between" }}>
                <div className="nxi-actions" style={{ flexWrap: "nowrap" }}><span className="nxi-product-state"><strong>{selectedInstallation.enabled ? "Ativo" : "Desativado"}</strong><small>{selectedInstallation.enabled ? `Disponível em ${selected.destination || "Norium"}` : "O recurso está instalado, mas não aparece no destino"}</small></span><Switch checked={selectedInstallation.enabled} disabled={busyId === selected.id} label={`${selectedInstallation.enabled ? "Desativar" : "Ativar"} ${selected.name}`} onChange={() => void toggle(selectedInstallation, selected)} /></div>
                <Button onClick={() => setSelected(null)}>Fechar</Button>
              </div>
            ) : (
              <>
                <label className="nxi-alert" style={{ marginTop: 16, flexWrap: "nowrap", cursor: "pointer", color: "var(--nx-text)" }}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Revisei os dados acessados, permissões, pré-requisitos e limites desta versão.</span></label>
                <div className="nxi-actions is-end" style={{ marginTop: 16 }}><Button onClick={() => setSelected(null)}>Cancelar</Button><Button variant="primary" disabled={!confirmed || busyId === selected.id} onClick={() => void install(selected)}>{busyId === selected.id ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Instalar</Button></div>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
