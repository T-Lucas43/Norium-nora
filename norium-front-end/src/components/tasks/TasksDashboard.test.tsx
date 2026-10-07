import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import TasksDashboard from "./TasksDashboard";
import { authJson } from "../../utils/authApi";
import { tasksApiRequest } from "../../features/tasks/api";
import type { AuthSession } from "../../types/auth";
vi.mock("../../features/tasks/api", () => ({ tasksApiRequest: vi.fn(), calendarApiRequest: vi.fn() }));
vi.mock("../../utils/authApi", () => ({ authJson: vi.fn().mockResolvedValue({ users: [] }) }));
const request = vi.mocked(tasksApiRequest);
const session = { user: { id: "u1", nome: "Ana", role: "owner" }, token: "test" } as AuthSession;
const project = { id: "p1", name: "Portal do cliente", description: "Entregas da equipe", ownerUserId: "u1", category: "produto", status: "ativo", color: "#2563eb", responsibleName: "Ana", sharedUserIds: [], defaultPriority: "media" };
const task = { id: "t1", title: "Revisar cadastro", description: "Fluxo de cadastro", projectId: "p1", status: "pendente", priority: "alta", category: "produto", labels: [], comments: [], attachments: [] };
const payload = { tasks: [task], labels: [], columns: [{ id: "pendente", title: "A fazer" }, { id: "andamento", title: "Em andamento" }], stats: { total: 1, ativas: 1, andamento: 0, concluidas: 0, vencidas: 0 } };
beforeEach(() => { request.mockReset(); request.mockImplementation(async (path = "") => path.startsWith("/projetos") ? { projects: [project] } : payload); });
async function openProject() {
  render(<TasksDashboard session={session} />);
  fireEvent.click(await screen.findByRole("button", { name: "Portal do cliente" }));
  await screen.findByRole("button", { name: /Revisar cadastro/ });
}
it("searches projects without removing them and opens the selected project", async () => {
  render(<TasksDashboard session={session} />);
  await screen.findByRole("button", { name: "Portal do cliente" });
  fireEvent.change(screen.getByLabelText("Buscar projetos"), { target: { value: "inexistente" } });
  expect(screen.getByText("Nenhum projeto encontrado")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Limpar busca" }));
  fireEvent.click(screen.getByRole("button", { name: "Portal do cliente" }));
  expect(await screen.findByRole("button", { name: /Revisar cadastro/ })).toBeInTheDocument();
});
it("separates personal and shared team projects and filters them by category", async () => {
  const sharedProject = { ...project, id: "p-team", name: "Operação da equipe", ownerUserId: "u2", category: "operacao", sharedUserIds: ["u1"] };
  request.mockImplementation(async (path = "") => path.startsWith("/projetos") ? { projects: [project, sharedProject] } : payload);
  render(<TasksDashboard session={session} />);

  expect(await screen.findByRole("heading", { name: /Meus projetos/ })).toHaveTextContent("1");
  expect(screen.getByRole("heading", { name: /Projetos da equipe/ })).toHaveTextContent("1");
  expect(screen.getByRole("button", { name: "Portal do cliente" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Operação da equipe" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Produto" }));
  expect(screen.queryByRole("button", { name: "Operação da equipe" })).not.toBeInTheDocument();
  expect(screen.getByText("Nenhum projeto desta categoria foi compartilhado com você.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Todas" }));
  expect(screen.getByRole("button", { name: "Operação da equipe" })).toBeInTheDocument();
});
it("opens task details from list view and closes them with Escape", async () => {
  await openProject();
  fireEvent.click(screen.getByRole("button", { name: "Lista" }));
  expect(screen.getByRole("button", { name: "Lista" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: /Revisar cadastro/ }));
  expect(screen.getByLabelText("Detalhes da tarefa")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByLabelText("Detalhes da tarefa")).not.toBeInTheDocument();
});
it("applies filters and clears them back to all tasks", async () => {
  await openProject();
  fireEvent.click(screen.getByRole("button", { name: "Filtros" }));
  fireEvent.change(screen.getByLabelText("Filtrar por prioridade"), { target: { value: "urgente" } });
  await waitFor(() => expect(request.mock.calls.some(([path]) => path?.includes("priority=urgente"))).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Fechar filtros do projeto" }));
  fireEvent.click(screen.getByRole("button", { name: "Limpar" }));
  await waitFor(() => expect(request.mock.calls.at(-1)?.[0]).toContain("priority=todas"));
  expect(request.mock.calls.at(-1)?.[0]).toContain("status=todas");
});
it("keeps a completed task visible in its column after changing its stage", async () => {
  let currentTask = { ...task };
  request.mockImplementation(async (path = "", init) => {
    if (path.startsWith("/projetos")) return { projects: [project] };
    if (init?.method === "PATCH") {
      currentTask = { ...currentTask, ...JSON.parse(String(init.body)) };
      return { task: currentTask };
    }
    const activeOnly = new URLSearchParams(path.split("?")[1]).get("status") === "ativas";
    return { ...payload, tasks: activeOnly && currentTask.status === "concluida" ? [] : [currentTask], columns: [...payload.columns, { id: "concluida", title: "Concluídas" }] };
  });
  await openProject();
  fireEvent.click(screen.getByRole("button", { name: /Revisar cadastro/ }));
  fireEvent.change(screen.getByLabelText("Etapa"), { target: { value: "concluida" } });
  await waitFor(() => expect(screen.getByLabelText("Etapa")).toHaveValue("concluida"));
  fireEvent.keyDown(window, { key: "Escape" });
  const completedColumn = screen.getByRole("heading", { name: /Concluídas/ }).closest("section")!;
  expect(within(completedColumn).getByRole("button", { name: /Revisar cadastro/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Lista" }));
  expect(screen.getByRole("button", { name: /Revisar cadastro/ })).toHaveTextContent("Concluídas");
});
it("opens the existing task creation flow from the main header", async () => {
  await openProject();
  fireEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByPlaceholderText("Título")).toHaveValue("");
  expect(within(dialog).getByRole("button", { name: "Criar" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("keeps the latest search when an earlier request finishes later", async () => {
  await openProject();
  let finishOld!: (value: unknown) => void;
  request.mockImplementation((path = "") => path.includes("q=antiga") ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve({ ...payload, tasks: [{ ...task, title: "Resultado atual" }] }));
  fireEvent.change(screen.getByLabelText("Buscar tarefas"), { target: { value: "antiga" } });
  fireEvent.change(screen.getByLabelText("Buscar tarefas"), { target: { value: "nova" } });
  await screen.findByRole("button", { name: /Resultado atual/ });
  await act(async () => { finishOld({ ...payload, tasks: [{ ...task, title: "Resultado antigo" }] }); });
  expect(screen.queryByRole("button", { name: /Resultado antigo/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Resultado atual/ })).toBeInTheDocument();
});
it("switches projects from the header and returns to the project selection", async () => {
  const second = { ...project, id: "p2", name: "Operação" };
  request.mockImplementation(async (path = "") => path.startsWith("/projetos") ? { projects: [project, second] } : { ...payload, tasks: path.includes("project_id=p2") ? [{ ...task, id: "t2", projectId: "p2", title: "Entrega operacional" }] : [task] });
  await openProject();
  fireEvent.change(screen.getByLabelText("Buscar tarefas"), { target: { value: "cadastro" } });
  fireEvent.change(screen.getByLabelText("Trocar projeto"), { target: { value: "p2" } });
  expect(await screen.findByRole("button", { name: /Entrega operacional/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Revisar cadastro/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Buscar tarefas")).toHaveValue("");
  expect(screen.getByRole("heading", { name: "Operação" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Voltar aos projetos" }));
  expect(screen.getByRole("button", { name: "Portal do cliente" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Operação" }).length).toBeGreaterThanOrEqual(1);
});

it("offers only the owner and explicit collaborators as task assignees", async () => {
  vi.mocked(authJson).mockResolvedValueOnce({ users: [session.user, { id: "allowed", nome: "Autorizado" }, { id: "denied", nome: "Sem acesso" }] });
  request.mockImplementation(async (path = "") => path.startsWith("/projetos") ? { projects: [{ ...project, sharedUserIds: ["allowed"] }] } : payload);
  await openProject();
  fireEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("option", { name: "Ana" })).toBeInTheDocument();
  expect(within(dialog).getByRole("option", { name: "Autorizado" })).toBeInTheDocument();
  expect(within(dialog).queryByRole("option", { name: "Sem acesso" })).not.toBeInTheDocument();
});
