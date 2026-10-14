import { useEffect, useRef } from "react";
import type { AuthSession } from "../../types/auth";
import { apiRequest } from "../../core/api/client";

export type PresenceResource = { type: "task" | "client" | "project" | "conversation" | "meeting"; id: string };
export default function TeamPresenceReporter({ session, activeTab }: { session: AuthSession; activeTab: string }) {
  const resource = useRef<PresenceResource | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const sessionRef = useRef(session); sessionRef.current = session;
  const activeCall = useRef<"call" | "meeting" | null>(null);
  useEffect(() => {
    resource.current = null;
    if (!session.user.teamChatEnabled) return;
    let active = true;
    async function report() {
      if (!active || !sessionRef.current.user.teamChatEnabled) return;
      const visible = document.visibilityState !== "hidden" && document.hasFocus();
      const current = visible ? resource.current : null;
      try { await apiRequest("/api/team-chat/presence/context", { method: "PUT", body: JSON.stringify({ clientId: clientId.current, state: activeCall.current || (!visible ? "away" : current?.type === "client" ? "service" : current?.type === "meeting" ? "meeting" : "online"), resource: current }) }); }
      catch { /* Presence never blocks the work screen or retries in a tight loop. */ }
    }
    const onContext = (event: Event) => { resource.current = (event as CustomEvent<PresenceResource | null>).detail; void report(); };
    const onLink = (event: Event) => { const detail = (event as CustomEvent<{ entityType?: string; entityId?: string }>).detail; if (detail?.entityId && ["task", "client", "project", "meeting"].includes(detail.entityType || "")) { resource.current = { type: detail.entityType as PresenceResource["type"], id: detail.entityId }; void report(); } };
    const onVisibility = () => void report();
    const onCall = (event: Event) => { activeCall.current = (event as CustomEvent<"call" | "meeting" | null>).detail; void report(); };
    window.addEventListener("norium:presence-context", onContext); window.addEventListener("norium:deep-link", onLink);
    window.addEventListener("focus", onVisibility); window.addEventListener("blur", onVisibility); document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("norium:presence-preferences", onVisibility);
    window.addEventListener("norium:presence-call", onCall);
    const heartbeat = window.setInterval(() => { if (document.visibilityState !== "hidden") void report(); }, 90000);
    void report();
    return () => { active = false; window.clearInterval(heartbeat); window.removeEventListener("norium:presence-context", onContext); window.removeEventListener("norium:deep-link", onLink); window.removeEventListener("focus", onVisibility); window.removeEventListener("blur", onVisibility); window.removeEventListener("norium:presence-preferences", onVisibility); window.removeEventListener("norium:presence-call", onCall); document.removeEventListener("visibilitychange", onVisibility); };
  }, [activeTab, session.user.id, session.user.teamChatEnabled]);
  return null;
}
