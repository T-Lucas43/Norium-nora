import { useEffect, useRef, useState } from "react";
import type { PresencePreferences, PresenceState } from "./TeamStatusDialog";

export function useTeamPresence(open: boolean, token: string, request: (path: string, init?: RequestInit) => Promise<{ states?: Record<string, PresenceState>; preferences?: PresencePreferences }>) {
  const [states, setStates] = useState<Record<string, PresenceState>>({});
  const [preferences, setPreferences] = useState<PresencePreferences>({});
  const requestRef = useRef(request); requestRef.current = request;
  useEffect(() => {
    setStates({}); setPreferences({});
    if (!open) return;
    let cancelled = false;
    void requestRef.current("/presence/context").then((data) => { if (!cancelled) { setStates(data.states || {}); setPreferences(data.preferences || {}); } }).catch(() => { /* A transient presence failure does not hide messages. */ });
    return () => { cancelled = true; };
  }, [open, token]);
  function handle(payload: unknown) {
    if (!open) return;
    const event = payload as { type?: string; states?: Record<string, PresenceState>; preferences?: PresencePreferences; partial?: boolean };
    if (event.type === "TEAM_PRESENCE_CONTEXT") { setStates((current) => event.partial ? { ...current, ...(event.states || {}) } : event.states || {}); setPreferences(event.preferences || {}); }
    if (event.type === "PRESENCE" || event.type === "CONNECTED") void requestRef.current("/presence/context").then((data) => { setStates(data.states || {}); setPreferences(data.preferences || {}); }).catch(() => undefined);
  }
  async function save(value: PresencePreferences) { const data = await requestRef.current("/presence/preferences", { method: "PATCH", body: JSON.stringify(value) }); setStates(data.states || {}); setPreferences(data.preferences || {}); window.dispatchEvent(new Event("norium:presence-preferences")); }
  return { states, preferences, handle, save };
}
