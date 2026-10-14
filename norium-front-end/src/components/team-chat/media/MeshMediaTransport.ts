import type {
  IcePathProtocol,
  IcePathType,
  IceTelemetrySnapshot,
  IceTelemetryState,
  MediaTransport,
  MediaTransportCall,
  MediaTransportDependencies,
  MediaTransportEvent,
  MediaTransportFactory,
  MediaTransportLocalMedia,
  MediaTransportSnapshot,
} from "./MediaTransport";
import { meshVideoInterestForUser, type VideoSubscriptionInterest } from "./videoSubscriptionPolicy";

const INITIAL_ICE_TELEMETRY: IceTelemetrySnapshot = {
  lastState: "unknown",
  stateCounts: {},
  pathTypeCounts: {},
  lastSelectedPath: null,
  relayObserved: false,
};

const SCREEN_SHARE_BITRATES: Record<MediaTransportLocalMedia["screenShareQuality"], number> = {
  "720p": 2_500_000,
  "1080p": 5_000_000,
  "1440p": 8_000_000,
};

type PeerNegotiationState = {
  makingOffer: boolean;
  needsNegotiation: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  polite: boolean;
  revision: number;
  operation: Promise<void>;
};

function iceTelemetryState(value: string): IceTelemetryState {
  return ["new", "checking", "connected", "completed", "failed", "disconnected", "closed"].includes(value)
    ? value as RTCIceConnectionState
    : "unknown";
}

function icePathType(value: unknown): IcePathType {
  return typeof value === "string" && ["host", "srflx", "prflx", "relay"].includes(value)
    ? value as RTCIceCandidateType
    : "unknown";
}

function icePathProtocol(value: unknown): IcePathProtocol {
  return typeof value === "string" && ["udp", "tcp", "tls"].includes(value.toLowerCase())
    ? value.toLowerCase() as IcePathProtocol
    : "unknown";
}

function selectedIcePath(report: RTCStatsReport): IceTelemetrySnapshot["lastSelectedPath"] {
  const entries: Array<Record<string, unknown>> = [];
  report.forEach((entry) => entries.push(entry as unknown as Record<string, unknown>));
  const transport = entries.find((entry) => entry.type === "transport" && typeof entry.selectedCandidatePairId === "string");
  const pair = transport
    ? report.get(String(transport.selectedCandidatePairId)) as unknown as Record<string, unknown> | undefined
    : entries.find((entry) => entry.type === "candidate-pair" && entry.state === "succeeded" && (entry.nominated === true || entry.selected === true));
  if (!pair) return null;
  const local = report.get(String(pair.localCandidateId || "")) as unknown as Record<string, unknown> | undefined;
  const remote = report.get(String(pair.remoteCandidateId || "")) as unknown as Record<string, unknown> | undefined;
  if (!local || !remote) return null;
  return {
    localType: icePathType(local.candidateType),
    remoteType: icePathType(remote.candidateType),
    protocol: icePathProtocol(local.relayProtocol || local.protocol),
  };
}

