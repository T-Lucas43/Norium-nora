import { describe, expect, it } from "vitest";
import { changedDocumentInput, type DocumentDraft } from "./commercialSave";

function draft(): DocumentDraft {
  return {
    title: "Proposta",
    contentHtml: "<p>Versao inicial</p>",
    scopeSummary: "Escopo",
    amount: 1200,
    currency: "BRL",
    validUntil: null,
    branding: {
      logoUrl: `data:image/png;base64,${"A".repeat(500_000)}`,
      logoAlignment: "left",
      logoScale: 100,
      primaryColor: "#2563EB",
      secondaryColor: "#0EA5E9",
      textColor: "#0F172A",
      headerHtml: "",
      footerHtml: "",
    },
    signers: [],
    deliverables: [],
  };
}

describe("salvamento comercial incremental", () => {
  it("envia somente o conteudo alterado e nao repete o logo pesado", () => {
    const saved = draft();
    const current = { ...saved, contentHtml: "<p>Versao revisada</p>" };

    const input = changedDocumentInput(current, saved, 7);

    expect(input).toEqual({ expectedVersion: 7, contentHtml: "<p>Versao revisada</p>" });
    expect(JSON.stringify(input).length).toBeLessThan(200);
  });

  it("inclui a marca quando ela realmente muda", () => {
    const saved = draft();
    const current = { ...saved, branding: { ...saved.branding, primaryColor: "#111827" } };

    const input = changedDocumentInput(current, saved, 2);

    expect(input.branding?.primaryColor).toBe("#111827");
  });
});
