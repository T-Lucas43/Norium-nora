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
  await waitFor(() => expect(Socket.instances).toHaveLength(1));
  return {
    ...hook,
    receiveTeam: (payload: Record<string, unknown>) => hook.result.current.handleTeamSocketEvent(payload as never),
  };
}

describe("team member mentions", () => {
  it("notifies a mentioned member with the chat open and deduplicates the inbox event", async () => {
    const { result } = renderHook(() => useWebSockets("Chat da Equipe", true, "member", true));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const inboxSocket = Socket.instances[0];
    const metadata = { mentionedUserIds: ["member"], threadId: "subteam:sales", messageId: "mention-1", senderId: "owner", senderName: "Ana", action: "team_member_mentioned", userId: "member" };
    act(() => result.current.handleTeamSocketEvent({ type: "TEAM_CHAT_MESSAGE", message: { id: "mention-1", threadId: "subteam:sales", senderId: "owner", senderName: "Ana", text: "@Member revise a proposta", metadata } }));
    expect(result.current.systemNotifications[0].title).toBe("Ana mencionou você");
    expect(result.current.systemNotifications[0].metadata?.threadId).toBe("subteam:sales");
    expect(DesktopNotification.instances).toHaveLength(1);
    act(() => inboxSocket.receive({ type: "NEW_EVENT", event: { id: "persisted-mention", source: "equipe", title: "Ana mencionou você", timestamp: new Date().toISOString(), description: "@Member revise a proposta", metadata } }));
    expect(result.current.systemNotifications).toHaveLength(1);
    expect(DesktopNotification.instances).toHaveLength(1);
  });

  it("does not alert a different member as mentioned or alert the sender", async () => {
    const { result } = renderHook(() => useWebSockets("Chat da Equipe", true, "member", true));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    act(() => {
      result.current.handleTeamSocketEvent({ type: "TEAM_CHAT_MESSAGE", message: { id: "other-mention", senderId: "owner", metadata: { mentionedUserIds: ["other"] } } });
      result.current.handleTeamSocketEvent({ type: "TEAM_CHAT_MESSAGE", message: { id: "self-mention", senderId: "member", metadata: { mentionedUserIds: ["member"] } } });
    });
    expect(result.current.systemNotifications).toHaveLength(0);
  });
});

describe("meeting notification lifecycle", () => {
  it("closes desktop alerts, toasts and unread badges when the meeting ends", async () => {
    const { result, receiveTeam, unmount } = await setup();
    act(() => receiveTeam(invite));
    expect(result.current.systemUnreadCount).toBe(1);
    expect(result.current.systemToasts).toHaveLength(1);
    expect(DesktopNotification.instances).toHaveLength(1);
    act(() => receiveTeam({ type: "CALL_END", callId: invite.callId }));
    expect(result.current.systemNotifications).toHaveLength(0);
    expect(result.current.systemToasts).toHaveLength(0);
    expect(result.current.systemUnreadCount).toBe(0);
    expect(DesktopNotification.instances[0].close).toHaveBeenCalled();
    act(() => receiveTeam(invite));
    expect(result.current.systemNotifications).toHaveLength(0);
    unmount();
  });

  it("handles invite and end in the same batch without leaving unread counters", async () => {
    const { result, receiveTeam, unmount } = await setup();
    act(() => {
      receiveTeam(invite);
      receiveTeam({ type: "CALL_END", callId: invite.callId });
    });
    expect(result.current.systemNotifications).toHaveLength(0);
    expect(result.current.systemUnreadCount).toBe(0);
    expect(result.current.systemToasts).toHaveLength(0);
    unmount();
  });

  it("does not ring on snapshots and clears stale invitations after reconnection", async () => {
    const { result, receiveTeam, unmount } = await setup();
    act(() => receiveTeam({ type: "CALLS_STATE", calls: [invite] }));
    expect(result.current.systemNotifications).toHaveLength(0);
    expect(DesktopNotification.instances).toHaveLength(0);
    act(() => receiveTeam(invite));
    act(() => receiveTeam({ type: "CALLS_STATE", calls: [] }));
    expect(result.current.systemNotifications).toHaveLength(0);
    expect(result.current.systemUnreadCount).toBe(0);
    expect(DesktopNotification.instances[0].close).toHaveBeenCalled();
    unmount();
  });

  it("dismisses alerts when joining or declining and does not alert on call-ended history", async () => {
    const { result, receiveTeam, unmount } = await setup();
    act(() => receiveTeam(invite));
    act(() => result.current.dismissCallNotifications(invite.callId));
    act(() => receiveTeam({ type: "TEAM_CHAT_MESSAGE", message: { id: "end", senderId: "owner", metadata: { action: "call_ended" } } }));
    expect(result.current.systemToasts).toHaveLength(0);
    expect(result.current.systemUnreadCount).toBe(0);
    expect(result.current.teamChatUnreadCount).toBe(0);
    unmount();
  });
});
