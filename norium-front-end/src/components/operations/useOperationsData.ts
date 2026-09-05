import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../core/api/client";
import { workspaceScope } from "../../core/api/sessionScope";
import type { OperationsOverview } from "./OperationsDashboard";

export const operationSections = ["summary", "approvals", "history", "integrations", "memory"] as const;
export type OperationSection = typeof operationSections[number];
type SectionPayload = Omit<Partial<OperationsOverview>, "summary"> & { summary?: Partial<OperationsOverview["summary"]> };
type Payloads = Partial<Record<OperationSection, SectionPayload>>;

function cached(key: string): Payloads {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    return Object.fromEntries(operationSections.flatMap((section) => {
      const entry = value?.sections?.[section];
      return entry?.savedAt && Date.now() - entry.savedAt < 60_000 && entry.data ? [[section, entry.data]] : [];
    }));
  } catch { return {}; }
}

export function useOperationsData(userId: string) {
  const key = `norium-operations-overview:${userId}:${workspaceScope()}`;
  const [payloads, setPayloads] = useState<Payloads>(() => cached(key));
  const [errors, setErrors] = useState<Partial<Record<OperationSection, string>>>({});
  const [pending, setPending] = useState<Partial<Record<OperationSection, boolean>>>({});
  const requests = useRef(new Map<OperationSection, AbortController>());

  const loadSection = useCallback(async (section: OperationSection, force = false) => {
    if (requests.current.has(section) && !force) return;
    requests.current.get(section)?.abort();
    const controller = new AbortController();
    requests.current.set(section, controller);
    setPending((current) => ({ ...current, [section]: true }));
    setErrors((current) => ({ ...current, [section]: undefined }));
    try {
      const result = await apiRequest<SectionPayload>(`/api/operacao/painel/${section}`, { signal: controller.signal, timeoutMs: 12_000 });
      if (controller.signal.aborted || requests.current.get(section) !== controller) return;
      setPayloads((current) => ({ ...current, [section]: result }));
      // Each section expires independently: refreshing tasks cannot renew old integrations.
      try {
        const stored = JSON.parse(sessionStorage.getItem(key) || "null");
        sessionStorage.setItem(key, JSON.stringify({ sections: { ...stored?.sections, [section]: { savedAt: Date.now(), data: result } } }));
      } catch { /* A disabled/full cache must not fail the UI. */ }
    } catch (error) {
      if (!controller.signal.aborted && requests.current.get(section) === controller) {
        setErrors((current) => ({ ...current, [section]: error instanceof Error ? error.message : "Não foi possível carregar esta seção." }));
      }
    } finally {
      if (requests.current.get(section) === controller) {
        requests.current.delete(section);
        setPending((current) => ({ ...current, [section]: false }));
      }
    }
  }, [key]);

  const refresh = useCallback(async (force = false) => {
    await Promise.all(operationSections.map((section) => loadSection(section, force)));
  }, [loadSection]);

  useEffect(() => {
    setPayloads(cached(key));
    setErrors({});
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    const activeRequests = requests.current;
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      for (const controller of activeRequests.values()) controller.abort();
      activeRequests.clear();
    };
  }, [key, refresh]);

  const overview = useMemo(() => operationSections.reduce<SectionPayload>((result, section) => {
    const payload = payloads[section];
    return payload ? { ...result, ...payload, summary: { ...result.summary, ...payload.summary }, alerts: [...(result.alerts || []), ...(payload.alerts || [])] } : result;
  }, {}), [payloads]);
  const ready = Object.fromEntries(operationSections.map((section) => [section, Boolean(payloads[section])])) as Record<OperationSection, boolean>;
  return { overview, ready, errors, pending, refreshing: Object.values(pending).some(Boolean), refresh, loadSection };
}
