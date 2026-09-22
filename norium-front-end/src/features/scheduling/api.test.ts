import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import { clearSlotsCache, schedulingApi } from "./api";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));

describe("schedulingApi slots cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSlotsCache();
    vi.mocked(apiRequest).mockResolvedValue({ slots: [], calendarVerified: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSlotsCache();
  });

  it("reuses the cached response within the TTL", async () => {
    vi.useFakeTimers();
    await schedulingApi.slotsCached("page-1", "2026-10-01", 30);
    await schedulingApi.slotsCached("page-1", "2026-10-01", 30);
    expect(apiRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31_000);
    await schedulingApi.slotsCached("page-1", "2026-10-01", 30);
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it("separates cache entries per day and duration", async () => {
    await schedulingApi.slotsCached("page-1", "2026-10-01", 30);
    await schedulingApi.slotsCached("page-1", "2026-10-02", 30);
    await schedulingApi.slotsCached("page-1", "2026-10-01", 60);
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it("clears only the requested page", async () => {
    await schedulingApi.slotsCached("page-1", "2026-10-01", 30);
    await schedulingApi.slotsCached("page-2", "2026-10-01", 30);
    clearSlotsCache("page-1");
    await schedulingApi.slotsCached("page-1", "2026-10-01", 30);
    await schedulingApi.slotsCached("page-2", "2026-10-01", 30);
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it("does not cache aborted responses", async () => {
    const controller = new AbortController();
    controller.abort();
    await schedulingApi.slotsCached("page-1", "2026-10-01", 30, controller.signal);
    await schedulingApi.slotsCached("page-1", "2026-10-01", 30);
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });
});
