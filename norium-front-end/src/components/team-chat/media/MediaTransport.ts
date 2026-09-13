export type MediaTransportKind = "mesh" | "sfu";

export type MediaTransportConnectionQuality = "offline" | "connecting" | "poor" | "fair" | "good";
export type MediaTransportFailure = { code: string; detail: string; retryable: boolean };
export type IceTelemetryState = RTCIceConnectionState | "unknown";
export type IcePathType = RTCIceCandidateType | "unknown";
export type IcePathProtocol = "udp" | "tcp" | "tls" | "unknown";

export type IceTelemetrySnapshot = {
  lastState: IceTelemetryState;
  stateCounts: Partial<Record<IceTelemetryState, number>>;
  pathTypeCounts: Partial<Record<IcePathType, number>>;
  lastSelectedPath: {
    localType: IcePathType;
    remoteType: IcePathType;
    protocol: IcePathProtocol;
  } | null;
  relayObserved: boolean;
};

export type MediaTransportSnapshot = {
  state: "idle" | "connecting" | "connected" | "failed";
  failure: MediaTransportFailure | null;
  remoteStreams: Array<{ userId: string; stream: MediaStream }>;
  connectionQuality: MediaTransportConnectionQuality;
  iceTelemetry: IceTelemetrySnapshot;
};

export type MediaTransportCall = {
  callId: string;
  selfUserId: string;
  clientId: string;
};

export type MediaTransportLocalMedia = {
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  outgoingVideoTrack?: MediaStreamTrack | null;
  outgoingVideoStream?: MediaStream | null;
  screenShareQuality: "720p" | "1080p" | "1440p";
  screenShareFps: 15 | 30 | 60;
};

export type MediaTransportEvent =
  | { type: "participant-joined"; callId: string; userId: string; clientId?: string | null }
  | { type: "participant-left"; callId: string; userId: string; clientId?: string | null }
  | { type: "signal"; callId: string; userId: string; clientId?: string | null; signal: RTCSessionDescriptionInit | RTCIceCandidateInit }
  | { type: "screen-started"; callId: string; userId: string; clientId?: string | null }
  | { type: "screen-stopped"; callId: string; userId: string; clientId?: string | null };

export type MediaTransportDependencies = {
  emitSignal: (
    callId: string,
    targetUserId: string,
    signal: RTCSessionDescriptionInit | RTCIceCandidateInit,
  ) => boolean;
  onConnected: () => void;
  onStatus: (message: string) => void;
  onTerminated?: (failure: MediaTransportFailure) => void;
};

/**
 * The media engine boundary. Call lifecycle, chat, recording, capture and the
 * global team socket remain in CallSession; peer/SFU protocol details do not.
 * A transport instance belongs to exactly one call and must ignore stale
 * events carrying another call id.
 */
export interface MediaTransport {
  readonly kind: MediaTransportKind;
  open(call: MediaTransportCall, media: MediaTransportLocalMedia): Promise<void>;
  receive(event: MediaTransportEvent): Promise<void>;
  updateLocalMedia(media: MediaTransportLocalMedia): Promise<void>;
  updateIce(configuration: RTCConfiguration): void;
  updateScreenProfile(
    quality: MediaTransportLocalMedia["screenShareQuality"],
    fps: MediaTransportLocalMedia["screenShareFps"],
  ): Promise<void>;
  snapshot(): MediaTransportSnapshot;
  subscribe(listener: (snapshot: MediaTransportSnapshot) => void): () => void;
  close(): Promise<void>;
}

export interface MediaTransportFactory {
  readonly kind: MediaTransportKind;
  create(dependencies: MediaTransportDependencies): MediaTransport;
}

export function resolveMediaTransportFactory(
  requested: MediaTransportKind | undefined,
  factories: readonly MediaTransportFactory[],
): MediaTransportFactory {
  const kind = requested || "mesh";
  const factory = factories.find((candidate) => candidate.kind === kind);
  if (!factory) throw new Error(`O transporte de mídia ${kind} não está disponível neste cliente.`);
  return factory;
}
