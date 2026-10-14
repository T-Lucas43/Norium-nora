import {
  ConnectionQuality,
  DisconnectReason,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  setLogLevel,
} from "livekit-client";
import { apiBaseUrl } from "../../../utils/api";
import type { VideoSubscriptionInterest } from "./videoSubscriptionPolicy";
import { registerRemoteVideoBinding, unregisterRemoteVideoBinding } from "./remoteVideoBindings";

// SDK diagnostics may contain SDP, candidates and server addresses. Only the
// normalized CallTelemetry events are eligible for operational collection.
setLogLevel("silent");

import type {
  IceTelemetrySnapshot,
  MediaTransport,
  MediaTransportDependencies,
  MediaTransportEvent,
  MediaTransportFactory,
  MediaTransportFailure,
  MediaTransportLocalMedia,
  MediaTransportSnapshot,
  MediaTransportCall,
} from "./MediaTransport";

export type LiveKitAccess = {
  serverUrl: string;
  token: string;
  expiresAt: string;
};

export type LiveKitAccessProvider = {
  getAccess(callId: string, clientId: string, signal?: AbortSignal): Promise<LiveKitAccess>;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const SFU_ACCESS_TIMEOUT_MS = 8000;

export class HttpLiveKitAccessProvider implements LiveKitAccessProvider {
  private readonly token: string;
  private readonly endpointBase: string;
  private readonly request: FetchLike;

  constructor(
    token: string,
    endpointBase = `${apiBaseUrl()}/api/team-chat`,
    request: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.token = token;
    this.endpointBase = endpointBase;
    this.request = request;
  }

  async getAccess(callId: string, clientId: string, signal?: AbortSignal): Promise<LiveKitAccess> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeoutId = globalThis.setTimeout(abort, SFU_ACCESS_TIMEOUT_MS);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let response: Response;
    try {
      response = await this.request(
        `${this.endpointBase}/calls/${encodeURIComponent(callId)}/media-token`,
        {
          method: "POST",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ clientId }),
        },
      );
    } finally {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
    }
    if (!response.ok) throw new Error("SFU access was rejected.");
    const value = await response.json() as Partial<LiveKitAccess>;
    const expiry = Date.parse(value.expiresAt || "");
    let url: URL;
    try {
      url = new URL(value.serverUrl || "");
    } catch {
      throw new Error("SFU access response is invalid.");
    }
    if (
      url.protocol !== "wss:"
      || !value.token?.trim()
      || !Number.isFinite(expiry)
      || expiry <= Date.now()
    ) {
      throw new Error("SFU access response is invalid.");
    }
    return {
      serverUrl: url.toString().replace(/\/$/, ""),
      token: value.token,
      expiresAt: value.expiresAt!,
    };
  }
}

type LiveKitTrackSource = "microphone" | "camera" | "screen-share" | "screen-share-audio";
type PublishedTrackRole = "microphone" | "screen-audio" | "video";
type LiveKitConnectionQuality = "excellent" | "good" | "poor" | "lost" | "unknown";
type LiveKitDisconnect = "duplicate-identity" | "participant-removed" | "room-deleted" | "unknown";

export type LiveKitRemoteParticipant = {
  identity: string;
  metadata?: string;
  tracks: readonly MediaStreamTrack[];
};

export type LiveKitRoomObserver = {
  reconnecting(): void;
  reconnected(): void;
  disconnected(reason: LiveKitDisconnect): void;
  participantConnected(participant: LiveKitRemoteParticipant): void;
  participantDisconnected(participant: LiveKitRemoteParticipant): void;
  trackSubscribed(participant: LiveKitRemoteParticipant, track: MediaStreamTrack): void;
  trackUnsubscribed(participant: LiveKitRemoteParticipant, track: MediaStreamTrack): void;
  connectionQualityChanged(quality: LiveKitConnectionQuality, local: boolean, remote?: LiveKitRemoteParticipant): void;
};

