import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfPreviewBinaryData, pdfPreviewBytes } from "./pdfPreviewData";

describe("PDF preview under production CSP", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reads an authenticated PDF from memory without fetching a blocked blob URL", async () => {
    const fetch = vi.fn(() => { throw new Error("CSP blocks blob fetch"); });
    vi.stubGlobal("fetch", fetch);
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const blob = { arrayBuffer: async () => bytes.buffer } as Blob;
    expect(await pdfPreviewBytes(blob, "blob:https://norium.test/report")).toEqual(bytes);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports failed downloads instead of feeding an error document to the PDF engine", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(pdfPreviewBytes(undefined, "https://norium.test/document.pdf")).rejects.toThrow("carregar este PDF");
  });
  it("resolves bundled standard fonts instead of relying on the viewer's installed fonts", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer });
    vi.stubGlobal("fetch", fetch);
    const result = await new PdfPreviewBinaryData({}).fetch({ kind: "standardFontDataUrl", filename: "FoxitSerif.pfb" });
    expect(result).toEqual(new Uint8Array([1, 2]));
    expect(fetch.mock.calls[0][0]).toContain("FoxitSerif");
  });
});
