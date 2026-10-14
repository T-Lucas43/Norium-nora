import { useEffect, useRef, type RefObject } from "react";
import { videoSubscriptionInterest, type VideoSubscriptionInterest } from "./media/videoSubscriptionPolicy";

/** Observe rendered tiles, including placeholders; never change audio capture. */
export function useCallVideoInterest(root: RefObject<HTMLElement | null>, callId: string | undefined,
  sharingIds: string[], minimized: boolean, presenting: boolean,
  update: ((interest: VideoSubscriptionInterest) => Promise<void>) | undefined) {
  const latest = useRef({ sharingIds, minimized, presenting, update });
  latest.current = { sharingIds, minimized, presenting, update };
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!callId || !root.current || !update) return;
    const element = root.current;
    const visible = new Set<Element>();
    const observed = new Set<Element>();
    let frame = 0, signature = "", disposed = false;
    const publish = () => {
      frame = 0;
      if (disposed) return;
      const state = latest.current;
      const panel = element.querySelector<HTMLElement>(".team-call-side-panel");
      // On mobile the single side panel covers the stage; IntersectionObserver
      // alone does not account for elements occluded by another element.
      const covered = !!panel && getComputedStyle(panel).position === "absolute";
      const hidden = state.minimized || document.hidden || covered;
      const tiles = (hidden ? [] : [...visible]).filter((tile) => element.contains(tile)
        && !(tile.getAttribute("data-tile") === "screen" && tile.getAttribute("data-watching") === "false")).map((tile) => {
        const rect = tile.getBoundingClientRect();
        return { userId: tile.getAttribute("data-participant") || "", kind: tile.getAttribute("data-tile") === "screen" ? "screen" as const : "camera" as const, width: rect.width, height: rect.height };
      });
      const interest = videoSubscriptionInterest(tiles, state.sharingIds, hidden, state.presenting);
      const next = JSON.stringify(interest);
      if (signature === next) return;
      signature = next;
      void state.update?.(interest).catch(() => { signature = ""; });
    };
    const schedule = () => {
      // Browsers suspend animation frames in hidden tabs. Publish the pause
      // synchronously so a real hidden tab stops receiving video immediately.
      if (document.hidden) { if (frame) cancelAnimationFrame(frame); frame = 0; publish(); }
      else if (!frame) frame = requestAnimationFrame(publish);
    };
    const intersection = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio > 0) visible.add(entry.target); else visible.delete(entry.target);
      schedule();
    }, { threshold: [0, 0.01] });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const discover = () => {
      const tiles = new Set(element.querySelectorAll("[data-participant][data-tile]"));
      for (const tile of observed) if (!tiles.has(tile)) { observed.delete(tile); visible.delete(tile); intersection?.unobserve(tile); resize?.unobserve(tile); }
      for (const tile of tiles) if (!observed.has(tile)) {
        observed.add(tile); intersection?.observe(tile); resize?.observe(tile);
        if (!intersection) visible.add(tile); // Older browsers retain visible media.
      }
      schedule();
    };
    const mutation = new MutationObserver(discover);
    mutation.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-watching"] });
    refresh.current = schedule;
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("resize", schedule);
    discover();
    return () => {
      disposed = true; refresh.current = null;
      if (frame) cancelAnimationFrame(frame);
      mutation.disconnect(); intersection?.disconnect(); resize?.disconnect();
      document.removeEventListener("visibilitychange", schedule); window.removeEventListener("resize", schedule);
    };
  }, [callId, root, update]);
  useEffect(() => { refresh.current?.(); }, [sharingIds, minimized, presenting]);
}
