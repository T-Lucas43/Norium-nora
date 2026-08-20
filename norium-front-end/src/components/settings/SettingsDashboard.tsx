import {
  Bell,
  Bot,
  Check,
  LockKeyhole,
  Moon,
  Palette,
  RotateCcw,
  Save,
  Settings2,
  SlidersHorizontal,
  Sun,
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

type SettingsDashboardProps = {
  userId?: string;
  currentUser?: NoriumUser | null;
  onSaved: (profile: PerfilOperador) => void;
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
}: SettingsDashboardProps) {
  const [profile, setProfile] = useState<PerfilOperador>(createDefaultProfile);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const canCustomizeTheme = Boolean(currentUser?.systemAdmin || currentUser?.plan === "enterprise");
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

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await saveOperatorProfile(userId, profile);
      setProfile(saved);
      applyNoriumTheme(saved.tema, canCustomizeTheme ? saved.tema_personalizado : undefined);
      onSaved(saved);
      setMessage("Configurações salvas e aplicadas em todas as telas.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar configurações.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-[var(--background)] text-[var(--text)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--primary)]">
            <Settings2 size={22} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold">Configurações</h1>
            <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">
              Aparência, notificações e comportamento da Nora
            </p>
          </div>
        </div>
        <Button variant="primary"
         
          onClick={() => void save()}
          disabled={saving || loading}
         
        >
          <Save size={16} />
          {saving ? "Salvando..." : "Salvar configurações"}
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl space-y-5">
          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="mb-5 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--primary)]/12 text-[var(--primary)]">
                <Palette size={19} />
              </span>
              <div>
                <h2 className="text-sm font-bold">Aparência do sistema</h2>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">
                  O tema escolhido é aplicado imediatamente em todo o Norium.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {(["escuro", "claro"] as PerfilTema[]).map((theme) => {
                const Icon = theme === "escuro" ? Moon : Sun;
                const active = profile.tema === theme;
                return (
                  <button
                    key={theme}
                    type="button"
                    onClick={() => updateTheme(theme)}
                    className={`flex min-h-16 items-center gap-3 rounded-lg border px-4 text-left transition ${
                      active
                        ? "border-[var(--primary)] bg-[var(--primary)]/12"
                        : "border-[var(--border)] bg-[var(--background)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <Icon size={19} className={active ? "text-[var(--primary)]" : ""} />
                    <span className="min-w-0 flex-1">
                      <strong className="block text-sm">{theme === "escuro" ? "Tema escuro" : "Tema claro"}</strong>
                      <small className="text-xs font-semibold text-[var(--text-secondary)]">Padrão Norium</small>
                    </span>
                    {active && <Check size={17} className="text-[var(--primary)]" />}
                  </button>
                );
              })}
            </div>

            <div className={`mt-5 rounded-lg border p-4 ${canCustomizeTheme ? "border-[var(--border)] bg-[var(--background)]" : "border-amber-400/25 bg-amber-400/8"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--primary)]/12 text-[var(--primary)]">
                    {canCustomizeTheme ? <Palette size={18} /> : <LockKeyhole size={18} />}
                  </span>
                  <div>
                    <h3 className="text-sm font-bold">Personalização avançada</h3>
                    <p className="text-xs font-semibold text-[var(--text-secondary)]">
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
                    className={`h-9 rounded-lg px-4 text-xs font-bold ${
                      customizationEnabled && canCustomizeTheme
                        ? "bg-[var(--primary)] text-white"
                        : "border border-[var(--border)]"
                    } disabled:opacity-45`}
                  >
                    {customizationEnabled && canCustomizeTheme ? "Ativa" : "Ativar"}
                  </button>
                </div>
              </div>

              {!canCustomizeTheme ? (
                <p className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/8 p-3 text-xs font-bold text-amber-300">
                  A personalização avançada está disponível no plano Enterprise.
                </p>
              ) : (
                <div className={`mt-4 space-y-4 ${customizationEnabled ? "" : "pointer-events-none opacity-50"}`}>
                  {colorGroups.map((group) => (
                    <div key={group.title} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
                      <p className="mb-3 text-xs font-bold uppercase text-[var(--text-secondary)]">{group.title}</p>
                      <div className="grid gap-3 md:grid-cols-2">
                        {group.fields.map((field) => (
                          <label key={field.key} className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                            <input
                              type="color"
                              value={activePalette[field.key]}
                              onChange={(event) => updateColor(field.key, event.target.value)}
                              className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-[var(--border)] bg-transparent p-1"
                            />
                            <span className="min-w-0 flex-1">
                              <strong className="block text-xs">{field.label}</strong>
                              <small className="block truncate text-xs font-semibold text-[var(--text-secondary)]">{field.hint}</small>
                            </span>
                            <code className="text-xs font-bold text-[var(--text-secondary)]">{activePalette[field.key]}</code>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="mb-5 flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-cyan-500/12 text-cyan-400"><Bot size={19} /></span>
                <div>
                  <h2 className="text-sm font-bold">Nora</h2>
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">Personalidade da sua assistente.</p>
                </div>
              </div>
              <label className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">Nível de sarcasmo</span>
                  <span className="rounded-full bg-[var(--primary)]/12 px-3 py-1 text-xs font-bold text-[var(--primary)]">
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

            <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="mb-5 flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-blue-500/12 text-blue-400"><Bell size={19} /></span>
                <div>
                  <h2 className="text-sm font-bold">Notificações</h2>
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">Alertas visuais e atualizações em tempo real.</p>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                  <span className="text-sm font-bold">Notificações do sistema</span>
                  <span className="rounded-full bg-emerald-500/12 px-3 py-1 text-xs font-bold text-emerald-400">Ativas</span>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                  <span className="text-sm font-bold">Atualizações em tempo real</span>
                  <span className="rounded-full bg-emerald-500/12 px-3 py-1 text-xs font-bold text-emerald-400">Ativas</span>
                </div>
              </div>
            </section>
          </div>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="flex items-center gap-3">
              <SlidersHorizontal size={18} className="text-[var(--primary)]" />
              <div>
                <h2 className="text-sm font-bold">Escopo global</h2>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">
                  Estas configurações são compartilhadas por todas as telas do sistema.
                </p>
              </div>
            </div>
          </section>

          {error && <p className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm font-bold text-red-300">{error}</p>}
          {message && <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm font-bold text-emerald-300">{message}</p>}
        </div>
      </main>
    </section>
  );
}