/** A narrow test seam around the vendor SDK. LiveKit SDK types never cross it. */
export interface LiveKitRoomClient {
  observe(observer: LiveKitRoomObserver): () => void;
  connect(serverUrl: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  participants(): readonly LiveKitRemoteParticipant[];
  publish(track: MediaStreamTrack, source: LiveKitTrackSource): Promise<void>;
  unpublish(track: MediaStreamTrack): Promise<void>;
  updateVideoInterest?(interest: VideoSubscriptionInterest): void;
}

type LiveKitMediaTransportOptions = {
  createRoom?: () => LiveKitRoomClient;
};

const EMPTY_ICE_TELEMETRY: IceTelemetrySnapshot = {
  lastState: "unknown",
  stateCounts: {},
  pathTypeCounts: {},
  lastSelectedPath: null,
  relayObserved: false,
};

const INITIAL_SNAPSHOT: MediaTransportSnapshot = {
  state: "idle",
  failure: null,
  remoteStreams: [],
  participantConnectionQuality: {},
  connectionQuality: "offline",
  iceTelemetry: EMPTY_ICE_TELEMETRY,
};

function disconnectReason(reason: DisconnectReason | undefined): LiveKitDisconnect {
  if (reason === DisconnectReason.DUPLICATE_IDENTITY) return "duplicate-identity";
  if (reason === DisconnectReason.PARTICIPANT_REMOVED) return "participant-removed";
  if (reason === DisconnectReason.ROOM_DELETED) return "room-deleted";
  return "unknown";
}

function terminalFailure(reason: LiveKitDisconnect): MediaTransportFailure {
  if (reason === "participant-removed") {
    return {
      code: "sfu_access_revoked",
      detail: "Seu acesso à mídia da chamada foi revogado.",
      retryable: false,
    };
  }
  if (reason === "duplicate-identity") {
    return {
      code: "sfu_session_replaced",
      detail: "A mídia desta chamada foi aberta em outra aba ou dispositivo.",
      retryable: false,
    };
  }
  if (reason === "room-deleted") {
    return {
      code: "sfu_call_ended",
      detail: "A mídia da chamada foi encerrada.",
      retryable: false,
    };
  }
  return {
    code: "sfu_disconnected",
    detail: "A conexão de mídia foi encerrada inesperadamente.",
    retryable: true,
  };
}

function connectionQuality(quality: LiveKitConnectionQuality): MediaTransportSnapshot["connectionQuality"] {
  if (quality === "excellent" || quality === "good") return "good";
  if (quality === "poor") return "poor";
  if (quality === "lost") return "offline";
  return "fair";
}

function subscribedTracks(participant: RemoteParticipant) {
  return Array.from(participant.trackPublications.values())
    .map((publication) => publication.track?.mediaStreamTrack)
    .filter((track): track is MediaStreamTrack => Boolean(track));
}

class LiveKitSdkRoomClient implements LiveKitRoomClient {
  private readonly room = new Room({ adaptiveStream: true, dynacast: true });
  private interest: VideoSubscriptionInterest = { hidden: false, cameras: [], screens: [], cameraQuality: "adaptive" };
  private readonly boundTracks = new Set<MediaStreamTrack>();

  updateVideoInterest(interest: VideoSubscriptionInterest) {
    this.interest = interest;
    for (const remote of this.room.remoteParticipants.values()) this.applySubscriptions(remote);
  }

  private applySubscriptions(remote: RemoteParticipant) {
    let userId = "";
    try { const value = JSON.parse(remote.metadata || ""); if (typeof value?.userId === "string") userId = value.userId.trim(); } catch { /* Ignore malformed metadata. */ }
    for (const publication of remote.trackPublications.values()) {
      if (publication.kind === Track.Kind.Audio) { publication.setSubscribed(true); continue; }
      if (publication.kind !== Track.Kind.Video) continue;
      const screen = publication.source === Track.Source.ScreenShare;
      const tile = (screen ? this.interest.screens : this.interest.cameras).find((item) => item.userId === userId);
      const subscribed = !this.interest.hidden && !!tile;
      publication.setSubscribed(subscribed);
      if (!subscribed) continue;
      publication.setEnabled(true);
      if (screen) publication.setVideoQuality(VideoQuality.HIGH);
      else if (this.interest.cameraQuality === "low") publication.setVideoQuality(VideoQuality.LOW);
      else publication.setVideoDimensions({ width: tile!.width, height: tile!.height });
    }
  }

