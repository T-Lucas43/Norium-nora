import { useEffect, useState } from "react";
import { updateSpeakerCandidate } from "./callStageLayout";

const EMPTY = { speakerId: null as string | null, speakingIds: [] as string[], recentSpeakers: [] as string[], localLevel: 0 };

/** Local amplitude only: no capture request, recording, network or transcript. */
export function useCallSpeakers(remoteStreams: Array<{ userId: string; stream: MediaStream }>, localStream: MediaStream | null, selfId: string, muted: boolean, callId?: string) {
  const [state, setState] = useState(EMPTY);
  useEffect(() => {
    setState(EMPTY);
    if (!callId || typeof AudioContext === "undefined") return;
    let context: AudioContext;
    try { context = new AudioContext(); } catch { return; }
    const sources: MediaStreamAudioSourceNode[] = [];
    const analysers: Array<{ id: string; node: AnalyserNode; data: Uint8Array<ArrayBuffer> }> = [];
    for (const item of [...remoteStreams, ...(localStream && !muted ? [{ userId: selfId, stream: localStream }] : [])]) {
      // The other tracks can contain presentation audio; they are not speakers.
      const track = item.stream.getAudioTracks?.().find((track) => track.contentHint !== "music" && track.readyState !== "ended");
      if (!track) continue;
      try {
        const source = context.createMediaStreamSource(new MediaStream([track]));
        const node = context.createAnalyser();
        node.fftSize = 256;
        source.connect(node);
        sources.push(source);
        analysers.push({ id: item.userId, node, data: new Uint8Array(256) });
      } catch { /* A track can disappear during reconnection. */ }
    }
    let candidate: ReturnType<typeof updateSpeakerCandidate> = null;
    let previousSample = 0;
    let lastSpeech = 0;
    let frame = 0;
    const resume = () => { if (context.state === "suspended") void context.resume().catch(() => undefined); };
    const sample = (now: number) => {
      frame = requestAnimationFrame(sample);
      if (document.hidden || now - previousSample < 200) return;
      previousSample = now;
      const levels = analysers.map(({ id, node, data }) => {
        node.getByteTimeDomainData(data);
        const level = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
        return { id, level };
      });
      const speakingIds = levels.filter((item) => item.level > 0.035).map((item) => item.id);
      const loudest = levels.filter((item) => item.level > 0.035).sort((a, b) => b.level - a.level)[0]?.id || null;
      candidate = updateSpeakerCandidate(candidate, loudest, now);
      if (loudest) lastSpeech = now;
      const qualified = candidate && now - candidate.since >= 1500 ? candidate.id : null;
      const localLevel = Math.min(100, Math.round((levels.find((item) => item.id === selfId)?.level || 0) * 400));
      setState((previous) => {
        const speakerId = qualified || (now - lastSpeech > 6000 ? null : previous.speakerId);
        const recentSpeakers = qualified ? [qualified, ...previous.recentSpeakers.filter((id) => id !== qualified)].slice(0, 12) : previous.recentSpeakers;
        if (speakerId === previous.speakerId && speakingIds.join() === previous.speakingIds.join() && localLevel === previous.localLevel && recentSpeakers.join() === previous.recentSpeakers.join()) return previous;
        return { speakerId, speakingIds, recentSpeakers, localLevel };
      });
    };
    frame = requestAnimationFrame(sample);
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    resume();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      sources.forEach((source) => source.disconnect());
      analysers.forEach(({ node }) => node.disconnect());
      void context.close().catch(() => undefined);
    };
  }, [remoteStreams, localStream, selfId, muted, callId]);
  return state;
}
