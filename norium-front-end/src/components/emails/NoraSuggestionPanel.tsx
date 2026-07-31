import Button from "../shared/Button";

/** Instrucao fixa do botao "Refazer" - reescreve mantendo o sentido. */
const REFAZER_INSTRUCAO = "Refaca a resposta com outra abordagem, mantendo o sentido e sendo mais precisa.";

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
    <div className="border-t border-cyan-300/15 bg-cyan-400/[0.06] p-3">
      <div className="rounded-xl border border-cyan-300/20 bg-slate-950/25 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-cyan-200">Sugestao da Nora</p>
            <p className="text-xs font-semibold text-white/50">Revise antes de colocar no e-mail.</p>
          </div>
          <Button onClick={onDiscard} className="border-white/10 py-1 text-white/55 hover:bg-white/7">
            Descartar
          </Button>
        </div>

        <textarea
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          aria-label="Texto sugerido pela Nora"
          className="h-36 w-full resize-none rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-medium leading-6 text-white outline-none"
        />

        <div className="mt-3 grid gap-2">
          <input
            value={instruction}
            onChange={(event) => onInstructionChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && instruction.trim()) onRegenerate(instruction);
            }}
            placeholder="Ex: deixe mais curto, mais firme, acrescente que retorno amanha..."
            className="h-10 rounded-lg border border-white/10 bg-black/20 px-3 text-xs font-semibold text-white outline-none placeholder:text-white/35"
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={onAccept} className="mail-primary bg-[#0EA5E9] py-2">
              Aceitar sugestao
            </Button>
            <Button
              onClick={() => onRegenerate(REFAZER_INSTRUCAO)}
              disabled={busy}
              className="mail-hover border-white/12 py-2 text-white/75 hover:bg-white/7"
            >
              Refazer
            </Button>
            <Button
              onClick={() => onRegenerate(instruction)}
              disabled={busy || !instruction.trim()}
              className="mail-hover border-cyan-400/25 py-2 text-cyan-200 hover:bg-cyan-400/10"
            >
              Aplicar ajuste
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
