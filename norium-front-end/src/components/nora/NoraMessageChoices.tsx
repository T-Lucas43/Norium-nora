import { useRef, useState } from "react";
import "./noraChoices.css";

function choicesForMessage(text: string, status = "") {
  const value = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/cancelad|executad|concluid|enviado/.test(status)) return [];
  if (/copia.*\(cc|copia oculta|anexar|algum.*anexo/.test(value)) return [{ label: "Pular esta etapa", value: "pular" }];
  if (/para qual|qual (?:vai ser|mensagem|tema|titulo|cliente|projeto|data|horario)/.test(value)) return [];
  if (/posso|continuar|confirmar|preparar|deseja|quer que|gostaria|\?\s*$/.test(value) || /coletando|precisa_dados|aguardando/.test(status)) {
    return [{ label: "Continuar", value: "sim" }, { label: "Não continuar", value: "cancelar" }];
  }
  return [];
}

export default function NoraMessageChoices({ text, status, selected, disabled, onChoose }: {
  text: string; status?: string; selected?: string; disabled: boolean; onChoose: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState("");
  const busy = useRef(false);
  const choices = choicesForMessage(text, status);
  if (!choices.length && !/\?/.test(text) && !/coletando|precisa_dados/.test(status || "")) return null;
  async function choose(value: string) {
    if (busy.current || disabled || selected || !value.trim()) return;
    busy.current = true;
    try { await onChoose(value.trim()); } finally { busy.current = false; }
  }
  return <div className="nora-inline-choices" aria-label="Responder à Nora">
    {selected ? <p role="status">Resposta registrada: {selected}</p> : <>
      <div className="nora-inline-options">
        {choices.map((choice) => <button key={choice.value} type="button" disabled={disabled} onClick={() => void choose(choice.value)}>{choice.label}</button>)}
        <button type="button" disabled={disabled} aria-expanded={editing} onClick={() => setEditing(!editing)}>Escrever outra opção</button>
      </div>
      {editing && <form onSubmit={(event) => { event.preventDefault(); void choose(answer); }}>
        <label>O que você prefere?<textarea maxLength={4000} value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={disabled} autoFocus /></label>
        <button type="submit" disabled={disabled || !answer.trim()}>Enviar resposta</button>
      </form>}
    </>}
  </div>;
}