  observe(observer: LiveKitRoomObserver) {
    const participant = (remote: RemoteParticipant): LiveKitRemoteParticipant => ({
      identity: remote.identity,
      metadata: remote.metadata,
      tracks: subscribedTracks(remote),
    });
    const listeners = [
      [RoomEvent.Reconnecting, () => observer.reconnecting()],
      [RoomEvent.Reconnected, () => { this.updateVideoInterest(this.interest); observer.reconnected(); }],
      [RoomEvent.Disconnected, (reason?: DisconnectReason) => observer.disconnected(disconnectReason(reason))],
      [RoomEvent.ParticipantConnected, (remote: RemoteParticipant) => { this.applySubscriptions(remote); observer.participantConnected(participant(remote)); }],
      [RoomEvent.TrackPublished, (_publication: unknown, remote: RemoteParticipant) => this.applySubscriptions(remote)],
      [RoomEvent.ParticipantDisconnected, (remote: RemoteParticipant) => observer.participantDisconnected(participant(remote))],
      [RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication: unknown, remote: RemoteParticipant) => {
        if (track.kind === Track.Kind.Video) {
          this.boundTracks.add(track.mediaStreamTrack);
          registerRemoteVideoBinding(track.mediaStreamTrack, (element) => { track.attach(element); return () => { track.detach(element); }; });
        }
        this.applySubscriptions(remote);
        observer.trackSubscribed(participant(remote), track.mediaStreamTrack);
      }],
      [RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication: unknown, remote: RemoteParticipant) => {
        unregisterRemoteVideoBinding(track.mediaStreamTrack); this.boundTracks.delete(track.mediaStreamTrack);
        observer.trackUnsubscribed(participant(remote), track.mediaStreamTrack);
      }],
      [RoomEvent.ConnectionQualityChanged, (quality: ConnectionQuality, changedParticipant: { isLocal: boolean }) => (
        observer.connectionQualityChanged(quality, changedParticipant.isLocal, changedParticipant instanceof RemoteParticipant ? participant(changedParticipant) : undefined)
      )],
    ] as const;
    listeners.forEach(([event, listener]) => this.room.on(event, listener as never));
    return () => listeners.forEach(([event, listener]) => this.room.off(event, listener as never));
  }

  async connect(serverUrl: string, token: string) {
    await this.room.connect(serverUrl, token, { autoSubscribe: false });
    this.updateVideoInterest(this.interest);
  }

  disconnect() {
    for (const track of this.boundTracks) unregisterRemoteVideoBinding(track);
    this.boundTracks.clear();
    return this.room.disconnect(false);
  }

  participants() {
    return Array.from(this.room.remoteParticipants.values()).map((participant) => ({
      identity: participant.identity,
      metadata: participant.metadata,
      tracks: subscribedTracks(participant),
    }));
  }

  async publish(track: MediaStreamTrack, source: LiveKitTrackSource) {
    const sdkSource = {
      microphone: Track.Source.Microphone,
      camera: Track.Source.Camera,
      "screen-share": Track.Source.ScreenShare,
      "screen-share-audio": Track.Source.ScreenShareAudio,
    }[source];
    await this.room.localParticipant.publishTrack(track, { source: sdkSource });
  }

  async unpublish(track: MediaStreamTrack) {
    await this.room.localParticipant.unpublishTrack(track, false);
  }
}

export class LiveKitMediaTransport implements MediaTransport {
  readonly kind = "sfu" as const;

  private readonly dependencies: MediaTransportDependencies;
  private readonly access: LiveKitAccessProvider;
  private readonly listeners = new Set<(snapshot: MediaTransportSnapshot) => void>();
  private readonly createRoom: () => LiveKitRoomClient;
  private room: LiveKitRoomClient | null = null;
  private stopObserving: (() => void) | null = null;
  private currentSnapshot = INITIAL_SNAPSHOT;
  private call: MediaTransportCall | null = null;
  private media: MediaTransportLocalMedia | null = null;
  private readonly publishedTracks = new Map<PublishedTrackRole, MediaStreamTrack>();
  private readonly remoteStreams = new Map<string, MediaStream>();
  private readonly remoteIdentityByUser = new Map<string, string>();
  private readonly supersededRemoteIdentities = new Set<string>();
  private openGeneration = 0;
  private accessAbortController: AbortController | null = null;

  constructor(
    dependencies: MediaTransportDependencies,
    access: LiveKitAccessProvider,
    options: LiveKitMediaTransportOptions = {},
  ) {
    this.dependencies = dependencies;
    this.access = access;
    this.createRoom = options.createRoom || (() => new LiveKitSdkRoomClient());
  }

