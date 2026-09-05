import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { MediaTransportDependencies, MediaTransportLocalMedia } from "./MediaTransport";
import {
  HttpLiveKitAccessProvider,
  LiveKitMediaTransportFactory,
  type LiveKitRoomClient,
  type LiveKitRoomObserver,
} from "./LiveKitMediaTransport";

class TestMediaStream {
  private readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }

  addTrack(track: MediaStreamTrack) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }

  removeTrack(track: MediaStreamTrack) {
    const index = this.tracks.indexOf(track);
    if (index >= 0) this.tracks.splice(index, 1);
  }

  getTracks() {
    return [...this.tracks];
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
}

class FakeRoom implements LiveKitRoomClient {
  observer: LiveKitRoomObserver | null = null;
  remoteParticipants: Array<{ identity: string; metadata?: string; tracks: readonly MediaStreamTrack[] }> = [];
  connect = vi.fn(async () => undefined);
  disconnect = vi.fn(async () => undefined);
  publish = vi.fn(async () => undefined);
  unpublish = vi.fn(async () => undefined);

  observe(observer: LiveKitRoomObserver) {
    this.observer = observer;
    return () => {
      if (this.observer === observer) this.observer = null;
    };
  }

  participants() {
    return this.remoteParticipants;
  }
}

const originalMediaStream = globalThis.MediaStream;

beforeAll(() => {
  Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: TestMediaStream });
});

afterAll(() => {
  Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: originalMediaStream });
});

function media(overrides: Partial<MediaTransportLocalMedia> = {}): MediaTransportLocalMedia {
  return {
    localStream: null,
    screenStream: null,
    screenShareQuality: "1080p",
    screenShareFps: 30,
    ...overrides,
  };
}

function dependencies(): MediaTransportDependencies {
  return {
    emitSignal: vi.fn(() => false),
    onConnected: vi.fn(),
    onStatus: vi.fn(),
    onTerminated: vi.fn(),
  };
}

