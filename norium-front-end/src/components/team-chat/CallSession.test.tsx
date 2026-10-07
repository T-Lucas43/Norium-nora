import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../../types/auth";
import type { MediaTransportFactory } from "./media/MediaTransport";

const mocked = vi.hoisted(() => ({
  runtime: null as Record<string, any> | null,
  useTeamCallRuntime: vi.fn(),
  apiRequest: vi.fn(),
}));

vi.mock("../../utils/api", () => ({
  authenticatedWebSocketUrl: async (url: string) => url,
  apiBaseUrl: () => "http://localhost",
  wsBaseUrl: () => "ws://localhost",
}));

vi.mock("./useTeamCall", () => ({
  SAFE_STUN_SERVERS: [{ urls: "stun:stun.example.test:3478" }],
  useTeamCallRuntime: (...args: unknown[]) => mocked.useTeamCallRuntime(...args),
}));

vi.mock("../../core/api/client", () => ({
  apiRequest: (...args: unknown[]) => mocked.apiRequest(...args),
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
    iceTelemetry: { lastState: "unknown", stateCounts: {}, pathTypeCounts: {}, lastSelectedPath: null, relayObserved: false },
    mediaTransport: "mesh",
    mediaTransportState: "connected",
    mediaTransportFailure: null,
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

function FailureProbe() {
  const { snapshot, commands } = useCallSession();
  return <>
    <output aria-label="call-failure">{snapshot.failureNotice || "none"}</output>
    <button type="button" onClick={commands.dismissFailure}>Dispensar falha</button>
  </>;
}

function IceProbe() {
  const { snapshot } = useCallSession();
  return <output aria-label="ice-service">{`${snapshot.iceService.status}:${snapshot.iceService.expiresAt || "none"}:${snapshot.iceService.detail}`}</output>;
}

function TransportProbe() {
  const { snapshot } = useCallSession();
  return <output aria-label="media-transport">{snapshot.mediaTransport}</output>;
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
    <output aria-label="entry-failure">{snapshot.failureNotice}</output>
    <button type="button" onClick={() => void commands.accept()}>Preparar convite</button>
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
  mocked.apiRequest.mockReset();
  mocked.apiRequest.mockResolvedValue({
    iceServers: [
      { urls: ["stun:stun.example.test:3478"] },
      {
        urls: ["turns:turn.example.test:5349?transport=tcp"],
        username: "temporary-user",
        credential: "temporary-password",
        credentialType: "password",
      },
    ],
    expiresAt: "2099-01-01T00:10:00+00:00",
    refreshAfter: "2099-01-01T00:08:00+00:00",
  });
  vi.stubGlobal("WebSocket", Socket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CallSession", () => {
  it("does not connect or request ICE when participation is disabled", async () => {
    render(<CallSessionProvider session={authSession} enabled={false}><Probe /></CallSessionProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(Socket.instances).toHaveLength(0);
    expect(mocked.apiRequest).not.toHaveBeenCalled();
  });

  it("closes the active socket when participation is revoked", async () => {
    const view = render(<CallSessionProvider session={authSession} enabled><Probe /></CallSessionProvider>);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    act(() => Socket.instances[0].open());
    view.rerender(<CallSessionProvider session={authSession} enabled={false}><Probe /></CallSessionProvider>);
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
    expect(mocked.runtime?.revokeAccess).toHaveBeenCalledOnce();
  });

  it("carrega credenciais ICE temporarias sem expo-las no snapshot", async () => {
    render(<CallSessionProvider session={authSession}><IceProbe /></CallSessionProvider>);

    await waitFor(() => expect(screen.getByLabelText("ice-service")).toHaveTextContent("ready:2099-01-01T00:10:00+00:00"));
    expect(mocked.apiRequest).toHaveBeenCalledWith("/api/team-chat/calls/ice-servers", {
      token: "test-token",
      timeoutMs: 8000,
    });
    expect(mocked.useTeamCallRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      iceServers: expect.arrayContaining([
        expect.objectContaining({ urls: ["turns:turn.example.test:5349?transport=tcp"] }),
      ]),
    }));
    expect(screen.getByLabelText("ice-service").textContent).not.toContain("temporary-password");
  });

  it("renova credenciais ICE antes da expiracao em chamadas longas", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    mocked.apiRequest
      .mockResolvedValueOnce({
        iceServers: [{ urls: "turns:turn.example.test:5349", username: "first", credential: "first-secret" }],
        expiresAt: "2026-09-04T12:01:00Z",
        refreshAfter: "2026-09-04T12:00:01Z",
      })
      .mockResolvedValueOnce({
        iceServers: [{ urls: "turns:turn.example.test:5349", username: "second", credential: "second-secret" }],
        expiresAt: "2026-09-04T12:11:00Z",
        refreshAfter: "2026-09-04T12:09:00Z",
      });

    const view = render(<CallSessionProvider session={authSession}><IceProbe /></CallSessionProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(mocked.apiRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(mocked.apiRequest).toHaveBeenCalledTimes(2);
    expect(mocked.useTeamCallRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      iceServers: [expect.objectContaining({ username: "second" })],
    }));
    view.unmount();
  });

  it("mantem fallback STUN e informa indisponibilidade sem vazar detalhes", async () => {
    mocked.apiRequest.mockRejectedValue(new Error("upstream secret diagnostic"));
    render(<CallSessionProvider session={authSession}><IceProbe /></CallSessionProvider>);

    await waitFor(() => expect(screen.getByLabelText("ice-service")).toHaveTextContent("unavailable:none:TURN indisponível"));
    expect(screen.getByLabelText("ice-service").textContent).not.toContain("upstream secret diagnostic");
    const configuration = mocked.useTeamCallRuntime.mock.lastCall?.[0];
    expect(configuration.iceServers).toEqual([
      { urls: "stun:stun.example.test:3478" },
    ]);
    expect(JSON.stringify(configuration.iceServers)).not.toContain("credential");
  });

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
    expect(mocked.useTeamCallRuntime).toHaveBeenCalled();
    expect(screen.getByLabelText("first")).toHaveTextContent("idle:connecting");
    expect(screen.getByLabelText("second")).toHaveTextContent("idle:connecting");

    view.unmount();
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
    expect(Socket.instances[0].onclose).toBeNull();
  });

  it.each([false, true])("marca a retomada automática como conectada (convite=%s)", async (invited) => {
    const view = render(<CallSessionProvider session={authSession}><Probe /></CallSessionProvider>);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    act(() => Socket.instances[0].open());
    if (invited) act(() => Socket.instances[0].receive({ type: "CALL_INVITE", callId: "restored", fromUserId: "member" }));
    mocked.runtime!.active = {
      callId: "restored", hostUserId: "owner", thread: { scope: "team", title: "Time todo" },
    };
    view.rerender(<CallSessionProvider session={authSession}><Probe /></CallSessionProvider>);
    expect(screen.getByLabelText("phase")).toHaveTextContent("connected:open");
  });

  it("encaminha uma fabrica SFU estreita para selecao por chamada", async () => {
    const create = vi.fn();
    const sfuFactory = {
      kind: "sfu" as const,
      create,
    } satisfies MediaTransportFactory;
    mocked.runtime!.mediaTransport = "sfu";
    render(
      <CallSessionProvider
        session={authSession}
        mediaTransports={[sfuFactory]}
      >
        <TransportProbe />
      </CallSessionProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("media-transport")).toHaveTextContent("sfu"));
    expect(mocked.useTeamCallRuntime).toHaveBeenCalledWith(expect.objectContaining({ mediaTransports: [sfuFactory] }));
    expect(create).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(1);
  });

  it("registra o transporte LiveKit dormente sem solicitar credenciais", async () => {
    render(<CallSessionProvider session={authSession}><TransportProbe /></CallSessionProvider>);

    await waitFor(() => expect(mocked.useTeamCallRuntime).toHaveBeenCalled());
    const options = mocked.useTeamCallRuntime.mock.calls.at(-1)?.[0] as {
      mediaTransports?: readonly MediaTransportFactory[];
    };
    expect(options.mediaTransports?.map((factory) => factory.kind)).toContain("sfu");
    expect(options.mediaTransports?.find((factory) => factory.kind === "sfu")?.create).toBeTypeOf("function");
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

  it.each(["false", "throw"])("explica falha de ingresso pelo convite (%s)", async (failure) => {
    mocked.runtime!.incoming = { callId: "invite", title: "Member", thread: { scope: "direct", title: "Member", recipientId: "member" } };
    mocked.runtime!.acceptIncoming = failure === "false" ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(new Error("synthetic private detail"));
    render(<CallSessionProvider session={authSession}><PrejoinProbe /></CallSessionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Preparar convite" }));
    await waitFor(() => expect(screen.getByLabelText("prejoin")).not.toHaveTextContent("none"));
    fireEvent.click(screen.getByRole("button", { name: "Entrar agora" }));
    await waitFor(() => expect(screen.getByLabelText("entry-failure")).toHaveTextContent("Não foi possível entrar"));
    expect(screen.getByLabelText("prejoin")).not.toHaveTextContent("none");
  });

  it("prepara o audio depois de uma interacao valida do teclado", async () => {
    render(<CallSessionProvider session={authSession}><Probe /></CallSessionProvider>);
    await waitFor(() => expect(mocked.useTeamCallRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      iceServers: expect.arrayContaining([expect.objectContaining({ username: "temporary-user" })]),
    })));

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

  it("mantem a rejeicao de capacidade util ate o usuario dispensar", async () => {
    render(<CallSessionProvider session={authSession}><FailureProbe /></CallSessionProvider>);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));

    act(() => Socket.instances[0].receive({
      type: "CALL_ERROR",
      code: "call_capacity_reached",
      callId: "call_full",
      detail: "Esta chamada atingiu o limite de 6 participantes. Tente novamente quando alguém sair.",
    }));

    expect(screen.getByLabelText("call-failure")).toHaveTextContent("limite de 6 participantes");
    fireEvent.click(screen.getByRole("button", { name: "Dispensar falha" }));
    expect(screen.getByLabelText("call-failure")).toHaveTextContent("none");
  });
});
