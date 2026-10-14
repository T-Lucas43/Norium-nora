import { useEffect, useState } from "react";
import { Mic, Square } from "lucide-react";

export default function CallMicrophoneMeter({ deviceId, listenOnly }: { deviceId: string; listenOnly: boolean }) {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    setLevel(0);
    if (listenOnly) { setTesting(false); return; }
    if (!testing) return;
    let disposed = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let frame = 0;
    let previousSample = 0;
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("unavailable");
        stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
        if (disposed) { stream.getTracks().forEach((track) => track.stop()); return; }
        context = new AudioContext();
        await context.resume();
        if (disposed) { void context.close().catch(() => undefined); return; }
        source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const values = new Uint8Array(256);
        const sample = (now: number) => {
          if (disposed) return;
          frame = requestAnimationFrame(sample);
          if (now - previousSample < 100) return;
          previousSample = now;
          analyser.getByteTimeDomainData(values);
          const rms = Math.sqrt(values.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / values.length);
          setLevel(Math.min(100, Math.round(rms * 400)));
        };
        frame = requestAnimationFrame(sample);
      } catch {
        stream?.getTracks().forEach((track) => track.stop());
        source?.disconnect();
        if (context && context.state !== "closed") void context.close().catch(() => undefined);
        if (!disposed) { setError("Não foi possível testar o microfone. Confira o dispositivo e a permissão do navegador."); setTesting(false); }
      }
    })();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") void context.close().catch(() => undefined);
    };
  }, [testing, listenOnly, deviceId]);
  return <section className="team-call-microphone-test">
    <button type="button" disabled={listenOnly} onClick={() => { setError(""); setTesting((current) => !current); }}>{testing && !listenOnly ? <Square size={14} /> : <Mic size={14} />}{testing && !listenOnly ? "Parar teste do microfone" : "Testar microfone"}</button>
    <meter aria-label="Nível do microfone na prévia" min={0} max={100} value={level}>{level}%</meter>
    <small>O teste solicita acesso ao microfone e fica só nesta prévia.</small>
    {error && <p role="alert">{error}</p>}
  </section>;
}
