import {
  Camera,
  CloudSun,
  Languages,
  Lock,
  LogOut,
  Save,
  ShieldCheck,
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
import Button from "../shared/Button";
import EmailPreferences from "./EmailPreferences";
import SessionDevices from "./SessionDevices";
import AvatarImage from "./AvatarImage";
import "../../styles/screens/inteligencia-equipe-conta.css";
import SettingsNav, { storeSettingsSection } from "../settings/SettingsNav";

type ProfileSettingsProps = {
  userId?: string;
  currentUser?: NoriumUser | null;
  onSaved: (profile: PerfilOperador) => void;
  onLogout?: () => void;
  onOpenAdmin?: () => void;
  onNavigate?: (tab: string) => void;
};

export default function ProfileSettings({
  userId = "primary",
  currentUser,
  onSaved,
  onLogout,
  onOpenAdmin,
  onNavigate,
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

  const roleLine = [currentUser?.jobTitle, currentUser?.role === "owner" ? "Principal" : currentUser ? "Membro" : ""].filter(Boolean).join(" · ");

  return (
    <section className="nx-page nxi-screen">
      <div className="nxi-cfg">
      <SettingsNav
        active="perfil"
        showPrivacy={Boolean(currentUser)}
        showAdmin={Boolean(currentUser?.systemAdmin && onOpenAdmin)}
        onSelect={(next) => { if (next === "perfil") return; storeSettingsSection(next); onNavigate?.("Configurações"); }}
      />
      <div className="nxi-cfg-main">
      <header className="nxi-cfg-head">
        <div>
          <h2 className="nxi-h2">Meu perfil</h2>
          <p>Como você aparece para a equipe e para os clientes.</p>
        </div>
        <div className="nxi-actions">
          {onLogout && (
            <Button variant="danger" onClick={onLogout}>
              <LogOut size={16} />
              Sair
            </Button>
          )}
          <Button variant="primary" onClick={() => void save()} disabled={saving || loading}>
            <Save size={16} />
            {saving ? "Salvando..." : "Salvar perfil"}
          </Button>
        </div>
      </header>

      <div className="nxi-stack" style={{ maxWidth: 1080 }}>
        <section className="nx-card flex flex-wrap items-center gap-5" style={{ padding: 22 }}>
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
            className="nxi-avatar-btn"
            title="Escolher foto da galeria"
            aria-label="Escolher foto da galeria"
          >
            <AvatarImage src={profile.fotoUrl} name={profile.nome} size={88} />
            <span className="nxi-avatar-cam"><Camera size={15} /></span>
          </button>
          <div className="min-w-0 flex-1">
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, overflowWrap: "anywhere" }}>{profile.nome}</h2>
            <p className="nx-muted" style={{ margin: "2px 0 0", overflowWrap: "anywhere" }}>{currentUser?.email || "Operador Norium"}{roleLine ? ` · ${roleLine}` : ""}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="nx-badge is-green"><ShieldCheck size={12} /> Conta protegida pelo Norium</span>
            </div>
          </div>
          <div className="nxi-actions">
            <Button variant="primary" size="sm" onClick={() => photoInputRef.current?.click()}>
              Alterar foto
            </Button>
            {Boolean(profile.fotoUrl?.trim()) && (
              <Button size="sm" onClick={() => setProfile((current) => ({ ...current, fotoUrl: "" }))}>
                Remover
              </Button>
            )}
          </div>
        </section>

        <section className="nx-card" style={{ padding: 22 }}>
          <h2 className="nxi-card-title" style={{ marginBottom: 16 }}>Dados do operador</h2>
          <div className="nxi-cols">
            <label className="nxi-label">
              Nome
              <input
                value={profile.nome}
                onChange={(event) => setProfile((current) => ({ ...current, nome: event.target.value }))}
                name="nome"
                autoComplete="name"
                className="nxi-field"
              />
            </label>

            <label className="nxi-label">
              E-mail
              <span className="nxi-search" style={{ color: "var(--nx-text-2)" }}><Lock size={14} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentUser?.email || "E-mail não informado"}</span></span>
            </label>

            <label className="nxi-label">
              Idioma
              <span className="nxi-search">
                <Languages size={15} />
                <select
                  value={profile.idioma}
                  onChange={(event) => setProfile((current) => ({ ...current, idioma: event.target.value }))}
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                  style={{ color: "var(--nx-text)", border: 0 }}
                >
                  <option value="pt-BR">Português (Brasil)</option>
                  <option value="en-US">English (US)</option>
                  <option value="es-ES">Español</option>
                </select>
              </span>
            </label>

            <label className="nxi-label">
              CEP (para o clima no painel)
              <span className="nxi-search">
                <CloudSun size={15} />
                <input
                  value={profile.cep}
                  onChange={(event) => setProfile((current) => ({ ...current, cep: event.target.value }))}
                  placeholder="00000-000"
                  name="cep"
                  autoComplete="postal-code"
                />
              </span>
            </label>

            <label className="nxi-label" style={{ gridColumn: "1 / -1" }}>
              URL da foto
              <input
                value={profile.fotoUrl}
                onChange={(event) => setProfile((current) => ({ ...current, fotoUrl: event.target.value }))}
                placeholder="https://... ou use Alterar foto"
                type="url"
                name="foto-url"
                autoComplete="off"
                className="nxi-field"
              />
            </label>
          </div>
        </section>

        <section className="nx-card nxi-card-pad is-sm">
          <h2 className="nxi-card-title">Preferências e aparência agora ficam em Configurações</h2>
          <p className="nxi-card-sub" style={{ lineHeight: 1.5 }}>
            O perfil mantém apenas seus dados pessoais. Tema, personalização visual e comportamento da Nora possuem uma tela própria.
          </p>
        </section>

        {error && <p className="nxi-alert is-error">{error}</p>}
        {message && <p className="nxi-alert is-success">{message}</p>}

        <EmailPreferences key={userId} />
        <SessionDevices key={`sessions:${userId}`} email={currentUser?.email} />
      </div>
      </div>
      </div>
    </section>
  );
}
