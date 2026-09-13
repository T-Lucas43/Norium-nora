import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoraFileCards, type NoraChatFile } from "./NoraFiles";

const pdf: NoraChatFile = {
  id: "nora_file_123",
  name: "relatorio-financeiro.pdf",
  mimeType: "application/pdf",
  size: 2048,
  previewUrl: "/api/nora/files/nora_file_123/content",
  downloadUrl: "/api/nora/files/nora_file_123/content?download=true",
};

const editablePdf: NoraChatFile = {
  ...pdf,
  id: "nora_file_editable",
  name: "curriculo-ana.pdf",
  editTarget: { tab: "Documentos", entityType: "proposal", entityId: "proposal_resume", label: "Editar no Documentos" },
};

describe("NoraFileCards", () => {
  it("exibe metadados e ações de visualizar, salvar e baixar", () => {
    render(<NoraFileCards files={[pdf]} />);
    expect(screen.getByText("relatorio-financeiro.pdf")).toBeInTheDocument();
    expect(screen.getByText("PDF · 2 KB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Visualizar relatorio-financeiro.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar à biblioteca: relatorio-financeiro.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Baixar relatorio-financeiro.pdf" })).toBeInTheDocument();
  });

  it("abre o documento editavel a partir do PDF do chat", async () => {
    const events: unknown[] = [];
    window.addEventListener("norium:deep-link", (event) => events.push((event as CustomEvent).detail), { once: true });
    render(<NoraFileCards files={[editablePdf]} />);

    screen.getByRole("button", { name: "Editar no Documentos: curriculo-ana.pdf" }).click();

    expect(JSON.parse(window.localStorage.getItem("norium-deep-link") || "null")).toEqual(editablePdf.editTarget);
    expect(events).toEqual([editablePdf.editTarget]);
  });
});
