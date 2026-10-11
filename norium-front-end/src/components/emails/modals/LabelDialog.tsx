import { Loader2, Plus, X } from "lucide-react";

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
    <div className="nx-mail-layer nx-mail-dialog-wrap" onClick={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        onClick={(event) => event.stopPropagation()}
        className="nx-mail-dialog"
        aria-label="Novo marcador"
      >
        <div className="nx-mail-layer-h">
          <div>
            <h2>Novo marcador</h2>
            <p>Organize mensagens sem sair do Norium Mail.</p>
          </div>
          <button type="button" onClick={onClose} className="nx-mail-iconbtn" aria-label="Fechar">
            <X size={16} />
          </button>
        </div>
        <div className="nx-mail-dialog-b">
          <label className="nx-mail-label">
            Nome do marcador
            <input
              autoFocus
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="Ex.: Clientes prioritários"
              maxLength={100}
            />
          </label>
          <div className="nx-mail-actions-end">
            <button type="button" onClick={onClose} className="nx-btn">
              Cancelar
            </button>
            <button type="submit" disabled={!name.trim() || saving} className="nx-btn is-primary">
              {saving ? <Loader2 size={15} className="nx-mail-spin" /> : <Plus size={15} />}
              Criar marcador
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
