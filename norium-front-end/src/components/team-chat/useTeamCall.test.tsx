import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../../types/auth";
import {
  fetchRecordingWithRetry,
  recordingNeedsBackpressure,
  useTeamCallRuntime,
} from "./useTeamCall";
import type {
  MediaTransport,
  MediaTransportFactory,
  MediaTransportSnapshot,
} from "./media/MediaTransport";

const session = {
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

describe("chamadas do Modo Equipe", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ calls: [] }) }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("entra em chamada de audio silenciada sem solicitar acesso a camera", async () => {
    const audioStop = vi.fn();
    const audioTrack = { kind: "audio", enabled: true, stop: audioStop } as unknown as MediaStreamTrack;
    const audioStream = {
      getTracks: () => [audioTrack],
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValueOnce(audioStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result, unmount } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
    }));

    await act(async () => result.current.startCall(undefined, {
      microphoneMode: "muted",
      cameraEnabled: false,
    }));

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "CALL_INVITE",
      mode: "audio",
      scope: "team",
    }));
    expect(result.current.active?.title).toBe("Time todo");
    expect(result.current.cameraOff).toBe(true);
    expect(result.current.cameraPermission).toBe("unknown");
    expect(result.current.muted).toBe(true);
    expect(audioTrack.enabled).toBe(false);

    vi.stubGlobal("MediaRecorder", class {});
    const confirmRecording = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => result.current.startRecording());
    expect(confirmRecording).toHaveBeenCalledWith(expect.stringContaining("Todos os participantes serão avisados"));
    expect(result.current.recording).toBe(false);
    expect(result.current.status).toBe("Gravação não iniciada.");

    await act(async () => { await result.current.endCall(); });
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_END" }));
    expect(audioStop).toHaveBeenCalled();
    unmount();
  });

  it.each([false, true])("retoma a mesma chamada automaticamente após recarregar a página (StrictMode=%s)", async (strict) => {
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const mount = () => renderHook(() => useTeamCallRuntime({
      session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent,
    }), { wrapper: strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined });
    const first = mount();
    await act(async () => first.result.current.startCall(undefined, { microphoneMode: "listen-only", cameraEnabled: false }));
    const callId = first.result.current.active!.callId;
    const clientId = first.result.current.clientId;
    await act(async () => first.result.current.handleSocketEvent({
      type: "CALL_ACK", callId, event: "CALL_INVITE", mediaTransport: "mesh",
    }));
    expect(JSON.parse(sessionStorage.getItem("norium.team-call.reload") || "null")).toEqual(expect.objectContaining({ callId, clientId }));
    act(() => window.dispatchEvent(new Event("pagehide")));
    first.unmount();
    sendSocketEvent.mockClear();
    const reloaded = mount();
    await act(async () => reloaded.result.current.handleSocketEvent({ type: "CALLS_STATE", calls: [{
      type: "CALL_ACTIVE", callId, fromUserId: "owner", fromUserName: "Owner",
      scope: "team", threadId: "team", mode: "audio", mediaTransport: "mesh",
      joinedUserIds: ["owner", "member"],
    }] }));
    expect(reloaded.result.current.active?.callId).toBe(callId);
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_ACCEPT", callId, clientId }));
    expect(sendSocketEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_INVITE" }));
    expect(reloaded.result.current.listenOnly).toBe(true);
    reloaded.unmount();
  });

  it.each(["ended", "other-user", "expired", "invalid"])("não retoma uma sessão %s", async (kind) => {
    sessionStorage.setItem("norium.team-call.reload", kind === "invalid" ? "invalid-json" : JSON.stringify({
      userId: kind === "other-user" ? "someone-else" : "owner", callId: "old-call", clientId: "old-client",
      savedAt: Date.now() - (kind === "expired" ? 301_000 : 0), microphoneMode: "on", cameraEnabled: true,
    }));
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    const { result, unmount } = renderHook(() => useTeamCallRuntime({
      session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent,
    }));
    await act(async () => result.current.handleSocketEvent({ type: "CALLS_STATE", calls: kind === "ended" ? [] : [{
      type: "CALL_ACTIVE", callId: "old-call", fromUserId: "owner", scope: "team", mediaTransport: "mesh",
    }] }));
    expect(result.current.active).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sendSocketEvent).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("norium.team-call.reload")).toBeNull();
    unmount();
  });

  it.each(["leaveCall", "endCall"] as const)("não guarda retomada após %s", async (command) => {
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result, unmount } = renderHook(() => useTeamCallRuntime({
      session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent,
    }));
    await act(async () => result.current.startCall(undefined, { microphoneMode: "listen-only", cameraEnabled: false }));
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACK", callId: result.current.active!.callId, event: "CALL_INVITE", mediaTransport: "mesh",
    }));
    await act(async () => result.current[command]());
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(sessionStorage.getItem("norium.team-call.reload")).toBeNull();
    unmount();
  });

  it("seleciona mesh ou SFU por chamada e ignora eventos atrasados da anterior", async () => {
    const instances: Array<MediaTransport & { receive: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const makeFactory = (kind: "mesh" | "sfu"): MediaTransportFactory => ({
      kind,
      create: () => {
        const snapshot: MediaTransportSnapshot = {
          state: "connected", failure: null,
          remoteStreams: [], connectionQuality: "good",
          iceTelemetry: { lastState: "unknown", stateCounts: {}, pathTypeCounts: {}, lastSelectedPath: null, relayObserved: false },
        };
        const receive = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn().mockResolvedValue(undefined);
        const transport = {
          kind,
          open: vi.fn().mockResolvedValue(undefined),
          receive,
          updateLocalMedia: vi.fn().mockResolvedValue(undefined),
          updateIce: vi.fn(),
          updateScreenProfile: vi.fn().mockResolvedValue(undefined),
          snapshot: () => snapshot,
          subscribe: (listener: (value: MediaTransportSnapshot) => void) => { listener(snapshot); return vi.fn(); },
          close,
        } as MediaTransport & { receive: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
        instances.push(transport);
        return transport;
      },
    });
    const mesh = makeFactory("mesh");
    const sfu = makeFactory("sfu");
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
      mediaTransports: [mesh, sfu],
    }));

    await act(async () => result.current.startCall(undefined, { microphoneMode: "listen-only", cameraEnabled: false }));
    const oldCallId = result.current.active?.callId || "";
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACK", callId: oldCallId, event: "CALL_INVITE", mediaTransport: "mesh",
    }));
    expect(result.current.mediaTransport).toBe("mesh");
    expect(instances).toHaveLength(1);
    await act(async () => result.current.leaveCall());
    expect(instances[0].close).toHaveBeenCalledOnce();

    await act(async () => result.current.handleSocketEvent({
      type: "CALL_INVITE", callId: "call_sfu", threadId: "team", scope: "team",
      fromUserId: "member", fromUserName: "Member", mediaTransport: "sfu",
    }));
    await act(async () => result.current.acceptIncoming({ microphoneMode: "listen-only", cameraEnabled: false }));
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACK", callId: "call_sfu", event: "CALL_ACCEPT", mediaTransport: "sfu",
    }));
    expect(result.current.mediaTransport).toBe("sfu");
    expect(instances).toHaveLength(2);

    await act(async () => result.current.handleSocketEvent({
      type: "CALL_SIGNAL", callId: "call_sfu", fromUserId: "member",
      signal: { type: "offer", sdp: "current" },
    }));
    expect(instances).toHaveLength(2);
    expect(instances[1].receive).toHaveBeenCalledWith(expect.objectContaining({ callId: "call_sfu" }));

    await act(async () => result.current.handleSocketEvent({
      type: "CALL_SIGNAL", callId: oldCallId, fromUserId: "member",
      signal: { type: "offer", sdp: "stale" },
    }));
    expect(instances[1].receive).not.toHaveBeenCalledWith(expect.objectContaining({ callId: oldCallId }));
  });

  it("aguarda o ACK autoritativo antes de abrir SFU e tolera estado anterior ao ACK", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const snapshot: MediaTransportSnapshot = {
      state: "connected", failure: null, remoteStreams: [], connectionQuality: "good",
      iceTelemetry: { lastState: "unknown", stateCounts: {}, pathTypeCounts: {}, lastSelectedPath: null, relayObserved: false },
    };
    const sfuFactory: MediaTransportFactory = {
      kind: "sfu",
      create: () => ({
        kind: "sfu",
        open,
        receive: vi.fn().mockResolvedValue(undefined),
        updateLocalMedia: vi.fn().mockResolvedValue(undefined),
        updateIce: vi.fn(),
        updateScreenProfile: vi.fn().mockResolvedValue(undefined),
        snapshot: () => snapshot,
        subscribe: (listener) => { listener(snapshot); return vi.fn(); },
        close: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
      mediaTransports: [sfuFactory],
    }));

    await act(async () => result.current.startCall(undefined, { microphoneMode: "listen-only", cameraEnabled: false }));
    const invitation = sendSocketEvent.mock.calls.find(([event]) => event.type === "CALL_INVITE")?.[0];
    const callId = invitation.callId as string;
    expect(open).not.toHaveBeenCalled();

    await act(async () => result.current.handleSocketEvent({
      type: "CALL_SESSION", callId, fromUserId: "owner", clientId: invitation.clientId,
    }));
    await act(async () => result.current.handleSocketEvent({
      type: "CALLS_STATE",
      calls: [{ type: "CALL_INVITE", callId, scope: "team", threadId: "team", fromUserId: "owner", mediaTransport: "sfu" }],
    }));
    expect(result.current.active?.callId).toBe(callId);
    expect(open).not.toHaveBeenCalled();

    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACK", callId, event: "CALL_INVITE", mediaTransport: "sfu",
    }));

    expect(open).toHaveBeenCalledWith(
      { callId, selfUserId: "owner", clientId: invitation.clientId },
      expect.objectContaining({ localStream: null }),
    );
    expect(result.current.mediaTransport).toBe("sfu");
  });

  it("compensa uma admissao cujo transporte falha antes de limpar a sessao", async () => {
    const failure = new Error("Não foi possível conectar a mídia da chamada.");
    const snapshot: MediaTransportSnapshot = {
      state: "failed",
      failure: { code: "sfu_connect_failed", detail: failure.message, retryable: true },
      remoteStreams: [], connectionQuality: "offline",
      iceTelemetry: { lastState: "failed", stateCounts: { failed: 1 }, pathTypeCounts: {}, lastSelectedPath: null, relayObserved: false },
    };
    const failingSfu: MediaTransportFactory = {
      kind: "sfu",
      create: () => ({
        kind: "sfu",
        open: vi.fn().mockRejectedValue(failure),
        receive: vi.fn().mockResolvedValue(undefined),
        updateLocalMedia: vi.fn().mockResolvedValue(undefined),
        updateIce: vi.fn(),
        updateScreenProfile: vi.fn().mockResolvedValue(undefined),
        snapshot: () => snapshot,
        subscribe: (listener) => { listener(snapshot); return vi.fn(); },
        close: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
      mediaTransports: [failingSfu],
    }));

    await act(async () => result.current.startCall(undefined, { microphoneMode: "listen-only", cameraEnabled: false }));
    const callId = result.current.active?.callId;
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACK", callId, event: "CALL_INVITE", mediaTransport: "sfu",
    }));

    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_END", callId }));
    expect(result.current.active).toBeNull();
    expect(result.current.status).toBe(failure.message);
  });

  it("encerra no servidor uma admissao sem ACK antes de limpar a captura", async () => {
    vi.useFakeTimers();
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
    }));

    await act(async () => result.current.startCall(undefined, { microphoneMode: "listen-only", cameraEnabled: false }));
    const callId = result.current.active?.callId;
    await act(async () => { await vi.advanceTimersByTimeAsync(8_100); });

    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_END", callId }));
    expect(result.current.active).toBeNull();
    expect(result.current.status).toContain("confirmar sua entrada");
  });

  it("sempre encerra a captura local mesmo se o adapter falhar ao fechar", async () => {
    const audioTrack = {
      kind: "audio", enabled: true, readyState: "live", stop: vi.fn(), onended: null,
    } as unknown as MediaStreamTrack;
    const audioStream = {
      getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack], getVideoTracks: () => [],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(audioStream) },
    });
    const snapshot: MediaTransportSnapshot = {
      state: "connected", failure: null, remoteStreams: [], connectionQuality: "good",
      iceTelemetry: { lastState: "unknown", stateCounts: {}, pathTypeCounts: {}, lastSelectedPath: null, relayObserved: false },
    };
    const close = vi.fn(() => { throw new Error("adapter close failed"); });
    const failingFactory: MediaTransportFactory = {
      kind: "mesh",
      create: () => ({
        kind: "mesh",
        open: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockResolvedValue(undefined),
        updateLocalMedia: vi.fn().mockResolvedValue(undefined),
        updateIce: vi.fn(),
        updateScreenProfile: vi.fn().mockResolvedValue(undefined),
        snapshot: () => snapshot,
        subscribe: (listener) => { listener(snapshot); return vi.fn(); },
        close,
      }),
    };
    const { result } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent: vi.fn().mockReturnValue(true),
      mediaTransports: [failingFactory],
    }));

    await act(async () => result.current.startCall());
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACK", callId: result.current.active?.callId,
      event: "CALL_INVITE", mediaTransport: "mesh",
    }));
    await act(async () => result.current.leaveCall());

    expect(close).toHaveBeenCalledOnce();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(result.current.active).toBeNull();
  });

  it("entra em modo somente escuta sem solicitar microfone nem camera", async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: vi.fn().mockResolvedValue([]) },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
    }));

    await act(async () => result.current.startCall(undefined, {
      microphoneMode: "listen-only",
      cameraEnabled: false,
    }));

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.localStream).toBeNull();
    expect(result.current.muted).toBe(true);
    expect(result.current.listenOnly).toBe(true);
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_INVITE" }));
  });

  it("lista e troca microfone, camera e saida de audio durante a chamada", async () => {
    const oldAudio = { id: "old-audio", kind: "audio", enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
    const oldVideo = { id: "old-video", kind: "video", enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
    const permissionVideo = { id: "permission-video", kind: "video", enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
    const newAudio = { id: "new-audio", kind: "audio", enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
    class FakeMediaStream {
      tracks: MediaStreamTrack[];
      constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks; }
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
      getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
    }
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const permissionStream = new FakeMediaStream([permissionVideo]) as unknown as MediaStream;
    const initialStream = new FakeMediaStream([oldAudio]) as unknown as MediaStream;
    const cameraStream = new FakeMediaStream([oldVideo]) as unknown as MediaStream;
    const replacementStream = new FakeMediaStream([newAudio]) as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValueOnce(initialStream).mockResolvedValueOnce(permissionStream).mockResolvedValueOnce(cameraStream).mockResolvedValueOnce(replacementStream);
    const enumerateDevices = vi.fn().mockResolvedValue([
      { deviceId: "mic-1", kind: "audioinput", label: "Microfone interno" },
      { deviceId: "mic-2", kind: "audioinput", label: "Headset" },
      { deviceId: "cam-1", kind: "videoinput", label: "Webcam" },
      { deviceId: "speaker-1", kind: "audiooutput", label: "Caixa de som" },
    ]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
    }));

    await act(async () => result.current.startCall());
    expect(result.current.devices.microphones).toHaveLength(2);
    expect(result.current.selectedCameraId).toBe("");

    await act(async () => result.current.toggleCamera());
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    expect(result.current.cameraOff).toBe(false);

    await act(async () => result.current.selectMicrophone("mic-2"));
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: {
        autoGainControl: true,
        deviceId: { exact: "mic-2" },
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    expect(result.current.selectedMicrophoneId).toBe("mic-2");
    expect(oldAudio.stop).toHaveBeenCalled();

    act(() => result.current.selectSpeaker("speaker-1"));
    expect(result.current.selectedSpeakerId).toBe("speaker-1");
    await act(async () => { await result.current.endCall(); });
  });

  it("responde uma chamada individual usando o organizador como destinatario", async () => {
    const audioTrack = { kind: "audio", enabled: true, readyState: "live", stop: vi.fn() } as unknown as MediaStreamTrack;
    const audioStream = {
      getTracks: () => [audioTrack],
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValueOnce(audioStream), enumerateDevices: vi.fn().mockResolvedValue([]) },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const memberSession = { ...session, user: { ...session.user, id: "member", nome: "Member", role: "member" as const } };
    const { result } = renderHook(() => useTeamCallRuntime({
      session: memberSession,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
    }));

    await act(async () => result.current.handleSocketEvent({
      type: "CALL_INVITE",
      callId: "call_0123456789abcdef",
      scope: "direct",
      recipientId: "member",
      fromUserId: "owner",
      fromUserName: "Owner",
      startedAt: new Date().toISOString(),
    }));
    await act(async () => result.current.acceptIncoming());

    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "CALL_ACCEPT",
      scope: "direct",
      recipientId: "owner",
    }));
  });

  it("envia mensagens pelo contexto da chamada direta, nao pela conversa selecionada no drawer", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: vi.fn().mockResolvedValue([]) },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    const { result } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
    }));

    await act(async () => result.current.startCall(
      { scope: "direct", title: "Member", recipientId: "member" },
      { microphoneMode: "listen-only", cameraEnabled: false },
    ));
    await act(async () => result.current.sendMeetingMessage("Mensagem privada da chamada", []));

    const callId = result.current.active?.callId;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/calls/${callId}/messages`),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Mensagem privada da chamada"),
      }),
    );
  });

  it("explica permissao de microfone negada e nao cria a chamada", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("Bloqueado", "NotAllowedError"));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));

    await act(async () => result.current.startCall(undefined, { microphoneMode: "muted", cameraEnabled: false }));

    expect(result.current.microphonePermission).toBe("denied");
    expect(result.current.status).toContain("microfone");
    expect(result.current.active).toBeNull();
    expect(sendSocketEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_INVITE" }));
  });

  it("so solicita camera quando o usuario pede a previa e a libera ao ocultar", async () => {
    const stop = vi.fn();
    const track = { kind: "video", enabled: true, stop, onended: null } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track], getAudioTracks: () => [], getVideoTracks: () => [track] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
    });
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent: vi.fn().mockReturnValue(true) }));

    let prepared = false;
    await act(async () => { prepared = await result.current.prepareCameraPreview(true); });
    expect(prepared).toBe(true);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    expect(result.current.previewStream).toBe(stream);
    await act(async () => { await result.current.prepareCameraPreview(false); });
    expect(stop).toHaveBeenCalledOnce();
    expect(result.current.previewStream).toBeNull();
  });

  it("limpa convite pendente ao encerrar e ignora reenvio atrasado", async () => {
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));
    const invite = { type: "CALL_INVITE", callId: "call_0123456789abcdef", fromUserId: "member", scope: "team" as const, threadId: "team" };
    await act(async () => result.current.handleSocketEvent(invite));
    expect(result.current.incoming?.callId).toBe(invite.callId);
    await act(async () => result.current.handleSocketEvent({ ...invite, type: "CALL_END" }));
    expect(result.current.incoming).toBeNull();
    expect(result.current.availableCalls).toHaveLength(0);
    await act(async () => result.current.handleSocketEvent(invite));
    expect(result.current.incoming).toBeNull();
  });

  it("sincroniza reuniao ativa sem tocar e permite ingressar depois de recusar", async () => {
    const audio = { kind: "audio", enabled: true, stop: vi.fn() };
    const stream = { getTracks: () => [audio], getAudioTracks: () => [audio], getVideoTracks: () => [] };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValueOnce(stream) } });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));
    const invite = { type: "CALL_INVITE", callId: "call_0123456789abcdef", fromUserId: "member", scope: "team" as const, threadId: "team" };
    await act(async () => result.current.handleSocketEvent({ type: "CALLS_STATE", calls: [invite] }));
    expect(result.current.incoming).toBeNull();
    expect(result.current.availableCalls).toHaveLength(1);
    await act(async () => result.current.handleSocketEvent(invite));
    act(() => result.current.rejectIncoming());
    await act(async () => result.current.handleSocketEvent(invite));
    expect(result.current.incoming).toBeNull();
    await act(async () => result.current.startCall());
    expect(result.current.active?.callId).toBe(invite.callId);
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_ACCEPT", callId: invite.callId }));
    expect(sendSocketEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_INVITE" }));
  });

  it("nao reabre a chamada se ela terminar enquanto o microfone pede permissao", async () => {
    let resolveMedia!: (stream: unknown) => void;
    const deferred = new Promise((resolve) => { resolveMedia = resolve; });
    const audio = { kind: "audio", enabled: true, stop: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockReturnValueOnce(deferred) } });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));
    const invite = { type: "CALL_INVITE", callId: "call_0123456789abcdef", fromUserId: "member", scope: "team" as const, threadId: "team" };
    await act(async () => result.current.handleSocketEvent(invite));
    let joining!: Promise<boolean>;
    await act(async () => { joining = result.current.acceptIncoming(); });
    await act(async () => result.current.handleSocketEvent({ ...invite, type: "CALL_END" }));
    await act(async () => {
      resolveMedia({ getTracks: () => [audio], getAudioTracks: () => [audio], getVideoTracks: () => [] });
      await joining;
    });
    expect(result.current.active).toBeNull();
    expect(result.current.incoming).toBeNull();
    expect(audio.stop).toHaveBeenCalled();
    expect(sendSocketEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_ACCEPT" }));
  });

  it.each(["camera", "screen"])("descarta %s autorizada depois que a reunião foi encerrada", async (kind) => {
    const permissionVideo = { kind: "video", stop: vi.fn() };
    const audio = { kind: "audio", enabled: true, stop: vi.fn() };
    const delayedVideo = { kind: "video", stop: vi.fn() };
    const stream = (tracks: typeof audio[]) => ({
      getTracks: () => tracks,
      getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
      getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
    });
    let resolveMedia!: (value: unknown) => void;
    const delayed = new Promise((resolve) => { resolveMedia = resolve; });
    const getUserMedia = vi.fn().mockResolvedValueOnce(stream([audio]));
    if (kind === "camera") getUserMedia.mockReturnValueOnce(delayed);
    else getUserMedia.mockResolvedValueOnce(stream([permissionVideo as typeof audio]));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia,
      getDisplayMedia: vi.fn().mockReturnValue(delayed),
    } });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result, unmount } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));
    await act(async () => result.current.startCall());
    let enabling!: Promise<void>;
    act(() => { enabling = kind === "camera" ? result.current.toggleCamera() : result.current.toggleScreenShare(); });
    await act(async () => result.current.endCall());
    await act(async () => { resolveMedia(stream([delayedVideo as typeof audio])); await enabling; });
    expect(result.current.active).toBeNull();
    expect(result.current.localStream).toBeNull();
    expect(result.current.screenStream).toBeNull();
    expect(delayedVideo.stop).toHaveBeenCalled();
    expect(sendSocketEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_SCREEN_STARTED" }));
    unmount();
  });

  it("bloqueia clique duplo ao iniciar e fecha sem esperar resposta HTTP", async () => {
    let resolveAudio!: (stream: unknown) => void;
    const audioPromise = new Promise((resolve) => { resolveAudio = resolve; });
    const audio = { kind: "audio", enabled: true, stop: vi.fn() };
    const audioStream = { getTracks: () => [audio], getAudioTracks: () => [audio], getVideoTracks: () => [] };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockReturnValueOnce(audioPromise) } });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));
    let starting!: Promise<boolean>;
    await act(async () => { starting = result.current.startCall(); await result.current.startCall(); });
    await act(async () => { resolveAudio(audioStream); await starting; });
    expect(sendSocketEvent.mock.calls.filter(([event]) => event.type === "CALL_INVITE")).toHaveLength(1);
    let resolveEnd!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((resolve) => { resolveEnd = resolve; })));
    let ending!: Promise<void>;
    await act(async () => { ending = result.current.endCall(); });
    expect(result.current.active).toBeNull();
    expect(audio.stop).toHaveBeenCalled();
    await act(async () => { resolveEnd({ ok: true }); await ending; });
  });

  it("reserva o canal de video e transmite camera e tela aos participantes", async () => {
    const permissionVideo = { kind: "video", enabled: true, readyState: "live", stop: vi.fn() } as unknown as MediaStreamTrack;
    const audioTrack = { kind: "audio", enabled: true, readyState: "live", stop: vi.fn() } as unknown as MediaStreamTrack;
    const cameraTrack = { kind: "video", enabled: true, readyState: "live", stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const screenTrack = { kind: "video", enabled: true, readyState: "live", stop: vi.fn(), onended: null, contentHint: "", applyConstraints } as unknown as MediaStreamTrack;
    const remoteAudioTrack = { id: "remote-audio", kind: "audio", enabled: true, readyState: "live", muted: false, stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
    const remoteScreenTrack = { id: "remote-screen", kind: "video", enabled: true, readyState: "live", muted: false, stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
    class FakeMediaStream {
      tracks: MediaStreamTrack[];
      constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks; }
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
      getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
    }
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const permissionStream = new FakeMediaStream([permissionVideo]) as unknown as MediaStream;
    const audioStream = new FakeMediaStream([audioTrack]) as unknown as MediaStream;
    const cameraStream = new FakeMediaStream([cameraTrack]) as unknown as MediaStream;
    const displayStream = new FakeMediaStream([screenTrack]) as unknown as MediaStream;
    const screenAudioConstraints = vi.fn().mockResolvedValue(undefined);
    const screenAudioTrack = { id: "screen-audio", kind: "audio", enabled: true, readyState: "live", stop: vi.fn(), contentHint: "", applyConstraints: screenAudioConstraints } as unknown as MediaStreamTrack;
    (displayStream as unknown as FakeMediaStream).tracks.push(screenAudioTrack);
    const replaceTrack = vi.fn().mockResolvedValue(undefined);
    const videoSender = { track: null, replaceTrack } as unknown as RTCRtpSender;
    const screenAudioSender = { track: null, replaceTrack: vi.fn().mockResolvedValue(undefined) };
    const peerInstances: FakePeerConnection[] = [];
    class FakePeerConnection {
      signalingState = "stable";
      connectionState = "connected";
      localDescription: RTCSessionDescription | null = null;
      remoteDescription: RTCSessionDescription | null = null;
      onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
      ontrack: ((event: RTCTrackEvent) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      constructor() { peerInstances.push(this); }
      addTrack(track: MediaStreamTrack) { return { track, replaceTrack: vi.fn() } as unknown as RTCRtpSender; }
      addTransceiver(kind: string) { return { sender: kind === "video" ? videoSender : screenAudioSender } as RTCRtpTransceiver; }
      createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "offer" });
      setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => { this.localDescription = description as RTCSessionDescription; });
      close = vi.fn();
    }
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    const getUserMedia = vi.fn().mockResolvedValueOnce(audioStream).mockResolvedValueOnce(permissionStream).mockResolvedValueOnce(cameraStream);
    const getDisplayMedia = vi.fn().mockResolvedValue(displayStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, getDisplayMedia, enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));

    await act(async () => result.current.startCall());
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACK", callId: result.current.active?.callId,
      event: "CALL_INVITE", mediaTransport: "mesh",
    }));
    await act(async () => result.current.handleSocketEvent({ type: "CALL_ACCEPT", callId: result.current.active?.callId, fromUserId: "member", fromUserName: "Member" }));
    const peer = peerInstances[0];
    await act(async () => {
      peer.ontrack?.({ track: remoteAudioTrack, streams: [new FakeMediaStream([remoteAudioTrack]) as unknown as MediaStream] } as unknown as RTCTrackEvent);
      peer.ontrack?.({ track: remoteScreenTrack, streams: [] } as unknown as RTCTrackEvent);
    });
    expect(result.current.remoteStreams).toHaveLength(1);
    expect(result.current.remoteStreams[0].stream.getAudioTracks()).toEqual([remoteAudioTrack]);
    expect(result.current.remoteStreams[0].stream.getVideoTracks()).toEqual([remoteScreenTrack]);
    const remoteSharedAudio = { ...remoteAudioTrack, id: "remote-shared-audio" };
    await act(async () => peer.ontrack?.({ track: remoteSharedAudio, streams: [] } as unknown as RTCTrackEvent));
    expect(result.current.remoteStreams[0].stream.getAudioTracks()).toEqual([remoteAudioTrack, remoteSharedAudio]);
    await act(async () => result.current.handleSocketEvent({ type: "CALL_MEDIA_STATE", callId: result.current.active?.callId, fromUserId: "member", cameraEnabled: false, screenSharing: false }));
    expect(result.current.remoteCameraEnabled.member).toBe(false);
    await act(async () => result.current.handleSocketEvent({ type: "CALL_SCREEN_STARTED", callId: result.current.active?.callId, fromUserId: "member", fromUserName: "Member" }));
    expect(result.current.remoteScreenSharingIds).toContain("member");
    // A faixa remota ja esta ativa; o receptor nao cria uma oferta concorrente.
    expect(peer.createOffer).toHaveBeenCalledTimes(1);
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "CALL_SIGNAL",
      targetUserId: "member",
      signal: expect.objectContaining({ type: "offer" }),
    }));

    await act(async () => result.current.toggleCamera());
    expect(replaceTrack).toHaveBeenLastCalledWith(cameraTrack);
    expect(result.current.cameraOff).toBe(false);
    expect(peer.createOffer).toHaveBeenCalledTimes(2);

    await act(async () => result.current.toggleScreenShare());
    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: { restrictOwnAudio: true, suppressLocalAudioPlayback: false },
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      },
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "include",
      windowAudio: "window",
    });
    expect(replaceTrack).toHaveBeenLastCalledWith(screenTrack);
    expect(result.current.screenStream).toBe(displayStream);
    expect(screenAudioSender.replaceTrack).toHaveBeenLastCalledWith(screenAudioTrack);
    expect(screenAudioTrack.contentHint).toBe("music");
    expect(screenAudioConstraints).toHaveBeenCalledWith({ restrictOwnAudio: true, suppressLocalAudioPlayback: false });
    await act(async () => { await result.current.toggleMute(); });
    expect(audioTrack.enabled).toBe(false);
    expect(screenAudioTrack.enabled).toBe(true);
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_SCREEN_STARTED" }));
    const reloadProtection = new Event("beforeunload", { cancelable: true });
    act(() => window.dispatchEvent(reloadProtection));
    expect(reloadProtection.defaultPrevented).toBe(true);
    expect(peer.createOffer).toHaveBeenCalledTimes(3);

    await act(async () => result.current.selectScreenShareQuality("720p"));
    await act(async () => result.current.selectScreenShareFps(60));
    expect(applyConstraints).toHaveBeenLastCalledWith({
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 60, max: 60 },
    });
    expect(result.current.screenShareQuality).toBe("720p");
    expect(result.current.screenShareFps).toBe(60);

    getDisplayMedia.mockRejectedValueOnce(new DOMException("Cancelado", "NotAllowedError"));
    await act(async () => result.current.changeScreenShare());
    expect(result.current.screenStream).toBe(displayStream);
    expect(screenTrack.stop).not.toHaveBeenCalled();
    const nextScreenTrack = { ...screenTrack, id: "replacement-screen", stop: vi.fn() };
    const nextDisplay = new FakeMediaStream([nextScreenTrack]) as unknown as MediaStream;
    getDisplayMedia.mockResolvedValueOnce(nextDisplay);
    await act(async () => result.current.changeScreenShare());
    expect(replaceTrack).toHaveBeenLastCalledWith(nextScreenTrack);
    expect(result.current.screenStream).toBe(nextDisplay);
    expect(screenTrack.stop).toHaveBeenCalledOnce();
    expect(screenAudioSender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(sendSocketEvent.mock.calls.filter(([event]) => event.type === "CALL_SCREEN_STARTED")).toHaveLength(1);

    await act(async () => result.current.toggleScreenShare());
    expect(replaceTrack).toHaveBeenLastCalledWith(cameraTrack);
    expect(result.current.screenStream).toBeNull();
    expect(screenAudioSender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(screenAudioTrack.stop).toHaveBeenCalled();
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_SCREEN_STOPPED" }));
    expect(peer.createOffer).toHaveBeenCalledTimes(5);
    await act(async () => result.current.toggleCamera());
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_MEDIA_STATE", cameraEnabled: false, screenSharing: false }));
    await act(async () => result.current.endCall());
  });

  it("limita retentativas de upload e aplica backpressure antes de acumular memoria", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const retried = vi.fn();

    const responsePromise = fetchRecordingWithRetry("/recording", { method: "PUT" }, retried);
    await vi.advanceTimersByTimeAsync(200);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retried).toHaveBeenCalledWith(2);
    expect(recordingNeedsBackpressure(24 * 1024 * 1024, 1)).toBe(true);
    expect(recordingNeedsBackpressure(1, 3)).toBe(true);
    expect(recordingNeedsBackpressure(1024, 1)).toBe(false);
  });

  it("resolve ofertas simultaneas com rollback no peer polite", async () => {
    const audioTrack = { kind: "audio", enabled: true, readyState: "live", stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
    class FakeMediaStream {
      tracks: MediaStreamTrack[];
      constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks; }
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
      getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
    }
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const audioStream = new FakeMediaStream([audioTrack]) as unknown as MediaStream;
    const peerInstances: PerfectPeer[] = [];
    class PerfectPeer {
      signalingState: RTCSignalingState = "stable";
      connectionState: RTCPeerConnectionState = "new";
      localDescription: RTCSessionDescription | null = null;
      remoteDescription: RTCSessionDescription | null = null;
      onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
      ontrack: ((event: RTCTrackEvent) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      onnegotiationneeded: (() => void) | null = null;
      constructor() { peerInstances.push(this); }
      addTrack(track: MediaStreamTrack) { return { track, replaceTrack: vi.fn() } as unknown as RTCRtpSender; }
      addTransceiver() { return { sender: { track: null, replaceTrack: vi.fn() } } as unknown as RTCRtpTransceiver; }
      createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "local-offer" });
      createAnswer = vi.fn().mockResolvedValue({ type: "answer", sdp: "local-answer" });
      setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
        if (description.type === "rollback") {
          this.localDescription = null;
          this.signalingState = "stable";
          return;
        }
        this.localDescription = description as RTCSessionDescription;
        this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
      });
      setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
        this.remoteDescription = description as RTCSessionDescription;
        this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
      });
      addIceCandidate = vi.fn().mockResolvedValue(undefined);
      close = vi.fn(() => { this.connectionState = "closed"; });
      restartIce = vi.fn();
    }
    vi.stubGlobal("RTCPeerConnection", PerfectPeer);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValueOnce(audioStream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result, unmount } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
    }));

    await act(async () => result.current.startCall());
    const activeCallId = result.current.active?.callId;
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACK", callId: activeCallId,
      event: "CALL_INVITE", mediaTransport: "mesh",
    }));
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACCEPT",
      callId: activeCallId,
      fromUserId: "member",
      fromUserName: "Member",
    }));
    const peer = peerInstances[0];
    expect(peer.signalingState).toBe("have-local-offer");

    await act(async () => result.current.handleSocketEvent({
      type: "CALL_SIGNAL",
      callId: activeCallId,
      fromUserId: "member",
      signal: { type: "offer", sdp: "remote-offer" },
    }));

    expect(peer.setLocalDescription).toHaveBeenCalledWith({ type: "rollback" });
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "remote-offer" });
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "CALL_SIGNAL",
      targetUserId: "member",
      signal: expect.objectContaining({ type: "answer", sdp: "local-answer" }),
    }));
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACCEPT",
      callId: activeCallId,
      fromUserId: "z-user",
      fromUserName: "Z User",
    }));
    const impolitePeer = peerInstances[1];
    expect(impolitePeer.signalingState).toBe("have-local-offer");
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_SIGNAL",
      callId: activeCallId,
      fromUserId: "z-user",
      signal: { type: "offer", sdp: "colliding-offer" },
    }));
    expect(impolitePeer.setRemoteDescription).not.toHaveBeenCalled();
    expect(impolitePeer.setLocalDescription).not.toHaveBeenCalledWith({ type: "rollback" });
    expect(impolitePeer.createAnswer).not.toHaveBeenCalled();
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_KICK",
      callId: activeCallId,
      targetUserId: "owner",
      reason: "access_revoked",
    }));
    expect(peer.close).toHaveBeenCalledOnce();
    expect(impolitePeer.close).toHaveBeenCalledOnce();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(result.current.active).toBeNull();
    expect(result.current.status).toBe("Seu acesso à chamada foi revogado.");
    unmount();
  });

  it("renova peers ativos e coleta somente categorias ICE sanitizadas", async () => {
    const peerInstances: TelemetryPeer[] = [];
    const configurations: RTCConfiguration[] = [];
    class TelemetryPeer {
      signalingState: RTCSignalingState = "stable";
      connectionState: RTCPeerConnectionState = "connected";
      iceConnectionState: RTCIceConnectionState = "new";
      localDescription: RTCSessionDescription | null = null;
      onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;
      ontrack: ((event: RTCTrackEvent) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      onnegotiationneeded: (() => void) | null = null;
      constructor(configuration: RTCConfiguration) {
        configurations.push(configuration);
        peerInstances.push(this);
      }
      addTransceiver() { return { sender: { track: null, replaceTrack: vi.fn() } } as unknown as RTCRtpTransceiver; }
      createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "offer" });
      setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => { this.localDescription = description as RTCSessionDescription; });
      setConfiguration = vi.fn((configuration: RTCConfiguration) => configurations.push(configuration));
      restartIce = vi.fn();
      close = vi.fn();
      getStats = vi.fn().mockResolvedValue(new Map([
        ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair", privateDiagnostic: "do-not-collect" }],
        ["pair", { id: "pair", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local", remoteCandidateId: "remote" }],
        ["local", { id: "local", type: "local-candidate", candidateType: "relay", protocol: "tcp", address: "10.0.0.10", port: 4444, candidate: "sensitive-local-candidate" }],
        ["remote", { id: "remote", type: "remote-candidate", candidateType: "srflx", protocol: "udp", address: "198.51.100.7", port: 5555, candidate: "sensitive-remote-candidate" }],
      ]));
    }
    vi.stubGlobal("RTCPeerConnection", TelemetryPeer);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const firstServers = [{ urls: "turns:turn.example.test:5349", username: "first", credential: "first-secret" }];
    const secondServers = [{ urls: "turns:turn.example.test:5349", username: "second", credential: "second-secret" }];
    const { result, rerender, unmount } = renderHook(
      ({ iceServers }) => useTeamCallRuntime({
        session,
        thread: { scope: "team", title: "Time todo" },
        sendSocketEvent,
        iceServers,
        iceTransportPolicy: "relay",
      }),
      { initialProps: { iceServers: firstServers } },
    );

    await act(async () => result.current.startCall(undefined, { microphoneMode: "listen-only", cameraEnabled: false }));
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACK", callId: result.current.active?.callId,
      event: "CALL_INVITE", mediaTransport: "mesh",
    }));
    await act(async () => result.current.handleSocketEvent({
      type: "CALL_ACCEPT",
      callId: result.current.active?.callId,
      fromUserId: "member",
      fromUserName: "Member",
    }));
    expect(configurations[0]).toMatchObject({ iceServers: firstServers, iceTransportPolicy: "relay" });

    rerender({ iceServers: secondServers });
    expect(peerInstances[0].setConfiguration).toHaveBeenCalledWith(expect.objectContaining({ iceServers: secondServers }));
    expect(peerInstances[0].restartIce).toHaveBeenCalledOnce();

    await act(async () => {
      peerInstances[0].iceConnectionState = "connected";
      peerInstances[0].oniceconnectionstatechange?.();
      await Promise.resolve();
    });
    expect(result.current.iceTelemetry).toEqual({
      lastState: "connected",
      stateCounts: { connected: 1 },
      pathTypeCounts: { relay: 1 },
      lastSelectedPath: { localType: "relay", remoteType: "srflx", protocol: "tcp" },
      relayObserved: true,
    });
    const serialized = JSON.stringify(result.current.iceTelemetry);
    expect(serialized).not.toMatch(/10\.0\.0\.10|198\.51\.100\.7|4444|5555|candidate|privateDiagnostic/i);
    unmount();
  });

  it("mantem convite silencioso e reserva sons para eventos dentro da chamada", async () => {
    const resume = vi.fn();
    const createOscillator = vi.fn(() => ({ type: "sine", frequency: { value: 0 }, connect: vi.fn((target) => target), start: vi.fn(), stop: vi.fn() } as unknown as OscillatorNode));
    class FakeAudioContext {
      state: AudioContextState = "suspended";
      currentTime = 0;
      destination = {} as AudioDestinationNode;
      async resume() { resume(); this.state = "running"; }
      createOscillator() { return createOscillator(); }
      createGain() {
        return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() } as unknown as GainNode;
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const transportSnapshot: MediaTransportSnapshot = {
      state: "connected", failure: null, remoteStreams: [], connectionQuality: "good",
      iceTelemetry: { lastState: "unknown", stateCounts: {}, pathTypeCounts: {}, lastSelectedPath: null, relayObserved: false },
    };
    const mesh: MediaTransportFactory = {
      kind: "mesh",
      create: () => ({
        kind: "mesh",
        open: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockResolvedValue(undefined),
        updateLocalMedia: vi.fn().mockResolvedValue(undefined),
        updateIce: vi.fn(),
        updateScreenProfile: vi.fn().mockResolvedValue(undefined),
        snapshot: () => transportSnapshot,
        subscribe: (listener) => { listener(transportSnapshot); return vi.fn(); },
        close: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const { result, unmount } = renderHook(() => useTeamCallRuntime({
      session,
      thread: { scope: "team", title: "Time todo" },
      sendSocketEvent,
      mediaTransports: [mesh],
    }));

    let ready = false;
    await act(async () => { ready = await result.current.prepareAudio(); });
    expect(ready).toBe(true);
    expect(resume).toHaveBeenCalledOnce();

    await act(async () => result.current.handleSocketEvent({
      type: "CALL_INVITE",
      callId: "call_audio_ready",
      fromUserId: "member",
      fromUserName: "Member",
      scope: "team",
      threadId: "team",
    }));
    expect(result.current.ringtoneAudible).toBe(false);
    expect(createOscillator).not.toHaveBeenCalled();

    act(() => result.current.rejectIncoming());
    await act(async () => result.current.handleSocketEvent({ type: "CALL_END", callId: "call_audio_ready", fromUserId: "member" }));
    await act(async () => result.current.startCall(undefined, { microphoneMode: "listen-only", cameraEnabled: false }));
    const callId = result.current.active?.callId;
    await act(async () => result.current.handleSocketEvent({ type: "CALL_ACK", callId, event: "CALL_INVITE", mediaTransport: "mesh" }));
    await act(async () => result.current.handleSocketEvent({ type: "CALL_ACCEPT", callId, fromUserId: "member", fromUserName: "Member", clientId: "member-tab" }));
    await act(async () => result.current.handleSocketEvent({ type: "CALL_ACCEPT", callId, fromUserId: "member", fromUserName: "Member", clientId: "member-tab" }));
    expect(createOscillator).toHaveBeenCalledTimes(3);
    await act(async () => result.current.handleSocketEvent({ type: "CALL_SCREEN_STARTED", callId, fromUserId: "member", fromUserName: "Member", clientId: "member-tab" }));
    await act(async () => result.current.handleSocketEvent({ type: "CALL_SCREEN_STARTED", callId, fromUserId: "member", fromUserName: "Member", clientId: "member-tab" }));
    expect(createOscillator).toHaveBeenCalledTimes(5);
    await act(async () => result.current.handleSocketEvent({ type: "CALL_LEAVE", callId, fromUserId: "member", fromUserName: "Member", clientId: "member-tab" }));
    await act(async () => result.current.handleSocketEvent({ type: "CALL_LEAVE", callId, fromUserId: "member", fromUserName: "Member", clientId: "member-tab" }));
    expect(createOscillator).toHaveBeenCalledTimes(7);
    unmount();
  });
});
