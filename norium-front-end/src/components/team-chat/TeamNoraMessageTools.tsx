import { useEffect, useState } from "react";
import type { TeamMessage } from "./teamChatTypes";
import type { NoraSource } from "./TeamNoraDialog";

export default function TeamNoraMessageTools({ message, request, onSource, onTask, onSchedule, onAsk, enabled }: {
  message: TeamMessage; request: (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;
  onSource: (source: NoraSource) => void; onTask?: () => void; onSchedule?: () => void; onAsk?: () => void; enabled: boolean;
}) {
  const [transcripts, setTranscripts] = useState<Record<string, { text: string; estimated: boolean }>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setTranscripts({}); setBusy(""); setError(""); }, [message.id, request]);
  const sources = Array.isArray(message.metadata?.noraSources) ? message.metadata.noraSources as NoraSource[] : [];
  async function transcribe(id: string) {
    if (busy) return;
    setBusy(id); setError("");
    try {
      const data = await request(`/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(id)}/transcription`, { method: "POST" });
      const usage = data.usage as { estimated?: boolean } | undefined;
      setTranscripts(current => ({ ...current, [id]: { text: String(data.text || ""), estimated: Boolean(usage?.estimated) } }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao transcrever o áudio."); }
    finally { setBusy(""); }
  }
  return <div className="team-v3-nora-tools">
    {Boolean(message.metadata?.privateNora) && <small>Resposta privada · só você pode ver</small>}
    {sources.length > 0 && <details><summary>Fontes consultadas ({sources.length})</summary>{sources.map((source, index) => <button type="button" className="nx-btn is-sm" key={source.messageId} onClick={() => onSource(source)}>{source.label} · {index+1}</button>)}</details>}
    {enabled && message.senderId === "nora" && <div className="team-v3-presets">{onTask && <button type="button" className="nx-btn is-sm" onClick={onTask}>Revisar tarefa</button>}{onSchedule && <button type="button" className="nx-btn is-sm" onClick={onSchedule}>Revisar agendamento</button>}</div>}
    {enabled && onAsk && <button type="button" className="nx-btn is-sm" onClick={onAsk}>Pedir à Nora sobre isto</button>}
    {enabled && message.attachments.filter(item => item.mimeType.startsWith("audio/")).map(attachment => <section key={attachment.id}>{transcripts[attachment.id] ? <><p>{transcripts[attachment.id].text}</p><small>Transcrição privada · {transcripts[attachment.id].estimated ? "consumo estimado" : "tokens de saída medidos"}</small></> : <><button type="button" className="nx-btn is-sm" disabled={Boolean(busy)} onClick={() => void transcribe(attachment.id)}>{busy === attachment.id ? "Transcrevendo…" : `Transcrever ${attachment.name}`}</button><small>Reserva temporária de 12 mil tokens; o desconto usa o consumo registrado.</small></>}</section>)}
    {error && <p role="alert" className="team-v3-dialog-error">{error}</p>}
  </div>;
}