async function applyScreenShareSenderProfile(
  sender: RTCRtpSender,
  quality: MediaTransportLocalMedia["screenShareQuality"],
  fps: MediaTransportLocalMedia["screenShareFps"],
  active = true,
) {
  if (typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function") return;
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return;
  parameters.encodings = parameters.encodings.map((encoding) => ({
    ...encoding,
    active,
    scaleResolutionDownBy: 1,
    maxBitrate: Math.round(SCREEN_SHARE_BITRATES[quality] * Math.max(0.65, fps / 30)),
    maxFramerate: fps,
  }));
  await sender.setParameters(parameters);
}

function online() {
  return typeof navigator === "undefined" || navigator.onLine;
}

export class MeshMediaTransport implements MediaTransport {
  readonly kind = "mesh" as const;

  private call: MediaTransportCall | null = null;
  private media: MediaTransportLocalMedia = {
    localStream: null,
    screenStream: null,
    screenShareQuality: "1080p",
    screenShareFps: 30,
  };
  private configuration: RTCConfiguration;
  private readonly listeners = new Set<(snapshot: MediaTransportSnapshot) => void>();
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly audioSenders = new Map<string, RTCRtpSender>();
  private readonly screenAudioSenders = new Map<string, RTCRtpSender>();
  private readonly videoSenders = new Map<string, RTCRtpSender>();
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly negotiations = new Map<string, PeerNegotiationState>();
  private readonly remoteClientIds = new Map<string, string>();
  private readonly remoteStreams = new Map<string, MediaStream>();
  private readonly screenRecoveryTimers = new Map<string, number>();
  private qualityTimer: number | null = null;
  private videoInterest: VideoSubscriptionInterest | null = null;
  private readonly viewerVideoPreferences = new Map<string, { receiveVideo: boolean; quality: "low" | "high" }>();
  private readonly sentVideoPreferences = new Map<string, string>();
  private readonly videoPreferenceOperations = new Map<string, Promise<void>>();
  private readonly dependencies: MediaTransportDependencies;
  private currentSnapshot: MediaTransportSnapshot = {
    state: "idle",
    failure: null,
    remoteStreams: [],
    connectionQuality: online() ? "good" : "offline",
    iceTelemetry: INITIAL_ICE_TELEMETRY,
  };

  constructor(dependencies: MediaTransportDependencies, configuration: RTCConfiguration) {
    this.dependencies = dependencies;
    this.configuration = configuration;
  }

  async open(call: MediaTransportCall, media: MediaTransportLocalMedia) {
    if (this.call?.callId && this.call.callId !== call.callId) await this.close();
    this.call = call;
    this.media = media;
    this.setSnapshot({ state: "connecting", failure: null, connectionQuality: online() ? "connecting" : "offline" });
    this.startQualityMeasurement();
    this.setSnapshot({ state: "connected" });
  }

  snapshot() {
    return this.currentSnapshot;
  }

  subscribe(listener: (snapshot: MediaTransportSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.currentSnapshot);
    return () => this.listeners.delete(listener);
  }

  updateIce(configuration: RTCConfiguration) {
    this.configuration = configuration;
    this.peers.forEach((peer) => {
      try {
        peer.setConfiguration(configuration);
        peer.restartIce();
      } catch {
        this.dependencies.onStatus("Não foi possível renovar a rota da chamada.");
      }
    });
  }

  async updateLocalMedia(media: MediaTransportLocalMedia) {
    if (!this.call) return;
    this.media = media;
    const audioTrack = media.localStream?.getAudioTracks().find((track) => track.readyState !== "ended") || null;
    const screenAudioTrack = media.screenStream?.getAudioTracks().find((track) => track.readyState !== "ended") || null;
    const explicitVideoTrack = Object.prototype.hasOwnProperty.call(media, "outgoingVideoTrack");
    const videoTrack = explicitVideoTrack
      ? media.outgoingVideoTrack || null
      : media.screenStream?.getVideoTracks().find((track) => track.readyState !== "ended")
        || media.localStream?.getVideoTracks().find((track) => track.enabled && track.readyState !== "ended")
        || null;
    const videoStream = media.outgoingVideoStream || media.screenStream || media.localStream;

    await Promise.all(Array.from(this.peers.entries()).map(async ([userId, peer]) => {
      const audioSender = this.audioSenders.get(userId);
      if (audioSender && audioSender.track !== audioTrack) await audioSender.replaceTrack(audioTrack);
      const screenAudioSender = this.screenAudioSenders.get(userId);
      if (screenAudioSender) await screenAudioSender.replaceTrack(screenAudioTrack);

      const videoSender = this.videoSenders.get(userId);
      if (videoSender) {
        const transceiver = typeof peer.getTransceivers === "function"
          ? peer.getTransceivers().find((item) => item.sender === videoSender)
          : undefined;
        if (videoTrack && transceiver && transceiver.direction !== "sendrecv") transceiver.direction = "sendrecv";
        await this.applyViewerVideoPreference(userId);
        await this.negotiate(userId, peer);
      } else if (videoTrack && videoStream) {
        const sender = peer.addTrack(videoTrack, videoStream);
        this.videoSenders.set(userId, sender);
        await this.applyViewerVideoPreference(userId);
        await this.negotiate(userId, peer);
      }
    }));
  }

  async updateScreenProfile(
    quality: MediaTransportLocalMedia["screenShareQuality"],
    fps: MediaTransportLocalMedia["screenShareFps"],
  ) {
    this.media = { ...this.media, screenShareQuality: quality, screenShareFps: fps };
    if (!this.media.screenStream?.getVideoTracks().some((track) => track.readyState === "live")) return;
    await Promise.all(Array.from(this.videoSenders.keys()).map((userId) => this.applyViewerVideoPreference(userId)));
  }

  async receive(event: MediaTransportEvent) {
    if (!this.call || event.callId !== this.call.callId) return;
    if (event.userId === this.call.selfUserId) return;
    if (event.type === "participant-joined") {
      const clientId = event.clientId || "";
      // CALL_ACCEPT also represents a page-reload resume. The client id is
      // intentionally preserved across reloads, but the browser-owned
      // RTCPeerConnection is not. Always discard the remote peer before the
      // resumed participant negotiates so media cannot remain attached to the
      // document that just closed.
      if (this.peers.has(event.userId)) this.closePeer(event.userId);
      if (clientId) this.remoteClientIds.set(event.userId, clientId);
      await this.createPeer(event.userId, true);
      return;
    }
    if (!this.eventBelongsToCurrentClient(event.userId, event.clientId)) return;
    if (event.type === "video-interest") {
      this.viewerVideoPreferences.set(event.userId, { receiveVideo: event.receiveVideo, quality: event.quality });
      await this.applyViewerVideoPreference(event.userId);
      return;
    }
    if (event.type === "participant-left") {
      this.closePeer(event.userId);
      return;
    }
    if (event.type === "screen-started") {
      await this.requestRemoteScreenRefresh(event.userId);
      return;
    }
    if (event.type === "screen-stopped") {
      this.clearScreenRecovery(event.userId);
      return;
    }
    if (event.clientId && !this.remoteClientIds.has(event.userId)) {
      this.remoteClientIds.set(event.userId, event.clientId);
    }
    await this.receiveSignal(event.userId, event.signal);
  }

  async close() {
    this.call = null;
    this.peers.forEach((_, userId) => this.closePeer(userId));
    this.peers.clear();
    this.audioSenders.clear();
    this.screenAudioSenders.clear();
    this.videoSenders.clear();
    this.videoInterest = null; this.viewerVideoPreferences.clear(); this.sentVideoPreferences.clear(); this.videoPreferenceOperations.clear();
    this.pendingCandidates.clear();
    this.negotiations.clear();
    this.remoteClientIds.clear();
    this.remoteStreams.forEach((stream) => stream.getTracks().forEach((track) => { track.onended = null; }));
    this.remoteStreams.clear();
    this.screenRecoveryTimers.forEach((timer) => window.clearTimeout(timer));
    this.screenRecoveryTimers.clear();
    if (this.qualityTimer !== null) window.clearInterval(this.qualityTimer);
    this.qualityTimer = null;
    window.removeEventListener("online", this.handleNetworkChange);
    window.removeEventListener("offline", this.handleNetworkChange);
    this.setSnapshot({
      state: "idle",
      failure: null,
      remoteStreams: [],
      connectionQuality: online() ? "good" : "offline",
      participantConnectionQuality: {},
      iceTelemetry: INITIAL_ICE_TELEMETRY,
    });
  }

  private setSnapshot(change: Partial<MediaTransportSnapshot>) {
    this.currentSnapshot = { ...this.currentSnapshot, ...change };
    this.listeners.forEach((listener) => listener(this.currentSnapshot));
  }

  private publishRemoteStreams() {
    this.setSnapshot({
      remoteStreams: Array.from(this.remoteStreams, ([userId, stream]) => ({ userId, stream })),
      participantConnectionQuality: Object.fromEntries(Array.from(this.peers, ([userId, peer]) => [userId, peer.connectionState === "connected" ? "good" : ["failed", "disconnected", "closed"].includes(peer.connectionState) ? "poor" : "connecting"])),
    });
  }

  private negotiationFor(userId: string) {
    let state = this.negotiations.get(userId);
    if (!state) {
      state = {
        makingOffer: false,
        needsNegotiation: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        polite: (this.call?.selfUserId || "").localeCompare(userId) > 0,
        revision: 0,
        operation: Promise.resolve(),
      };
      this.negotiations.set(userId, state);
    }
    return state;
  }

  private eventBelongsToCurrentClient(userId: string, clientId?: string | null) {
    const currentClientId = this.remoteClientIds.get(userId);
    return !clientId || !currentClientId || clientId === currentClientId;
  }

  private serializeSdpOperation<T>(negotiation: PeerNegotiationState, operation: () => Promise<T>): Promise<T> {
    const result = negotiation.operation.then(operation, operation);
    negotiation.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async negotiate(userId: string, peer: RTCPeerConnection) {
    const negotiation = this.negotiationFor(userId);
    await this.serializeSdpOperation(negotiation, async () => {
      const callId = this.call?.callId;
      if (!callId || this.peers.get(userId) !== peer) return;
      if (negotiation.makingOffer || peer.signalingState !== "stable") {
        // A media update during an outstanding offer still needs negotiation
        // when that offer settles. Coalesce requests without dropping them.
        negotiation.needsNegotiation = true;
        return;
      }
      negotiation.needsNegotiation = false;
      const revision = ++negotiation.revision;
      try {
        negotiation.makingOffer = true;
        const offer = await peer.createOffer();
        if (negotiation.revision !== revision || this.peers.get(userId) !== peer || this.call?.callId !== callId) return;
        await peer.setLocalDescription(offer);
        if (negotiation.revision !== revision || this.peers.get(userId) !== peer || this.call?.callId !== callId) return;
        this.dependencies.emitSignal(callId, userId, peer.localDescription || offer);
      } finally {
        if (negotiation.revision === revision) negotiation.makingOffer = false;
      }
    });
  }

  private async createPeer(userId: string, createOffer: boolean) {
    const callId = this.call?.callId;
    if (!callId || userId === this.call?.selfUserId) return null;
    let peer = this.peers.get(userId);
    if (!peer) {
      peer = new RTCPeerConnection(this.configuration);
      this.peers.set(userId, peer);
      this.negotiationFor(userId);

      const localAudio = this.media.localStream?.getAudioTracks().find((track) => track.readyState !== "ended");
      if (localAudio && this.media.localStream) {
        this.audioSenders.set(userId, peer.addTrack(localAudio, this.media.localStream));
      } else {
        this.audioSenders.set(userId, peer.addTransceiver("audio", { direction: "sendrecv" }).sender);
      }

      const screenAudio = this.media.screenStream?.getAudioTracks()[0];
      this.screenAudioSenders.set(userId, screenAudio && this.media.screenStream
        ? peer.addTrack(screenAudio, this.media.screenStream)
        : peer.addTransceiver("audio", { direction: "sendrecv" }).sender);

      const outgoingVideo = this.media.screenStream?.getVideoTracks()[0]
        || this.media.localStream?.getVideoTracks().find((track) => track.enabled);
      const outgoingVideoStream = this.media.screenStream || this.media.localStream;
      if (outgoingVideo && outgoingVideoStream) {
        this.videoSenders.set(userId, peer.addTrack(outgoingVideo, outgoingVideoStream));
      } else {
        this.videoSenders.set(userId, peer.addTransceiver("video", { direction: "sendrecv" }).sender);
      }

      const currentPeer = peer;
      peer.onicecandidate = (candidateEvent) => {
        if (candidateEvent.candidate && this.call?.callId === callId && this.peers.get(userId) === currentPeer) {
          this.dependencies.emitSignal(callId, userId, candidateEvent.candidate.toJSON());
        }
      };
      peer.ontrack = (trackEvent) => this.receiveTrack(userId, trackEvent);
      peer.onconnectionstatechange = () => this.connectionChanged(userId, currentPeer);
      peer.oniceconnectionstatechange = () => {
        if (this.peers.get(userId) === currentPeer) void this.collectIceTelemetry(currentPeer);
      };
      peer.onnegotiationneeded = () => {
        if (this.peers.get(userId) === currentPeer) void this.negotiate(userId, currentPeer).catch(() => {
          if (this.peers.get(userId) === currentPeer) this.closePeer(userId);
        });
      };
    }
    await this.applyViewerVideoPreference(userId);
    if (createOffer) await this.negotiate(userId, peer);
    this.sendVideoPreference(userId);
    return peer;
  }

  async updateVideoInterest(interest: VideoSubscriptionInterest) {
    this.videoInterest = interest;
    for (const userId of this.screenRecoveryTimers.keys()) if (!meshVideoInterestForUser(interest, userId).receiveVideo) this.clearScreenRecovery(userId);
    this.peers.forEach((_, userId) => this.sendVideoPreference(userId));
  }

  private sendVideoPreference(userId: string) {
    if (!this.call || !this.videoInterest) return;
    const preference = meshVideoInterestForUser(this.videoInterest, userId);
    const key = `${preference.receiveVideo}:${preference.quality}`;
    if (this.sentVideoPreferences.get(userId) === key) return;
    this.sentVideoPreferences.set(userId, key);
    this.dependencies.emitVideoInterest?.(this.call.callId, userId, preference.receiveVideo, preference.quality);
  }

  private applyViewerVideoPreference(userId: string): Promise<void> {
    const previous = this.videoPreferenceOperations.get(userId) || Promise.resolve();
    const operation = previous.then(() => this.applyCurrentVideoPreference(userId), () => this.applyCurrentVideoPreference(userId));
    this.videoPreferenceOperations.set(userId, operation.catch(() => undefined));
    return operation;
  }

  private async applyCurrentVideoPreference(userId: string) {
    const sender = this.videoSenders.get(userId);
    const preference = this.viewerVideoPreferences.get(userId) || { receiveVideo: true, quality: "high" };
    if (!sender || !this.call) return;
    const video = this.media.outgoingVideoTrack !== undefined ? this.media.outgoingVideoTrack
      : this.media.screenStream?.getVideoTracks().find((track) => track.readyState !== "ended")
        || this.media.localStream?.getVideoTracks().find((track) => track.enabled && track.readyState !== "ended") || null;
    const hasEncodingControl = typeof sender.getParameters === "function" && typeof sender.setParameters === "function";
    // Keep the negotiated track while pausing encodings. Removing it during
    // glare/reoffers can change the remote transceiver and break later shares.
    const desired = hasEncodingControl || preference.receiveVideo ? video : null;
    if (sender.track !== desired) await sender.replaceTrack(desired || null);
    if (!desired || !hasEncodingControl) return;
    if (this.media.screenStream?.getVideoTracks().includes(desired)) {
      try { await applyScreenShareSenderProfile(sender, this.media.screenShareQuality, this.media.screenShareFps, preference.receiveVideo); }
      catch { if (!preference.receiveVideo) await sender.replaceTrack(null); }
      return;
    }
    const parameters = sender.getParameters();
    parameters.encodings = (parameters.encodings?.length ? parameters.encodings : [{}]).map((encoding) => {
      const next = { ...encoding };
      next.active = preference.receiveVideo;
      if (preference.quality === "low") { next.scaleResolutionDownBy = 2; next.maxBitrate = 250_000; next.maxFramerate = 15; }
      else { delete next.scaleResolutionDownBy; delete next.maxBitrate; delete next.maxFramerate; }
      return next;
    });
    try { await sender.setParameters(parameters); }
    catch { if (!preference.receiveVideo) await sender.replaceTrack(null); }
  }

  private receiveTrack(userId: string, event: RTCTrackEvent) {
    const previous = this.remoteStreams.get(userId);
    const tracks = [
      ...(previous?.getTracks() || []).filter((track) => track.readyState !== "ended"
        && (event.track.kind === "video" ? track.kind !== "video" : track.id !== event.track.id)),
      event.track,
    ];
    const stream = new MediaStream(tracks);
    this.remoteStreams.set(userId, stream);
    if (event.track.kind === "video") {
      const markVideoReceived = () => {
        const hadRecoveryTimer = this.screenRecoveryTimers.has(userId);
        this.clearScreenRecovery(userId);
        if (hadRecoveryTimer) this.dependencies.onStatus("Transmissão de tela recebida");
      };
      if (!event.track.muted) markVideoReceived();
      else event.track.addEventListener("unmute", markVideoReceived, { once: true });
    }
    event.track.onended = () => {
      const current = this.remoteStreams.get(userId);
      if (!current) return;
      const remaining = current.getTracks().filter((track) => track !== event.track && (!event.track.id || track.id !== event.track.id));
      if (!remaining.length) this.remoteStreams.delete(userId);
      else this.remoteStreams.set(userId, new MediaStream(remaining));
      this.publishRemoteStreams();
    };
    this.publishRemoteStreams();
  }

  private connectionChanged(userId: string, peer: RTCPeerConnection) {
    if (this.peers.get(userId) !== peer) return;
    this.setSnapshot({ participantConnectionQuality: { ...this.currentSnapshot.participantConnectionQuality, [userId]: peer.connectionState === "connected" ? "good" : ["failed", "disconnected", "closed"].includes(peer.connectionState) ? "poor" : "connecting" } });
    if (peer.connectionState === "connected") {
      const currentAudio = this.media.localStream?.getAudioTracks().find((track) => track.readyState !== "ended") || null;
      const sender = this.audioSenders.get(userId);
      if (sender && sender.track !== currentAudio) void sender.replaceTrack(currentAudio).catch(() => undefined);
      this.setSnapshot({ connectionQuality: "good" });
      this.dependencies.onConnected();
      this.dependencies.onStatus("Na chamada · áudio conectado");
      return;
    }
    if (peer.connectionState === "failed") {
      peer.restartIce();
      void this.negotiate(userId, peer).catch(() => {
        if (this.peers.get(userId) === peer) this.closePeer(userId);
      });
      return;
    }
    if (peer.connectionState === "disconnected") {
      this.setSnapshot({ connectionQuality: "poor" });
      this.dependencies.onStatus("Reconectando áudio e vídeo...");
      return;
    }
    if (peer.connectionState === "closed") this.closePeer(userId);
  }

  private async receiveSignal(userId: string, signal: RTCSessionDescriptionInit | RTCIceCandidateInit) {
    const callId = this.call?.callId;
    if (!callId) return;
    const peer = await this.createPeer(userId, false);
    if (!peer) return;
    if ("type" in signal && signal.type) {
      const description = signal as RTCSessionDescriptionInit;
      const negotiation = this.negotiationFor(userId);
      await this.serializeSdpOperation(negotiation, async () => {
        const readyForOffer = !negotiation.makingOffer
          && (peer.signalingState === "stable" || negotiation.isSettingRemoteAnswerPending);
        const offerCollision = description.type === "offer" && !readyForOffer;
        negotiation.ignoreOffer = !negotiation.polite && offerCollision;
        if (negotiation.ignoreOffer) return;
        if (offerCollision) {
          negotiation.revision += 1;
          negotiation.makingOffer = false;
        }
        negotiation.isSettingRemoteAnswerPending = description.type === "answer";
        try {
          if (offerCollision && negotiation.polite && peer.signalingState !== "stable") {
            await peer.setLocalDescription({ type: "rollback" });
          }
          await peer.setRemoteDescription(description);
        } finally {
          negotiation.isSettingRemoteAnswerPending = false;
        }
        if (this.peers.get(userId) !== peer || this.call?.callId !== callId) return;
        for (const candidate of this.pendingCandidates.get(userId) || []) await peer.addIceCandidate(candidate);
        this.pendingCandidates.delete(userId);
        if (description.type === "offer") {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          if (this.peers.get(userId) !== peer || this.call?.callId !== callId) return;
          this.dependencies.emitSignal(callId, userId, peer.localDescription || answer);
        }
      });
      if (negotiation.needsNegotiation && peer.signalingState === "stable"
        && this.peers.get(userId) === peer && this.call?.callId === callId) {
        await this.negotiate(userId, peer);
      }
      return;
    }

    const negotiation = this.negotiationFor(userId);
    await negotiation.operation;
    if (this.peers.get(userId) !== peer || this.call?.callId !== callId) return;
    if (negotiation.ignoreOffer) return;
    if (peer.remoteDescription) {
      try {
        await peer.addIceCandidate(signal as RTCIceCandidateInit);
      } catch (error) {
        if (!negotiation.ignoreOffer) throw error;
      }
    } else {
      this.pendingCandidates.set(userId, [...(this.pendingCandidates.get(userId) || []), signal as RTCIceCandidateInit]);
    }
  }

  private async requestRemoteScreenRefresh(userId: string) {
    await this.createPeer(userId, false);
    this.clearScreenRecovery(userId);
    const callId = this.call?.callId;
    const timer = window.setTimeout(() => {
      this.screenRecoveryTimers.delete(userId);
      if (!callId || this.call?.callId !== callId) return;
      if (this.videoInterest && !meshVideoInterestForUser(this.videoInterest, userId).receiveVideo) return;
      const remoteVideoReady = this.remoteStreams.get(userId)?.getVideoTracks()
        .some((track) => track.readyState === "live" && !track.muted);
      if (remoteVideoReady) return;
      const peer = this.peers.get(userId);
      if (!peer) return;
      if (["failed", "disconnected"].includes(peer.connectionState)) peer.restartIce();
      this.dependencies.onStatus("Reconectando a transmissão de tela...");
      void this.negotiate(userId, peer).catch(() => {
        this.dependencies.onStatus("Não foi possível receber a tela. Peça ao participante para interromper e compartilhar novamente.");
      });
    }, 3500);
    this.screenRecoveryTimers.set(userId, timer);
  }

  private clearScreenRecovery(userId: string) {
    const timer = this.screenRecoveryTimers.get(userId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.screenRecoveryTimers.delete(userId);
  }

  private closePeer(userId: string) {
    this.clearScreenRecovery(userId);
    const peer = this.peers.get(userId);
    if (peer) {
      peer.onicecandidate = null;
      peer.oniceconnectionstatechange = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.onnegotiationneeded = null;
      peer.close();
    }
    this.peers.delete(userId);
    this.audioSenders.delete(userId);
    this.screenAudioSenders.delete(userId);
    this.videoSenders.delete(userId);
    this.viewerVideoPreferences.delete(userId); this.sentVideoPreferences.delete(userId); this.videoPreferenceOperations.delete(userId);
    this.pendingCandidates.delete(userId);
    this.negotiations.delete(userId);
    this.remoteClientIds.delete(userId);
    this.remoteStreams.get(userId)?.getTracks().forEach((track) => { track.onended = null; });
    this.remoteStreams.delete(userId);
    this.publishRemoteStreams();
  }

  private async collectIceTelemetry(peer: RTCPeerConnection) {
    const state = iceTelemetryState(peer.iceConnectionState || "unknown");
    let selectedPath: IceTelemetrySnapshot["lastSelectedPath"] = null;
    if (["connected", "completed"].includes(state) && typeof peer.getStats === "function") {
      try {
        selectedPath = selectedIcePath(await peer.getStats());
      } catch {
        // Telemetry must never interfere with call media.
      }
    }
    const current = this.currentSnapshot.iceTelemetry;
    const pathTypeCounts = { ...current.pathTypeCounts };
    if (selectedPath) pathTypeCounts[selectedPath.localType] = (pathTypeCounts[selectedPath.localType] || 0) + 1;
    this.setSnapshot({
      iceTelemetry: {
        lastState: state,
        stateCounts: { ...current.stateCounts, [state]: (current.stateCounts[state] || 0) + 1 },
        pathTypeCounts,
        lastSelectedPath: selectedPath || current.lastSelectedPath,
        relayObserved: current.relayObserved || selectedPath?.localType === "relay" || selectedPath?.remoteType === "relay",
      },
    });
  }

  private readonly handleNetworkChange = () => {
    this.setSnapshot({ connectionQuality: online() ? (this.call ? "connecting" : "good") : "offline" });
  };

  private startQualityMeasurement() {
    if (this.qualityTimer !== null) return;
    window.addEventListener("online", this.handleNetworkChange);
    window.addEventListener("offline", this.handleNetworkChange);
    const measure = async () => {
      if (!this.call) return;
      if (!online()) {
        this.setSnapshot({ connectionQuality: "offline" });
        return;
      }
      const peers = Array.from(this.peers.values());
      if (!peers.length) {
        this.setSnapshot({ connectionQuality: "connecting" });
        return;
      }
      if (peers.some((peer) => ["failed", "disconnected", "closed"].includes(peer.connectionState))) {
        this.setSnapshot({ connectionQuality: "poor" });
        return;
      }
      let highestRoundTrip = 0;
      let lostPackets = 0;
      let receivedPackets = 0;
      const participantQuality: NonNullable<MediaTransportSnapshot["participantConnectionQuality"]> = {};
      await Promise.all(Array.from(this.peers, async ([userId, peer]) => {
        if (typeof peer.getStats !== "function") return;
        const report = await peer.getStats();
        let roundTrip = 0; let lost = 0; let received = 0;
        report.forEach((entry) => {
          if (entry.type === "candidate-pair" && entry.state === "succeeded" && entry.currentRoundTripTime) {
            highestRoundTrip = Math.max(highestRoundTrip, Number(entry.currentRoundTripTime));
            roundTrip = Math.max(roundTrip, Number(entry.currentRoundTripTime));
          }
          if (entry.type === "inbound-rtp") {
            lostPackets += Number(entry.packetsLost || 0);
            receivedPackets += Number(entry.packetsReceived || 0);
            lost += Number(entry.packetsLost || 0); received += Number(entry.packetsReceived || 0);
          }
        });
        const packetLoss = lost + received > 0 ? lost / (lost + received) * 100 : 0;
        participantQuality[userId] = roundTrip > .65 || packetLoss > 8 ? "poor" : roundTrip > .3 || packetLoss > 3 ? "fair" : "good";
      })).catch(() => undefined);
      const loss = lostPackets + receivedPackets > 0 ? (lostPackets / (lostPackets + receivedPackets)) * 100 : 0;
      this.setSnapshot({
        participantConnectionQuality: participantQuality,
        connectionQuality: highestRoundTrip > 0.65 || loss > 8
          ? "poor"
          : highestRoundTrip > 0.3 || loss > 3
            ? "fair"
            : "good",
      });
    };
    void measure();
    this.qualityTimer = window.setInterval(() => { void measure(); }, 3500);
  }
}

export class MeshMediaTransportFactory implements MediaTransportFactory {
  readonly kind = "mesh" as const;
  private readonly configuration: () => RTCConfiguration;

  constructor(configuration: () => RTCConfiguration) {
    this.configuration = configuration;
  }

  create(dependencies: MediaTransportDependencies) {
    return new MeshMediaTransport(dependencies, this.configuration());
  }
}
