import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNoriumFetchAuth } from "./fetchAuth";
import { AUTH_TOKEN_STORAGE } from "./config";
import { SESSION_CLOSED_EVENT } from "./cookieSession";

const renew = vi.hoisted(() => vi.fn());
vi.mock("./cookieSession", async (original) => ({
  ...await original<typeof import("./cookieSession")>(), renewCookieSession: renew,
}));
const token = (sub = "a", sid = "sid-a", remaining = 900) =>
  btoa(JSON.stringify({ sub, sid, exp: Math.floor(Date.now() / 1000) + remaining })) + ".synthetic";
let native: ReturnType<typeof vi.fn>;
const resetMarker = () => { delete (window as unknown as Record<string, unknown>).__noriumFetchAuthInstalled; };

beforeEach(() => {
  resetMarker(); sessionStorage.clear(); localStorage.clear(); renew.mockReset();
  native = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", native);
  installNoriumFetchAuth();
});
afterEach(() => { resetMarker(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("session-aware fetch transport", () => {
  it("does not inject credentials into external requests", async () => {
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, token());
    await fetch("https://external.example.invalid/api/private");
    expect(native.mock.calls[0][1]).toBeUndefined();
  });

  it("keeps cookie protocol calls free of automatically injected Bearer", async () => {
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, token());
    await fetch("/api/auth/refresh", { method: "POST", headers: { Authorization: "Bearer synthetic-old" } });
    expect(new Headers(native.mock.calls[0][1].headers).has("Authorization")).toBe(false);
    expect(renew).not.toHaveBeenCalled();
  });

  it("rejects a stale explicit identity before sending any business operation", async () => {
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, token("b", "sid-b"));
    await expect(fetch("/api/private", { method: "POST", headers: { Authorization: `Bearer ${token()}` } }))
      .rejects.toMatchObject({ status: 401 });
    expect(native).not.toHaveBeenCalled();
  });

  it("renews before a mutation and sends the business operation once", async () => {
    const old = token("a", "sid-a", 1), fresh = token();
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, old);
    renew.mockResolvedValue({ token: fresh });
    await fetch("/api/private", { method: "POST", body: "{}" });
    expect(renew).toHaveBeenCalledWith(old);
    expect(native).toHaveBeenCalledOnce();
    expect(new Headers(native.mock.calls[0][1].headers).get("Authorization")).toBe(`Bearer ${fresh}`);
    expect(new Headers(native.mock.calls[0][1].headers).has("Idempotency-Key")).toBe(true);
  });

  it("does not resend a mutation after a network failure", async () => {
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, token());
    native.mockRejectedValueOnce(new TypeError("synthetic lost response"));
    await expect(fetch("/api/private", { method: "POST" })).rejects.toThrow("synthetic lost response");
    expect(native).toHaveBeenCalledOnce();
  });

  it("scopes a delayed invalidation to the original session after another login", async () => {
    let finish!: (value: Response) => void;
    native.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, token());
    const closed = vi.fn(); window.addEventListener(SESSION_CLOSED_EVENT, closed);
    try {
      const pending = fetch("/api/private");
      sessionStorage.setItem(AUTH_TOKEN_STORAGE, token("b", "sid-b"));
      finish(new Response("{}", { status: 401 })); await pending;
      expect(closed).toHaveBeenCalledOnce();
      expect((closed.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: "sid-a" });
    } finally { window.removeEventListener(SESSION_CLOSED_EVENT, closed); }
  });

  it("does not close a session for an incorrect password submitted to the change endpoint", async () => {
    native.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, token());
    const closed = vi.fn(); window.addEventListener(SESSION_CLOSED_EVENT, closed);
    try { await fetch("/api/auth/change-password", { method: "POST" }); expect(closed).not.toHaveBeenCalled(); }
    finally { window.removeEventListener(SESSION_CLOSED_EVENT, closed); }
  });
});
