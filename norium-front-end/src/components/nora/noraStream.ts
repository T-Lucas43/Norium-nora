export type NoraStreamEvent = {
  type?: "status" | "delta" | "done";
  state?: string;
  response_id?: string;
  delta?: string;
  metrics?: Record<string, number>;
};

/** Drain complete SSE frames while retaining the final partial frame. */
export function drainNoraSseEvents(source: string, flush = false): { events: NoraStreamEvent[]; rest: string } {
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frames = (flush ? `${normalized}\n\n` : normalized).split("\n\n");
  const rest = flush ? "" : frames.pop() || "";
  const events: NoraStreamEvent[] = [];

  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as NoraStreamEvent;
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // A malformed provider frame is isolated; later complete frames still render.
    }
  }
  return { events, rest };
}
