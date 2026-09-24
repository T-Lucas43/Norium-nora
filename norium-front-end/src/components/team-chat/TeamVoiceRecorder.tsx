import { useEffect, useRef, useState } from "react";
import { Mic, Send, Trash2 } from "lucide-react";

type TeamVoiceRecorderProps = {
  disabled?: boolean;
  onSend: (file: File) => void;
  onError: (message: string) => void;
};

function preferredAudioMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(type)) || "";
}

function extensionFor(type: string) {
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4")) return "m4a";
  return "webm";
}

export default function TeamVoiceRecorder({ disabled, onSend, onError }: TeamVoiceRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!recording) return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => () => {
    cancelledRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function startRecording() {
    if (disabled || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("Seu navegador não oferece gravação de áudio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const mimeType = preferredAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;
      setSeconds(0);
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => onError("Não foi possível concluir a gravação.");
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        if (cancelledRef.current) return;
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        if (!blob.size) { onError("A gravação ficou vazia. Tente novamente."); return; }
        onSend(new File([blob], `audio-norium-${Date.now()}.${extensionFor(type)}`, { type, lastModified: Date.now() }));
      };
      recorder.start(250);
      setRecording(true);
    } catch (error) {
      onError(error instanceof DOMException && error.name === "NotAllowedError" ? "Autorize o microfone para gravar áudio." : "Não foi possível acessar o microfone.");
    }
  }

  function finish(cancel: boolean) {
    cancelledRef.current = cancel;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  if (!recording) {
    return <button type="button" className="team-icon-button" disabled={disabled} onClick={() => void startRecording()} aria-label="Gravar áudio" title="Gravar áudio"><Mic size={18} /></button>;
  }

  return (
    <div className="team-voice-recording" role="status" aria-label="Gravação de áudio em andamento">
      <span><i /> {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</span>
      <button type="button" onClick={() => finish(true)} aria-label="Cancelar gravação" title="Cancelar"><Trash2 size={16} /></button>
      <button type="button" className="is-send" onClick={() => finish(false)} aria-label="Enviar áudio" title="Enviar áudio"><Send size={16} /></button>
    </div>
  );
}
