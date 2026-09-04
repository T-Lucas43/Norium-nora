import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../../types/auth";
import {
  fetchRecordingWithRetry,
  recordingNeedsBackpressure,
  useTeamCallRuntime,
} from "./useTeamCall";

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
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ calls: [] }) }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("inicia uma reuniao com audio e deixa a camera para ser ativada dentro da sala", async () => {
    const cameraStop = vi.fn();
    const audioStop = vi.fn();
    const cameraTrack = { kind: "video", stop: cameraStop } as unknown as MediaStreamTrack;
    const audioTrack = { kind: "audio", stop: audioStop } as unknown as MediaStreamTrack;
    const cameraStream = {
      getTracks: () => [cameraTrack],
      getAudioTracks: () => [],
      getVideoTracks: () => [cameraTrack],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [audioTrack],
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValueOnce(cameraStream).mockResolvedValueOnce(audioStream);
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

    await act(async () => result.current.startCall());

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
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
    expect(result.current.cameraPermission).toBe("granted");
    expect(cameraStop).toHaveBeenCalled();

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
    const getUserMedia = vi.fn().mockResolvedValueOnce(permissionStream).mockResolvedValueOnce(initialStream).mockResolvedValueOnce(cameraStream).mockResolvedValueOnce(replacementStream);
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
    const cameraTrack = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
    const audioTrack = { kind: "audio", enabled: true, readyState: "live", stop: vi.fn() } as unknown as MediaStreamTrack;
    const cameraStream = {
      getTracks: () => [cameraTrack],
      getAudioTracks: () => [],
      getVideoTracks: () => [cameraTrack],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [audioTrack],
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValueOnce(cameraStream).mockResolvedValueOnce(audioStream), enumerateDevices: vi.fn().mockResolvedValue([]) },
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
    const camera = { getTracks: () => [{ stop: vi.fn() }] };
    const audio = { kind: "audio", enabled: true, stop: vi.fn() };
    const stream = { getTracks: () => [audio], getAudioTracks: () => [audio], getVideoTracks: () => [] };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValueOnce(camera).mockResolvedValueOnce(stream) } });
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
    const camera = { getTracks: () => [{ stop: vi.fn() }] };
    const audio = { kind: "audio", enabled: true, stop: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValueOnce(camera).mockReturnValueOnce(deferred) } });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));
    const invite = { type: "CALL_INVITE", callId: "call_0123456789abcdef", fromUserId: "member", scope: "team" as const, threadId: "team" };
    await act(async () => result.current.handleSocketEvent(invite));
    let joining!: Promise<void>;
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
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValueOnce(stream([permissionVideo as typeof audio])).mockResolvedValueOnce(stream([audio])).mockReturnValue(delayed),
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
    let resolveCamera!: (stream: unknown) => void;
    const cameraPromise = new Promise((resolve) => { resolveCamera = resolve; });
    const camera = { getTracks: () => [{ stop: vi.fn() }] };
    const audio = { kind: "audio", enabled: true, stop: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockReturnValueOnce(cameraPromise).mockResolvedValue({ getTracks: () => [audio], getAudioTracks: () => [audio], getVideoTracks: () => [] }) } });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));
    let starting!: Promise<void>;
    await act(async () => { starting = result.current.startCall(); await result.current.startCall(); });
    await act(async () => { resolveCamera(camera); await starting; });
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
    const screenAudioTrack = { id: "screen-audio", kind: "audio", enabled: true, readyState: "live", stop: vi.fn() } as unknown as MediaStreamTrack;
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
    const getUserMedia = vi.fn().mockResolvedValueOnce(permissionStream).mockResolvedValueOnce(audioStream).mockResolvedValueOnce(cameraStream);
    const getDisplayMedia = vi.fn().mockResolvedValue(displayStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, getDisplayMedia, enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const sendSocketEvent = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTeamCallRuntime({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));

    await act(async () => result.current.startCall());
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
      audio: true,
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    expect(replaceTrack).toHaveBeenLastCalledWith(screenTrack);
    expect(result.current.screenStream).toBe(displayStream);
    expect(screenAudioSender.replaceTrack).toHaveBeenLastCalledWith(screenAudioTrack);
    act(() => result.current.toggleMute());
    expect(audioTrack.enabled).toBe(false);
    expect(screenAudioTrack.enabled).toBe(true);
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_SCREEN_STARTED" }));
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
    const permissionTrack = { kind: "video", enabled: true, readyState: "live", stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
    const audioTrack = { kind: "audio", enabled: true, readyState: "live", stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
    class FakeMediaStream {
      tracks: MediaStreamTrack[];
      constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks; }
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
      getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
    }
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const permissionStream = new FakeMediaStream([permissionTrack]) as unknown as MediaStream;
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
        getUserMedia: vi.fn().mockResolvedValueOnce(permissionStream).mockResolvedValueOnce(audioStream),
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
});
