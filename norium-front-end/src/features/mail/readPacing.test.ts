import { afterEach, expect, it, vi } from "vitest";
import { MAIL_SYNC_PAGE_DELAY_MS, waitForMailRead } from "./readPacing";
afterEach(() => vi.useRealTimers());
it("aguarda quinze segundos antes da próxima página em segundo plano", async () => {
  vi.useFakeTimers();
  let done = false;
  const pending = waitForMailRead(MAIL_SYNC_PAGE_DELAY_MS).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(done).toBe(true);
});
