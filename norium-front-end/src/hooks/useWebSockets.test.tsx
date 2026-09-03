import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebSockets } from "./useWebSockets";

vi.mock("../utils/api", () => ({
  apiBaseUrl: () => "http://localhost",
  wsBaseUrl: () => "ws://localhost",
  authToken: () => "test-token",
  authenticatedWebSocketUrl: async (url: string) => url,
}));

class Socket {
  static instances: Socket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  url: string;
  constructor(url: string) { this.url = url; Socket.instances.push(this); }
  receive(payload: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

class DesktopNotification {
  static permission = "granted";
  static instances: DesktopNotification[] = [];
  close = vi.fn();
  constructor() { DesktopNotification.instances.push(this); }
}

const invite = { type: "CALL_INVITE", callId: "call_test", fromUserId: "owner", fromUserName: "Organizador", scope: "team" };

beforeEach(() => {
  Socket.instances = [];
  DesktopNotification.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("Notification", DesktopNotification);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes("/notifications/state") ? { userId: "member" } : [],
  })));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup() {
  const hook = renderHook(() => useWebSockets("Início", true, "member"));
  await waitFor(() => expect(Socket.instances).toHaveLength(2));
  const socket = Socket.instances.find((item) => item.url.includes("team-chat"))!;
  return { ...hook, socket };
}

describe("meeting notification lifecycle", () => {
  it("closes desktop alerts, toasts and unread badges when the meeting ends", async () => {
    const { result, socket, unmount } = await setup();
    act(() => socket.receive(invite));
    expect(result.current.systemUnreadCount).toBe(1);
    expect(result.current.systemToasts).toHaveLength(1);
    expect(DesktopNotification.instances).toHaveLength(1);
    act(() => socket.receive({ type: "CALL_END", callId: invite.callId }));
    expect(result.current.systemNotifications).toHaveLength(0);
    expect(result.current.systemToasts).toHaveLength(0);
    expect(result.current.systemUnreadCount).toBe(0);
    expect(DesktopNotification.instances[0].close).toHaveBeenCalled();
    act(() => socket.receive(invite));
    expect(result.current.systemNotifications).toHaveLength(0);
    unmount();
  });

  it("handles invite and end in the same batch without leaving unread counters", async () => {
    const { result, socket, unmount } = await setup();
    act(() => {
      socket.receive(invite);
      socket.receive({ type: "CALL_END", callId: invite.callId });
    });
    expect(result.current.systemNotifications).toHaveLength(0);
    expect(result.current.systemUnreadCount).toBe(0);
    expect(result.current.systemToasts).toHaveLength(0);
    unmount();
  });

  it("does not ring on snapshots and clears stale invitations after reconnection", async () => {
    const { result, socket, unmount } = await setup();
    act(() => socket.receive({ type: "CALLS_STATE", calls: [invite] }));
    expect(result.current.systemNotifications).toHaveLength(0);
    expect(DesktopNotification.instances).toHaveLength(0);
    act(() => socket.receive(invite));
    act(() => socket.receive({ type: "CALLS_STATE", calls: [] }));
    expect(result.current.systemNotifications).toHaveLength(0);
    expect(result.current.systemUnreadCount).toBe(0);
    expect(DesktopNotification.instances[0].close).toHaveBeenCalled();
    unmount();
  });

  it("dismisses alerts when joining or declining and does not alert on call-ended history", async () => {
    const { result, socket, unmount } = await setup();
    act(() => socket.receive(invite));
    act(() => window.dispatchEvent(new CustomEvent("norium:team-call-dismiss", { detail: { callId: invite.callId } })));
    act(() => socket.receive({ type: "TEAM_CHAT_MESSAGE", message: { id: "end", senderId: "owner", metadata: { action: "call_ended" } } }));
    expect(result.current.systemToasts).toHaveLength(0);
    expect(result.current.systemUnreadCount).toBe(0);
    expect(result.current.teamChatUnreadCount).toBe(0);
    unmount();
  });
});
