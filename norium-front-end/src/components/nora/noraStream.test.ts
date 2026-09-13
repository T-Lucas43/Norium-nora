import { describe, expect, it } from "vitest";
import { drainNoraSseEvents } from "./noraStream";

describe("Nora SSE protocol", () => {
  it("reads named events, CRLF frames and chunks split in the middle of JSON", () => {
    const first = drainNoraSseEvents('event: status\r\ndata: {"type":"status","state":"thinking"}\r\n\r\nevent: delta\r\ndata: {"type":"delta","delta":"Ol');
    expect(first.events).toEqual([{ type: "status", state: "thinking" }]);
    const second = drainNoraSseEvents(`${first.rest}á"}\r\n\r\nevent: done\r\ndata: {"type":"done"}\r\n\r\n`);
    expect(second.events).toEqual([{ type: "delta", delta: "Olá" }, { type: "done" }]);
    expect(second.rest).toBe("");
  });

  it("flushes a final frame and ignores malformed frames without losing valid ones", () => {
    const result = drainNoraSseEvents('data: not-json\n\ndata: {"type":"delta","delta":"Resposta"}', true);
    expect(result.events).toEqual([{ type: "delta", delta: "Resposta" }]);
  });
});
