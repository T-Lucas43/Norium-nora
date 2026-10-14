export type VideoSubscriptionInterest = {
  hidden: boolean;
  cameras: Array<{ userId: string; width: number; height: number }>;
  screens: Array<{ userId: string; width: number; height: number }>;
  cameraQuality: "low" | "adaptive";
};

export function videoSubscriptionInterest(
  visible: Array<{ userId: string; kind: "camera" | "screen"; width: number; height: number }>,
  sharingIds: string[], hidden: boolean, presenting: boolean,
): VideoSubscriptionInterest {
  const cameras = new Map<string, { userId: string; width: number; height: number }>();
  const screens = new Map<string, { userId: string; width: number; height: number }>();
  if (!hidden) for (const tile of visible) {
    if (!tile.userId || !Number.isFinite(tile.width) || !Number.isFinite(tile.height) || tile.width <= 0 || tile.height <= 0) continue;
    // Mesh has one video source while sharing: the presenter's avatar must
    // not cause subscription to an off-screen presentation.
    if (tile.kind === "camera" && sharingIds.includes(tile.userId)) continue;
    const target = tile.kind === "screen" ? screens : cameras;
    const previous = target.get(tile.userId);
    const width = Math.max(1, Math.min(3840, Math.round(tile.width)));
    const height = Math.max(1, Math.min(2160, Math.round(tile.height)));
    if (!previous || width * height > previous.width * previous.height) target.set(tile.userId, { userId: tile.userId, width, height });
  }
  return { hidden, cameras: [...cameras.values()].sort((a, b) => a.userId.localeCompare(b.userId)),
    screens: [...screens.values()].sort((a, b) => a.userId.localeCompare(b.userId)), cameraQuality: presenting ? "low" : "adaptive" };
}

export function meshVideoInterestForUser(interest: VideoSubscriptionInterest, userId: string) {
  if (interest.hidden) return { receiveVideo: false, quality: "low" as const };
  if (interest.screens.some((tile) => tile.userId === userId)) return { receiveVideo: true, quality: "high" as const };
  return { receiveVideo: interest.cameras.some((tile) => tile.userId === userId), quality: interest.cameraQuality === "low" ? "low" as const : "high" as const };
}
