import { useEffect, useMemo, useRef, useState } from "react";
import { Volume2 } from "lucide-react";

function TrackAudio({ tracks, label, volume, muted, sinkId }: {
  tracks: MediaStreamTrack[]; label: string; volume: number; muted: boolean; sinkId: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const gainRef = useRef<GainNode | null>(null);
  const retryRef = useRef<() => void>(() => {});
  const settingsRef = useRef({ volume, muted });
  settingsRef.current = { volume, muted };
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    const activeTracks = tracks.filter((track) => track.readyState !== "ended");
    if (!audio || !activeTracks.length) return;
    let context: AudioContext | null = null;
    let destination: MediaStreamAudioDestinationNode | null = null;
    let sources: MediaStreamAudioSourceNode[] = [];
    let receivers = activeTracks.map((track) => {
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
      sources = activeTracks.map((track) => {
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
      audio.srcObject = new MediaStream(activeTracks);
      audio.volume = Math.min(1, settingsRef.current.volume / 100);
    }
    audio.muted = settingsRef.current.muted;
    const play = () => { void (async () => {
      try {
        if (context?.state === "suspended") await context.resume();
        await Promise.all(receivers.map((receiver) => receiver.play()));
        await audio.play();
        if (!disposed) setBlocked(false);
      } catch { if (!disposed) setBlocked(true); }
    })(); };
    retryRef.current = play;
    play();
    activeTracks.forEach((track) => track.addEventListener("unmute", play));
    window.addEventListener("pointerdown", play);
    window.addEventListener("keydown", play);
    return () => {
      disposed = true;
      retryRef.current = () => {};
      window.removeEventListener("pointerdown", play);
      window.removeEventListener("keydown", play);
      activeTracks.forEach((track) => track.removeEventListener("unmute", play));
      audio.srcObject = null;
      receivers.forEach((receiver) => { receiver.srcObject = null; });
      sources.forEach((source) => source.disconnect());
      gainRef.current?.disconnect();
      gainRef.current = null;
      destination?.stream.getTracks().forEach((track) => track.stop());
      if (context) void context.close().catch(() => undefined);
    };
  }, [tracks]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = muted;
    if (gainRef.current) gainRef.current.gain.value = muted ? 0 : volume / 100;
    else audio.volume = Math.min(1, volume / 100);
  }, [volume, muted]);

  useEffect(() => {
    const audio = audioRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (audio?.setSinkId) void audio.setSinkId(sinkId).catch(() => undefined);
  }, [sinkId]);

  return <><audio ref={audioRef} autoPlay aria-label={label} />
    {blocked && !muted && <button type="button" onClick={() => retryRef.current()} className="team-call-enable-audio absolute bottom-16 left-1/2 z-30 -translate-x-1/2 rounded-full px-4 py-2 text-xs font-black" aria-label={`Ativar ${label.toLowerCase()}`}><Volume2 size={15} /> Ativar áudio</button>}
  </>;
}

/** O primeiro canal recebido é o microfone; os demais são o áudio da tela. */
export default function ParticipantAudio({ stream, name, volume, screenVolume, microphoneMuted, screenMuted, outputMuted, sinkId }: {
  stream: MediaStream; name: string; volume: number; screenVolume?: number; microphoneMuted: boolean; screenMuted: boolean; outputMuted: boolean; sinkId: string;
}) {
  const tracks = useMemo(() => stream.getAudioTracks(), [stream]);
  const screenTracks = useMemo(() => {
    const identified = tracks.filter((track) => track.contentHint === "music");
    return identified.length ? identified : tracks.slice(1);
  }, [tracks]);
  const microphoneTracks = useMemo(() => {
    const identifiedScreenIds = new Set(screenTracks.map((track) => track.id));
    return tracks.filter((track) => !identifiedScreenIds.has(track.id)).slice(0, 1);
  }, [screenTracks, tracks]);
  return <>
    <TrackAudio tracks={microphoneTracks} label={`Microfone de ${name}`} volume={volume} muted={outputMuted || microphoneMuted} sinkId={sinkId} />
    <TrackAudio tracks={screenTracks} label={`Áudio da transmissão de ${name}`} volume={screenVolume ?? volume} muted={outputMuted || screenMuted} sinkId={sinkId} />
  </>;
}
