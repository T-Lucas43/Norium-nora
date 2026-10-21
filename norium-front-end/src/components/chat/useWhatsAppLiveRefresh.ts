import { useEffect, useRef } from "react";
import { requestScope } from "../../core/api/sessionScope";

export const WHATSAPP_FALLBACK_MS = 120_000;

/** Reuse the application's socket; coalesce bursts without polling every chat. */
export function useWhatsAppLiveRefresh({ active, ownerId, onChange }: {
  active: boolean; ownerId?: string; onChange: (areas: Set<string>) => void;
}) {
  const scope = requestScope();
  const handler = useRef(onChange); handler.current = onChange;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let online = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    const flush = () => {
      timer = undefined;
      if (stopped || requestScope() !== scope || document.hidden) return;
      const areas = new Set(pending); pending.clear();
      if (areas.size) handler.current(areas);
    };
    const queue = (area: string) => {
      pending.add(area);
      if (!timer) timer = setTimeout(flush, 180);
    };
    const event = (raw: Event) => {
      const detail = (raw as CustomEvent).detail;
      online = true;
      queue(typeof detail?.area === "string" ? detail.area : "conversations");
      if (typeof detail?.area !== "string") queue("status");
    };
    const connection = (raw: Event) => {
      const detail = (raw as CustomEvent).detail;
      if (detail?.ownerId !== ownerId) return;
      online = detail.state === "online";
      if (online) { queue("connection"); queue("catalog"); }
    };
    const visible = () => {
      if (document.hidden) return;
      if (pending.size) flush();
      // Catch up after hidden/background operation even if the socket is live.
      queue("conversations");
    };
    const fallback = setInterval(() => {
      if (!document.hidden && !online) { queue("conversations"); queue("status"); queue("connection"); }
    }, WHATSAPP_FALLBACK_MS);
    window.addEventListener("norium:whatsapp-event", event);
    window.addEventListener("norium:omnichannel-connection", connection);
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true; clearInterval(fallback); clearTimeout(timer);
      window.removeEventListener("norium:whatsapp-event", event);
      window.removeEventListener("norium:omnichannel-connection", connection);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, ownerId, scope]);
}