describe("LiveKitMediaTransport", () => {
  it("requests a short-lived token for the exact admitted call and client", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      serverUrl: "wss://sfu.example.test",
      token: "ephemeral-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const provider = new HttpLiveKitAccessProvider(
      "session-token",
      "https://api.example.test/api/team-chat",
      request,
    );

    await expect(provider.getAccess("call_admitted", "tab_a")).resolves.toEqual({
      serverUrl: "wss://sfu.example.test",
      token: "ephemeral-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.example.test/api/team-chat/calls/call_admitted/media-token",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer session-token" }),
        body: JSON.stringify({ clientId: "tab_a" }),
      }),
    );
  });

  it("obtains ephemeral access for the admitted call and client before connecting", async () => {
    const room = new FakeRoom();
    const getAccess = vi.fn(async () => ({
      serverUrl: "wss://sfu.example.test",
      token: "short-lived-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const deps = dependencies();
    const transport = new LiveKitMediaTransportFactory(
      { getAccess },
      { createRoom: () => room },
    ).create(deps);

    await transport.open(
      { callId: "call_admitted", selfUserId: "user_owner", clientId: "tab_a" },
      media(),
    );

    expect(getAccess).toHaveBeenCalledWith(
      "call_admitted",
      "tab_a",
      expect.any(AbortSignal),
    );
    expect(room.connect).toHaveBeenCalledWith("wss://sfu.example.test", "short-lived-token");
    expect(transport.snapshot().state).toBe("connected");
    expect(deps.onConnected).toHaveBeenCalledOnce();
  });

  it("publishes the captured microphone and camera without acquiring new devices", async () => {
    const room = new FakeRoom();
    const microphone = { id: "mic", kind: "audio", readyState: "live" } as unknown as MediaStreamTrack;
    const camera = { id: "camera", kind: "video", enabled: true, readyState: "live" } as unknown as MediaStreamTrack;
    const transport = new LiveKitMediaTransportFactory(
      { getAccess: async () => ({ serverUrl: "wss://sfu.test", token: "token", expiresAt: "2099-01-01T00:00:00Z" }) },
      { createRoom: () => room },
    ).create(dependencies());

    await transport.open(
      { callId: "call_media", selfUserId: "user_owner", clientId: "tab_media" },
      media({ localStream: new MediaStream([microphone, camera]) }),
    );

    expect(room.publish.mock.calls).toEqual([
      [microphone, "microphone"],
      [camera, "camera"],
    ]);
  });

  it("replaces camera publication with screen video and screen audio", async () => {
    const room = new FakeRoom();
    const camera = { id: "camera", kind: "video", enabled: true, readyState: "live" } as unknown as MediaStreamTrack;
    const screenVideo = { id: "screen-video", kind: "video", enabled: true, readyState: "live" } as unknown as MediaStreamTrack;
    const screenAudio = { id: "screen-audio", kind: "audio", enabled: true, readyState: "live" } as unknown as MediaStreamTrack;
    const transport = new LiveKitMediaTransportFactory(
      { getAccess: async () => ({ serverUrl: "wss://sfu.test", token: "token", expiresAt: "2099-01-01T00:00:00Z" }) },
      { createRoom: () => room },
    ).create(dependencies());
    await transport.open(
      { callId: "call_screen", selfUserId: "owner", clientId: "tab_screen" },
      media({ localStream: new MediaStream([camera]) }),
    );

    await transport.updateLocalMedia(media({
      localStream: new MediaStream([camera]),
      screenStream: new MediaStream([screenVideo, screenAudio]),
      outgoingVideoTrack: screenVideo,
      outgoingVideoStream: new MediaStream([screenVideo, screenAudio]),
    }));

    expect(room.unpublish).toHaveBeenCalledWith(camera);
    expect(room.publish.mock.calls.slice(-2)).toEqual([
      [screenAudio, "screen-share-audio"],
      [screenVideo, "screen-share"],
    ]);
  });

  it("exposes streams for participants already present when the room opens", async () => {
    const room = new FakeRoom();
    const remoteAudio = { id: "remote-audio", kind: "audio", readyState: "live" } as unknown as MediaStreamTrack;
    room.remoteParticipants = [{
      identity: "opaque-session-id",
      metadata: JSON.stringify({ userId: "user_remote" }),
      tracks: [remoteAudio],
    }];
    const transport = new LiveKitMediaTransportFactory(
      { getAccess: async () => ({ serverUrl: "wss://sfu.test", token: "token", expiresAt: "2099-01-01T00:00:00Z" }) },
      { createRoom: () => room },
    ).create(dependencies());

    await transport.open(
      { callId: "call_remote", selfUserId: "owner", clientId: "tab_remote" },
      media(),
    );

    expect(transport.snapshot().remoteStreams).toHaveLength(1);
    expect(transport.snapshot().remoteStreams[0]?.userId).toBe("user_remote");
    expect(transport.snapshot().remoteStreams[0]?.stream.getTracks()).toEqual([remoteAudio]);
  });

  it("adds and removes subscribed remote tracks through the transport snapshot", async () => {
    const room = new FakeRoom();
    const transport = new LiveKitMediaTransportFactory(
      { getAccess: async () => ({ serverUrl: "wss://sfu.test", token: "token", expiresAt: "2099-01-01T00:00:00Z" }) },
      { createRoom: () => room },
    ).create(dependencies());
    await transport.open(
      { callId: "call_tracks", selfUserId: "owner", clientId: "tab_tracks" },
      media(),
    );
    const remoteVideo = { id: "remote-video", kind: "video", readyState: "live" } as unknown as MediaStreamTrack;

    const participant = { identity: "opaque-member-session", metadata: JSON.stringify({ userId: "member" }), tracks: [] };
    room.observer?.trackSubscribed(participant, remoteVideo);
    expect(transport.snapshot().remoteStreams[0]?.stream.getTracks()).toEqual([remoteVideo]);

    room.observer?.trackUnsubscribed(participant, remoteVideo);
    expect(transport.snapshot().remoteStreams).toEqual([]);
  });

  it("ignores a late disconnect from a replaced tab of the same participant", async () => {
    const room = new FakeRoom();
    const transport = new LiveKitMediaTransportFactory(
      { getAccess: async () => ({ serverUrl: "wss://sfu.test", token: "token", expiresAt: "2099-01-01T00:00:00Z" }) },
      { createRoom: () => room },
    ).create(dependencies());
    await transport.open(
      { callId: "call_tabs", selfUserId: "owner", clientId: "owner-tab" },
      media(),
    );
    const oldTrack = { id: "old-audio", kind: "audio", readyState: "live" } as unknown as MediaStreamTrack;
    const newTrack = { id: "new-audio", kind: "audio", readyState: "live" } as unknown as MediaStreamTrack;
    const oldTab = { identity: "opaque-old", metadata: JSON.stringify({ userId: "member" }), tracks: [] };
    const newTab = { identity: "opaque-new", metadata: JSON.stringify({ userId: "member" }), tracks: [] };

    room.observer?.trackSubscribed(oldTab, oldTrack);
    room.observer?.participantConnected(newTab);
    room.observer?.trackSubscribed(newTab, newTrack);
    room.observer?.participantDisconnected(oldTab);

    expect(transport.snapshot().remoteStreams).toHaveLength(1);
    expect(transport.snapshot().remoteStreams[0]?.stream.getTracks()).toEqual([newTrack]);
  });

  it("reports reconnecting and returns to connected after LiveKit recovers", async () => {
    const room = new FakeRoom();
    const deps = dependencies();
    const transport = new LiveKitMediaTransportFactory(
      { getAccess: async () => ({ serverUrl: "wss://sfu.test", token: "token", expiresAt: "2099-01-01T00:00:00Z" }) },
      { createRoom: () => room },
    ).create(deps);
    await transport.open(
      { callId: "call_reconnect", selfUserId: "owner", clientId: "tab_reconnect" },
      media(),
    );

    room.observer?.reconnecting();
    expect(transport.snapshot().state).toBe("connecting");
    expect(transport.snapshot().connectionQuality).toBe("connecting");

    room.observer?.reconnected();
    expect(transport.snapshot().state).toBe("connected");
    expect(deps.onConnected).toHaveBeenCalledTimes(2);
  });

  it("normalizes a terminal provider disconnect and asks the session to clean up", async () => {
    const room = new FakeRoom();
    const deps = dependencies();
    const transport = new LiveKitMediaTransportFactory(
      { getAccess: async () => ({ serverUrl: "wss://sfu.test", token: "token", expiresAt: "2099-01-01T00:00:00Z" }) },
      { createRoom: () => room },
    ).create(deps);
    await transport.open(
      { callId: "call_revoked", selfUserId: "owner", clientId: "tab_revoked" },
      media(),
    );

    room.observer?.disconnected("participant-removed");

    const failure = {
      code: "sfu_access_revoked",
      detail: "Seu acesso à mídia da chamada foi revogado.",
      retryable: false,
    };
    expect(transport.snapshot()).toMatchObject({
      state: "failed",
      failure,
      connectionQuality: "offline",
      remoteStreams: [],
    });
    expect(deps.onTerminated).toHaveBeenCalledWith(failure);
  });

  it("normalizes access failures without exposing token or provider details", async () => {
    const room = new FakeRoom();
    const transport = new LiveKitMediaTransportFactory(
      { getAccess: async () => { throw new Error("secret provider response"); } },
      { createRoom: () => room },
    ).create(dependencies());

    await expect(transport.open(
      { callId: "call_denied", selfUserId: "owner", clientId: "tab_denied" },
      media(),
    )).rejects.toThrow("Não foi possível autorizar a mídia da chamada.");

    expect(transport.snapshot()).toMatchObject({
      state: "failed",
      failure: {
        code: "sfu_access_unavailable",
        detail: "Não foi possível autorizar a mídia da chamada.",
        retryable: true,
      },
    });
    expect(JSON.stringify(transport.snapshot())).not.toContain("secret provider response");
  });

  it("cancels an in-flight open and cannot reconnect after the session closes", async () => {
    const room = new FakeRoom();
    let resolveAccess!: (access: { serverUrl: string; token: string; expiresAt: string }) => void;
    let requestSignal: AbortSignal | undefined;
    const transport = new LiveKitMediaTransportFactory(
      {
        getAccess: (_callId, _clientId, signal) => {
          requestSignal = signal;
          return new Promise((resolve) => { resolveAccess = resolve; });
        },
      },
      { createRoom: () => room },
    ).create(dependencies());

    const opening = transport.open(
      { callId: "call_cancel", selfUserId: "owner", clientId: "owner-tab" },
      media(),
    );
    await Promise.resolve();
    await transport.close();
    resolveAccess({ serverUrl: "wss://sfu.test", token: "token", expiresAt: "2099-01-01T00:00:00Z" });

    await expect(opening).rejects.toThrow("encerrada");
    expect(requestSignal?.aborted).toBe(true);
    expect(room.connect).not.toHaveBeenCalled();
    expect(transport.snapshot().state).toBe("idle");
  });

  it("closes idempotently, unpublishes tracks and leaves capture ownership with CallSession", async () => {
    const room = new FakeRoom();
    const stop = vi.fn();
    const microphone = { id: "mic", kind: "audio", readyState: "live", stop } as unknown as MediaStreamTrack;
    const transport = new LiveKitMediaTransportFactory(
      { getAccess: async () => ({ serverUrl: "wss://sfu.test", token: "token", expiresAt: "2099-01-01T00:00:00Z" }) },
      { createRoom: () => room },
    ).create(dependencies());
    await transport.open(
      { callId: "call_close", selfUserId: "owner", clientId: "tab_close" },
      media({ localStream: new MediaStream([microphone]) }),
    );

    await transport.close();
    await transport.close();

    expect(room.unpublish).toHaveBeenCalledWith(microphone);
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(room.observer).toBeNull();
    expect(transport.snapshot()).toMatchObject({ state: "idle", remoteStreams: [] });
  });
});
