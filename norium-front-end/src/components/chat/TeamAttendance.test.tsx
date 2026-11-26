import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatCentral from "./ChatCentral";
import { apiRequest, ApiError } from "../../core/api/client";
import WhatsAppInboxShell from "./WhatsAppInboxShell";
import { useWhatsAppScope } from "./WhatsAppScope";
import WhatsAppAttendanceLink from "./WhatsAppAttendanceLink";

vi.mock("../../core/api/client", async importOriginal => ({ ...await importOriginal<typeof import("../../core/api/client")>(), apiRequest: vi.fn() }));
const inboxId = "a".repeat(64), endpoint = `/api/chat/caixas/${inboxId}`;
const members = [{ id: "alice", name: "Alice", avatar: "", canManage: false }, { id: "manager", name: "Bruno", avatar: "", canManage: true }];
const assignment = { assigneeKind: "none", assigneeUserId: null, status: "open", version: 0 };
const conversation = { id: "synthetic-chat", contato: "Marina", canal: "whatsapp", ultimoTexto: "Pedido sintético", horario: "09:12", timestampUltimaMsg: 100,
  lida: true, mensagens: [], metadados: { numeroCompleto: "synthetic-chat" }, assignee: assignment, attendanceRef: "b".repeat(64) };
let enabled: boolean, version: number, noteText: string;
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState(null, "", "/"); localStorage.clear(); enabled = true; version = 0; noteText = "Verificar internamente";
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path === "/api/chat/caixas") return { items: enabled ? [{ id: inboxId, name: "WhatsApp da equipe", canManage: false }] : [], configuration: null } as never;
    if (path === "/api/chat/status-canais" || path.startsWith(endpoint + "/status-canais")) return { whatsapp: { conectado: true, provider: "evolution" } } as never;
    if (path.endsWith("/atendimento")) {
      if (options?.method === "PATCH") { version++; return { ...assignment, version } as never; }
      return { assignment: { ...assignment, version }, members, canManage: false, viewers: ["manager"],
        notes: { items: noteText ? [{ id: "note-1", body: noteText, authorUserId: "alice", mentions: [], version: 1, createdAt: 101, editedAt: null }] : [], cursor: null, hasMore: false },
        events: { items: [], cursor: null, hasMore: false } } as never;
    }
    if (path.endsWith("/notas") && options?.method === "POST") { noteText = JSON.parse(String(options.body)).body; return { id: "created" } as never; }
    if (path.endsWith("/detalhes")) return conversation as never;
    if (path.includes("/mensagens?")) return { items: [{ id: "m1", tipo: "texto", texto: "Mensagem sintética do cliente", timestamp: 100 }], hasMore: false } as never;
    if (path.includes("/conversas?")) return { items: [conversation], total: 1, counts: { me: 0, none: 1, nora: 0, all: 1 }, nextOffset: null, cursor: 0 } as never;
    if (path.endsWith("/contatos-disponiveis")) return [] as never;
    if (path.endsWith("/grupos")) return { items: [] } as never;
    if (path.endsWith("/status-whatsapp")) return { items: [] } as never;
    if (path.endsWith("/sincronizacao")) return { status: "idle", progress: 0 } as never;
    if (path.endsWith("/perfil-whatsapp")) return {} as never;
    if (path.endsWith("/contact-labels")) return { items: [] } as never;
    if (path.startsWith("/api/business/tags")) return { items: [] } as never;
    throw new Error("Synthetic unsupported endpoint");
  });
});

async function openTeam() {
  const user = userEvent.setup(); render(<ChatCentral userId="alice" />);
  await user.selectOptions(await screen.findByLabelText("Caixa do WhatsApp"), inboxId);
  await user.click(await screen.findByRole("button", { name: "Abrir conversa com Marina" }));
  await screen.findByLabelText("Responsável pelo atendimento");
  return user;
}

