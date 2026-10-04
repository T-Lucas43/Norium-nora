import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKEN_STORAGE } from "./config";
import { cancelSessionRestoration, closeCookieSession, renewCookieSession, SESSION_RENEWED_EVENT } from "./cookieSession";

const runtime = vi.hoisted(() => ({ base: "" }));
vi.mock("./config", () => ({ apiBaseUrl: () => runtime.base, AUTH_TOKEN_STORAGE: "norium-auth-token",
  authToken: () => sessionStorage.getItem("norium-auth-token") }));

function session(sub = "alice", sid = "session-a") {
  return { token: btoa(JSON.stringify({ sub, sid, exp: Math.floor(Date.now() / 1000) + 900 })) + ".synthetic-signature",
    user: { id: sub }, availableModes: ["app"] };
}
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cancelSessionRestoration();
  runtime.base = window.location.origin;
  sessionStorage.clear(); localStorage.clear();
  fetchMock = vi.fn().mockResolvedValueOnce(reply({ csrf: "synthetic-csrf" })).mockResolvedValue(reply(session()));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("opaque cookie session transport", () => {
  it("restores only short access into sessionStorage with no-store same-origin requests", async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE, "legacy-access");
    const restored = await renewCookieSession();
    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE)).toBe(restored.token);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request).toMatchObject({ credentials: "same-origin", cache: "no-store", method: "POST", body: "{}" });
    expect(new Headers(request.headers).get("X-Norium-CSRF")).toBe("synthetic-csrf");
    expect(new Headers(request.headers).has("Authorization")).toBe(false);
  });

  it("shares one renewal within a tab", async () => {
    await Promise.all([renewCookieSession(), renewCookieSession()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not replace the current account with the cookie account", async () => {
    const current = session("bob", "session-b").token;
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, current);
    await expect(renewCookieSession(current)).rejects.toMatchObject({ status: 401 });
    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE)).toBe(current);
  });

  it("checks each caller even when sharing one renewal", async () => {
    const results = await Promise.allSettled([renewCookieSession(session().token), renewCookieSession(session("bob", "session-b").token)]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
  });

  it("cancels a late restoration after logout or login", async () => {
    let finish!: (value: Response) => void;
    fetchMock.mockReset().mockResolvedValueOnce(reply({ csrf: "synthetic-csrf" }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = renewCookieSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    cancelSessionRestoration(); finish(reply(session()));
    await expect(pending).rejects.toMatchObject({ status: 499 });
    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
  });

  it("never retries an ambiguous network failure", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(reply({ csrf: "synthetic-csrf" }))
      .mockRejectedValueOnce(new TypeError("synthetic connection lost"));
    await expect(renewCookieSession()).rejects.toThrow("synthetic connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once only after a definitive unconsumed rate limit", async () => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockResolvedValueOnce(reply({ csrf: "synthetic-csrf" }))
      .mockResolvedValueOnce(reply({ detail: "Aguarde" }, 429)).mockResolvedValueOnce(reply(session()));
    const pending = renewCookieSession();
    await vi.advanceTimersByTimeAsync(5100);
    await expect(pending).resolves.toMatchObject({ user: { id: "alice" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses the tab's signed session for logout without forcing a renewal", async () => {
    const token = session().token;
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, token);
    await closeCookieSession();
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/auth/cookie-logout");
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("Authorization")).toBe(`Bearer ${token}`);
  });

  it("blocks a foreign cookie endpoint before sending a request", async () => {
    runtime.base = "https://foreign.example";
    await expect(renewCookieSession()).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not publish a malformed session response", async () => {
    const renewed = vi.fn(); window.addEventListener(SESSION_RENEWED_EVENT, renewed);
    try {
      fetchMock.mockReset().mockResolvedValueOnce(reply({ csrf: "synthetic-csrf" })).mockResolvedValueOnce(reply({ token: "invalid" }));
      await expect(renewCookieSession()).rejects.toMatchObject({ status: 401 });
      expect(renewed).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
    } finally { window.removeEventListener(SESSION_RENEWED_EVENT, renewed); }
  });
});
