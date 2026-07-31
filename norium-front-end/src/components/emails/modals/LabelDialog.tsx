import { Loader2, Plus, X } from "lucide-react";
import Button from "../../shared/Button";

type LabelDialogProps = {
  name: string;
  saving: boolean;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
};

/** Criacao de marcador do Gmail. */
export default function LabelDialog({ name, saving, onNameChange, onSubmit, onClose }: LabelDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[90] grid place-items-center bg-black/65 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        onClick={(event) => event.stopPropagation()}
        className="mail-modal w-full max-w-md overflow-hidden rounded-lg border border-white/12 bg-[#0C0E10] shadow-[0_24px_80px_rgba(0,0,0,0.72)]"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-base font-black">Novo marcador</h2>
            <p className="mt-1 text-xs font-semibold text-white/45">Organize mensagens sem sair do Norium Mail.</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={onClose}
            className="mail-hover hover:bg-white/7"
            aria-label="Fechar"
          >
            <X size={16} />
          </Button>
        </div>
        <div className="p-5">
          <label className="grid gap-2 text-xs font-bold text-white/65">
            Nome do marcador
            <input
              autoFocus
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="Ex.: Clientes prioritarios"
              maxLength={100}
              className="mail-input h-11 rounded-lg border border-white/12 bg-black/25 px-3 text-sm text-white outline-none focus:border-cyan-400/60"
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={onClose} className="mail-hover border-white/12 text-white/65 hover:bg-white/7">
              Cancelar
            </Button>
            <Button
              variant="ghost"
              type="submit"
              disabled={!name.trim() || saving}
              className="mail-primary bg-[#0EA5E9]"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              Criar marcador
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
