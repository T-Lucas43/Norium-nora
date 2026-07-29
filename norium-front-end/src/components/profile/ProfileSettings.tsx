import {
  Camera,
  CloudSun,
  Languages,
  LogOut,
  Mail,
  Save,
  ShieldCheck,
  UserCircle2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NoriumUser } from "../../types/auth";
import type { PerfilOperador } from "../../types/omnichannel";
import {
  createDefaultProfile,
  imageFileToProfileDataUrl,
  loadOperatorProfile,
  saveOperatorProfile,
} from "./profileService";

type ProfileSettingsProps = {
  userId?: string;
  currentUser?: NoriumUser | null;
  onSaved: (profile: PerfilOperador) => void;
  onLogout?: () => void;
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] || "N"}${parts[1]?.[0] || ""}`.toUpperCase();
}

export default function ProfileSettings({
  userId = "lucas123",
  currentUser,
  onSaved,
  onLogout,
}: ProfileSettingsProps) {
  const [profile, setProfile] = useState<PerfilOperador>(createDefaultProfile);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const loaded = await loadOperatorProfile(userId);
        if (cancelled) return;
        setProfile(loaded);
        onSaved(loaded);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Falha ao carregar o perfil.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [onSaved, userId]);

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await saveOperatorProfile(userId, profile);
      setProfile(saved);
      onSaved(saved);
      setMessage("Perfil atualizado com sucesso.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar o perfil.");
    } finally {
      setSaving(false);
    }
  }

  async function selectPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setError("");
    setMessage("");
    try {
      const dataUrl = await imageFileToProfileDataUrl(file);
      setProfile((current) => ({ ...current, fotoUrl: dataUrl }));
      setMessage("Foto preparada. Salve o perfil para confirmar.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar a foto.");
    }
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-[var(--background)] text-[var(--text)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--primary)]">
            <UserCircle2 size={23} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold">Meu perfil</h1>
            <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">
              Foto, identificação e dados pessoais do operador
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="flex h-10 items-center gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-4 text-sm font-bold text-red-300 hover:bg-red-500/16"
            >
              <LogOut size={16} />
              Sair
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading}
            className="flex h-10 items-center gap-2 rounded-lg bg-[var(--primary)] px-4 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-50"
          >
            <Save size={16} />
            {saving ? "Salvando..." : "Salvar perfil"}
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[300px_1fr]">
          <aside className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="flex flex-col items-center text-center">
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => void selectPhoto(event)}
              />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="relative mb-4 grid h-28 w-28 place-items-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--background)] text-3xl font-black text-[var(--primary)] transition hover:border-[var(--primary)]"
                title="Escolher foto da galeria"
              >
                {profile.fotoUrl ? (
                  <img src={profile.fotoUrl} alt="Foto do perfil" className="h-full w-full object-cover" />
                ) : (
                  initials(profile.nome)
                )}
                <span className="absolute bottom-1 right-1 grid h-9 w-9 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface)]">
                  <Camera size={16} />
                </span>
              </button>
              <h2 className="text-lg font-bold">{profile.nome}</h2>
              <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                {currentUser?.email || "Operador Norium"}
              </p>

              <div className="mt-5 flex w-full gap-2">
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className="flex-1 rounded-lg bg-[var(--primary)] px-3 py-2 text-xs font-black text-white"
                >
                  Alterar foto
                </button>
                {profile.fotoUrl && (
                  <button
                    type="button"
                    onClick={() => setProfile((current) => ({ ...current, fotoUrl: "" }))}
                    className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-black"
                  >
                    Remover
                  </button>
                )}
              </div>
            </div>

            <div className="mt-6 space-y-3 border-t border-[var(--border)] pt-5 text-xs font-semibold text-[var(--text-secondary)]">
              <div className="flex items-center gap-2"><ShieldCheck size={15} /> Conta protegida pelo Norium</div>
              <div className="flex items-center gap-2"><Mail size={15} /> {currentUser?.email || "E-mail não informado"}</div>
            </div>
          </aside>

          <div className="space-y-5">
            <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
              <h2 className="mb-5 text-sm font-bold uppercase text-[var(--text-secondary)]">
                Dados do operador
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">Nome</span>
                  <input
                    value={profile.nome}
                    onChange={(event) => setProfile((current) => ({ ...current, nome: event.target.value }))}
                    className="h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-semibold outline-none focus:border-[var(--primary)]"
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">CEP para clima</span>
                  <div className="flex h-11 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3">
                    <CloudSun size={16} className="text-[var(--text-secondary)]" />
                    <input
                      value={profile.cep}
                      onChange={(event) => setProfile((current) => ({ ...current, cep: event.target.value }))}
                      placeholder="00000-000"
                      className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
                    />
                  </div>
                </label>

                <label className="space-y-2">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">Idioma</span>
                  <div className="flex h-11 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3">
                    <Languages size={16} className="text-[var(--text-secondary)]" />
                    <select
                      value={profile.idioma}
                      onChange={(event) => setProfile((current) => ({ ...current, idioma: event.target.value }))}
                      className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
                    >
                      <option value="pt-BR">Português (Brasil)</option>
                      <option value="en-US">English (US)</option>
                      <option value="es-ES">Español</option>
                    </select>
                  </div>
                </label>

                <label className="space-y-2 sm:col-span-2">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">URL da foto</span>
                  <input
                    value={profile.fotoUrl}
                    onChange={(event) => setProfile((current) => ({ ...current, fotoUrl: event.target.value }))}
                    placeholder="https://... ou use Alterar foto"
                    className="h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-semibold outline-none focus:border-[var(--primary)]"
                  />
                </label>
              </div>
            </section>

            <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
              <h2 className="text-sm font-bold">Preferências e aparência agora ficam em Configurações</h2>
              <p className="mt-2 text-sm font-semibold leading-6 text-[var(--text-secondary)]">
                O perfil mantém apenas seus dados pessoais. Tema, personalização visual e comportamento da Nora possuem uma tela própria.
              </p>
            </section>

            {error && <p className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm font-bold text-red-300">{error}</p>}
            {message && <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm font-bold text-emerald-300">{message}</p>}
          </div>
        </div>
      </main>
    </section>
  );
}
