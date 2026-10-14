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

  it("retoma uma atualizacao de camera pedida durante oferta pendente sem perder a negociacao", async () => {
    let peer: TestPeer;
    class TestPeer {
      signalingState: RTCSignalingState = "stable";
      localDescription: RTCSessionDescription | null = null;
      remoteDescription: RTCSessionDescription | null = null;
      onicecandidate = null;
      oniceconnectionstatechange = null;
      ontrack = null;
      onconnectionstatechange = null;
      onnegotiationneeded = null;
      senders: RTCRtpSender[] = [];
      createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "local" });
      createAnswer = vi.fn().mockResolvedValue({ type: "answer", sdp: "answer" });
      setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
        this.localDescription = description as RTCSessionDescription;
        this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
      });
      setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
        this.remoteDescription = description as RTCSessionDescription;
        this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
      });
      addIceCandidate = vi.fn().mockResolvedValue(undefined);
      close = vi.fn();
      addTransceiver() {
        const sender = { track: null, replaceTrack: vi.fn().mockResolvedValue(undefined) } as unknown as RTCRtpSender;
        this.senders.push(sender);
        return { sender } as RTCRtpTransceiver;
      }
      constructor() { peer = this; }
    }
    vi.stubGlobal("RTCPeerConnection", TestPeer);
    const emitSignal = vi.fn().mockReturnValue(true);
    const transport = new MeshMediaTransport({ emitSignal, onConnected: vi.fn(), onStatus: vi.fn() }, {});
    const media = { localStream: null, screenStream: null, screenShareQuality: "1080p" as const, screenShareFps: 30 as const };
    transport.open({ callId: "call_current", selfUserId: "owner", clientId: "owner-tab" }, media);
    await transport.receive({ type: "signal", callId: "call_current", userId: "member", clientId: "member-tab", signal: { candidate: "synthetic-initial-candidate" } });
    const earlyPeer = peer!;
    await transport.receive({ type: "participant-joined", callId: "call_current", userId: "member", clientId: "member-tab" });
    expect(peer!).toBe(earlyPeer);
    expect(earlyPeer.close).not.toHaveBeenCalled();
    expect(peer!.signalingState).toBe("have-local-offer");
    const camera = { kind: "video", enabled: true, readyState: "live" } as MediaStreamTrack;
    await transport.updateLocalMedia({ ...media, outgoingVideoTrack: camera });
    await transport.updateLocalMedia({ ...media, outgoingVideoTrack: camera });
    expect(peer!.createOffer).toHaveBeenCalledTimes(1);
    await transport.receive({ type: "signal", callId: "call_current", userId: "member", clientId: "member-tab",
      signal: { type: "answer", sdp: "remote" } });
    expect(earlyPeer.addIceCandidate).toHaveBeenCalledWith({ candidate: "synthetic-initial-candidate" });
    expect(peer!.senders[2].replaceTrack).toHaveBeenCalledWith(camera);
    expect(peer!.createOffer).toHaveBeenCalledTimes(2);
    expect(emitSignal.mock.calls.filter(call => call[2].type === "offer")).toHaveLength(2);
    await transport.receive({ type: "signal", callId: "call_current", userId: "member", clientId: "member-tab",
      signal: { type: "answer", sdp: "remote-again" } });
    expect(peer!.createOffer).toHaveBeenCalledTimes(2);
    expect(peer!.signalingState).toBe("stable");
    await transport.close();
  });

  it("rejeita deterministicamente transporte desconhecido", () => {
    expect(() => resolveMediaTransportFactory("sfu", [factory("mesh")])).toThrow(
      "O transporte de mídia sfu não está disponível neste cliente.",
    );
  });

  it("processa a resposta SDP mesmo quando a troca de video aguarda essa resposta", async () => {
    let peer!: PendingMediaPeer;
    let releaseReplacement!: () => void;
    const pendingReplacement = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    class PendingMediaPeer {
      signalingState: RTCSignalingState = "stable";
      localDescription: RTCSessionDescription | null = null;
      remoteDescription: RTCSessionDescription | null = null;
      onicecandidate = null;
      oniceconnectionstatechange = null;
      ontrack = null;
      onconnectionstatechange = null;
      onnegotiationneeded = null;
      senders: RTCRtpSender[] = [];
      createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "local" });
      createAnswer = vi.fn().mockResolvedValue({ type: "answer", sdp: "answer" });
      setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
        this.localDescription = description as RTCSessionDescription;
        this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
      });
      setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
        this.remoteDescription = description as RTCSessionDescription;
        this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
        releaseReplacement();
      });
      addIceCandidate = vi.fn().mockResolvedValue(undefined);
      close = vi.fn();
      addTransceiver() {
        const sender = { track: null, replaceTrack: vi.fn().mockResolvedValue(undefined) } as unknown as RTCRtpSender;
        this.senders.push(sender);
        return { sender } as RTCRtpTransceiver;
      }
      constructor() { peer = this; }
    }
    vi.stubGlobal("RTCPeerConnection", PendingMediaPeer);
    const transport = new MeshMediaTransport({ emitSignal: vi.fn().mockReturnValue(true), onConnected: vi.fn(), onStatus: vi.fn() }, {});
    const media = { localStream: null, screenStream: null, screenShareQuality: "1080p" as const, screenShareFps: 30 as const };
    await transport.open({ callId: "call", selfUserId: "owner", clientId: "owner-tab" }, media);
    await transport.receive({ type: "participant-joined", callId: "call", userId: "member", clientId: "member-tab" });
    vi.mocked(peer.senders[2].replaceTrack).mockReturnValueOnce(pendingReplacement);
    const camera = { kind: "video", enabled: true, readyState: "live" } as MediaStreamTrack;
    const updating = transport.updateLocalMedia({ ...media, outgoingVideoTrack: camera });
    await vi.waitFor(() => expect(peer.senders[2].replaceTrack).toHaveBeenCalledWith(camera));
    await transport.receive({ type: "signal", callId: "call", userId: "member", clientId: "member-tab", signal: { type: "answer", sdp: "remote" } });
    await updating;
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "remote" });
    expect(peer.createOffer).toHaveBeenCalledTimes(2);
    expect(peer.close).not.toHaveBeenCalled();
    await transport.close();
  });

  it.each(["negotiation", "failed"] as const)("substitui a aba e ignora sinal, saida e rejeicao atrasados (%s)", async (failureEvent) => {
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
      onconnectionstatechange: (() => void) | null = null;
      onnegotiationneeded: (() => void) | null = null;
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
      type: "participant-joined", callId: "call_current", userId: "member", clientId: "old-tab",
    });
    expect(peers).toHaveLength(2);
    expect(peers[0].close).toHaveBeenCalledOnce();
    peers[1].connectionState = "disconnected";
    (peers[1].onconnectionstatechange as unknown as () => void)();
    expect(transport.snapshot().participantConnectionQuality?.member).toBe("poor");
    peers[1].connectionState = "connected";
    (peers[1].onconnectionstatechange as unknown as () => void)();
    expect(transport.snapshot().participantConnectionQuality?.member).toBe("good");

    await transport.receive({
      type: "signal", callId: "call_current", userId: "member", clientId: "old-tab",
      signal: { type: "answer", sdp: "settled" },
    });
    let rejectOldOffer!: (reason: Error) => void;
    const oldOffer = new Promise<{ type: string; sdp: string }>((_, reject) => { rejectOldOffer = reject; });
    peers[1].createOffer.mockReturnValueOnce(oldOffer);
    if (failureEvent === "failed") {
      peers[1].connectionState = "failed";
      peers[1].onconnectionstatechange?.();
    } else {
      peers[1].onnegotiationneeded?.();
    }
    await vi.waitFor(() => expect(peers[1].createOffer).toHaveBeenCalledTimes(2));

    await transport.receive({
      type: "participant-joined", callId: "call_current", userId: "member", clientId: "new-tab",
    });
    expect(peers).toHaveLength(3);
    expect(peers[1].close).toHaveBeenCalledOnce();
    rejectOldOffer(new Error("obsolete peer failed"));
    // Drain the old serialized operation and its rejection handler.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(peers[2].close).not.toHaveBeenCalled();

    await transport.receive({
      type: "signal", callId: "call_current", userId: "member", clientId: "old-tab",
      signal: { type: "offer", sdp: "stale" },
    });
    await transport.receive({
      type: "participant-left", callId: "call_current", userId: "member", clientId: "old-tab",
    });
    expect(peers[2].setRemoteDescription).not.toHaveBeenCalled();
    expect(peers[2].close).not.toHaveBeenCalled();

    await transport.receive({
      type: "signal", callId: "call_current", userId: "member", clientId: "new-tab",
      signal: { type: "offer", sdp: "current" },
    });
    expect(peers[2].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "current" });
    await transport.close();
  });
});
