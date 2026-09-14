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
  Sparkles,
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
  if (image) return <img src={image} alt="" className="h-12 w-12 object-contain" />;
  const Icon = item.icon === "document-models" ? FileStack
    : item.icon === "browser" ? Globe2
      : item.icon === "knowledge-web" || item.icon === "knowledge" ? LibraryBig
        : item.icon === "automation" ? Workflow
          : item.icon === "models" || item.icon === "nora-model" ? Network
            : item.icon === "clients" ? UserRoundCheck
              : Boxes;
  return <Icon size={29} strokeWidth={1.65} />;
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
      className={`marketplace-switch ${checked ? "is-on" : ""}`}
    >
      <span />
    </button>
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
      setMessage(`${item.name} foi instalado. Ative quando quiser disponibilizá-lo no Norium.`);
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
    <main className="marketplace-page mx-auto w-full max-w-[1720px] space-y-5 p-4 text-[var(--text)] sm:p-6">
      <header className="marketplace-hero">
        <div className="marketplace-hero-mark"><Sparkles size={28} /></div>
        <div className="min-w-0">
          <span>Ecossistema Norium</span>
          <h1>Marketplace interno</h1>
          <p>Instale recursos reais, entenda o que cada conector acessa e controle claramente o que está ativo no workspace.</p>
        </div>
        <div className="marketplace-hero-stats">
          <strong>{data.catalog.length}<small>disponíveis</small></strong>
          <strong>{installedCount}<small>instalados</small></strong>
          <strong>{activeCount}<small>ativos</small></strong>
        </div>
      </header>

      {error && <div role="alert" className="marketplace-notice is-error">{error}</div>}
      {message && <div role="status" className="marketplace-notice">{message}</div>}

      <section className="marketplace-toolbar">
        <label><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar conectores, agentes e modelos" /></label>
        <div className="marketplace-categories" aria-label="Categorias do marketplace">
          {categories.map((item) => <button key={item} type="button" className={category === item ? "is-active" : ""} onClick={() => setCategory(item)}>{item}</button>)}
        </div>
      </section>

      <section className="marketplace-grid">
        {visible.map((item) => {
          const installation = installationFor(item.id);
          return (
            <article key={item.id} className={`marketplace-product ${installation ? "is-installed" : ""} ${installation?.enabled ? "is-enabled" : ""}`}>
              <div className="marketplace-product-top">
                <span className="marketplace-product-icon"><ProductIcon item={item} /></span>
                <div className="marketplace-product-badges">
                  {installation && <span className="marketplace-installed"><CheckCircle2 size={13} /> Instalado</span>}
                  {item.verified && <span className="marketplace-verified"><ShieldCheck size={13} /> Verificado</span>}
                </div>
              </div>
              <p className="marketplace-product-meta">{item.category} · v{item.version}</p>
              <h2>{item.name}</h2>
              <p className="marketplace-product-description">{item.description}</p>
              <div className="marketplace-feature-preview">
                {(item.features || []).slice(0, 3).map((feature) => <span key={feature}><CheckCircle2 size={13} /> {feature}</span>)}
              </div>
              <dl className="marketplace-product-specs">
                <div><dt>Tipo</dt><dd>{itemTypeLabels[item.type] || item.type}</dd></div>
                <div><dt>Onde aparece</dt><dd>{item.destination || "Workspace Norium"}</dd></div>
              </dl>
              <button type="button" className="marketplace-details-link" onClick={() => { setSelected(item); setConfirmed(false); }}>
                <Info size={14} /> Ver ficha completa
              </button>
              <div className="marketplace-product-footer">
                {installation ? (
                  <>
                    <div><strong>{installation.enabled ? "Instalado e ativo" : "Instalado e desativado"}</strong><small>{installation.enabled ? `Disponível em ${item.destination || "Norium"}` : "Não aparece nos módulos até ser ativado"}</small></div>
                    <Switch checked={installation.enabled} disabled={busyId === item.id} label={`${installation.enabled ? "Desativar" : "Ativar"} ${item.name}`} onChange={() => void toggle(installation, item)} />
                    <Button iconOnly variant="danger" size="sm" disabled={busyId === item.id} onClick={() => void uninstall(installation, item)} aria-label={`Desinstalar ${item.name}`}><Trash2 size={15} /></Button>
                  </>
                ) : <Button variant="primary" className="w-full" onClick={() => { setSelected(item); setConfirmed(false); }}><Plus size={16} /> Ver detalhes e instalar</Button>}
              </div>
            </article>
          );
        })}
      </section>
      {!visible.length && <div className="marketplace-empty"><Boxes size={30} /><strong>Nenhum recurso encontrado</strong><span>Tente outro termo ou categoria.</span></div>}

      {selected && (
        <div className="marketplace-dialog-backdrop" role="dialog" aria-modal="true" aria-label={`Detalhes de ${selected.name}`}>
          <section className="marketplace-dialog">
            <div className="marketplace-dialog-header">
              <span className="marketplace-product-icon is-large"><ProductIcon item={selected} /></span>
              <div><p>{itemTypeLabels[selected.type] || selected.type} · {selected.category} · v{selected.version} · por {selected.author}</p><h2>{selected.name}</h2><span><ShieldCheck size={13} /> {selectedInstallation ? `Instalado e ${selectedInstallation.enabled ? "ativo" : "desativado"}` : "Componente verificado"}</span></div>
              <button type="button" onClick={() => setSelected(null)} aria-label="Fechar ficha"><X size={19} /></button>
            </div>
            <p className="marketplace-dialog-description">{selected.details || selected.description}</p>
            <div className="marketplace-dialog-columns">
              <section><h3>O que será adicionado</h3>{(selected.features || []).map((feature) => <p key={feature}><CheckCircle2 size={15} /> {feature}</p>)}</section>
              <section><h3>Onde atua</h3><p><MapPin size={15} /> {selected.destination || "Workspace Norium"}</p>{selected.activationBehavior && <p><CheckCircle2 size={15} /> {selected.activationBehavior}</p>}</section>
              <section><h3>Dados que pode acessar</h3>{(selected.dataAccess || ["Somente os dados autorizados nas permissões abaixo."]).map((entry) => <p key={entry}><Database size={15} /> {entry}</p>)}</section>
              <section><h3>Permissões exigidas</h3>{selected.permissions.map((permission) => <p key={permission}><ShieldCheck size={15} /> {permission}</p>)}</section>
              <section><h3>Pré-requisitos</h3>{selected.dependencies.length ? selected.dependencies.map((dependency) => <p key={dependency}><ExternalLink size={15} /> {dependency}</p>) : <p><CheckCircle2 size={15} /> Nenhum pré-requisito adicional</p>}</section>
              <section><h3>Como configurar</h3><ol>{(selected.setupSteps || ["Instale o recurso.", "Revise as permissões e ative quando estiver pronto."]).map((step) => <li key={step}>{step}</li>)}</ol></section>
              <section><h3>Limites e proteções</h3>{(selected.limitations || ["Ações externas continuam protegidas pelas confirmações do Norium."]).map((entry) => <p key={entry}><AlertCircle size={15} /> {entry}</p>)}</section>
            </div>
            <div className="marketplace-safety-note"><ShieldCheck size={18} /><span><strong>Você mantém o controle.</strong> {selectedInstallation ? "Este recurso já está instalado. Você pode ativá-lo ou desativá-lo sem perder os dados que ele criou." : `O recurso será instalado desativado e só aparecerá em ${selected.destination || "seu destino"} depois que você o ativar.`}</span></div>
            {selectedInstallation ? (
              <div className="marketplace-dialog-actions is-installed">
                <div className="marketplace-dialog-installed-actions"><span><strong>{selectedInstallation.enabled ? "Ativo" : "Desativado"}</strong><small>{selectedInstallation.enabled ? `Disponível em ${selected.destination || "Norium"}` : "O recurso está instalado, mas não aparece no destino"}</small></span><Switch checked={selectedInstallation.enabled} disabled={busyId === selected.id} label={`${selectedInstallation.enabled ? "Desativar" : "Ativar"} ${selected.name}`} onChange={() => void toggle(selectedInstallation, selected)} /></div>
                <Button onClick={() => setSelected(null)}>Fechar</Button>
              </div>
            ) : (
              <>
                <label className="marketplace-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Revisei os dados acessados, permissões, pré-requisitos e limites desta versão.</span></label>
                <div className="marketplace-dialog-actions"><Button onClick={() => setSelected(null)}>Cancelar</Button><Button variant="primary" disabled={!confirmed || busyId === selected.id} onClick={() => void install(selected)}>{busyId === selected.id ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Instalar</Button></div>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
