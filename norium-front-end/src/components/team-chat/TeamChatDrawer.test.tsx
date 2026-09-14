import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TeamChatDrawer from "./TeamChatDrawer";
import type { AuthSession } from "../../types/auth";

vi.mock("../../utils/api", () => ({ apiBaseUrl: () => "http://localhost", wsBaseUrl: () => "ws://localhost", authToken: () => "test", authenticatedWebSocketUrl: async (url: string) => url }));
const callSession = vi.hoisted(() => ({
  snapshot: { busy: false, active: null, incoming: null, availableCalls: [], status: "" },
  commands: { start: vi.fn(), join: vi.fn() },
}));
vi.mock("./CallSession", () => ({
  useCallSession: () => callSession,
  useTeamSocketEvents: () => undefined,
}));
vi.mock("./TeamCallOverlay", () => ({ default: () => null }));
const session = { token: "test", availableModes: ["app"], user: { id: "owner", nome: "Rafael", email: "rafael@example.test", role: "owner", plan: "equipe", status: "ativo", systemAdmin: false, permissions: { chat: true, equipe: true, nora: true } } } as AuthSession;
const members = [session.user, { ...session.user, id: "ana", nome: "Ana Carolina", role: "member" }, { ...session.user, id: "bruno", nome: "Bruno Almeida", role: "member" }];
const message = (id: string, threadId: string, text: string) => ({ id, threadId, scope: threadId === "team" ? "team" : "direct", senderId: "ana", senderName: "Ana Carolina", text, attachments: [], metadata: {}, createdAt: "2026-09-06T14:00:00Z" });
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });
let pinned = false;
let delayTeam: Promise<ReturnType<typeof response>> | null;
let posted: Record<string, unknown>[];
let reads: string[];
beforeEach(() => {
  pinned = false; delayTeam = null; posted = []; reads = [];
  vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 1; close() {} send() {} });
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url.endsWith("/members")) return response({ members, onlineUserIds: ["owner", "ana"] });
    if (url.endsWith("/subteams")) return response({ subteams: [] });
    if (url.endsWith("/threads/pin")) { pinned = body.pinned; return response(body); }
    if (url.endsWith("/threads")) return response({ threads: [{ id: "team", scope: "team", pinned, unreadCount: 1 }, { id: "direct:ana:owner", scope: "direct", recipientId: "ana", pinned: false, unreadCount: 0 }] });
    if (url.endsWith("/messages/read")) { reads.push(...body.messageIds); return response({ ok: true }); }
    if (options?.method === "POST") { posted.push(body); return response({ message: { ...message("sent", body.scope === "team" ? "team" : "direct:ana:owner", body.text), senderId: "owner" } }); }
    if (url.includes("scope=team")) return delayTeam || response({ messages: [message("team-msg", "team", "Mensagem do time")] });
    return response({ messages: [message("direct-msg", "direct:ana:owner", "Mensagem privada")] });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function setup() {
  const view = render(<TeamChatDrawer open onClose={() => {}} session={session} variant="page" />);
  await screen.findByRole("button", { name: "Abrir conversa Time todo" });
  return view;
}

describe("conversas da equipe", () => {
  it("starts unselected without reading messages and can close a conversation", async () => {
    await setup();
    expect(screen.queryByRole("textbox", { name: "Mensagem para a conversa" })).not.toBeInTheDocument();
    expect(reads).toEqual([]);
    expect(within(screen.getByRole("region", { name: "Time todo" })).queryByRole("button", { name: "Abrir conversa Ana Carolina" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Contatos" })).getByText("Online agora")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa Time todo" }));
    await screen.findByText("Mensagem do time");
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa Time todo" }));
    expect(screen.getByText("Mensagem do time")).toBeInTheDocument();
    await waitFor(() => expect(reads).toContain("team-msg"));
    fireEvent.click(screen.getByRole("button", { name: "Fechar conversa" }));
    expect(screen.queryByRole("textbox", { name: "Mensagem para a conversa" })).not.toBeInTheDocument();
  });

  it("keeps personal pins after remount and drafts in their respective threads", async () => {
    const view = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Fixar conversa Time todo" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Time todo" })).getByRole("button", { name: "Abrir conversa Time todo" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa Time todo" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem para a conversa" }), { target: { value: "Rascunho do time" } });
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa Ana Carolina" }));
    expect(screen.getByRole("textbox", { name: "Mensagem para a conversa" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa Time todo" }));
    expect(screen.getByRole("textbox", { name: "Mensagem para a conversa" })).toHaveValue("Rascunho do time");
    view.unmount(); await setup();
    expect(within(screen.getByRole("region", { name: "Time todo" })).getByRole("button", { name: "Abrir conversa Time todo" })).toBeInTheDocument();
  });

  it("selects a participant with the keyboard and sends their ID with the mention", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa Time todo" }));
    const input = screen.getByRole("textbox", { name: "Mensagem para a conversa" });
    fireEvent.change(input, { target: { value: "@Ana", selectionStart: 4 } });
    await screen.findByRole("option", { name: /Ana Carolina/ });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("@Ana Carolina ");
    expect(posted).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(posted[0]).toMatchObject({ text: "@Ana Carolina ", mentionedUserIds: ["ana"], scope: "team" }));
  });

  it("gives Nora responses the wider reading layout without changing other messages", async () => {
    delayTeam = Promise.resolve(response({ messages: [
      { ...message("nora-wide", "team", "Resumo executivo da conversa"), senderId: "nora", senderName: "Nora" },
      message("person-standard", "team", "Mensagem comum"),
    ] }));
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa Time todo" }));

    expect((await screen.findByText("Resumo executivo da conversa")).closest(".team-chat-message")).toHaveClass("team-chat-message-nora");
    expect(screen.getByText("Mensagem comum").closest(".team-chat-message")).not.toHaveClass("team-chat-message-nora");
  });

  it("ignores a delayed message response after switching to another conversation", async () => {
    let resolveTeam!: (value: ReturnType<typeof response>) => void;
    delayTeam = new Promise((resolve) => { resolveTeam = resolve; });
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa Time todo" }));
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa Ana Carolina" }));
    await screen.findByText("Mensagem privada");
    await act(async () => resolveTeam(response({ messages: [message("late-team", "team", "Resposta atrasada")] })));
    expect(screen.queryByText("Resposta atrasada")).not.toBeInTheDocument();
    expect(reads).not.toContain("late-team");
  });
});
