import { RefreshCw, Settings, Sparkles, X } from "lucide-react";
import { accountInitials } from "../../../features/mail/formatters";
import type { GmailStatus } from "../../../features/mail/types";

type ProfilePopoverProps = {
  status: GmailStatus | null;
  connecting?: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

/** Cartao da conta do Gmail com as acoes de conexao. */
export default function ProfilePopover({
  status,
  connecting = false,
  onClose,
  onOpenSettings,
  onRefresh,
  onConnect,
  onDisconnect,
}: ProfilePopoverProps) {
  return (
    <aside className="nx-mail-layer nx-mail-popover" aria-label="Conta do Gmail">
      <div className="nx-mail-popover-h">
        <div className="nx-mail-popover-av">
          {status?.picture ? (
            <img src={status.picture} alt="Foto do perfil" onError={(event) => { event.currentTarget.style.display = "none"; }} />
          ) : (
            <span>{accountInitials(status)}</span>
          )}
        </div>
        <div>
          <p className="nx-row-t">{status?.name || "Perfil Norium"}</p>
          <p className="nx-faint nx-small">{status?.email || "Gmail não conectado"}</p>
        </div>
        <button type="button" onClick={onClose} className="nx-mail-iconbtn" aria-label="Fechar">
          <X size={16} />
        </button>
      </div>

      <div className="nx-mail-popover-b">
        <button type="button" onClick={onOpenSettings} className="nx-btn is-ghost">
          <Settings size={16} />
          Configurações
        </button>
        <button type="button" onClick={onRefresh} className="nx-btn is-ghost">
          <RefreshCw size={16} />
          Atualizar perfil
        </button>
        <button type="button" onClick={onConnect} disabled={connecting} className="nx-btn is-ghost">
          <Sparkles size={16} />
          {connecting ? "Abrindo Google..." : status?.connected ? "Reconectar Gmail" : "Conectar Gmail"}
        </button>
        <button type="button" onClick={onDisconnect} disabled={!status?.connected} className="nx-btn is-ghost is-danger">
          <X size={16} />
          Sair desta conta
        </button>
      </div>
    </aside>
  );
}
