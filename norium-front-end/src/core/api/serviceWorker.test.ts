/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker() {
  const listeners: Record<string, (event: unknown) => void> = {};
  const fetch = vi.fn().mockResolvedValue(new Response("public", { status: 200 }));
  const cache = { put: vi.fn(), addAll: vi.fn().mockResolvedValue(undefined) };
  const caches = { match: vi.fn().mockResolvedValue(undefined), open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue([]), delete: vi.fn() };
  const self = { location: { origin: "https://norium.test" }, addEventListener: (name: string, fn: (event: unknown) => void) => { listeners[name] = fn; }, skipWaiting: vi.fn(), clients: { claim: vi.fn() } };
  runInNewContext(readFileSync(resolve("public/sw.js"), "utf8"), { self, caches, fetch, URL, Set });
  function request(path: string, headers: HeadersInit = {}) {
    const event = { request: { url: new URL(path, self.location.origin).href, method: "GET", mode: "cors", headers: new Headers(headers) }, respondWith: vi.fn(), waitUntil: vi.fn() };
    listeners.fetch(event);
    return event;
  }
  return { request, caches, cache, fetch };
}

describe("public asset cache", () => {
  it.each(["/api/nora/files/id/content", "/uploads/private.pdf", "/assets/file-abcdefgh.pdf", "/assets/logo-abcdefgh.png?token=private", "https://external.test/assets/app-abcdefgh.js"])("does not cache private, parameterized or external resources: %s", (path) => {
    expect(worker().request(path).respondWith).not.toHaveBeenCalled();
  });
  it("ignores even a build asset when it carries authentication", () => {
    expect(worker().request("/assets/app-abcdefgh.js", { Authorization: "Bearer private" }).respondWith).not.toHaveBeenCalled();
  });
  it("reuses an immutable build asset without downloading it again", async () => {
    const w = worker();
    const cached = new Response("cached js");
    w.caches.match.mockResolvedValue(cached);
    const event = w.request("/assets/app-abcdefgh.js");
    expect(await event.respondWith.mock.calls[0][0]).toBe(cached);
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it("refuses to save a response marked private", async () => {
    const w = worker();
    w.fetch.mockResolvedValue(new Response("private", { headers: { "Cache-Control": "private, no-store" } }));
    const event = w.request("/assets/app-abcdefgh.js");
    await event.respondWith.mock.calls[0][0];
    expect(w.cache.put).not.toHaveBeenCalled();
  });
});
