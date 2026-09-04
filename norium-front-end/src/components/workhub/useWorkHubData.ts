import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../../core/api/client";
import type { WorkHubData } from "./WorkHubDashboard";

type Resource = keyof WorkHubData;
export type WorkHubTab = "pending" | "inbox" | "followups" | "team" | "data";
const resources: Record<Resource, { path: string; label: string }> = {
  pending: { path: "/api/operacao/pendencias", label: "Pendências" },
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
  pending: ["pending"],
  inbox: ["inbox", "members"],
  followups: ["pending"],
  team: ["goals", "productivity"],
  data: ["usage", "backups"],
};
const headerResources: Resource[] = ["pending", "focus", "weekly"];

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
        const result = await apiRequest<WorkHubData[typeof key]>(resources[key].path, { signal: task.controller.signal });
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
  return {
    data, refresh,
    loading: Object.values(pending).some(Boolean),
    tabLoading: tabResources[activeTab].some((key) => !data[key] && !errors[key]),
    errors: (Object.entries(errors) as Array<[Resource, string | undefined]>)
      .filter(([key, message]) => visibleResources.has(key) && message)
      .map(([key, message]) => ({ key, label: resources[key].label, message, retry: () => request(key, true) })),
  };
}