describe("atendimento WhatsApp", () => {
  it("mantém o compartilhamento desligado e a conta pessoal como padrão", async () => {
    enabled = false; render(<ChatCentral userId="alice" />);
    await screen.findByRole("heading", { name: "Conversas" });
    expect(screen.queryByLabelText("Caixa do WhatsApp")).not.toBeInTheDocument();
    expect(vi.mocked(apiRequest).mock.calls.some(([path, options]) => path.endsWith("configuracao") && options?.method === "PATCH")).toBe(false);
  });

  it("mostra responsável, estado, presença e nota dentro da conversa", async () => {
    await openTeam();
    expect(await screen.findByText("Verificar internamente")).toBeInTheDocument();
    expect(await screen.findByText("Mensagem sintética do cliente")).toBeInTheDocument();
    expect(screen.getByText("Bruno também está nesta conversa")).toBeInTheDocument();
    expect(screen.getByLabelText("Estado do atendimento")).toHaveValue("open");
    expect(screen.getByRole("group", { name: "Filtrar por responsável" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nota interna" })).toBeInTheDocument();
  });

  it("salva uma nota apenas no endpoint interno e conserva o rascunho da resposta", async () => {
    const user = await openTeam();
    await user.type(screen.getByLabelText("Mensagem"), "Rascunho para o cliente");
    await user.click(screen.getByRole("button", { name: "Nota interna" }));
    expect(screen.queryByLabelText("Anexar")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Nota interna para a equipe"), "Conferir antes de responder");
    await user.click(screen.getByLabelText("Mencionar membro na nota"));
    await user.click(screen.getByRole("button", { name: "Bruno" }));
    await user.click(screen.getByLabelText("Salvar nota interna"));
    await waitFor(() => expect(vi.mocked(apiRequest).mock.calls.some(([path, options]) => path === endpoint + "/conversas/synthetic-chat/notas" && options?.method === "POST" && JSON.parse(String(options.body)).mentions.includes("manager"))).toBe(true));
    expect(vi.mocked(apiRequest).mock.calls.some(([path, options]) => /\/(enviar|enviar-arquivo)$/.test(path) && options?.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: /^Responder$/ }));
    expect(screen.getByLabelText("Mensagem")).toHaveValue("Rascunho para o cliente");
  });

  it("exige confirmação para resolver e envia a versão vista", async () => {
    const user = await openTeam();
    await user.click(screen.getByRole("button", { name: "Resolver" }));
    expect(vi.mocked(apiRequest).mock.calls.some(([path, options]) => path.endsWith("/atendimento") && options?.method === "PATCH")).toBe(false);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Resolver atendimento");
    await user.click(screen.getAllByRole("button", { name: "Resolver" }).at(-1)!);
    await waitFor(() => expect(vi.mocked(apiRequest).mock.calls.some(([path, options]) => path.endsWith("/atendimento") && options?.method === "PATCH" && JSON.parse(String(options.body)).expectedVersion === 0)).toBe(true));
  });

  it("não permite usar o número pessoal ao executar ação sem rota de equipe", async () => {
    let disconnect: () => Promise<unknown> = async () => {};
    function Probe() { const { api, inboxId: id } = useWhatsAppScope(); disconnect = () => api.disconnect(); return <span>{id || "personal"}</span>; }
    const user = userEvent.setup(); render(<WhatsAppInboxShell>{() => <Probe />}</WhatsAppInboxShell>);
    await user.selectOptions(await screen.findByLabelText("Caixa do WhatsApp"), inboxId);
    await expect(disconnect()).rejects.toThrow("Meu WhatsApp");
    expect(vi.mocked(apiRequest).mock.calls.some(([path]) => path.endsWith("/desconectar"))).toBe(false);
  });

  it("remove a conversa da interface depois da perda de acesso", async () => {
    await openTeam();
    vi.mocked(apiRequest).mockImplementation(async () => { throw new ApiError("Conversa indisponível", 404); });
    await act(async () => { window.dispatchEvent(new CustomEvent("norium:whatsapp-event", { detail: { inboxId, ownerId: "alice", area: "attendance" } })); await new Promise(resolve => setTimeout(resolve, 250)); });
    await waitFor(() => expect(screen.queryByText("Verificar internamente")).not.toBeInTheDocument());
  });

  it("constrói links opacos locais e rejeita destinos fornecidos no conteúdo", () => {
    const view = render(<WhatsAppAttendanceLink metadata={{ action: "whatsapp_internal_mention", inboxId, attendanceRef: "b".repeat(64), link: "https://external.invalid" }} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", expect.stringContaining("/app/dSlgZL0DMGQm5JjdLMrs?inbox="));
    view.rerender(<WhatsAppAttendanceLink metadata={{ action: "whatsapp_internal_mention", inboxId: "foreign", attendanceRef: "b".repeat(64) }} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
