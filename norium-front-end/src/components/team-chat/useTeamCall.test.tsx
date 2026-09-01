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
      audio: true,
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
    expect(result.current.selectedCameraId).toBe("cam-1");

    await act(async () => result.current.toggleCamera());
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      audio: false,
      video: { deviceId: { exact: "cam-1" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    expect(result.current.cameraOff).toBe(false);

    await act(async () => result.current.selectMicrophone("mic-2"));
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: "mic-2" } }, video: false });
    expect(result.current.selectedMicrophoneId).toBe("mic-2");
    expect(oldAudio.stop).toHaveBeenCalled();

    act(() => result.current.selectSpeaker("speaker-1"));
    expect(result.current.selectedSpeakerId).toBe("speaker-1");
    await act(async () => { await result.current.endCall(); });
  });

  it("responde uma chamada individual usando o organizador como destinatario", async () => {
    const cameraTrack = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
    const cameraStream = {
      getTracks: () => [cameraTrack],
      getAudioTracks: () => [],
      getVideoTracks: () => [cameraTrack],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
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
});
