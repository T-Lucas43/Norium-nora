import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import WhatsAppStatusView from "./WhatsAppStatusView";

describe("estado vazio do Status", () => {
  it("explica a ausência de eventos da integração e permite atualizar", () => {
    render(
      <WhatsAppStatusView
        items={[]}
        selectedId={null}
        sync={{ status: "error", progress: 4, message: "Falha ao sincronizar contatos" }}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onCreateUnavailable={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/A W-API não disponibilizou Status recentes/)).toHaveLength(2);
    expect(screen.getByText(/continuará aguardando novos Status/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atualizar Status" })).toBeInTheDocument();
  });
});
