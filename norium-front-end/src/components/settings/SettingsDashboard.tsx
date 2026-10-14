import PrivacyStorageCard from "./PrivacyStorageCard";
import { applyInterfacePreferences, defaultInterfacePreferences, type InterfacePreferences } from "../../utils/interfacePreferences";
import {
  Bell,
  Bot,
  Check,
  Download,
  LockKeyhole,
  Moon,
  Palette,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { NoriumUser } from "../../types/auth";
import type { PerfilOperador, PerfilTema, TemaCores, TemaPersonalizado } from "../../types/omnichannel";
import { applyNoriumTheme, defaultThemeCustomization } from "../../utils/theme";
import {
  createDefaultProfile,
  loadOperatorProfile,
  saveOperatorProfile,
} from "../profile/profileService";
import Button from "../shared/Button";
import { apiBlobRequest, apiRequest } from "../../core/api/client";
import "../../styles/screens/inteligencia-equipe-conta.css";
import SettingsNav, { readSettingsSection, storeSettingsSection, type SettingsSection } from "./SettingsNav";
import NoraUsageSettings from "./NoraUsageSettings";

type SettingsDashboardProps = {
  userId?: string;
  currentUser?: NoriumUser | null;
  onSaved: (profile: PerfilOperador) => void;
  onOpenAdmin?: () => void;
  onLogout?: () => void;
  onNavigate?: (tab: string) => void;
};

const sectionHeads: Record<Exclude<SettingsSection, "perfil">, { title: string; subtitle: string }> = {
  nora: { title: "Nora e IA", subtitle: "Personalidade da sua assistente." },
  consumo: { title: "Consumo da Nora", subtitle: "Acompanhe o uso, a franquia e a próxima renovação da sua conta." },
  aparencia: { title: "Aparência e acessibilidade", subtitle: "Ajuste o Norium ao seu jeito de trabalhar. O tema é aplicado imediatamente em todo o Norium." },
  notificacoes: { title: "Notificações", subtitle: "Alertas visuais e atualizações em tempo real." },
  privacidade: { title: "Seus dados e privacidade", subtitle: "Baixe uma cópia portátil dos dados pessoais da conta. A exclusão revoga as sessões, elimina o diretório pessoal e anonimiza o cadastro e a auditoria." },
  admin: { title: "Painel administrativo", subtitle: "Gerencie usuários, planos, equipes e permissões sem sair da sua sessão atual." },
};

const colorGroups: Array<{
  title: string;
  fields: Array<{ key: keyof TemaCores; label: string; hint: string }>;
}> = [
  {
    title: "Marca e ações",
    fields: [
      { key: "primary", label: "Cor primária", hint: "Ícones, links e destaques" },
      { key: "primaryStrong", label: "Realce", hint: "Ações secundárias" },
      { key: "primaryDeep", label: "Profundidade", hint: "Botões e sombras" },
      { key: "onPrimary", label: "Texto em botões", hint: "Contraste sobre a marca" },
    ],
  },
  {
    title: "Fundo e painéis",
    fields: [
      { key: "gradientStart", label: "Gradiente inicial", hint: "Primeira cor do fundo" },
      { key: "gradientMiddle", label: "Gradiente central", hint: "Transição do fundo" },
      { key: "gradientEnd", label: "Gradiente final", hint: "Última cor do fundo" },
      { key: "background", label: "Fundo base", hint: "Camada principal" },
      { key: "surface", label: "Painéis", hint: "Cards e barras" },
      { key: "surfaceHover", label: "Hover", hint: "Realce ao apontar" },
      { key: "border", label: "Bordas", hint: "Linhas e contornos" },
    ],
  },
  {
    title: "Textos e estados",
    fields: [
      { key: "text", label: "Texto principal", hint: "Títulos e conteúdo" },
      { key: "textSecondary", label: "Texto secundário", hint: "Descrições e metadados" },
      { key: "success", label: "Sucesso", hint: "Concluído e conectado" },
      { key: "warning", label: "Aviso", hint: "Pendências e alertas" },
      { key: "danger", label: "Erro", hint: "Falhas e exclusões" },
    ],
  },
];

export default function SettingsDashboard({
  userId = "primary",
  currentUser,
  onSaved,
  onOpenAdmin,
  onLogout,
  onNavigate,
}: SettingsDashboardProps) {
  const showAdmin = Boolean(currentUser?.systemAdmin && onOpenAdmin);
  const showPrivacy = Boolean(currentUser);
  const [storedSection, setSection] = useState<SettingsSection>(() => readSettingsSection() || "aparencia");
  const section: Exclude<SettingsSection, "perfil"> = storedSection === "perfil" || (storedSection === "admin" && !showAdmin) || (storedSection === "privacidade" && !showPrivacy) || (storedSection === "consumo" && !currentUser) ? "aparencia" : storedSection;
  function selectSection(next: SettingsSection) {
    storeSettingsSection(next);
    if (next === "perfil") {
      if (onNavigate) onNavigate("Perfil");
      return;
    }
    setSection(next);
  }
  const head = sectionHeads[section];
  const [profile, setProfile] = useState<PerfilOperador>(createDefaultProfile);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [exportingData, setExportingData] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const canCustomizeTheme = Boolean(currentUser?.systemAdmin || currentUser?.plan === "enterprise");
  const preferences = { ...defaultInterfacePreferences, ...profile.interface_preferences };
  function updatePreference<K extends keyof InterfacePreferences>(key: K, value: InterfacePreferences[K]) {
    setProfile(current => ({ ...current, interface_preferences: { ...defaultInterfacePreferences, ...current.interface_preferences, [key]: value } }));
    setMessage("");
  }
  const activePalette = profile.tema_personalizado[profile.tema];
  const customizationEnabled = Boolean(profile.tema_personalizado.enabled);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const loaded = await loadOperatorProfile(userId);
        if (cancelled) return;
        setProfile(loaded);
        applyNoriumTheme(loaded.tema, canCustomizeTheme ? loaded.tema_personalizado : undefined);
        onSaved(loaded);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Falha ao carregar configurações.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [canCustomizeTheme, onSaved, userId]);

  function applyDraft(next: PerfilOperador) {
    setProfile(next);
    applyNoriumTheme(next.tema, canCustomizeTheme ? next.tema_personalizado : undefined);
  }

  function updateTheme(theme: PerfilTema) {
    applyDraft({ ...profile, tema: theme });
  }

  function updateCustomization(updater: (value: TemaPersonalizado) => TemaPersonalizado) {
    if (!canCustomizeTheme) return;
    const next = {
      ...profile,
      tema_personalizado: updater(profile.tema_personalizado),
    };
    applyDraft(next);
  }

  function updateColor(key: keyof TemaCores, value: string) {
    updateCustomization((customization) => ({
      ...customization,
      [profile.tema]: {
        ...customization[profile.tema],
        [key]: value,
      },
    }));
  }

  async function exportPersonalData() {
    setExportingData(true);
    setError("");
    try {
      const blob = await apiBlobRequest("/api/auth/privacy/export", { headers: { Accept: "application/zip" } });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "norium-dados-pessoais.zip";
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("Exportação de dados preparada com manifesto de integridade.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao exportar seus dados.");
    } finally {
      setExportingData(false);
    }
  }

  async function deleteAccount() {
    setDeletingAccount(true);
    setError("");
    try {
      await apiRequest("/api/auth/privacy/account", {
        method: "DELETE",
        body: JSON.stringify({ currentPassword, confirmation: deletionConfirmation }),
      });
      onLogout?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao excluir a conta.");
    } finally {
      setDeletingAccount(false);
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await saveOperatorProfile(userId, profile);
      setProfile(saved);
      applyNoriumTheme(saved.tema, canCustomizeTheme ? saved.tema_personalizado : undefined);
      applyInterfacePreferences(saved.interface_preferences);
      onSaved(saved);
      setMessage("Configurações salvas e aplicadas em todas as telas.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar configurações.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="nx-page nxi-screen">
      <div className="nxi-cfg">
        <SettingsNav active={section} onSelect={selectSection} showPrivacy={showPrivacy} showAdmin={showAdmin} showUsage={Boolean(currentUser)} />
        <div className="nxi-cfg-main" style={{ maxWidth: 1080 }}>
          <header className="nxi-cfg-head">
            <div><h2 className="nxi-h2">{head.title}</h2><p>{head.subtitle}</p></div>
            {section !== "consumo" && <Button variant="primary"
              onClick={() => void save()}
              disabled={saving || loading}
            >
              <Save size={16} />
              {saving ? "Salvando..." : "Salvar configurações"}
            </Button>}
          </header>

          {error && <p role="alert" className="nxi-alert is-error">{error}</p>}
          {message && <p role="status" className="nxi-alert is-success">{message}</p>}

          {section === "consumo" && currentUser && <NoraUsageSettings userId={currentUser.id} onOpenAdmin={showAdmin ? onOpenAdmin : undefined} />}

          {showAdmin && (
            <section hidden={section !== "admin"} className="nx-card nxi-card-pad flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="nxi-tile is-blue">
                  <ShieldCheck size={19} />
                </span>
                <div>
                  <h2 className="nxi-card-title">Painel administrativo</h2>
                  <p className="nxi-card-sub">
                    Gerencie usuários, planos, equipes e permissões sem sair da sua sessão atual.
                  </p>
                </div>
              </div>
              <Button variant="primary" onClick={onOpenAdmin} className="shrink-0">
                <ShieldCheck size={16} /> Abrir painel Admin
              </Button>
            </section>
          )}

          <div className="nxi-stack" hidden={section !== "aparencia"}>
          <section className="nx-card nxi-card-pad">
            <h3 className="nxi-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}><Palette size={16} /> Tema</h3>
            <div className="flex flex-wrap gap-4" style={{ marginTop: 14 }} role="group" aria-label="Tema do sistema">
              {(["claro", "escuro"] as PerfilTema[]).map((theme) => {
                const Icon = theme === "escuro" ? Moon : Sun;
                const active = profile.tema === theme;
                return (
                  <button
                    key={theme}
                    type="button"
                    aria-pressed={active}
                    onClick={() => updateTheme(theme)}
                    className={`nxi-theme-opt ${active ? "is-active" : ""}`}
                  >
                    <span className="nxi-theme-prev" style={{ display: "block", background: theme === "escuro" ? "#0c0d10" : "#f5f6f8" }}><span style={{ background: theme === "escuro" ? "#16171c" : "#fff" }} /></span>
                    <strong><Icon size={14} /> {theme === "escuro" ? "Escuro" : "Claro"}{active && <Check size={14} style={{ color: "var(--nx-primary)" }} />}</strong>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 18, borderTop: "1px solid var(--nx-border)", paddingTop: 16 }}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={`nxi-tile is-sm ${canCustomizeTheme ? "is-blue" : "is-amber"}`}>
                    {canCustomizeTheme ? <Palette size={17} /> : <LockKeyhole size={17} />}
                  </span>
                  <div>
                    <h3 className="text-[13.5px] font-semibold">Personalização avançada</h3>
                    <p className="nxi-card-sub">
                      Altere apenas as cores, mantendo o layout atual.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canCustomizeTheme && (
                    <Button size="sm"
                     
                      onClick={() =>
                        updateCustomization((customization) => ({
                          ...customization,
                          [profile.tema]: { ...defaultThemeCustomization[profile.tema] },
                        }))
                      }
                     
                    >
                      <RotateCcw size={14} />
                      Restaurar
                    </Button>
                  )}
                  <button
                    type="button"
                    disabled={!canCustomizeTheme}
                    onClick={() =>
                      updateCustomization((customization) => ({
                        ...customization,
                        enabled: !customization.enabled,
                      }))
                    }
                    aria-pressed={customizationEnabled && canCustomizeTheme}
                    className={`nx-btn is-sm ${customizationEnabled && canCustomizeTheme ? "is-primary" : ""}`}
                  >
                    {customizationEnabled && canCustomizeTheme ? "Ativa" : "Ativar"}
                  </button>
                </div>
              </div>

              {!canCustomizeTheme ? (
                <p className="nxi-alert is-warning mt-4">
                  A personalização avançada está disponível no plano Enterprise.
                </p>
              ) : (
                <div className={`mt-4 space-y-4 ${customizationEnabled ? "" : "pointer-events-none opacity-50"}`}>
                  {colorGroups.map((group) => (
                    <div key={group.title}>
                      <p className="mb-3 text-[13px] font-semibold">{group.title}</p>
                      <div className="grid gap-3 md:grid-cols-2">
                        {group.fields.map((field) => (
                          <label key={field.key} className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                            <input
                              type="color"
                              value={activePalette[field.key]}
                              onChange={(event) => updateColor(field.key, event.target.value)}
                              className="h-9 w-11 shrink-0 cursor-pointer rounded-lg border border-[var(--border)] bg-transparent p-1"
                            />
                            <span className="min-w-0 flex-1">
                              <strong className="block text-[13px] font-medium">{field.label}</strong>
                              <small className="block truncate text-xs text-[var(--nx-text-3)]">{field.hint}</small>
                            </span>
                            <code className="nxi-code">{activePalette[field.key]}</code>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="nx-card nxi-card-pad" style={{ paddingTop: 12, paddingBottom: 12 }}>
            <h3 className="nxi-card-title" style={{ paddingTop: 8 }}>Leitura e acessibilidade</h3>
            <p className="nxi-card-sub">As preferências abaixo são aplicadas ao salvar e ficam vinculadas ao seu perfil.</p>
            <div className="nxi-cols" style={{ margin: "14px 0 6px" }}>
              <label className="nxi-label">Estilo do menu
                <select className="nxi-field" value={preferences.navigationStyle} onChange={event => updatePreference("navigationStyle", event.target.value as InterfacePreferences["navigationStyle"])}>
                  <option value="grouped">Menu atual · categorias recolhíveis</option>
                  <option value="classic">Menu antigo · lista completa</option>
                </select>
                <small>Escolha entre os grupos atuais ou a navegação clássica do Norium.</small>
              </label>
              <label className="nxi-label">Tamanho do texto
                <select className="nxi-field" value={preferences.textSize} onChange={event => updatePreference("textSize", event.target.value as InterfacePreferences["textSize"])}>
                  <option value="normal">Padrão</option><option value="large">Grande</option><option value="extra">Extra grande</option>
                </select>
                <small>Amplia textos e elementos dimensionados pela fonte do sistema.</small>
              </label>
            </div>
            <PreferenceToggle label="Reduzir animações" hint="Reduz transições da interface e movimento dos alertas." checked={preferences.reducedMotion} onChange={value => updatePreference("reducedMotion", value)} />
            <PreferenceToggle label="Destacar navegação por teclado" hint="Reforça o contorno do elemento selecionado com Tab." checked={preferences.strongFocus} onChange={value => updatePreference("strongFocus", value)} />
            <PreferenceToggle label="Sublinhar links" hint="Facilita identificar links nos conteúdos e menus." checked={preferences.underlineLinks} onChange={value => updatePreference("underlineLinks", value)} />
            <PreferenceToggle label="Ajuda contextual nas telas" hint="Mostra orientações de uso e sugestões de perguntas para a Nora." checked={preferences.showGuides} onChange={value => updatePreference("showGuides", value)} />
            <div style={{ borderTop: "1px solid var(--nx-border)", padding: "12px 0 8px" }}>
              <Button size="sm" onClick={() => setProfile(current => ({ ...current, interface_preferences: { ...defaultInterfacePreferences } }))}><RotateCcw size={14} /> Restaurar preferências de interface</Button>
            </div>
          </section>
          </div>

            <section className="nx-card nxi-card-pad" hidden={section !== "nora"}>
              <div className="mb-4 flex items-center gap-3">
                <span className="nxi-tile is-sm is-blue"><Bot size={17} /></span>
                <div>
                  <h3 className="nxi-card-title">Nora</h3>
                  <p className="nxi-card-sub">Tom das respostas da sua assistente.</p>
                </div>
              </div>
              <label className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13.5px] font-medium">Nível de sarcasmo</span>
                  <span className="nx-badge is-blue">
                    {profile.configuracoes_nora.sarcasmo}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={profile.configuracoes_nora.sarcasmo}
                  onChange={(event) =>
                    setProfile((current) => ({
                      ...current,
                      configuracoes_nora: { sarcasmo: Number(event.target.value) },
                    }))
                  }
                  className="w-full accent-[var(--primary)]"
                />
              </label>
            </section>

            <div className="nxi-stack" hidden={section !== "notificacoes"}>
            <section className="nx-card nxi-card-pad" style={{ paddingBottom: 8 }}>
              <div className="mb-2 flex items-center gap-3">
                <span className="nxi-tile is-sm is-blue"><Bell size={17} /></span>
                <div>
                  <h3 className="nxi-card-title">Alertas no Norium</h3>
                  <p className="nxi-card-sub">Avisos flutuantes sobre as telas.</p>
                </div>
              </div>
              <PreferenceToggle label="Alertas flutuantes" hint="Exibe novos avisos sobre as telas. O histórico continua disponível na central." checked={preferences.showToasts} onChange={value => updatePreference("showToasts", value)} />
              <PreferenceToggle label="Mostrar prévia dos alertas" hint="Exibe título e descrição nos alertas flutuantes. Desative para mais privacidade." checked={preferences.toastPreview} onChange={value => updatePreference("toastPreview", value)} />
              <label className="nxi-swrow" style={{ flexWrap: "wrap" }}>
                <span className="nxi-swrow-t nx-grow">Posição dos alertas flutuantes</span>
                <select className="nxi-field" style={{ width: 220 }} value={preferences.toastPosition} onChange={event => updatePreference("toastPosition", event.target.value as InterfacePreferences["toastPosition"])}>
                  <option value="top">Canto superior direito</option><option value="bottom">Canto inferior direito</option>
                </select>
              </label>
            </section>

          <section className="nx-card nxi-card-pad is-sm">
            <div className="flex items-center gap-3">
              <SlidersHorizontal size={17} style={{ color: "var(--nx-primary)" }} />
              <div>
                <h3 className="nxi-card-title">Escopo global</h3>
                <p className="nxi-card-sub">
                  Preferências pessoais salvas no seu perfil. Alertas flutuantes não alteram o histórico da central nem as permissões de acesso.
                </p>
              </div>
            </div>
          </section>
          </div>

          {currentUser && (
            <section className="nxi-stack is-sm" hidden={section !== "privacidade"} aria-label="Seus dados e privacidade">
              {section === "privacidade" && <PrivacyStorageCard />}
              <div className="nx-card nxi-card-pad flex flex-wrap items-center gap-3">
                <div className="nx-grow"><h3 className="nxi-card-title">Exportar meus dados</h3><p className="nxi-card-sub">Arquivo compactado com seus dados pessoais e manifesto de integridade.</p></div>
                <Button onClick={() => void exportPersonalData()} disabled={exportingData}>
                  <Download size={15} /> {exportingData ? "Preparando…" : "Exportar meus dados"}
                </Button>
              </div>
              <div className="nx-card nxi-card-pad nxi-danger-card">
                <h3 className="nxi-card-title" style={{ color: "var(--nx-danger)" }}>Excluir minha conta</h3>
                <p className="nxi-card-sub">Ação permanente. Para confirmar, informe sua senha e digite EXCLUIR MINHA CONTA.</p>
                <form className="nxi-cols" style={{ marginTop: 14 }} autoComplete="off" onSubmit={event => event.preventDefault()}>
                  <input type="text" name="username" autoComplete="username" value={currentUser.email || ""} readOnly hidden aria-hidden="true" tabIndex={-1} />
                  <label className="nxi-label">Senha atual
                    <input type="password" name="current-password" autoComplete="current-password" className="nxi-field" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
                  </label>
                  <label className="nxi-label">Digite EXCLUIR MINHA CONTA
                    <input className="nxi-field" name="delete-confirmation" autoComplete="off" value={deletionConfirmation} onChange={event => setDeletionConfirmation(event.target.value)} />
                  </label>
                </form>
                <div className="nxi-actions is-end" style={{ marginTop: 14 }}>
                  <Button
                    variant="danger"
                    onClick={() => void deleteAccount()}
                    disabled={deletingAccount || !currentPassword || deletionConfirmation !== "EXCLUIR MINHA CONTA"}
                  >
                    <Trash2 size={15} /> {deletingAccount ? "Excluindo…" : "Excluir minha conta"}
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}

function PreferenceToggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="nxi-swrow">
    <span className="nx-grow"><span className="nxi-swrow-t">{label}</span><span className="nxi-swrow-d">{hint}</span></span>
    <input type="checkbox" className="nxi-switch" checked={checked} onChange={event => onChange(event.target.checked)} />
  </label>;
}
