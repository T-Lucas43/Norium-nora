import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshMediaTransport } from "./MeshMediaTransport";
import type { MediaTransportLocalMedia } from "./MediaTransport";

class Sender {
  parameters: RTCRtpSendParameters = { encodings: [{}] } as RTCRtpSendParameters;
  track: MediaStreamTrack | null;
  constructor(track: MediaStreamTrack | null) { this.track = track; }
  replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => { this.track = track; });
  getParameters = () => this.parameters;
  setParameters = vi.fn(async (value: RTCRtpSendParameters) => { this.parameters = value; });
}
class Peer {
  senders: Sender[] = [];
  signalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  connectionState = "new";
  addTrack(track: MediaStreamTrack) { const sender = new Sender(track); this.senders.push(sender); return sender; }
  addTransceiver() { const sender = new Sender(null); this.senders.push(sender); return { sender }; }
  getTransceivers() { return this.senders.map((sender) => ({ sender, direction: "sendrecv" })); }
  createOffer = async () => ({ type: "offer" as const, sdp: "synthetic" });
  setLocalDescription = async (value: RTCSessionDescriptionInit) => { this.localDescription = value; };
  close = vi.fn();
}
afterEach(() => vi.unstubAllGlobals());
describe("Mesh receiver video preference", () => {
  it("pauses only the requesting peer's video, preserves audio and capture, rejects stale sessions and restores presentation", async () => {
    const peers: Peer[] = [];
    vi.stubGlobal("RTCPeerConnection", class extends Peer { constructor() { super(); peers.push(this); } });
    const audio = { kind: "audio", readyState: "live", stop: vi.fn() } as unknown as MediaStreamTrack;
    const video = { kind: "video", enabled: true, readyState: "live", stop: vi.fn(), getSettings: () => ({ width: 1280, height: 720 }) } as unknown as MediaStreamTrack;
    const stream = { getAudioTracks: () => [audio], getVideoTracks: () => [video] } as unknown as MediaStream;
    const media: MediaTransportLocalMedia = { localStream: stream, screenStream: null, screenShareQuality: "1080p", screenShareFps: 30 };
    const emitVideoInterest = vi.fn();
    const transport = new MeshMediaTransport({ emitSignal: () => true, emitVideoInterest, onConnected: vi.fn(), onStatus: vi.fn() }, {});
    await transport.open({ callId: "call", selfUserId: "owner", clientId: "owner-tab" }, media);
    await transport.receive({ type: "participant-joined", callId: "call", userId: "member", clientId: "member-tab" });
    await transport.receive({ type: "participant-joined", callId: "call", userId: "other", clientId: "other-tab" });
    const interest = { type: "video-interest" as const, callId: "call", userId: "member", clientId: "member-tab", receiveVideo: false, quality: "low" as const };
    await transport.receive({ ...interest, callId: "old-call" });
    await transport.receive({ ...interest, clientId: "old-tab" });
    expect(peers[0].senders[2].track).toBe(video);
    await transport.receive(interest);
    expect(peers[0].senders[2].track).toBe(video);
    expect(peers[0].senders[2].parameters.encodings[0].active).toBe(false);
    expect(peers[1].senders[2].parameters.encodings[0].active).toBe(true);
    expect(peers[0].senders[0].replaceTrack).not.toHaveBeenCalled(); expect(video.stop).not.toHaveBeenCalled(); expect(video.enabled).toBe(true);
    await transport.receive({ ...interest, receiveVideo: true });
    expect(peers[0].senders[2].parameters.encodings[0]).toMatchObject({ maxBitrate: 250000, maxFramerate: 15, scaleResolutionDownBy: 2 });
    await transport.updateLocalMedia({ ...media, screenStream: stream });
    expect(peers[0].senders[2].parameters.encodings[0]).toMatchObject({ maxBitrate: 5000000, maxFramerate: 30, scaleResolutionDownBy: 1 });
    await transport.receive(interest);
    await transport.updateScreenProfile("720p", 15);
    expect(peers[0].senders[2].parameters.encodings[0]).toMatchObject({ active: false, maxFramerate: 15 });
    await transport.updateVideoInterest({ hidden: true, cameras: [], screens: [], cameraQuality: "adaptive" });
    expect(emitVideoInterest).toHaveBeenCalledWith("call", "member", false, "low");
    const count = emitVideoInterest.mock.calls.length;
    await transport.updateVideoInterest({ hidden: true, cameras: [], screens: [], cameraQuality: "adaptive" });
    expect(emitVideoInterest).toHaveBeenCalledTimes(count);
    await transport.updateVideoInterest({ hidden: false, cameras: [], screens: [{ userId: "member", width: 1280, height: 720 }], cameraQuality: "low" });
    expect(emitVideoInterest).toHaveBeenCalledWith("call", "member", true, "high");
    await transport.close();
  });
});
