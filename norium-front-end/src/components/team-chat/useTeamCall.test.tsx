import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../../types/auth";
import { useTeamCall } from "./useTeamCall";

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
  });

  afterEach(() => {
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
    const { result, unmount } = renderHook(() => useTeamCall({
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
    const { result } = renderHook(() => useTeamCall({
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
    const { result } = renderHook(() => useTeamCall({
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

  it("reserva o canal de video e transmite camera e tela aos participantes", async () => {
    const permissionVideo = { kind: "video", enabled: true, readyState: "live", stop: vi.fn() } as unknown as MediaStreamTrack;
    const audioTrack = { kind: "audio", enabled: true, readyState: "live", stop: vi.fn() } as unknown as MediaStreamTrack;
    const cameraTrack = { kind: "video", enabled: true, readyState: "live", stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
    const screenTrack = { kind: "video", enabled: true, readyState: "live", stop: vi.fn(), onended: null, contentHint: "" } as unknown as MediaStreamTrack;
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
    const replaceTrack = vi.fn().mockResolvedValue(undefined);
    const videoSender = { track: null, replaceTrack } as unknown as RTCRtpSender;
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
      addTransceiver() { return { sender: videoSender } as RTCRtpTransceiver; }
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
    const { result } = renderHook(() => useTeamCall({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent }));

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
    await act(async () => result.current.handleSocketEvent({ type: "CALL_SCREEN_STARTED", callId: result.current.active?.callId, fromUserId: "member", fromUserName: "Member" }));
    expect(result.current.remoteScreenSharingIds).toContain("member");
    expect(peer.createOffer).toHaveBeenCalledTimes(2);
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "CALL_SIGNAL",
      targetUserId: "member",
      signal: expect.objectContaining({ type: "offer" }),
    }));

    await act(async () => result.current.toggleCamera());
    expect(replaceTrack).toHaveBeenLastCalledWith(cameraTrack);
    expect(result.current.cameraOff).toBe(false);

    await act(async () => result.current.toggleScreenShare());
    expect(replaceTrack).toHaveBeenLastCalledWith(screenTrack);
    expect(result.current.screenStream).toBe(displayStream);
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_SCREEN_STARTED" }));

    await act(async () => result.current.toggleScreenShare());
    expect(replaceTrack).toHaveBeenLastCalledWith(cameraTrack);
    expect(result.current.screenStream).toBeNull();
    expect(sendSocketEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "CALL_SCREEN_STOPPED" }));
    await act(async () => result.current.endCall());
  });
});
