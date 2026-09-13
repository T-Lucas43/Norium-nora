import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";

/** Mix each incoming track once, then apply the listener's gain before output. */
export default function ParticipantAudio({ stream, name, volume, muted, sinkId }: {
  stream: MediaStream; name: string; volume: number; muted: boolean; sinkId: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const gainRef = useRef<GainNode | null>(null);
  const retryRef = useRef<() => void>(() => {});
  const settingsRef = useRef({ volume, muted });
  settingsRef.current = { volume, muted };
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const tracks = stream.getAudioTracks().filter((track) => track.readyState !== "ended");
    if (!tracks.length) return;
    let context: AudioContext | null = null;
    let destination: MediaStreamAudioDestinationNode | null = null;
    let sources: MediaStreamAudioSourceNode[] = [];
    // Chromium needs a media element consuming each RTP track before exposing
    // decoded samples to Web Audio. Muted elements never duplicate the output.
    let receivers = tracks.map((track) => {
      const receiver = new Audio();
      receiver.muted = true;
      receiver.srcObject = new MediaStream([track]);
      return receiver;
    });
    let disposed = false;
    try {
      context = new AudioContext();
      const gain = context.createGain();
      destination = context.createMediaStreamDestination();
      sources = tracks.map((track) => {
        const source = context!.createMediaStreamSource(new MediaStream([track]));
        source.connect(gain);
        return source;
      });
      gain.connect(destination);
      gain.gain.value = settingsRef.current.muted ? 0 : settingsRef.current.volume / 100;
      gainRef.current = gain;
      audio.srcObject = destination.stream;
      audio.volume = 1;
    } catch {
      sources.forEach((source) => source.disconnect());
      receivers.forEach((receiver) => { receiver.srcObject = null; });
      receivers = [];
      if (context) void context.close().catch(() => undefined);
      context = null;
      audio.srcObject = new MediaStream(tracks);
      audio.volume = Math.min(1, settingsRef.current.volume / 100);
    }
    audio.muted = settingsRef.current.muted;
    const play = () => {
      void (async () => {
        try {
          if (context?.state === "suspended") await context.resume();
          await Promise.all(receivers.map((receiver) => receiver.play()));
          await audio.play();
          if (!disposed) setBlocked(false);
        } catch { if (!disposed) setBlocked(true); }
      })();
    };
    retryRef.current = play;
    play();
    tracks.forEach((track) => track.addEventListener("unmute", play));
    window.addEventListener("pointerdown", play);
    window.addEventListener("keydown", play);
    return () => {
      disposed = true;
      retryRef.current = () => {};
      window.removeEventListener("pointerdown", play);
      window.removeEventListener("keydown", play);
      tracks.forEach((track) => track.removeEventListener("unmute", play));
      audio.srcObject = null;
      receivers.forEach((receiver) => { receiver.srcObject = null; });
      sources.forEach((source) => source.disconnect());
      gainRef.current?.disconnect();
      gainRef.current = null;
      destination?.stream.getTracks().forEach((track) => track.stop());
      if (context) void context.close().catch(() => undefined);
    };
  }, [stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = muted;
    if (gainRef.current) gainRef.current.gain.value = muted ? 0 : volume / 100;
    else audio.volume = Math.min(1, volume / 100);
  }, [volume, muted, stream]);

  useEffect(() => {
    const audio = audioRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (audio?.setSinkId) void audio.setSinkId(sinkId).catch(() => undefined);
  }, [sinkId]);

  return <><audio ref={audioRef} autoPlay aria-label={`Áudio de ${name}`} />
    {blocked && !muted && <button type="button" onClick={() => retryRef.current()} className="team-call-enable-audio absolute bottom-16 left-1/2 z-30 -translate-x-1/2 rounded-full px-4 py-2 text-xs font-black" aria-label={`Ativar áudio de ${name}`}><Volume2 size={15} /> Ativar áudio</button>}
  </>;
}
