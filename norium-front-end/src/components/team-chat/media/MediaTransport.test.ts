import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveMediaTransportFactory,
  type MediaTransportFactory,
} from "./MediaTransport";
import { MeshMediaTransport } from "./MeshMediaTransport";

function factory(kind: "mesh" | "sfu"): MediaTransportFactory {
  return { kind, create: vi.fn() };
}

describe("MediaTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mantem mesh como transporte compativel para chamadas legadas", () => {
    const mesh = factory("mesh");
    expect(resolveMediaTransportFactory(undefined, [mesh])).toBe(mesh);
    expect(resolveMediaTransportFactory("mesh", [mesh])).toBe(mesh);
  });

  it("seleciona uma fabrica SFU pela politica armazenada na chamada", () => {
    const mesh = factory("mesh");
    const sfu = factory("sfu");
    expect(resolveMediaTransportFactory("sfu", [mesh, sfu])).toBe(sfu);
  });

  it("rejeita deterministicamente transporte desconhecido", () => {
    expect(() => resolveMediaTransportFactory("sfu", [factory("mesh")])).toThrow(
      "O transporte de mídia sfu não está disponível neste cliente.",
    );
  });

  it("substitui a aba remota e ignora sinal e saida atrasados da sessao anterior", async () => {
    const peers: TestPeer[] = [];
    class TestPeer {
      signalingState: RTCSignalingState = "stable";
      connectionState: RTCPeerConnectionState = "new";
      iceConnectionState: RTCIceConnectionState = "new";
      localDescription: RTCSessionDescription | null = null;
      remoteDescription: RTCSessionDescription | null = null;
      onicecandidate = null;
      oniceconnectionstatechange = null;
      ontrack = null;
      onconnectionstatechange = null;
      onnegotiationneeded = null;
      close = vi.fn(() => { this.connectionState = "closed"; });
      restartIce = vi.fn();
      setConfiguration = vi.fn();
      addIceCandidate = vi.fn().mockResolvedValue(undefined);
      createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "local" });
      createAnswer = vi.fn().mockResolvedValue({ type: "answer", sdp: "answer" });
      setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
        this.localDescription = description.type === "rollback" ? null : description as RTCSessionDescription;
        this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
      });
      setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
        this.remoteDescription = description as RTCSessionDescription;
        this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
      });
      addTransceiver() {
        return { sender: { track: null, replaceTrack: vi.fn().mockResolvedValue(undefined) } } as unknown as RTCRtpTransceiver;
      }
      constructor() { peers.push(this); }
    }
    vi.stubGlobal("RTCPeerConnection", TestPeer);
    const transport = new MeshMediaTransport({
      emitSignal: vi.fn().mockReturnValue(true),
      onConnected: vi.fn(),
      onStatus: vi.fn(),
    }, {});
    transport.open({ callId: "call_current", selfUserId: "owner", clientId: "owner-tab" }, {
      localStream: null, screenStream: null, screenShareQuality: "1080p", screenShareFps: 30,
    });

    await transport.receive({
      type: "participant-joined", callId: "call_current", userId: "member", clientId: "old-tab",
    });
    await transport.receive({
      type: "participant-joined", callId: "call_current", userId: "member", clientId: "new-tab",
    });
    expect(peers).toHaveLength(2);
    expect(peers[0].close).toHaveBeenCalledOnce();

    await transport.receive({
      type: "signal", callId: "call_current", userId: "member", clientId: "old-tab",
      signal: { type: "offer", sdp: "stale" },
    });
    await transport.receive({
      type: "participant-left", callId: "call_current", userId: "member", clientId: "old-tab",
    });
    expect(peers[1].setRemoteDescription).not.toHaveBeenCalled();
    expect(peers[1].close).not.toHaveBeenCalled();

    await transport.receive({
      type: "signal", callId: "call_current", userId: "member", clientId: "new-tab",
      signal: { type: "offer", sdp: "current" },
    });
    expect(peers[1].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "current" });
    await transport.close();
  });
});
