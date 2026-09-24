import { useRef, useState } from "react";
import { Gauge } from "lucide-react";

const PLAYBACK_RATES = [1, 1.5, 2];

export default function TeamAudioControls({ src, label }: { src: string; label: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [rateIndex, setRateIndex] = useState(0);

  function cycleRate() {
    const nextIndex = (rateIndex + 1) % PLAYBACK_RATES.length;
    setRateIndex(nextIndex);
    if (audioRef.current) audioRef.current.playbackRate = PLAYBACK_RATES[nextIndex];
  }

  return (
    <div className="team-audio-player">
      <audio ref={audioRef} src={src} controls preload="metadata" aria-label={label} />
      <button type="button" onClick={cycleRate} aria-label={`Velocidade do áudio ${PLAYBACK_RATES[rateIndex]}x`} title="Alterar velocidade">
        <Gauge size={14} /> {PLAYBACK_RATES[rateIndex]}x
      </button>
    </div>
  );
}
