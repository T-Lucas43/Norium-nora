import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import WhatsAppChannelsView from "./WhatsAppChannelsView";

describe("area de canais do WhatsApp", () => {
  it("mostra as atualizacoes reais ao abrir um canal", async () => {
    const user = userEvent.setup();
    render(
      <WhatsAppChannelsView
        items={[
          {
            id: "ofertas@newsletter",
            name: "Ofertas Norium",
            description: "Promocoes selecionadas",
            messages: [
              {
                id: "CHANNEL-UPDATE-1",
                remetente: "contato",
                texto: "Cupom de 20% disponivel ate sexta",
                tipo: "texto",
                horario: "10:30",
                timestamp: 1_725_000_100,
                canal: "whatsapp",
                channel: "whatsapp",
              },
              {
                id: "CHANNEL-UPDATE-2",
                remetente: "contato",
                texto: "Catalogo visual da promocao",
                tipo: "midia",
                arquivoUrl: "https://cdn.example/channel-promo.jpg",
                arquivoMime: "image/jpeg",
                horario: "10:31",
                timestamp: 1_725_000_200,
                canal: "whatsapp",
                channel: "whatsapp",
              },
            ],
          },
        ]}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Abrir canal Ofertas Norium" }));

    expect(screen.getByText("Cupom de 20% disponivel ate sexta")).toBeInTheDocument();
    expect(screen.getByText("10:30")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Catalogo visual da promocao" })).toHaveAttribute(
      "src",
      "https://cdn.example/channel-promo.jpg",
    );
  });

  it.each([
    { kind: "imagem", tipo: "midia" as const, mime: "image/jpeg" },
    { kind: "audio", tipo: "audio" as const, mime: "audio/ogg" },
    { kind: "video", tipo: "midia" as const, mime: "video/mp4" },
  ])("mostra fallback e remonta $kind publica ao tentar novamente", async ({ kind, tipo, mime }) => {
    const user = userEvent.setup();
    const label = `Publicacao de ${kind}`;
    const source = `https://cdn.example/channel-${kind}`;
    render(
      <WhatsAppChannelsView
        items={[
          {
            id: "midia@newsletter",
            name: "Canal de Midia",
            messages: [
              {
                id: `CHANNEL-${kind.toUpperCase()}`,
                remetente: "contato",
                texto: label,
                tipo,
                arquivoUrl: source,
                arquivoMime: mime,
                horario: "10:31",
                timestamp: 1_725_000_200,
                canal: "whatsapp",
                channel: "whatsapp",
              },
            ],
          },
        ]}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Abrir canal Canal de Midia" }));
    const findMedia = () => mime.startsWith("image/")
      ? screen.getByRole("img", { name: label })
      : screen.getByLabelText(label);
    const firstMedia = findMedia();

    fireEvent.error(firstMedia);

    expect(screen.getByText("Mídia indisponível.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    const retriedMedia = findMedia();
    expect(retriedMedia).not.toBe(firstMedia);
    expect(retriedMedia).toHaveAttribute("src", source);
  });

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
