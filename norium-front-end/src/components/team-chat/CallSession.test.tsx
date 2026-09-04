import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../../types/auth";

const mocked = vi.hoisted(() => ({
  runtime: null as Record<string, any> | null,
  useTeamCallRuntime: vi.fn(),
}));

vi.mock("../../utils/api", () => ({
  authenticatedWebSocketUrl: async (url: string) => url,
  wsBaseUrl: () => "ws://localhost",
}));

vi.mock("./useTeamCall", () => ({
  useTeamCallRuntime: (...args: unknown[]) => mocked.useTeamCallRuntime(...args),
}));

import {
  CallSessionProvider,
  transitionCallSession,
  useCallSession,
} from "./CallSession";

const authSession = {
  token: "test-token",
  availableModes: ["app"],
  user: {
    id: "owner",
    nome: "Owner",
    email: "owner@example.test",
    role: "owner",
    plan: "equipe",
    status: "ativo",
    systemAdmin: false,
    permissions: {} as AuthSession["user"]["permissions"],
  },
} satisfies AuthSession;

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    Socket.instances.push(this);
  }

  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }

  receive(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  disconnect(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function runtime() {
  return {
    incoming: null,
    active: null,
    availableCalls: [],
    busy: false,
    localStream: null,
    remoteStreams: [],
    muted: false,
    listenOnly: false,
    microphonePermission: "unknown",
    cameraOff: true,
    cameraPermission: "unknown",
    sharingScreen: false,
    screenStream: null,
    previewStream: null,
    remoteScreenSharingIds: [],
    remoteCameraEnabled: {},
    callElapsedSeconds: 0,
    recording: false,
    recordingElapsedSeconds: 0,
    recordingUploadState: "idle",
    recordingUploadedBytes: 0,
    recordingPendingBytes: 0,
    recordingUploadProgress: 0,
    connectionQuality: "good",
    reactions: [],
    status: "",
    audioReady: false,
    ringtoneAudible: false,
    isHost: false,
    devices: { microphones: [], cameras: [], speakers: [] },
    selectedMicrophoneId: "",
    selectedCameraId: "",
    selectedSpeakerId: "",
    screenShareQuality: "1080p",
    screenShareFps: 30,
    supportsSpeakerSelection: true,
    startCall: vi.fn().mockResolvedValue(undefined),
    acceptIncoming: vi.fn().mockResolvedValue(undefined),
    joinActiveCall: vi.fn().mockResolvedValue(undefined),
    rejectIncoming: vi.fn(),
    endCall: vi.fn().mockResolvedValue(undefined),
    leaveCall: vi.fn().mockResolvedValue(undefined),
    toggleMute: vi.fn(),
    toggleCamera: vi.fn(),
    requestCameraPermission: vi.fn().mockResolvedValue(true),
    toggleScreenShare: vi.fn().mockResolvedValue(undefined),
    startRecording: vi.fn().mockResolvedValue(undefined),
    stopRecording: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn(),
    meetingMessages: [],
    sendMeetingMessage: vi.fn().mockResolvedValue(undefined),
    toggleHand: vi.fn(),
    selectMicrophone: vi.fn().mockResolvedValue(undefined),
    selectCamera: vi.fn().mockResolvedValue(undefined),
    selectSpeaker: vi.fn(),
    selectScreenShareQuality: vi.fn().mockResolvedValue(undefined),
    selectScreenShareFps: vi.fn().mockResolvedValue(undefined),
    refreshDevices: vi.fn().mockResolvedValue(undefined),
    prepareAudio: vi.fn().mockResolvedValue(true),
    prepareCameraPreview: vi.fn().mockResolvedValue(true),
    handleSocketEvent: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn(),
    revokeAccess: vi.fn(),
  };
}

function Probe({ name = "phase" }: { name?: string }) {
  const { snapshot } = useCallSession();
  return <output aria-label={name}>{`${snapshot.phase}:${snapshot.socketState}`}</output>;
}

function ReconnectProbe() {
  const { snapshot } = useCallSession();
  return <output aria-label="reconnection-result">{snapshot.reconnectionNotice || "none"}</output>;
}

function ConversationProbe() {
  const { snapshot, commands } = useCallSession();
  const conversation = snapshot.conversation;
  return <>
    <output aria-label="call-conversation">{conversation
      ? `${conversation.thread.scope}:${conversation.thread.recipientId}:${conversation.messages.map((message) => message.text).join("|")}`
      : "none"}</output>
    <button type="button" onClick={() => void commands.sendMeetingMessage("Mensagem da chamada", [])}>Enviar na chamada</button>
  </>;
}

function PrejoinProbe() {
  const { snapshot, commands } = useCallSession();
  return <>
    <output aria-label="prejoin">{snapshot.prejoin
      ? `${snapshot.prejoin.thread.scope}:${snapshot.prejoin.thread.recipientId}:${snapshot.prejoin.microphoneMode}:${snapshot.prejoin.cameraEnabled}`
      : "none"}</output>
    <button type="button" onClick={() => void commands.start({ scope: "direct", title: "Member", recipientId: "member" })}>Preparar direta</button>
    <button type="button" onClick={() => commands.setEntryMicrophoneMode("listen-only")}>Somente escuta</button>
    <button type="button" onClick={() => commands.setEntryCameraEnabled(true)}>Ativar câmera</button>
    <button type="button" onClick={() => void commands.setEntryPreviewEnabled(true)}>Mostrar prévia</button>
    <button type="button" onClick={() => void commands.enter()}>Entrar agora</button>
  </>;
}

beforeEach(() => {
  Socket.instances = [];
  mocked.runtime = runtime();
  mocked.useTeamCallRuntime.mockReset();
  mocked.useTeamCallRuntime.mockImplementation(() => mocked.runtime);
  vi.stubGlobal("WebSocket", Socket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CallSession", () => {
  it("mantem as transicoes explicitas e permite recomecar depois de falha", () => {
    expect(transitionCallSession("idle", { type: "INVITE_RECEIVED" })).toBe("ringing");
    expect(transitionCallSession("ringing", { type: "JOIN_REQUESTED" })).toBe("joining");
    expect(transitionCallSession("joining", { type: "CONNECTED" })).toBe("connected");
    expect(transitionCallSession("connected", { type: "SOCKET_LOST" })).toBe("reconnecting");
    expect(transitionCallSession("reconnecting", { type: "CONNECTED" })).toBe("connected");
    expect(transitionCallSession("connected", { type: "END_REQUESTED" })).toBe("ending");
    expect(transitionCallSession("ending", { type: "RESET" })).toBe("idle");
    expect(transitionCallSession("joining", { type: "FAILED" })).toBe("failed");
    expect(transitionCallSession("failed", { type: "JOIN_REQUESTED" })).toBe("joining");
  });

  it("compartilha uma unica instancia entre consumidores e limpa o socket ao desmontar", async () => {
    const view = render(
      <CallSessionProvider session={authSession}>
        <Probe name="first" />
        <Probe name="second" />
      </CallSessionProvider>,
    );

    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    expect(mocked.useTeamCallRuntime).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("first")).toHaveTextContent("idle:connecting");
    expect(screen.getByLabelText("second")).toHaveTextContent("idle:connecting");

    view.unmount();
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
    expect(Socket.instances[0].onclose).toBeNull();
  });

  it("reconecta com um unico temporizador e reutiliza a mesma sessao", async () => {
    vi.useFakeTimers();
    render(<CallSessionProvider session={authSession}><Probe /></CallSessionProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(Socket.instances).toHaveLength(1);

    act(() => Socket.instances[0].open());
    expect(screen.getByLabelText("phase")).toHaveTextContent("idle:open");
    act(() => Socket.instances[0].disconnect());
    expect(screen.getByLabelText("phase")).toHaveTextContent("idle:reconnecting");

    await act(async () => {
      vi.advanceTimersByTime(1800);
      await Promise.resolve();
    });
    expect(Socket.instances).toHaveLength(2);
  });

  it("encerra midia e nao reconecta quando o servidor revoga o acesso", async () => {
    vi.useFakeTimers();
    mocked.runtime!.active = {
      callId: "call_test",
      hostUserId: "member",
      startedAt: new Date().toISOString(),
      mode: "audio",
      title: "Time todo",
      thread: { scope: "team", title: "Time todo" },
    };
    render(<CallSessionProvider session={authSession}><Probe /></CallSessionProvider>);
    await act(async () => { await Promise.resolve(); });
    act(() => Socket.instances[0].open());
    expect(mocked.runtime!.heartbeat).toHaveBeenCalledOnce();

    act(() => Socket.instances[0].disconnect(4403));
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    expect(mocked.runtime!.revokeAccess).toHaveBeenCalledWith("Seu acesso à chamada foi revogado.");
    expect(Socket.instances).toHaveLength(1);
    expect(screen.getByLabelText("phase")).toHaveTextContent("failed:closed");
  });

  it("roteia protocolo de chamada internamente e publica apenas o snapshot", async () => {
    const onIncomingCall = vi.fn();
    mocked.runtime!.handleSocketEvent.mockImplementation(async (event: Record<string, unknown>) => {
      mocked.runtime!.incoming = {
        callId: event.callId,
        fromUserId: event.fromUserId,
        fromUserName: event.fromUserName,
        mode: "audio",
        title: "Time todo",
        hostUserId: event.fromUserId,
        startedAt: new Date().toISOString(),
        thread: { scope: "team", title: "Time todo" },
      };
    });
    render(
      <CallSessionProvider session={authSession} onIncomingCall={onIncomingCall}>
        <Probe />
      </CallSessionProvider>,
    );
    await waitFor(() => expect(Socket.instances).toHaveLength(1));

    act(() => Socket.instances[0].receive({
      type: "CALL_INVITE",
      callId: "call_test",
      fromUserId: "member",
      fromUserName: "Member",
    }));

    expect(mocked.runtime?.handleSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ callId: "call_test" }));
    expect(onIncomingCall).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("phase")).toHaveTextContent("ringing");
  });

  it.each([
    { calls: [{ callId: "call_test" }], expected: "Chamada ainda ativa" },
    { calls: [], expected: "Chamada perdida" },
  ])("confirma o estado da chamada no servidor depois de reconectar: $expected", async ({ calls, expected }) => {
    vi.useFakeTimers();
    mocked.runtime!.active = {
      callId: "call_test",
      hostUserId: "owner",
      startedAt: new Date().toISOString(),
      mode: "audio",
      title: "Time todo",
      thread: { scope: "team", title: "Time todo" },
    };
    render(<CallSessionProvider session={authSession}><ReconnectProbe /></CallSessionProvider>);
    await act(async () => { await Promise.resolve(); });
    act(() => Socket.instances[0].open());
    act(() => Socket.instances[0].disconnect());
    await act(async () => { vi.advanceTimersByTime(1800); await Promise.resolve(); });
    act(() => Socket.instances[1].open());
    act(() => Socket.instances[1].receive({ type: "CALLS_STATE", calls }));

    expect(screen.getByLabelText("reconnection-result")).toHaveTextContent(expected);
  });

  it("mantem a conversa direta da chamada independente da conversa aberta no drawer", async () => {
    mocked.runtime!.active = {
      callId: "call_direct",
      mode: "audio",
      title: "Member",
      hostUserId: "owner",
      startedAt: new Date().toISOString(),
      thread: { scope: "direct", title: "Member", recipientId: "member" },
    };
    mocked.runtime!.meetingMessages = [{
      id: "message-1",
      senderId: "member",
      senderName: "Member",
      text: "Somente desta chamada",
      attachments: [],
      createdAt: new Date().toISOString(),
    }];
    mocked.runtime!.sendMeetingMessage = vi.fn().mockResolvedValue(undefined);

    render(<CallSessionProvider session={authSession}><ConversationProbe /></CallSessionProvider>);

    expect(screen.getByLabelText("call-conversation")).toHaveTextContent("direct:member:Somente desta chamada");
    screen.getByRole("button", { name: "Enviar na chamada" }).click();
    await waitFor(() => expect(mocked.runtime!.sendMeetingMessage).toHaveBeenCalledWith("Mensagem da chamada", []));
  });

  it("prepara a entrada e so inicia a chamada depois da confirmacao", async () => {
    mocked.runtime!.prepareAudio = vi.fn().mockResolvedValue(true);
    mocked.runtime!.prepareCameraPreview = vi.fn().mockResolvedValue(true);
    render(<CallSessionProvider session={authSession}><PrejoinProbe /></CallSessionProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Preparar direta" }));
    await waitFor(() => expect(screen.getByLabelText("prejoin")).toHaveTextContent("direct:member:muted:false"));
    expect(mocked.runtime!.startCall).not.toHaveBeenCalled();
    expect(mocked.runtime!.refreshDevices).toHaveBeenCalled();
    expect(mocked.runtime!.prepareAudio).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Ativar câmera" }));
    fireEvent.click(screen.getByRole("button", { name: "Mostrar prévia" }));
    await waitFor(() => expect(mocked.runtime!.prepareCameraPreview).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Somente escuta" }));
    expect(screen.getByLabelText("prejoin")).toHaveTextContent("direct:member:listen-only:false");
    fireEvent.click(screen.getByRole("button", { name: "Entrar agora" }));

    await waitFor(() => expect(mocked.runtime!.startCall).toHaveBeenCalledWith(
      { scope: "direct", title: "Member", recipientId: "member" },
      { microphoneMode: "listen-only", cameraEnabled: false },
    ));
  });

  it("mantem a pre-entrada aberta quando o navegador nega o dispositivo", async () => {
    mocked.runtime!.startCall = vi.fn().mockResolvedValue(false);
    mocked.runtime!.microphonePermission = "denied";
    render(<CallSessionProvider session={authSession}><PrejoinProbe /></CallSessionProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Preparar direta" }));
    await waitFor(() => expect(screen.getByLabelText("prejoin")).not.toHaveTextContent("none"));
    fireEvent.click(screen.getByRole("button", { name: "Entrar agora" }));

    await waitFor(() => expect(mocked.runtime!.startCall).toHaveBeenCalled());
    expect(screen.getByLabelText("prejoin")).toHaveTextContent("direct:member:muted:false");
  });

  it("prepara o audio depois de uma interacao valida do teclado", () => {
    render(<CallSessionProvider session={authSession}><Probe /></CallSessionProvider>);

    fireEvent.keyDown(window, { key: "Enter" });

    expect(mocked.runtime!.prepareAudio).toHaveBeenCalledOnce();
  });

  it("recusa um segundo proprietario da sessao", () => {
    expect(() => render(
      <CallSessionProvider session={authSession}>
        <CallSessionProvider session={authSession}><Probe /></CallSessionProvider>
      </CallSessionProvider>,
    )).toThrow("CallSessionProvider must be mounted only once.");
  });
});
