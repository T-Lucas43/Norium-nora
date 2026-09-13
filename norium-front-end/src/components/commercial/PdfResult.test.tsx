import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import PdfResult from "./PdfResult";
import type { UploadedDocument } from "../../features/commercial/types";
vi.mock("../../features/commercial/api", () => ({ downloadImportedDocument: vi.fn().mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" })) }));
afterEach(() => vi.unstubAllGlobals());
it("keeps a processed PDF available for preview and download on the same page", async () => {
  const NativeUrl = URL;
  vi.stubGlobal("URL", class extends NativeUrl { static createObjectURL = vi.fn(() => "blob:processed-pdf"); static revokeObjectURL = vi.fn(); });
  render(<PdfResult document={{ id: "result-1", title: "PDF editado", originalFileName: "pdf-editado.pdf", mimeType: "application/pdf" } as UploadedDocument}/>);
  const download = await screen.findByRole("link", { name: "Baixar arquivo" });
  expect(download).toHaveAttribute("download", "pdf-editado.pdf");
  expect(download).toHaveAttribute("href", "blob:processed-pdf");
  await userEvent.setup().click(screen.getByRole("button", { name: "Visualizar resultado" }));
  expect(screen.getByTitle("Resultado: PDF editado")).toHaveAttribute("src", "blob:processed-pdf");
  expect(screen.getByTitle("Resultado: PDF editado")).not.toHaveAttribute("sandbox");
});
