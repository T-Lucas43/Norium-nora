export type CallStageLayout = "gallery" | "spotlight" | "presentation";
export type CallLayoutPreference = "auto" | CallStageLayout;

export function readCallLayout(userId: string): CallLayoutPreference {
  try {
    const value = localStorage.getItem(`norium.team-call.layout.${userId}`);
    if (value === "gallery" || value === "spotlight" || value === "presentation") return value;
  } catch { /* Private browsing must not prevent joining. */ }
  return "auto";
}

export function saveCallLayout(userId: string, layout: CallLayoutPreference) {
  try { localStorage.setItem(`norium.team-call.layout.${userId}`, layout); }
  catch { /* The selected layout still applies for this session. */ }
}

export function resolveCallLayout(preference: CallLayoutPreference, hasScreen: boolean, speakerId: string | null, pinned: boolean): CallStageLayout {
  if (preference !== "auto") return preference;
  if (hasScreen) return "presentation";
  return speakerId || pinned ? "spotlight" : "gallery";
}

export function orderCallParticipants(ids: string[], selfId: string, recentSpeakers: string[], hands: Record<string, string>) {
  return [...ids].sort((a, b) => {
    if (a === selfId || b === selfId) return a === b ? 0 : a === selfId ? 1 : -1;
    const recentA = recentSpeakers.indexOf(a);
    const recentB = recentSpeakers.indexOf(b);
    if (recentA !== recentB) return (recentA < 0 ? Infinity : recentA) - (recentB < 0 ? Infinity : recentB);
    if (!!hands[a] !== !!hands[b]) return hands[a] ? -1 : 1;
    return (hands[a] || "").localeCompare(hands[b] || "");
  });
}

/** A short pause is tolerated; stage changes require 1.5 seconds of speech. */
export function updateSpeakerCandidate(previous: { id: string; since: number; lastVoice: number } | null, id: string | null, now: number) {
  if (!id) return previous && now - previous.lastVoice <= 300 ? previous : null;
  return previous?.id === id ? { ...previous, lastVoice: now } : { id, since: now, lastVoice: now };
}
