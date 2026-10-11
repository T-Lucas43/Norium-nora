import { X } from "lucide-react";
import { cn } from "../../../utils/cn";
import type { GmailStatus } from "../../../features/mail/types";

export type MailPreferences = {
  compactMode: boolean;
  groupByCategory: boolean;
  showPreview: boolean;
  autoRefresh: boolean;
};

type MailSettingsDrawerProps = {
  preferences: MailPreferences;
  status: GmailStatus | null;
  connecting?: boolean;
  onPreferenceChange: <K extends keyof MailPreferences>(key: K, value: MailPreferences[K]) => void;
  onRefreshNow: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onClose: () => void;
};

/** Preferencias do Norium Mail e estado da conta conectada. */
export default function MailSettingsDrawer({
  preferences,
  status,
  connecting = false,
  onPreferenceChange,
  onRefreshNow,
  onConnect,
  onDisconnect,
  onClose,
}: MailSettingsDrawerProps) {
  const { compactMode, groupByCategory, showPreview, autoRefresh } = preferences;

  return (
    <div className="nx-mail-layer nx-mail-backdrop" onClick={onClose}>
      <aside className="nx-mail-drawer" onClick={(event) => event.stopPropagation()} aria-label="Ajustes rápidos">
        <div className="nx-mail-layer-h">
          <div>
            <h2>Ajustes rápidos</h2>
            <p>Personalize o Norium Mail</p>
          </div>
          <button type="button" onClick={onClose} className="nx-mail-iconbtn" aria-label="Fechar">
            <X size={16} />
          </button>
        </div>

        <div className="nx-mail-drawer-b">
          <section className="nx-card">
            <div className="nx-card-h"><h3>Densidade</h3></div>
            <div className="nx-card-b">
              <div className="nx-seg nx-mail-seg-full">
                <button
                  type="button"
                  aria-pressed={!compactMode}
                  onClick={() => onPreferenceChange("compactMode", false)}
                  className={cn(!compactMode && "is-active")}
                >
                  Padrão
                </button>
                <button
                  type="button"
                  aria-pressed={compactMode}
                  onClick={() => onPreferenceChange("compactMode", true)}
                  className={cn(compactMode && "is-active")}
                >
                  Compacta
                </button>
              </div>
            </div>
          </section>

          <section className="nx-card">
            <div className="nx-card-h"><h3>Caixa de entrada</h3></div>
            <div className="nx-card-b">
              <ToggleRow checked={groupByCategory} label="Agrupar por categorias" onChange={(v) => onPreferenceChange("groupByCategory", v)} />
              <ToggleRow checked={showPreview} label="Mostrar texto de prévia" onChange={(v) => onPreferenceChange("showPreview", v)} />
            </div>
          </section>

          <section className="nx-card">
            <div className="nx-card-h"><h3>Sincronização</h3></div>
            <div className="nx-card-b">
              <ToggleRow checked={autoRefresh} label="Atualizar automaticamente a cada 45s" onChange={(v) => onPreferenceChange("autoRefresh", v)} />
              <button type="button" onClick={onRefreshNow} disabled={!status?.connected} className="nx-btn is-sm">
                Atualizar agora
              </button>
            </div>
          </section>

          <section className="nx-card">
            <div className="nx-card-h"><h3>Conta Gmail</h3></div>
            <div className="nx-card-b">
              <p className="nx-row-t" style={{ overflowWrap: "anywhere" }}>{status?.connected ? status.email : "Desconectada"}</p>
              <p className="nx-faint nx-small">
                {status?.lastSync
                  ? `Última sincronização: ${new Date(status.lastSync).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`
                  : "Aguardando autorização"}
              </p>
              <div className="nx-grid-2" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <button type="button" onClick={onConnect} disabled={connecting} className="nx-btn is-sm">
                  {connecting ? "Abrindo Google..." : "Reconectar"}
                </button>
                <button type="button" onClick={onDisconnect} disabled={!status?.connected} className="nx-btn is-sm is-danger">
                  Desconectar
                </button>
              </div>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function ToggleRow({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <label className="nx-mail-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
