import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PdfCapabilities, UploadedDocument } from "../../features/commercial/types";

const commercialApi = vi.hoisted(() => ({ downloadImportedDocument: vi.fn() }));

vi.mock("../../features/commercial/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../features/commercial/api")>();
  return { ...actual, ...commercialApi };
});

import PdfToolsWorkspace from "./PdfToolsWorkspace";

const document: UploadedDocument = {
  id: "pdf-1",
  documentType: "pdf",
  title: "Contrato final",
  originalFileName: "contrato-final.pdf",
  mimeType: "application/pdf",
  size: 1024,
  sha256: "abc",
  category: "pdf",
  direction: "internal",
  status: "ready",
  favorite: false,
  archived: false,
  confidential: false,
  scanStatus: "pending",
  securityReviewRequired: true,
  events: [],
  createdBy: "user-test",
  createdByName: "Usuario teste",
  createdAt: "2026-09-02T10:00:00Z",
  updatedAt: "2026-09-02T10:00:00Z",
};

const capabilities: PdfCapabilities = {
  operations: [{ id: "edit_pdf", label: "Editar PDF", engine: "native" }],
  stirling: { configured: false, available: false, operations: [], message: "Nao configurado" },
  maxUploadBytes: 25 * 1024 * 1024,
  asynchronous: true,
};

describe("PdfToolsWorkspace", () => {
  beforeEach(() => {
    commercialApi.downloadImportedDocument.mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
    const NativeUrl = URL;
    vi.stubGlobal("URL", class extends NativeUrl {
      static createObjectURL = vi.fn(() => "blob:https://norium.local/pdf-1");
      static revokeObjectURL = vi.fn();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("visualiza o PDF sem o sandbox que o Edge bloqueia", async () => {
    render(<PdfToolsWorkspace capabilities={capabilities} documents={[document]} jobs={[]} busy={false} onBack={vi.fn()} onProcess={vi.fn()} onImported={vi.fn()} onDelete={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Editar PDF/ }));
    await userEvent.setup().click(screen.getByRole("radio"));

    const viewer = await screen.findByTitle("Visualizacao de Contrato final");
    await waitFor(() => expect(viewer).toHaveAttribute("src", "blob:https://norium.local/pdf-1"));
    expect(viewer).not.toHaveAttribute("sandbox");
  });

  it("permite excluir o PDF dentro da ferramenta", async () => {
    const onDelete = vi.fn().mockResolvedValue(true);
    render(<PdfToolsWorkspace capabilities={capabilities} documents={[document]} jobs={[]} busy={false} onBack={vi.fn()} onProcess={vi.fn()} onImported={vi.fn()} onDelete={onDelete} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Editar PDF/ }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Excluir Contrato final" }));

    expect(onDelete).toHaveBeenCalledWith(document);
    expect(await screen.findByText(/foi excluido/i)).toBeInTheDocument();
  });
});
