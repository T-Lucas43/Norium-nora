import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../core/api/client";
import type { PendingData, WorkHubData } from "./WorkHubDashboard";

type Resource = Exclude<keyof WorkHubData, "pending">;
const prioritySources = [
  { key: "pendingActivity", label: "Aprovações e acompanhamentos" },
  { key: "pendingTasks", label: "Tarefas" },
  { key: "pendingFinance", label: "Financeiro" },
  { key: "pendingMessages", label: "Mensagens" },
  { key: "pendingIntegrations", label: "Integrações" },
] as const;
const priorityKeys = prioritySources.map((source) => source.key);
export type WorkHubTab = "pending" | "inbox" | "followups" | "team" | "data";
const resources: Record<Resource, { path: string; label: string }> = {
  pendingActivity: { path: "/api/operacao/pendencias/fontes/activity", label: "Aprovações e acompanhamentos" },
  pendingTasks: { path: "/api/operacao/pendencias/fontes/tasks", label: "Tarefas" },
  pendingFinance: { path: "/api/operacao/pendencias/fontes/finance", label: "Financeiro" },
  pendingMessages: { path: "/api/operacao/pendencias/fontes/messages", label: "Mensagens" },
  pendingIntegrations: { path: "/api/operacao/pendencias/fontes/integrations", label: "Integrações" },
  focus: { path: "/api/operacao/foco", label: "Modo foco" },
  weekly: { path: "/api/operacao/resumo-semanal?include_team=false", label: "Resumo semanal" },
  inbox: { path: "/api/operacao/inbox-compartilhada", label: "Caixa compartilhada" },
  members: { path: "/api/team-chat/members", label: "Responsáveis" },
  goals: { path: "/api/operacao/metas", label: "Metas" },
  productivity: { path: "/api/operacao/produtividade-equipe", label: "Indicadores da equipe" },
  usage: { path: "/api/operacao/uso-plano", label: "Uso da conta" },
  backups: { path: "/api/operacao/backups", label: "Backups" },
};
const tabResources: Record<WorkHubTab, Resource[]> = {
  pending: priorityKeys,
  inbox: ["inbox", "members"],
  followups: ["pendingActivity"],
  team: ["goals", "productivity"],
  data: ["usage", "backups"],
};
const headerResources: Resource[] = [...priorityKeys, "focus", "weekly"];

// Independent requests keep slow secondary sections from blocking priorities.
// Data belongs to this mounted workspace only; no cross-account global cache.
export function useWorkHubData(activeTab: WorkHubTab) {
  const [data, setData] = useState<Partial<WorkHubData>>({});
  const [pending, setPending] = useState<Partial<Record<Resource, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Resource, string>>>({});
  const dataRef = useRef<Partial<WorkHubData>>({});
  const requests = useRef(new Map<Resource, { controller: AbortController; promise: Promise<void> }>());

  const request = useCallback((key: Resource, force = false): Promise<void> => {
    const running = requests.current.get(key);
    if (running && !force) return running.promise;
    if (running) running.controller.abort();
    if (!force && dataRef.current[key]) return Promise.resolve();
    const task = { controller: new AbortController(), promise: Promise.resolve() };
    requests.current.set(key, task);
    setPending((current) => ({ ...current, [key]: true }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    task.promise = (async () => {
      try {
        const result = await apiRequest<WorkHubData[typeof key]>(resources[key].path, { signal: task.controller.signal, timeoutMs: 12_000 });
        if (requests.current.get(key) !== task) return;
        dataRef.current = { ...dataRef.current, [key]: result };
        setData(dataRef.current);
      } catch (error) {
        if (requests.current.get(key) !== task || task.controller.signal.aborted) return;
        setErrors((current) => ({ ...current, [key]: error instanceof Error ? error.message : "Não foi possível carregar esta seção." }));
      } finally {
        if (requests.current.get(key) === task) {
          requests.current.delete(key);
          setPending((current) => ({ ...current, [key]: false }));
        }
      }
    })();
    return task.promise;
  }, []);

  useEffect(() => {
    const activeRequests = requests.current;
    return () => {
      for (const task of activeRequests.values()) task.controller.abort();
      activeRequests.clear();
    };
  }, []);

  useEffect(() => {
    for (const key of new Set([...headerResources, ...tabResources[activeTab]])) void request(key);
  }, [activeTab, request]);

  const refresh = useCallback(async () => {
    const keys = new Set([...headerResources, ...tabResources[activeTab], ...Object.keys(dataRef.current) as Resource[]]);
    await Promise.all([...keys].map((key) => request(key, true)));
  }, [activeTab, request]);

  const visibleResources = new Set([...headerResources, ...tabResources[activeTab]]);
  const priorities = useMemo<PendingData | undefined>(() => {
    const loaded = priorityKeys.flatMap((key) => data[key] ? [data[key]!] : []);
    if (!loaded.length) return undefined;
    const items = loaded.flatMap((part) => part.items).sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.kind] = (counts[item.kind] || 0) + 1;
    return { items, total: items.length, counts, inboxOpen: data.pendingMessages?.inboxOpen,
      complete: priorityKeys.every((key) => data[key] && !errors[key] && !pending[key]) };
  }, [data, errors, pending]);
  return {
    data: { ...data, pending: priorities }, refresh,
    sources: prioritySources.map((source) => ({ ...source, status: errors[source.key] ? "error" : pending[source.key] || !data[source.key] ? "loading" : "ready" })),
    loading: Object.values(pending).some(Boolean),
    tabLoading: activeTab === "pending" ? !priorities && priorityKeys.some((key) => !errors[key]) : tabResources[activeTab].some((key) => !data[key] && !errors[key]),
    errors: (Object.entries(errors) as Array<[Resource, string | undefined]>)
      .filter(([key, message]) => visibleResources.has(key) && message)
      .map(([key, message]) => ({ key, label: resources[key].label, message, retry: () => request(key, true) })),
  };
}
