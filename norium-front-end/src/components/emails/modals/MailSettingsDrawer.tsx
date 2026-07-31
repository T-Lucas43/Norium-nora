import { X } from "lucide-react";
import Button from "../../shared/Button";
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
  onPreferenceChange,
  onRefreshNow,
  onConnect,
  onDisconnect,
  onClose,
}: MailSettingsDrawerProps) {
  const { compactMode, groupByCategory, showPreview, autoRefresh } = preferences;

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <aside
        className="mail-modal absolute inset-y-0 right-0 flex w-[430px] max-w-[92vw] flex-col border-l border-white/12 bg-[#18181B] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-5">
          <div>
            <h2 className="text-base font-black">Ajustes rapidos</h2>
            <p className="text-xs font-semibold text-white/45">Personalize o Norium Mail</p>
          </div>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose} className="mail-hover hover:bg-white/7" aria-label="Fechar">
            <X size={17} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <section className="mail-card rounded-lg border border-white/10 bg-[#121217] p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-white/45">Densidade</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onPreferenceChange("compactMode", false)}
                className={cn(
                  "h-10 rounded-lg border text-xs font-black",
                  !compactMode ? "border-cyan-300/45 bg-cyan-300/12 text-cyan-100" : "border-white/10 text-white/60 hover:bg-white/7",
                )}
              >
                Padrao
              </button>
              <button
                type="button"
                onClick={() => onPreferenceChange("compactMode", true)}
                className={cn(
                  "h-10 rounded-lg border text-xs font-black",
                  compactMode ? "border-cyan-300/45 bg-cyan-300/12 text-cyan-100" : "border-white/10 text-white/60 hover:bg-white/7",
                )}
              >
                Compacta
              </button>
            </div>
          </section>

          <section className="mail-card rounded-lg border border-white/10 bg-[#121217] p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-white/45">Caixa de entrada</p>
            <div className="mt-3 grid gap-2">
              <ToggleRow checked={groupByCategory} label="Agrupar por categorias" onChange={(v) => onPreferenceChange("groupByCategory", v)} />
              <ToggleRow checked={showPreview} label="Mostrar texto de previa" onChange={(v) => onPreferenceChange("showPreview", v)} />
            </div>
          </section>

          <section className="mail-card rounded-lg border border-white/10 bg-[#121217] p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-white/45">Sincronizacao</p>
            <div className="mt-3 grid gap-2">
              <ToggleRow checked={autoRefresh} label="Atualizar automaticamente a cada 45s" onChange={(v) => onPreferenceChange("autoRefresh", v)} />
              <Button onClick={onRefreshNow} disabled={!status?.connected} className="mail-hover border-white/12">
                Atualizar agora
              </Button>
            </div>
          </section>

          <section className="mail-card rounded-lg border border-white/10 bg-[#121217] p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-white/45">Conta Gmail</p>
            <p className="mt-2 break-all text-sm font-bold">{status?.connected ? status.email : "Desconectada"}</p>
            <p className="mt-1 text-xs font-semibold text-white/45">
              {status?.lastSync
                ? `Ultima sincronizacao: ${new Date(status.lastSync).toLocaleString("pt-BR")}`
                : "Aguardando autorizacao"}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button onClick={onConnect} className="mail-hover border-white/12">Reconectar</Button>
              <Button onClick={onDisconnect} disabled={!status?.connected} className="border-red-500/35 text-red-300">
                Desconectar
              </Button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function ToggleRow({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3 border-b border-white/8 py-2 text-sm font-bold last:border-b-0">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-[var(--mail-primary)]"
      />
    </label>
  );
}
