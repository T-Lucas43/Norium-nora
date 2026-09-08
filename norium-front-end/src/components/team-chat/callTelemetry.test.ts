import { describe, expect, it, vi } from "vitest";
import { CallTelemetry } from "./callTelemetry";
import type { MediaTransportSnapshot } from "./media/MediaTransport";

const snapshot: MediaTransportSnapshot = {
  state: "connected", failure: null, remoteStreams: [], connectionQuality: "good",
  iceTelemetry: { lastState: "connected", stateCounts: {}, pathTypeCounts: {}, lastSelectedPath: null, relayObserved: false },
};

describe("call telemetry privacy and lifecycle", () => {
  it("counts first media connection once and never sends RTC diagnostics", () => {
    const send = vi.fn((_sample: unknown) => true);
    const telemetry = new CallTelemetry(send, performance.now());
    telemetry.connected();
    telemetry.connected();
    telemetry.observe({ ...snapshot, sdp: "private-sdp", ip: "192.0.2.1", candidate: "private-ice",
      iceTelemetry: { ...snapshot.iceTelemetry, stateCounts: { failed: 2 } } } as MediaTransportSnapshot, "mesh");
    telemetry.observe(snapshot, "mesh");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toEqual({ event: "connected", durationMs: expect.any(Number) });
    expect(send.mock.calls[1][0]).toEqual({ event: "ice_failed" });
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/private|192\.0\.2/);
  });

  it("queues a bounded reconnect sample until the authorized socket is restored", () => {
    let open = true;
    const delivered: unknown[] = [];
    const telemetry = new CallTelemetry((sample) => { if (open) delivered.push(sample); return open; }, performance.now());
    telemetry.connected();
    open = false;
    telemetry.reconnecting("socket");
    telemetry.reconnecting("socket");
    expect(delivered).toHaveLength(1);
    open = true;
    telemetry.recovered("socket");
    expect(delivered).toEqual([{ event: "connected", durationMs: expect.any(Number) },
      { event: "reconnecting" }, { event: "reconnected" }]);
    telemetry.failure("sfu");
    telemetry.failure("sfu");
    expect(delivered.filter((item) => (item as {event: string}).event === "sfu_failed")).toHaveLength(1);
  });
});
