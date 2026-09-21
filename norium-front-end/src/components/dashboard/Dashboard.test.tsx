import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import type { TaskItem } from "../../features/tasks/types";
import type { EventSource, OmnichannelEvent } from "../../types/omnichannel";
import Dashboard from "./Dashboard";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
vi.mock("./DashboardSignal", () => ({ default: () => null }));
vi.mock("./IntegrationGrid", () => ({ default: () => null }));
vi.mock("./ActiveAutomations", () => ({ default: () => null }));
vi.mock("./Statistics", () => ({ default: () => null }));

const request = vi.mocked(apiRequest);
const emptyEvents = Object.fromEntries(
  (["gmail", "whatsapp", "calendar", "kanban", "financeiro", "equipe", "automacoes", "brainstorm", "relatorios", "sistema"] as EventSource[]).map((source) => [source, [] as OmnichannelEvent[]]),
) as Record<EventSource, OmnichannelEvent[]>;

function task(id: string, title: string, assigneeId: string, status: TaskItem["status"] = "pendente"): TaskItem {
  return {
    id,
    projectId: "project-1",
    title,
    description: "",
    category: "operacao",
    status,
    priority: "alta",
    labels: [],
    dueDate: "2026-09-20",
    assigneeId,
    assigneeName: assigneeId,
    attachments: [],
    comments: [],
    createdAt: "2026-09-15T10:00:00Z",
    updatedAt: "2026-09-15T10:00:00Z",
    order: 0,
  };
}

describe("Dashboard operacional", () => {
  beforeEach(() => {
    request.mockImplementation((path: string) => {
      if (path.startsWith("/api/tarefas")) return Promise.resolve({ tasks: [
        task("mine", "Revisar proposta", "user-1"),
        task("other", "Tarefa de outra pessoa", "user-2"),
        task("done", "Tarefa já concluída", "user-1", "concluida"),
      ] }) as never;
      if (path.startsWith("/api/financeiro")) return Promise.resolve({ lancamentos: [], programados: [], resumo: { saldo: 0, pendente: 0, vencidos: 0 } }) as never;
      return Promise.resolve({}) as never;
    });
  });

  it("mostra cartões roláveis somente das tarefas atribuídas ao usuário atual", async () => {
    render(<Dashboard eventsBySource={emptyEvents} connected profile={null} userId="user-1" onNavigate={vi.fn()} onOpenNora={vi.fn()} />);

    const matches = await screen.findAllByText("Revisar proposta");
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Tarefa de outra pessoa")).not.toBeInTheDocument();
    expect(screen.queryByText("Tarefa já concluída")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Tarefas atribuídas a mim")).toHaveClass("norium-assigned-task-list");
    expect(screen.getByText("Próxima decisão")).toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining("/api/tarefas"), expect.objectContaining({ cache: "no-store" })));
  });
});
