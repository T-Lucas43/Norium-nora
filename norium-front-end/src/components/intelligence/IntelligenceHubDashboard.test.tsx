import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock("../../core/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/api/client")>();
  return { ...actual, apiRequest: client.apiRequest };
});

import IntelligenceHubDashboard from "./IntelligenceHubDashboard";

describe("IntelligenceHubDashboard", () => {
  beforeEach(() => {
    client.apiRequest.mockImplementation((path: string) => {
      if (path === "/api/navegador") return Promise.resolve({ profiles: [], runs: [], credentials: [], runtime: { engine: "playwright-chromium", realBrowser: true, maxConcurrency: 1 } });
      if (path === "/api/conhecimento") return Promise.resolve({ bases: [], sources: [] });
      if (path === "/api/marketplace") return Promise.resolve({ catalog: [], installations: [] });
      if (path === "/api/modelos-ia") return Promise.resolve({ providers: [], policies: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 } });
      return Promise.resolve({});
    });
  });

  it.each([
    ["browser", "Agente Navegador", "/api/navegador"],
    ["knowledge", "Conhecimento", "/api/conhecimento"],
    ["marketplace", "Marketplace interno", "/api/marketplace"],
    ["models", "IA e Modelos", "/api/modelos-ia"],
  ] as const)("renderiza a tela %s e carrega seu contrato", async (mode, title, endpoint) => {
    render(<IntelligenceHubDashboard mode={mode} onOpenNora={vi.fn()} />);
    expect(screen.getByRole("heading", { name: title, level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(client.apiRequest.mock.calls.some(([path]) => path === endpoint)).toBe(true));
    if (mode === "browser") expect(screen.getByRole("button", { name: "Preparar pesquisa" })).toBeInTheDocument();
  });

  it("ativa uma instalação pelo controle funcional do marketplace", async () => {
    client.apiRequest.mockImplementation((path: string) => {
      if (path === "/api/marketplace") return Promise.resolve({
        catalog: [{
          id: "document-models-pack", type: "template-pack", name: "Modelos de documentos",
          description: "Biblioteca editorial", details: "Modelos preenchidos e editáveis", version: "1.0.0",
          author: "Norium", verified: true, permissions: ["Documentos"], dependencies: [],
          category: "Documentos", features: ["Currículos completos"], icon: "document-models", destination: "Documentos",
        }],
        installations: [{ id: "installation-1", catalogId: "document-models-pack", version: "1.0.0", status: "installed", enabled: false }],
      });
      if (path === "/api/marketplace/installations/installation-1") return Promise.resolve({ enabled: true });
      return Promise.resolve({});
    });

    render(<IntelligenceHubDashboard mode="marketplace" onOpenNora={vi.fn()} />);
    await userEvent.setup().click(await screen.findByRole("switch", { name: "Ativar Modelos de documentos" }));

    expect(client.apiRequest).toHaveBeenCalledWith(
      "/api/marketplace/installations/installation-1",
      { method: "PATCH", body: JSON.stringify({ enabled: true }) },
    );
  });
});
