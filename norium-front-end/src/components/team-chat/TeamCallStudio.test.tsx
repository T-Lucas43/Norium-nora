import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../core/api/client";
import TeamCallStudio from "./TeamCallStudio";

const mocks = vi.hoisted(() => ({ api: vi.fn(), listener: null as null | ((event: { type: string; callId: string }) => void) }));
vi.mock("../../core/api/client", async (load) => ({ ...await load<typeof import("../../core/api/client")>(), apiRequest: mocks.api }));
vi.mock("./CallSession", () => ({ useTeamApiRequest: () => mocks.api, useTeamSocketEvents: (listener: typeof mocks.listener) => { mocks.listener = listener; } }));
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes, onNodeClick }: { nodes: Array<{ id: string; data: { label: string } }>; onNodeClick: (event: null, node: unknown) => void }) => <div>{nodes.map((node) => <button key={node.id} onClick={() => onNodeClick(null, node)}>{node.data.label}</button>)}</div>,
  Background: () => null, Controls: () => null, applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
  Handle: () => null, Position: { Left: "left", Right: "right" },
}));

const board = () => ({ id: "studio", title: "Planejamento", active: true, revision: 1,
  board: { nodes: [{ id: "note", type: "idea", version: 1, position: { x: 0, y: 0 }, data: { label: "Ideia inicial", description: "", color: "#FDE68A", variant: "sticky", votes: [], comments: [] } }], edges: [] } });
const props = { callId: "call", clientId: "my-tab", currentUserId: "owner", isHost: true, visible: true, onOpen: vi.fn(), onClose: vi.fn() };

describe("estúdio colaborativo da chamada", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.listener = null; });

  it("organizador abre a sessão pela API com o cliente da chamada", async () => {
    mocks.api.mockResolvedValueOnce({ session: null }).mockResolvedValueOnce({ session: board() });
    render(<TeamCallStudio {...props} />);
    fireEvent.change(await screen.findByLabelText("Nome da sessão"), { target: { value: "Planejamento" } });
    fireEvent.click(screen.getByRole("button", { name: "Abrir sessão para todos" }));
    await screen.findByRole("button", { name: "Ideia inicial" });
    expect(JSON.parse(mocks.api.mock.calls[1][1].body)).toMatchObject({ clientId: "my-tab", title: "Planejamento", active: true });
    expect(props.onOpen).toHaveBeenCalledOnce();
  });

  it("participante aguarda e abre automaticamente uma sessão criada pelo organizador", async () => {
    mocks.api.mockResolvedValueOnce({ session: null }).mockResolvedValue({ session: board() });
    render(<TeamCallStudio {...props} isHost={false} />);
    await screen.findByText(/Aguardando o organizador/);
    expect(screen.queryByRole("button", { name: "Abrir sessão para todos" })).not.toBeInTheDocument();
    act(() => mocks.listener?.({ type: "CALL_STUDIO_UPDATED", callId: "call" }));
    await screen.findByRole("button", { name: "Ideia inicial" });
    expect(props.onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Encerrar estúdio" })).not.toBeInTheDocument();
  });

  it("preserva rascunho local quando outro participante edita o mesmo cartão", async () => {
    let current = board();
    mocks.api.mockImplementation(async (_path, options) => {
      if (options?.method === "POST") throw new ApiError("Outra pessoa editou este cartão.", 409);
      return { session: structuredClone(current) };
    });
    render(<TeamCallStudio {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ideia inicial" }));
    fireEvent.change(screen.getByLabelText("Título do cartão"), { target: { value: "Meu rascunho" } });
    current = board(); current.revision = 2; current.board.nodes[0].version = 2; current.board.nodes[0].data.label = "Edição remota";
    act(() => mocks.listener?.({ type: "CALL_STUDIO_UPDATED", callId: "call" }));
    await screen.findByRole("button", { name: "Edição remota" });
    expect(screen.getByLabelText("Título do cartão")).toHaveValue("Meu rascunho");
    fireEvent.click(screen.getByRole("button", { name: "Salvar cartão" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Título do cartão")).toHaveValue("Meu rascunho");
    fireEvent.click(screen.getByRole("button", { name: "Descartar rascunho" }));
    expect(screen.getByLabelText("Título do cartão")).toHaveValue("Edição remota");
  });

  it("reenvia uma operação incerta com o mesmo identificador para evitar duplicação", async () => {
    let posts = 0;
    mocks.api.mockImplementation(async (_path, options) => {
      if (options?.method === "POST" && ++posts === 1) throw new ApiError("Tempo de conexão esgotado.", 408);
      return { session: board() };
    });
    render(<TeamCallStudio {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ideia inicial" }));
    fireEvent.click(screen.getByRole("button", { name: "Votar (0)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Tentar envio novamente" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Tentar envio novamente" })).not.toBeInTheDocument());
    const operations = mocks.api.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => JSON.parse(call[1].body));
    expect(operations).toHaveLength(2);
    expect(operations[0].operationId).toBe(operations[1].operationId);
  });
});
