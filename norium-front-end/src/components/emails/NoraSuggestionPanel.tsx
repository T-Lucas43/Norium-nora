import NoraAvatar from "../layout/NoraAvatar";

/** Instrucao fixa do botao "Refazer" - reescreve mantendo o sentido. */
const REFAZER_INSTRUCAO = "Refaça a resposta com outra abordagem, mantendo o sentido e sendo mais precisa.";

type NoraSuggestionPanelProps = {
  text: string;
  instruction: string;
  /** Alvo em geracao; trava os botoes enquanto houver um. */
  busy: boolean;
  onTextChange: (value: string) => void;
  onInstructionChange: (value: string) => void;
  onAccept: () => void;
  onDiscard: () => void;
  onRegenerate: (instruction: string) => void;
};

/** Sugestao de texto da Nora, editavel antes de entrar no e-mail. */
export default function NoraSuggestionPanel({
  text,
  instruction,
  busy,
  onTextChange,
  onInstructionChange,
  onAccept,
  onDiscard,
  onRegenerate,
}: NoraSuggestionPanelProps) {
  return (
    <div className="nx-mail-suggest">
      <div className="nx-mail-suggest-h">
        <NoraAvatar className="rounded-full" />
        <div className="nx-grow">
          <b>Sugestão da Nora</b>
          <p>Revise antes de colocar no e-mail.</p>
        </div>
      </div>

      <textarea
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        aria-label="Texto sugerido pela Nora"
        className="nx-mail-textarea"
      />

      <label className="nx-input">
        <input
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && instruction.trim()) onRegenerate(instruction);
          }}
          aria-label="Ajuste para a Nora"
          placeholder="Ex.: deixe mais curto, mais firme, acrescente que retorno amanhã..."
        />
      </label>

      <div className="nx-mail-suggest-actions">
        <button type="button" onClick={onAccept} className="nx-btn is-sm is-primary">
          Aceitar sugestão
        </button>
        <button
          type="button"
          onClick={() => onRegenerate(REFAZER_INSTRUCAO)}
          disabled={busy}
          className="nx-btn is-sm"
        >
          Refazer
        </button>
        <button
          type="button"
          onClick={() => onRegenerate(instruction)}
          disabled={busy || !instruction.trim()}
          className="nx-btn is-sm"
        >
          Aplicar ajuste
        </button>
        <button type="button" onClick={onDiscard} className="nx-btn is-sm is-ghost">
          Descartar
        </button>
      </div>
    </div>
  );
}
