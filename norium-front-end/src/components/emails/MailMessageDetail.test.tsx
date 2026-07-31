import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MailMessageDetail from "./MailMessageDetail";
import type { GmailLabel, GmailMessage } from "../../features/mail/types";

const base = {
  id: "m1", threadId: "t1", subject: "Contrato 2026", snippet: "resumo",
  fromName: "Ana Lima", fromEmail: "ana@x.com", to: "eu@x.com",
  dateLabel: "10:24", dateFull: "15/01/2026 10:24", labels: [],
} as unknown as GmailMessage;

function setup(over: Partial<Parameters<typeof MailMessageDetail>[0]> = {}) {
  const h = {
    onClose: vi.fn(), onToggleFullscreen: vi.fn(), onToggleMenu: vi.fn(),
    onAction: vi.fn(), onDownloadAttachment: vi.fn(),
  };
  render(
    <MailMessageDetail
      message={base}
      labelById={new Map()}
      loading={false}
      fullscreen={false}
      menuOpen={false}
      scrollRef={createRef<HTMLDivElement>()}
      {...h}
      {...over}
    />,
  );
  return h;
}

describe("MailMessageDetail", () => {
  it("mostra assunto, remetente e data", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Contrato 2026" })).toBeInTheDocument();
    expect(screen.getByText("Ana Lima")).toBeInTheDocument();
    expect(screen.getByText("ana@x.com")).toBeInTheDocument();
  });

  it("mostra o carregando enquanto abre", () => {
    setup({ loading: true });
    expect(screen.getByText(/abrindo e-mail/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Contrato 2026" })).not.toBeInTheDocument();
  });

  it("arquivar e lixeira fecham a leitura depois da acao", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /arquivar/i }));
    fireEvent.click(screen.getByRole("button", { name: /mover para a lixeira/i }));
    expect(h.onAction).toHaveBeenCalledWith("archive", true);
    expect(h.onAction).toHaveBeenCalledWith("trash", true);
  });

  it("alterna lido conforme o estado atual", () => {
    const h = setup({ message: { ...base, unread: true } as GmailMessage });
    fireEvent.click(screen.getByRole("button", { name: /marcar como lido/i }));
    expect(h.onAction).toHaveBeenCalledWith("read");
  });

  it("alterna nao lido quando ja esta lido", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /marcar como nao lido/i }));
    expect(h.onAction).toHaveBeenCalledWith("unread");
  });

  it("alterna estrela conforme o estado atual", () => {
    const h = setup({ message: { ...base, starred: true } as GmailMessage });
    fireEvent.click(screen.getByRole("button", { name: /remover estrela/i }));
    expect(h.onAction).toHaveBeenCalledWith("unstar");
  });

  it("esconde acoes extras ate abrir o menu", () => {
    setup();
    expect(screen.queryByRole("button", { name: /spam/i })).not.toBeInTheDocument();
  });

  it("mostra acoes extras com o menu aberto", () => {
    const h = setup({ menuOpen: true });
    expect(screen.getByRole("button", { name: /marcar importante/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /spam/i }));
    expect(h.onAction).toHaveBeenCalledWith("spam", true);
  });

  it("esconde 'Tela cheia' no menu quando ja esta em tela cheia", () => {
    setup({ menuOpen: true, fullscreen: true });
    expect(screen.queryByRole("button", { name: /^tela cheia$/i })).not.toBeInTheDocument();
  });

  it("troca o rotulo do botao de tela cheia conforme o estado", () => {
    setup({ fullscreen: true });
    expect(screen.getByRole("button", { name: /sair da tela cheia/i })).toBeInTheDocument();
  });

  it("usa iframe com sandbox vazio para o HTML do remetente", () => {
    setup({ message: { ...base, bodyHtml: "<p>oi</p>" } as GmailMessage });
    const frame = screen.getByTitle("Conteudo do e-mail");
    expect(frame).toHaveAttribute("sandbox", "");
  });

  it("cai para o texto puro quando nao ha HTML", () => {
    setup({ message: { ...base, bodyText: "corpo em texto" } as GmailMessage });
    expect(screen.getByText("corpo em texto")).toBeInTheDocument();
  });

  it("avisa quando nao ha conteudo algum", () => {
    setup({ message: { ...base, snippet: "" } as GmailMessage });
    expect(screen.getByText(/sem conteudo disponivel/i)).toBeInTheDocument();
  });

  it("lista anexos e dispara o download", () => {
    const h = setup({
      message: {
        ...base,
        attachments: [{ attachmentId: "a1", fileName: "nota.pdf", mimeType: "application/pdf", size: 2048, downloadUrl: "/d/a1" }],
      } as GmailMessage,
    });
    fireEvent.click(screen.getByText("nota.pdf").closest("button")!);
    expect(h.onDownloadAttachment).toHaveBeenCalledWith("/d/a1", "nota.pdf");
  });

  it("nao repete na lista o rotulo ja mostrado como categoria", () => {
    setup({
      message: { ...base, subject: "Seu boleto venceu", labels: ["L1"] } as GmailMessage,
      labelById: new Map([["L1", { id: "L1", name: "Financeiro" } as GmailLabel]]),
    });
    expect(screen.getByText("Nenhum marcador adicional.")).toBeInTheDocument();
  });

  it("omite rotulos ja representados por outros elementos da tela", () => {
    setup({ message: { ...base, labels: ["INBOX", "UNREAD", "STARRED"] } as GmailMessage });
    expect(screen.getByText("Nenhum marcador adicional.")).toBeInTheDocument();
  });

  it("mostra marcadores proprios do usuario", () => {
    setup({
      message: { ...base, labels: ["L9"] } as GmailMessage,
      labelById: new Map([["L9", { id: "L9", name: "Clientes VIP" } as GmailLabel]]),
    });
    expect(screen.getByText("Clientes VIP")).toBeInTheDocument();
  });

  it("renderiza a caixa de resposta recebida", () => {
    setup({ replyBox: <div>caixa de resposta</div> });
    expect(screen.getByText("caixa de resposta")).toBeInTheDocument();
  });

  it("fecha pelo voltar e pelo X", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /voltar para a lista/i }));
    fireEvent.click(screen.getByRole("button", { name: /fechar e-mail/i }));
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });
});
