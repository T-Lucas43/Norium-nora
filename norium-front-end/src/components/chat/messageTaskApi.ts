import { tasksApiRequest } from "../../features/tasks/api";

export type MessageTaskProject = {
  id: string;
  name: string;
};

type ProjectRecord = Record<string, unknown>;

function normalizeProject(value: unknown): MessageTaskProject | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as ProjectRecord;
  const id = String(raw.id || raw.projectId || "").trim();
  const name = String(raw.name || raw.title || raw.projectName || "").trim();
  return id && name ? { id, name } : null;
}

export const messageTaskApi = {
  async listProjects() {
    const payload = await tasksApiRequest<{ projects?: unknown[] }>("/projetos", { cache: "no-store" });
    return (payload.projects || []).map(normalizeProject).filter((project): project is MessageTaskProject => Boolean(project));
  },

  async createFromMessage(input: { project: MessageTaskProject; title: string; description: string }) {
    return tasksApiRequest<{ task: { id: string; title: string } }>("", {
      method: "POST",
      body: JSON.stringify({
        projectId: input.project.id,
        projectName: input.project.name,
        title: input.title.trim(),
        description: input.description.trim(),
        category: "comunicacao",
        status: "pendente",
        priority: "media",
        labels: ["whatsapp", "nora"],
      }),
    });
  },
};