  async open(call: MediaTransportCall, media: MediaTransportLocalMedia) {
    if (this.call && (this.call.callId !== call.callId || this.call.clientId !== call.clientId)) {
      await this.close();
    }
    const generation = ++this.openGeneration;
    this.accessAbortController?.abort();
    const accessController = new AbortController();
    this.accessAbortController = accessController;
    this.call = call;
    this.media = media;
    this.setSnapshot({ state: "connecting", failure: null, connectionQuality: "connecting" });
    const room = this.createRoom();
    this.room = room;
    this.stopObserving = room.observe(this.observer());
    try {
      let access: LiveKitAccess;
      try {
        access = await this.access.getAccess(call.callId, call.clientId, accessController.signal);
      } catch {
        await this.requireCurrentOpen(generation, room);
        await this.failOpen("sfu_access_unavailable", "Não foi possível autorizar a mídia da chamada.");
      }
      await this.requireCurrentOpen(generation, room);
      try {
        await room.connect(access!.serverUrl, access!.token);
      } catch {
        await this.requireCurrentOpen(generation, room);
        await this.failOpen("sfu_connect_failed", "Não foi possível conectar a mídia da chamada.");
      }
      await this.requireCurrentOpen(generation, room);
      try {
        room.participants().forEach((participant) => this.replaceRemoteParticipant(participant, false));
        await this.syncLocalMedia();
      } catch {
        await this.requireCurrentOpen(generation, room);
        await this.failOpen("sfu_publish_failed", "Não foi possível publicar sua mídia na chamada.");
      }
      await this.requireCurrentOpen(generation, room);
      this.setSnapshot({
        state: "connected",
        connectionQuality: "good",
        remoteStreams: this.remoteStreamSnapshot(),
      });
      this.dependencies.onConnected();
    } finally {
      if (this.accessAbortController === accessController) this.accessAbortController = null;
    }
  }

  async receive(_event: MediaTransportEvent) {}

  async updateLocalMedia(media: MediaTransportLocalMedia) {
    this.media = media;
    if (this.room) await this.syncLocalMedia();
  }

  updateIce(_configuration: RTCConfiguration) {}
  async updateVideoInterest(interest: VideoSubscriptionInterest) { this.room?.updateVideoInterest?.(interest); }

  async updateScreenProfile(
    quality: MediaTransportLocalMedia["screenShareQuality"],
    fps: MediaTransportLocalMedia["screenShareFps"],
  ) {
    if (this.media) this.media = { ...this.media, screenShareQuality: quality, screenShareFps: fps };
  }

  snapshot() {
    return this.currentSnapshot;
  }

  subscribe(listener: (snapshot: MediaTransportSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.currentSnapshot);
    return () => this.listeners.delete(listener);
  }

  async close() {
    this.openGeneration += 1;
    this.accessAbortController?.abort();
    this.accessAbortController = null;
    this.stopObserving?.();
    this.stopObserving = null;
    const room = this.room;
    const publishedTracks = Array.from(this.publishedTracks.values());
    this.room = null;
    this.call = null;
    this.media = null;
    this.publishedTracks.clear();
    this.remoteStreams.clear();
    this.remoteIdentityByUser.clear();
    this.supersededRemoteIdentities.clear();
    if (room) {
      await Promise.allSettled(publishedTracks.map((track) => room.unpublish(track)));
      await room.disconnect().catch(() => undefined);
    }
    this.setSnapshot(INITIAL_SNAPSHOT);
  }

  private observer(): LiveKitRoomObserver {
    return {
      reconnecting: () => {
        this.setSnapshot({
          state: "connecting",
          connectionQuality: "connecting",
          iceTelemetry: this.iceState("checking"),
        });
        this.dependencies.onStatus("Reconectando mídia da chamada...");
      },
      reconnected: () => {
        this.setSnapshot({
          state: "connected",
          connectionQuality: "good",
          iceTelemetry: this.iceState("connected"),
        });
        this.dependencies.onConnected();
      },
      disconnected: (reason) => this.terminate(reason),
      participantConnected: (participant) => this.replaceRemoteParticipant(participant),
      participantDisconnected: (participant) => this.removeRemoteParticipant(participant),
      trackSubscribed: (participant, track) => this.addRemoteTrack(participant, track),
      trackUnsubscribed: (participant, track) => this.removeRemoteTrack(participant, track),
      connectionQualityChanged: (quality, local, remote) => {
        if (local) this.setSnapshot({ connectionQuality: connectionQuality(quality) });
        else if (remote) {
          const userId = this.remoteUserId(remote);
          if (userId && this.remoteIdentityByUser.get(userId) === remote.identity) this.setSnapshot({ participantConnectionQuality: { ...this.currentSnapshot.participantConnectionQuality, [userId]: connectionQuality(quality) } });
        }
      },
    };
  }

