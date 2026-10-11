import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MailReplyBox from "./MailReplyBox";

function setup(over: Partial<Parameters<typeof MailReplyBox>[0]> = {}) {
  const h = {
    onTextChange: vi.fn(), onAddFiles: vi.fn(), onRemoveAttachment: vi.fn(),
    onAskNora: vi.fn(), onSend: vi.fn(),
  };
  render(
    <MailReplyBox
      text=""
      attachments={[]}
      sending={false}
      canUseNora
      noraSuggesting={null}
      {...h}
      {...over}
    />,
  );
  return h;
}

describe("MailReplyBox", () => {
  it("bloqueia responder sem texto", () => {
    setup();
    expect(screen.getByRole("button", { name: /responder/i })).toBeDisabled();
  });

  it("bloqueia responder com texto so de espacos", () => {
    setup({ text: "   " });
    expect(screen.getByRole("button", { name: /responder/i })).toBeDisabled();
  });

  it("libera responder com texto valido", () => {
    const h = setup({ text: "segue retorno" });
    fireEvent.click(screen.getByRole("button", { name: /responder/i }));
    expect(h.onSend).toHaveBeenCalled();
  });

  it("bloqueia durante o envio", () => {
    setup({ text: "ok", sending: true });
    expect(screen.getByRole("button", { name: /responder/i })).toBeDisabled();
  });

  it("propaga a digitacao", () => {
    const h = setup();
    fireEvent.change(screen.getByPlaceholderText(/escreva sua resposta/i), { target: { value: "oi" } });
    expect(h.onTextChange).toHaveBeenCalledWith("oi");
  });

  it("esconde a Nora para conta sem acesso", () => {
    setup({ canUseNora: false });
    expect(screen.queryByRole("button", { name: /gerar sugestão/i })).not.toBeInTheDocument();
  });

  it("trava a sugestao enquanto outra esta sendo gerada", () => {
    setup({ noraSuggesting: "compose" });
    expect(screen.getByRole("button", { name: /gerar sugestão/i })).toBeDisabled();
  });

  it("mostra anexos da resposta e permite remover", () => {
    const h = setup({ attachments: [{ id: "r1", fileName: "doc.pdf", mimeType: "application/pdf", size: 1024, dataUrl: "d" }] });
    expect(screen.getByText("doc.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remover anexo doc\.pdf/i }));
    expect(h.onRemoveAttachment).toHaveBeenCalledWith("r1");
  });

  it("renderiza o painel de sugestao recebido", () => {
    setup({ suggestionPanel: <div>sugestao</div> });
    expect(screen.getByText("sugestao")).toBeInTheDocument();
  });
});
