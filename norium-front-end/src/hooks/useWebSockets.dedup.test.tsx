// Tarefa 2: caixa de entrada sem repetição — reconexão, dois canais,
// remount e releitura do histórico não duplicam; alerta novo aparece.
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmnichannelEvent } from "../types/omnichannel";
import { useWebSockets } from "./useWebSockets";

vi.mock("../utils/api", () => ({
  apiBaseUrl: () => "http://localhost:8000",
  wsBaseUrl: () => "ws://localhost:8000",
  authToken: () => "token-de-teste",
  authenticatedWebSocketUrl: (url: string) => Promise.resolve(url),
}));

type SocketHandler = ((message: { data: string }) => void) | null;

class MockSocket {
  static instances: MockSocket[] = [];

  onopen: (() => void) | null = null;

  onmessage: SocketHandler = null;

  onclose: (() => void) | null = null;

  onerror: (() => void) | null = null;

  sent: string[] = [];

  url: string;

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }
}

function omniSocket(): MockSocket {
  const socket = MockSocket.instances.findLast((item) => item.url.includes("/api/omnichannel/ws"));
  if (!socket) throw new Error("WebSocket omnichannel não conectado");
  return socket;
}

function inboxEvent(partial: Partial<OmnichannelEvent> & { id: string }): OmnichannelEvent {
  return {
    source: "kanban",
    title: "Atividade",
    description: "detalhe",
    timestamp: "2026-09-20T12:00:00.000Z",
    ...partial,
    metadata: { userId: "user1", ...(partial.metadata ?? {}) },
  };
}

let historyEvents: OmnichannelEvent[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function mockFetch() {
  fetchMock = vi.fn((url: string) => {
    if (String(url).includes("/api/omnichannel/inbox")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(historyEvents) });
    }
    if (String(url).includes("/api/omnichannel/notifications/state")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ userId: "user1", readBefore: null, clearedBefore: null }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function sendOmniEvent(event: OmnichannelEvent): void {
  omniSocket().onmessage?.({ data: JSON.stringify({ type: "NEW_EVENT", event }) });
}

beforeEach(() => {
  MockSocket.instances = [];
  historyEvents = [];
  localStorage.clear();
  vi.stubGlobal("WebSocket", MockSocket as unknown as typeof WebSocket);
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useWebSockets sem repetição", () => {
  it("mesmo evento por reconexão/entrega dupla chega uma vez", async () => {
    const { result } = renderHook(() => useWebSockets("Agenda", true, "user1", false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const event = inboxEvent({ id: "evt_1", title: "Tarefa criada" });
    act(() => {
      sendOmniEvent(event);
      sendOmniEvent(event);
    });

    expect(result.current.systemNotifications).toHaveLength(1);
    expect(result.current.systemUnreadCount).toBe(1);
    expect(result.current.systemToasts).toHaveLength(1);
  });

  it("atualiza evento da agenda com o mesmo ID sem repetir aviso", async () => {
    const { result } = renderHook(() => useWebSockets("Agenda", true, "user1", false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const original = inboxEvent({ id: "calendar_1", source: "calendar", title: "Reunião 10h" });
    const updated = { ...original, title: "Reunião 11h" };
    act(() => {
      sendOmniEvent(original);
      sendOmniEvent(updated);
    });

    expect(result.current.eventsBySource.calendar).toHaveLength(1);
    expect(result.current.eventsBySource.calendar[0].title).toBe("Reunião 11h");
    expect(result.current.systemNotifications).toHaveLength(1);
    expect(result.current.systemToasts).toHaveLength(1);
  });

  it("mensagem da equipe pelos dois canais gera um único aviso", async () => {
    const { result } = renderHook(() => useWebSockets("Agenda", true, "user1", false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const teamEvent = inboxEvent({
      id: "evt_team_1",
      source: "equipe",
      title: "Mensagem no chat interno",
      metadata: {
        userId: "user1",
        action: "team_message_created",
        messageId: "team_msg_1",
        senderId: "user2",
        senderName: "Bia",
      },
    });
    act(() => {
      sendOmniEvent(teamEvent);
      result.current.handleTeamSocketEvent({
        type: "TEAM_CHAT_MESSAGE",
        message: { id: "team_msg_1", senderId: "user2", senderName: "Bia", text: "Oi" },
      } as never);
    });

    expect(
      result.current.systemNotifications.filter((item) => item.id === "notification_team_team_msg_1"),
    ).toHaveLength(1);
    expect(result.current.teamChatUnreadCount).toBe(1);
  });

  it("reler o histórico não recria toast e alerta novo continua aparecendo", async () => {
    historyEvents = [inboxEvent({ id: "evt_hist", title: "Histórico" })];
    const first = renderHook(() => useWebSockets("Agenda", true, "user1", false));
    await waitFor(() => expect(first.result.current.systemNotifications).toHaveLength(1));

    const live = inboxEvent({ id: "evt_live", title: "Ao vivo" });
    act(() => sendOmniEvent(live));
    expect(first.result.current.systemToasts).toHaveLength(1);

    // Remount: mesma ocorrência (histórico + replay) não gera novo toast.
    first.unmount();
    historyEvents = [historyEvents[0], live];
    const second = renderHook(() => useWebSockets("Agenda", true, "user1", false));
    await waitFor(() => expect(second.result.current.systemNotifications).toHaveLength(2));
    expect(second.result.current.systemToasts).toHaveLength(0);
    act(() => sendOmniEvent(live));
    expect(second.result.current.systemNotifications).toHaveLength(2);
    expect(second.result.current.systemToasts).toHaveLength(0);

    // Ocorrência nova com identidade própria aparece com toast.
    const next = inboxEvent({ id: "evt_novo", title: "Novo alerta" });
    act(() => sendOmniEvent(next));
    expect(second.result.current.systemNotifications).toHaveLength(3);
    expect(second.result.current.systemToasts).toHaveLength(1);
  });

  it("preserva a regra do Gmail: enviados e rascunhos não viram aviso", async () => {
    historyEvents = [
      inboxEvent({ id: "gmail_in", source: "gmail", metadata: { userId: "user1", folder: "inbox" } }),
      inboxEvent({ id: "gmail_sent", source: "gmail", metadata: { userId: "user1", folder: "sent" } }),
      inboxEvent({ id: "gmail_draft", source: "gmail", metadata: { userId: "user1", folder: "drafts" } }),
    ];
    const { result } = renderHook(() => useWebSockets("Agenda", true, "user1", false));
    await waitFor(() => expect(result.current.systemNotifications).toHaveLength(1));
    expect(result.current.systemNotifications[0].id).toBe("notification_gmail_in");
    expect(result.current.systemUnreadCount).toBe(1);
  });
});
