export const MAIL_SYNC_PAGE_DELAY_MS = 15_000;
export function waitForMailRead(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}
