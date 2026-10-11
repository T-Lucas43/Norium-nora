import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ComposeModal from "./ComposeModal";
import type { ComposeState } from "../../../features/mail/types";

const vazio: ComposeState = { to: "", cc: "", bcc: "", subject: "", body: "", attachments: [] };

function setup(over: Partial<Parameters<typeof ComposeModal>[0]> = {}) {
  const handlers = {
    onChange: vi.fn(), onAddFiles: vi.fn(), onRemoveAttachment: vi.fn(),
    onAskNora: vi.fn(), onSaveDraft: vi.fn(), onSend: vi.fn(), onClose: vi.fn(),
  };
  render(
    <ComposeModal
      compose={vazio}
      sending={false}
      canUseNora
      noraSuggesting={null}
      {...handlers}
      {...over}
    />,
  );
  return handlers;
}

describe("ComposeModal", () => {
  it("bloqueia envio e rascunho sem destinatario", () => {
    setup();
    expect(screen.getByRole("button", { name: /enviar/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /salvar rascunho/i })).toBeDisabled();
  });

  it("bloqueia envio quando o destinatario tem so espacos", () => {
    setup({ compose: { ...vazio, to: "   " } });
    expect(screen.getByRole("button", { name: /enviar/i })).toBeDisabled();
  });

  it("libera envio com destinatario valido", () => {
    const { onSend } = setup({ compose: { ...vazio, to: "a@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /enviar/i }));
    expect(onSend).toHaveBeenCalled();
  });

  it("bloqueia envio durante o envio em andamento", () => {
    setup({ compose: { ...vazio, to: "a@x.com" }, sending: true });
    expect(screen.getByRole("button", { name: /enviar/i })).toBeDisabled();
  });

  it("propaga a edicao de cada campo preservando os demais", () => {
    const { onChange } = setup({ compose: { ...vazio, subject: "mantem" } });
    fireEvent.change(screen.getByPlaceholderText("Para"), { target: { value: "b@y.com" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ to: "b@y.com", subject: "mantem" }));
  });

  it("esconde o botao da Nora quando a conta nao tem acesso", () => {
    setup({ canUseNora: false });
    expect(screen.queryByRole("button", { name: /gerar sugestão/i })).not.toBeInTheDocument();
  });

  it("trava a sugestao enquanto outra esta sendo gerada", () => {
    setup({ noraSuggesting: "reply" });
    expect(screen.getByRole("button", { name: /gerar sugestão/i })).toBeDisabled();
  });

  it("mostra anexos e permite remover", () => {
    const { onRemoveAttachment } = setup({
      compose: { ...vazio, attachments: [{ id: "a1", fileName: "nota.pdf", mimeType: "application/pdf", size: 2048, dataUrl: "d" }] },
    });
    expect(screen.getByText("nota.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remover anexo nota\.pdf/i }));
    expect(onRemoveAttachment).toHaveBeenCalledWith("a1");
  });

  it("renderiza o painel de sugestao recebido do dashboard", () => {
    setup({ suggestionPanel: <div>sugestao da nora</div> });
    expect(screen.getByText("sugestao da nora")).toBeInTheDocument();
  });

  it("fecha pelo X", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