  private terminate(reason: LiveKitDisconnect) {
    if (!this.call && !this.room) return;
    this.openGeneration += 1;
    this.accessAbortController?.abort();
    this.accessAbortController = null;
    const failure = terminalFailure(reason);
    this.stopObserving?.();
    this.stopObserving = null;
    this.room = null;
    this.call = null;
    this.media = null;
    this.publishedTracks.clear();
    this.remoteStreams.clear();
    this.remoteIdentityByUser.clear();
    this.supersededRemoteIdentities.clear();
    this.setSnapshot({
      state: "failed",
      failure,
      remoteStreams: [],
      participantConnectionQuality: {},
      connectionQuality: "offline",
      iceTelemetry: this.iceState("failed"),
    });
    this.dependencies.onStatus(failure.detail);
    this.dependencies.onTerminated?.(failure);
  }

  private async syncLocalMedia() {
    const room = this.room;
    const media = this.media;
    if (!room || !media) return;
    const isLive = (track: MediaStreamTrack) => track.readyState !== "ended";
    const microphone = media.localStream?.getAudioTracks().find(isLive) || null;
    const screenAudio = media.screenStream?.getAudioTracks().find(isLive) || null;
    const hasExplicitVideo = Object.prototype.hasOwnProperty.call(media, "outgoingVideoTrack");
    const video = hasExplicitVideo
      ? media.outgoingVideoTrack || null
      : media.screenStream?.getVideoTracks().find(isLive)
        || media.localStream?.getVideoTracks().find((track) => isLive(track) && track.enabled)
        || null;
    const screenVideo = Boolean(video && media.screenStream?.getVideoTracks().includes(video));
    const desired: Array<[PublishedTrackRole, MediaStreamTrack | null, LiveKitTrackSource]> = [
      ["microphone", microphone, "microphone"],
      ["screen-audio", screenAudio, "screen-share-audio"],
      ["video", video, screenVideo ? "screen-share" : "camera"],
    ];

    for (const [role, track, source] of desired) {
      const current = this.publishedTracks.get(role) || null;
      if (current === track) continue;
      if (current) {
        await room.unpublish(current);
        this.publishedTracks.delete(role);
      }
      if (track) {
        await room.publish(track, source);
        this.publishedTracks.set(role, track);
      }
    }
  }

  private replaceRemoteParticipant(participant: LiveKitRemoteParticipant, publish = true) {
    const userId = this.remoteUserId(participant);
    if (!userId || userId === this.call?.selfUserId) return;
    if (!this.claimRemoteIdentity(userId, participant.identity)) return;
    if (!participant.tracks.length) {
      this.remoteStreams.delete(userId);
    } else {
      this.remoteStreams.set(userId, new MediaStream([...participant.tracks]));
    }
    if (publish) this.setSnapshot({ remoteStreams: this.remoteStreamSnapshot() });
  }

  private addRemoteTrack(participant: LiveKitRemoteParticipant, track: MediaStreamTrack) {
    const userId = this.remoteUserId(participant);
    if (!userId || userId === this.call?.selfUserId) return;
    if (!this.claimRemoteIdentity(userId, participant.identity)) return;
    const stream = this.remoteStreams.get(userId) || new MediaStream();
    stream.addTrack(track);
    this.remoteStreams.set(userId, stream);
    this.setSnapshot({ remoteStreams: this.remoteStreamSnapshot() });
  }

  private removeRemoteTrack(participant: LiveKitRemoteParticipant, track: MediaStreamTrack) {
    const userId = this.remoteUserId(participant);
    if (!userId) return;
    if (this.remoteIdentityByUser.get(userId) !== participant.identity) return;
    const stream = this.remoteStreams.get(userId);
    if (!stream) return;
    stream.removeTrack(track);
    if (!stream.getTracks().length) this.remoteStreams.delete(userId);
    this.setSnapshot({ remoteStreams: this.remoteStreamSnapshot() });
  }

