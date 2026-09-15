import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import IntegrationGrid from "./IntegrationGrid";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));

const request = vi.mocked(apiRequest);

describe("IntegrationGrid", () => {
  beforeEach(() => request.mockReset());

  it("shows a compact set of real integrations and respects marketplace installation state", async () => {
    request.mockResolvedValue({
      installations: [
        { catalogId: "web-source-connector", status: "installed", enabled: true },
      ],
    });
    const onNavigate = vi.fn();

    render(<IntegrationGrid onNavigate={onNavigate} />);

    expect(screen.getByRole("button", { name: "Abrir Gmail" })).toHaveClass("min-h-[88px]");
    expect(screen.getByRole("button", { name: "Abrir Chat da Equipe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir Modelos de documentos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir Nora para Clientes" })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole("button", { name: "Abrir Fontes web" })).toHaveTextContent("Ativo"));
    fireEvent.click(screen.getByRole("button", { name: "Abrir Fontes web" }));
    expect(onNavigate).toHaveBeenLastCalledWith("Conhecimento");

    fireEvent.click(screen.getByRole("button", { name: "Abrir Modelos de documentos" }));
    expect(onNavigate).toHaveBeenLastCalledWith("Marketplace");
  });
});
