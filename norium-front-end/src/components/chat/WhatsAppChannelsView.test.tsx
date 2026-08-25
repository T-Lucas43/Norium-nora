import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import WhatsAppChannelsView from "./WhatsAppChannelsView";

describe("area de canais do WhatsApp", () => {
  it("pesquisa canais e abre o detalhe do resultado selecionado", async () => {
    const user = userEvent.setup();
    render(
      <WhatsAppChannelsView
        items={[
          {
            id: "1@newsletter",
            name: "Canal Norium",
            description: "Novidades do produto",
            photoUrl: "https://cdn.example/norium.jpg",
          },
          {
            id: "2@newsletter",
            name: "Esportes Agora",
            description: "Resultados e noticias",
            verified: true,
            unreadCount: 3,
            timestamp: 1_725_000_123,
          },
        ]}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: "Pesquisar canais" }), "esportes");

    expect(screen.queryByRole("button", { name: "Abrir canal Canal Norium" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abrir canal Esportes Agora" }));

    expect(screen.getByRole("heading", { level: 2, name: "Esportes Agora" })).toBeInTheDocument();
    expect(within(screen.getByRole("article")).getByText("Resultados e noticias")).toBeInTheDocument();
    expect(screen.getByText("Canal verificado")).toBeInTheDocument();
    expect(screen.getByText("3 n\u00e3o lidas")).toBeInTheDocument();
  });
  it("expoe carregamento, erro com nova tentativa e catalogo vazio", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const { rerender } = render(
      <WhatsAppChannelsView items={[]} loading error={null} onRefresh={onRefresh} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Carregando canais");

    rerender(
      <WhatsAppChannelsView
        items={[]}
        loading={false}
        error={"N\u00e3o foi poss\u00edvel carregar os canais."}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("N\u00e3o foi poss\u00edvel carregar os canais.");
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <WhatsAppChannelsView items={[]} loading={false} error={null} onRefresh={onRefresh} />,
    );
    expect(screen.getByText("Nenhum canal dispon\u00edvel.")).toBeInTheDocument();
  });
});
