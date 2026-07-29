// Adaptadores de tarefas e agenda retiram chamadas HTTP do Kanban visual.
import { apiRequest } from "../../core/api/client";

export function tasksApiRequest<T>(path = "", init: RequestInit = {}) {
  return apiRequest<T>(`/api/tarefas${path}`, init);
}

export function calendarApiRequest<T>(path = "", init: RequestInit = {}) {
  return apiRequest<T>(`/api/agenda${path}`, init);
}
