import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NoraMailDrawer from "./NoraMailDrawer";
import type { GmailMessage } from "../../../features/mail/types";

const aberta = { id: "m1", subject: "Contrato 2026" } as GmailMessage;

function setup(over: Partial<Parameters<typeof NoraMailDrawer>[0]> = {}) {
  const handlers = {
    onInputChange: vi.fn(), onSend: vi.fn(), onSummarize: vi.fn(), onNextAction: vi.fn(),
    onSuggestReply: vi.fn(), onListUnread: vi.fn(), onSummarizeInbox: vi.fn(), onCompose: vi.fn(), onClose: vi.fn(),
  };
  render(
    <NoraMailDrawer
      selectedMessage={null}
      messages={[]}
      loading={false}
      input=""
      scrollRef={createRef<HTMLDivElement>()}
      {...handlers}
      {...over}
    />,
  );
  return handlers;
}

describe("NoraMailDrawer", () => {
  it("sem e-mail aberto mostra os atalhos da caixa", () => {
    setup();
    expect(screen.getByRole("button", { name: /nao lidos/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resumir caixa/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sugerir resposta/i })).not.toBeInTheDocument();
    expect(screen.getByText(/caixa de entrada e novos envios/i)).toBeInTheDocument();
  });

  it("com e-mail aberto troca para os atalhos contextuais e mostra o assunto", () => {
    setup({ selectedMessage: aberta });
    expect(screen.getByRole("button", { name: /resumir aberto/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sugerir resposta/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /proxima acao/i })).toBeInTheDocument();
    expect(screen.getByText(/contexto: contrato 2026/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /nao lidos/i })).not.toBeInTheDocument();
  });

  it("dispara os atalhos contextuais", () => {
    const h = setup({ selectedMessage: aberta });
    fireEvent.click(screen.getByRole("button", { name: /resumir aberto/i }));
    fireEvent.click(screen.getByRole("button", { name: /sugerir resposta/i }));
    fireEvent.click(screen.getByRole("button", { name: /proxima acao/i }));
    expect(h.onSummarize).toHaveBeenCalled();
    expect(h.onSuggestReply).toHaveBeenCalled();
    expect(h.onNextAction).toHaveBeenCalled();
  });

  it("dispara os atalhos da caixa", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /nao lidos/i }));
    fireEvent.click(screen.getByRole("button", { name: /resumir caixa/i }));
    fireEvent.click(screen.getByRole("button", { name: /criar e-mail/i }));
    expect(h.onListUnread).toHaveBeenCalled();
    expect(h.onSummarizeInbox).toHaveBeenCalled();
    expect(h.onCompose).toHaveBeenCalled();
  });

  it("renderiza a conversa distinguindo operador e Nora", () => {
    setup({ messages: [{ role: "user", text: "resumir" }, { role: "ai", text: "voce tem 3 nao lidos" }] });
    expect(screen.getByText("resumir")).toBeInTheDocument();
    expect(screen.getByText("voce tem 3 nao lidos")).toBeInTheDocument();
  });

  it("mostra o aviso de carregamento enquanto a Nora responde", () => {
    setup({ loading: true });
    expect(screen.getByText(/nora lendo seus e-mails/i)).toBeInTheDocument();
  });

  it("envia com Enter e pelo botao", () => {
    const h = setup({ input: "oi" });
    fireEvent.keyDown(screen.getByPlaceholderText(/peca algo ao agente/i), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /enviar para a nora/i }));
    expect(h.onSend).toHaveBeenCalledTimes(2);
  });

  it("nao envia em outras teclas", () => {
    const h = setup({ input: "oi" });
    fireEvent.keyDown(screen.getByPlaceholderText(/peca algo ao agente/i), { key: "a" });
    expect(h.onSend).not.toHaveBeenCalled();
  });

  it("propaga a digitacao e fecha pelo X", () => {
    const h = setup();
    fireEvent.change(screen.getByPlaceholderText(/peca algo ao agente/i), { target: { value: "resumir" } });
    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));
    expect(h.onInputChange).toHaveBeenCalledWith("resumir");
    expect(h.onClose).toHaveBeenCalled();
  });
});
