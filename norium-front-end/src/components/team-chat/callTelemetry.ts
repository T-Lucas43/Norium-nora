import type { MediaTransportSnapshot } from "./media/MediaTransport";

type Event = "connected" | "ice_failed" | "reconnecting" | "reconnected" | "sfu_failed";
type Sample = { event: Event; durationMs?: number };

/** Fixed vocabulary, eight pending samples, no timers or raw diagnostics. */
export class CallTelemetry {
  private connectedOnce = false;
  private recovering = new Set<"socket" | "media">();
  private iceFailures = 0;
  private failed = false;
  private pending: Sample[] = [];
  private readonly send: (sample: Sample) => boolean;
  private readonly started: number;

  constructor(send: (sample: Sample) => boolean, started: number) {
    this.send = send;
    this.started = started;
  }

  private emit(event: Event, durationMs?: number) {
    const sample: Sample = durationMs === undefined ? { event } : { event, durationMs };
    if (this.pending.length < 8) this.pending.push(sample);
    this.flush();
  }

  flush() {
    while (this.pending.length && this.send(this.pending[0])) this.pending.shift();
  }

  connected() {
    if (!this.connectedOnce) {
      this.connectedOnce = true;
      this.emit("connected", Math.min(120_000, Math.max(0, Math.round(performance.now() - this.started))));
    }
    this.recovered("media");
  }

  reconnecting(source: "socket" | "media") {
    if (!this.connectedOnce || this.recovering.has(source)) return;
    this.recovering.add(source);
    this.emit("reconnecting");
  }

  recovered(source: "socket" | "media") {
    if (this.recovering.delete(source)) this.emit("reconnected");
    this.flush();
  }

  failure(kind: "mesh" | "sfu") {
    if (kind === "sfu" && !this.failed) {
      this.failed = true;
      this.emit("sfu_failed");
    }
  }

  observe(snapshot: MediaTransportSnapshot, kind: "mesh" | "sfu") {
    const failures = snapshot.iceTelemetry.stateCounts.failed || 0;
    if (failures > this.iceFailures) this.emit("ice_failed");
    this.iceFailures = failures;
    if (snapshot.connectionQuality === "offline"
      || snapshot.connectionQuality === "connecting") this.reconnecting("media");
    if (snapshot.state === "failed") this.failure(kind);
    if (["good", "fair", "poor"].includes(snapshot.connectionQuality)) this.recovered("media");
  }
}
