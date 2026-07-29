// Adaptador HTTP do dominio; o componente cuida apenas do estado visual.
import { apiRequest } from "../../core/api/client";
import type { TaskProject } from "./types";

const AUTOMATIONS_PATH = "/api/automacoes";

export function automationsApiRequest<T>(path = "", init: RequestInit = {}) {
  return apiRequest<T>(`${AUTOMATIONS_PATH}${path}`, init);
}

export async function fetchActiveTaskProjects(): Promise<TaskProject[]> {
  const payload = await apiRequest<{ projects?: TaskProject[] }>("/api/tarefas/projetos", {
    cache: "no-store",
  });
  return (payload.projects || []).filter((project) => !project.archived);
}
