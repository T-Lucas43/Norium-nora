import { RefreshCw, Settings, Sparkles, X } from "lucide-react";
import Button from "../../shared/Button";
import { accountInitials } from "../../../features/mail/formatters";
import type { GmailStatus } from "../../../features/mail/types";

type ProfilePopoverProps = {
  status: GmailStatus | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

/** Cartao da conta do Gmail com as acoes de conexao. */
export default function ProfilePopover({
  status,
  onClose,
  onOpenSettings,
  onRefresh,
  onConnect,
  onDisconnect,
}: ProfilePopoverProps) {
  return (
    <div className="fixed right-6 top-24 z-50 w-[340px] max-w-[calc(100vw-48px)]">
      <aside className="mail-modal overflow-hidden rounded-lg border border-white/12 bg-[#18181B] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-white/10 p-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#4A3B8F] text-base font-black">
            {status?.picture ? (
              <img src={status.picture} alt="Foto do perfil" className="h-full w-full object-cover" />
            ) : (
              <span>{accountInitials(status)}</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{status?.name || "Perfil Norium"}</p>
            <p className="truncate text-xs font-semibold text-white/45">{status?.email || "Gmail nao conectado"}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={onClose}
            className="mail-hover ml-auto hover:bg-white/7"
            aria-label="Fechar"
          >
            <X size={16} />
          </Button>
        </div>

        <div className="grid gap-2 p-3">
          <Button variant="ghost" onClick={onOpenSettings} className="mail-hover hover:bg-white/7">
            <Settings size={16} />
            Configuracoes
          </Button>
          <Button variant="ghost" onClick={onRefresh} className="mail-hover hover:bg-white/7">
            <RefreshCw size={16} />
            Atualizar perfil
          </Button>
          <Button variant="ghost" onClick={onConnect} className="mail-hover hover:bg-white/7">
            <Sparkles size={16} />
            {status?.connected ? "Reconectar Gmail" : "Conectar Gmail"}
          </Button>
          <Button
            variant="danger"
            onClick={onDisconnect}
            disabled={!status?.connected}
            className="text-red-400 hover:bg-red-500/10"
          >
            <X size={16} />
            Sair desta conta
          </Button>
        </div>
      </aside>
    </div>
  );
}