  private removeRemoteParticipant(participant: LiveKitRemoteParticipant) {
    const userId = this.remoteUserId(participant);
    if (!userId) return;
    if (this.remoteIdentityByUser.get(userId) !== participant.identity) {
      this.supersededRemoteIdentities.delete(participant.identity);
      return;
    }
    this.remoteIdentityByUser.delete(userId);
    this.remoteStreams.delete(userId);
    const qualities = { ...this.currentSnapshot.participantConnectionQuality }; delete qualities[userId];
    this.setSnapshot({ participantConnectionQuality: qualities });
    this.setSnapshot({ remoteStreams: this.remoteStreamSnapshot() });
  }

  private claimRemoteIdentity(userId: string, identity: string) {
    if (this.supersededRemoteIdentities.has(identity)) return false;
    const currentIdentity = this.remoteIdentityByUser.get(userId);
    if (currentIdentity && currentIdentity !== identity) {
      this.supersededRemoteIdentities.add(currentIdentity);
      this.remoteStreams.delete(userId);
      const qualities = { ...this.currentSnapshot.participantConnectionQuality }; delete qualities[userId];
      this.setSnapshot({ participantConnectionQuality: qualities });
    }
    this.remoteIdentityByUser.set(userId, identity);
    return true;
  }

  private remoteUserId(participant: LiveKitRemoteParticipant) {
    try {
      const metadata = JSON.parse(participant.metadata || "") as unknown;
      if (!metadata || typeof metadata !== "object" || !("userId" in metadata)) return null;
      const userId = (metadata as { userId?: unknown }).userId;
      return typeof userId === "string" && userId.trim() ? userId.trim() : null;
    } catch {
      return null;
    }
  }

  private remoteStreamSnapshot() {
    return Array.from(this.remoteStreams, ([userId, stream]) => ({ userId, stream }));
  }

  private iceState(state: IceTelemetrySnapshot["lastState"]): IceTelemetrySnapshot {
    const current = this.currentSnapshot.iceTelemetry;
    return {
      ...current,
      lastState: state,
      stateCounts: {
        ...current.stateCounts,
        [state]: (current.stateCounts[state] || 0) + 1,
      },
    };
  }

  private async requireCurrentOpen(generation: number, room: LiveKitRoomClient) {
    if (generation === this.openGeneration && this.room === room && this.call) return;
    await room.disconnect().catch(() => undefined);
    throw new Error("A chamada foi encerrada durante a conexão da mídia.");
  }

  private async failOpen(code: string, detail: string): Promise<never> {
    this.openGeneration += 1;
    this.accessAbortController?.abort();
    this.accessAbortController = null;
    const room = this.room;
    this.stopObserving?.();
    this.stopObserving = null;
    this.room = null;
    this.call = null;
    this.media = null;
    this.publishedTracks.clear();
    this.remoteStreams.clear();
    this.remoteIdentityByUser.clear();
    this.supersededRemoteIdentities.clear();
    if (room) await room.disconnect().catch(() => undefined);
    this.setSnapshot({
      state: "failed",
      failure: { code, detail, retryable: true },
      remoteStreams: [],
      participantConnectionQuality: {},
      connectionQuality: "offline",
      iceTelemetry: this.iceState("failed"),
    });
    this.dependencies.onStatus(detail);
    throw new Error(detail);
  }

  private setSnapshot(change: Partial<MediaTransportSnapshot>) {
    this.currentSnapshot = { ...this.currentSnapshot, ...change };
    this.listeners.forEach((listener) => listener(this.currentSnapshot));
  }
}

export class LiveKitMediaTransportFactory implements MediaTransportFactory {
  readonly kind = "sfu" as const;

  private readonly access: LiveKitAccessProvider;
  private readonly options: LiveKitMediaTransportOptions;

  constructor(
    access: LiveKitAccessProvider,
    options: LiveKitMediaTransportOptions = {},
  ) {
    this.access = access;
    this.options = options;
  }

  create(dependencies: MediaTransportDependencies) {
    return new LiveKitMediaTransport(dependencies, this.access, this.options);
  }
}
