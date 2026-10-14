import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomEvent, Track, VideoQuality } from "livekit-client";
import { LiveKitMediaTransportFactory } from "./LiveKitMediaTransport";
import { bindRemoteVideo } from "./remoteVideoBindings";

const state = vi.hoisted(() => ({ rooms: [] as Array<Record<string, any>> }));
vi.mock("livekit-client", async (original) => {
  const sdk = await original<Record<string, unknown>>();
  class Room {
    remoteParticipants = new Map();
    listeners = new Map();
    localParticipant = { publishTrack: vi.fn(), unpublishTrack: vi.fn() };
    connect = vi.fn(async () => undefined); disconnect = vi.fn(async () => undefined);
    on(event: string, listener: (...args: unknown[]) => void) { this.listeners.set(event, listener); }
    off(event: string) { this.listeners.delete(event); }
    constructor() { state.rooms.push(this); }
  }
  return { ...sdk, Room };
});

function publication(kind: Track.Kind, source: Track.Source) {
  return { kind, source, setSubscribed: vi.fn(), setEnabled: vi.fn(), setVideoQuality: vi.fn(), setVideoDimensions: vi.fn() };
}
async function open() {
  vi.stubGlobal("MediaStream", class { private tracks: MediaStreamTrack[]; constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks; } getTracks() { return this.tracks; } addTrack(track: MediaStreamTrack) { this.tracks.push(track); } removeTrack(track: MediaStreamTrack) { this.tracks = this.tracks.filter((item) => item !== track); } });
  const transport = new LiveKitMediaTransportFactory({ getAccess: async () => ({ serverUrl: "wss://sfu.test", token: "synthetic", expiresAt: "2099-01-01T00:00:00Z" }) }).create({ emitSignal: () => true, onConnected: vi.fn(), onStatus: vi.fn() });
  await transport.open({ callId: "video", selfUserId: "owner", clientId: "tab" }, { localStream: null, screenStream: null, screenShareQuality: "1080p", screenShareFps: 30 });
  const room = state.rooms.at(-1)!;
  const audio = publication(Track.Kind.Audio, Track.Source.Microphone);
  const screenAudio = publication(Track.Kind.Audio, Track.Source.ScreenShareAudio);
  const camera = publication(Track.Kind.Video, Track.Source.Camera);
  const screen = publication(Track.Kind.Video, Track.Source.ScreenShare);
  const remote = { identity: "member-tab", metadata: JSON.stringify({ userId: "member" }), trackPublications: new Map(Object.entries({ audio, screenAudio, camera, screen })) };
  room.remoteParticipants.set(remote.identity, remote);
  room.listeners.get(RoomEvent.ParticipantConnected)(remote);
  return { transport, room, remote, audio, screenAudio, camera, screen };
}
afterEach(() => { vi.unstubAllGlobals(); state.rooms.length = 0; });
describe("SDK video subscriptions", () => {
  it("disables automatic subscriptions, preserves both audio sources and resumes visible camera", async () => {
    const { transport, room, audio, screenAudio, camera, screen } = await open();
    expect(room.connect).toHaveBeenCalledWith("wss://sfu.test", "synthetic", { autoSubscribe: false });
    await transport.updateVideoInterest!({ hidden: false, cameras: [{ userId: "member", width: 640, height: 360 }], screens: [], cameraQuality: "adaptive" });
    expect(camera.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(camera.setVideoDimensions).toHaveBeenLastCalledWith({ width: 640, height: 360 });
    await transport.updateVideoInterest!({ hidden: true, cameras: [], screens: [], cameraQuality: "adaptive" });
    expect(camera.setSubscribed).toHaveBeenLastCalledWith(false); expect(screen.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(audio.setSubscribed.mock.calls.every(([enabled]) => enabled === true)).toBe(true);
    expect(screenAudio.setSubscribed.mock.calls.every(([enabled]) => enabled === true)).toBe(true);
    await transport.updateVideoInterest!({ hidden: false, cameras: [{ userId: "member", width: 320, height: 180 }], screens: [], cameraQuality: "adaptive" });
    expect(camera.setSubscribed).toHaveBeenLastCalledWith(true);
    await transport.close();
  });
  it("prioritizes screen, lowers lateral camera and applies policy to late publications and reconnect", async () => {
    const { transport, room, remote, camera, screen } = await open();
    await transport.updateVideoInterest!({ hidden: false, cameras: [{ userId: "member", width: 160, height: 90 }], screens: [{ userId: "member", width: 1280, height: 720 }], cameraQuality: "low" });
    expect(screen.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
    expect(camera.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.LOW);
    camera.setSubscribed.mockClear();
    room.listeners.get(RoomEvent.TrackPublished)(camera, remote);
    expect(camera.setSubscribed).toHaveBeenLastCalledWith(true);
    room.listeners.get(RoomEvent.Reconnected)();
    expect(screen.setSubscribed).toHaveBeenLastCalledWith(true);
    await transport.close();
  });
  it("attaches the actual video element to adaptive SDK tracks and removes bindings on unsubscribe", async () => {
    const { transport, room, remote, camera } = await open();
    const mediaStreamTrack = { kind: "video", id: "camera" } as MediaStreamTrack;
    const track = { kind: Track.Kind.Video, mediaStreamTrack, attach: vi.fn(), detach: vi.fn() };
    room.listeners.get(RoomEvent.TrackSubscribed)(track, camera, remote);
    const element = document.createElement("video");
    const detach = bindRemoteVideo(mediaStreamTrack, element);
    expect(track.attach).toHaveBeenCalledWith(element); detach!(); expect(track.detach).toHaveBeenCalledWith(element);
    room.listeners.get(RoomEvent.TrackUnsubscribed)(track, camera, remote);
    expect(bindRemoteVideo(mediaStreamTrack, element)).toBeUndefined();
    await transport.close();
  });
});
