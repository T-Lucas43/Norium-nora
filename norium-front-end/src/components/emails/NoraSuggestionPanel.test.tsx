import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NoraSuggestionPanel from "./NoraSuggestionPanel";

function setup(over: Partial<Parameters<typeof NoraSuggestionPanel>[0]> = {}) {
  const h = {
    onTextChange: vi.fn(), onInstructionChange: vi.fn(), onAccept: vi.fn(),
    onDiscard: vi.fn(), onRegenerate: vi.fn(),
  };
  render(<NoraSuggestionPanel text="Ola, segue retorno." instruction="" busy={false} {...h} {...over} />);
  return h;
}

describe("NoraSuggestionPanel", () => {
  it("mostra o texto sugerido de forma editavel", () => {
    setup();
    expect(screen.getByLabelText(/texto sugerido pela nora/i)).toHaveValue("Ola, segue retorno.");
  });

  it("permite editar a sugestao antes de aceitar", () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText(/texto sugerido pela nora/i), { target: { value: "editado" } });
    expect(h.onTextChange).toHaveBeenCalledWith("editado");
  });

  it("aceita e descarta a sugestao", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /aceitar sugestao/i }));
    fireEvent.click(screen.getByRole("button", { name: /descartar/i }));
    expect(h.onAccept).toHaveBeenCalled();
    expect(h.onDiscard).toHaveBeenCalled();
  });

  it("refazer usa instrucao fixa, sem depender do campo", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /refazer/i }));
    expect(h.onRegenerate).toHaveBeenCalledWith(expect.stringContaining("outra abordagem"));
  });

  it("aplicar ajuste fica bloqueado sem instrucao", () => {
    setup();
    expect(screen.getByRole("button", { name: /aplicar ajuste/i })).toBeDisabled();
  });

  it("aplicar ajuste fica bloqueado com instrucao so de espacos", () => {
    setup({ instruction: "   " });
    expect(screen.getByRole("button", { name: /aplicar ajuste/i })).toBeDisabled();
  });

  it("aplica o ajuste digitado", () => {
    const h = setup({ instruction: "seja mais breve" });
    fireEvent.click(screen.getByRole("button", { name: /aplicar ajuste/i }));
    expect(h.onRegenerate).toHaveBeenCalledWith("seja mais breve");
  });

  it("aplica o ajuste com Enter", () => {
    const h = setup({ instruction: "mais formal" });
    fireEvent.keyDown(screen.getByPlaceholderText(/deixe mais curto/i), { key: "Enter" });
    expect(h.onRegenerate).toHaveBeenCalledWith("mais formal");
  });

  it("Enter sem instrucao nao regenera", () => {
    const h = setup({ instruction: "  " });
    fireEvent.keyDown(screen.getByPlaceholderText(/deixe mais curto/i), { key: "Enter" });
    expect(h.onRegenerate).not.toHaveBeenCalled();
  });

  it("trava refazer e aplicar enquanto outra sugestao e gerada", () => {
    setup({ instruction: "x", busy: true });
    expect(screen.getByRole("button", { name: /refazer/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /aplicar ajuste/i })).toBeDisabled();
  });

  it("aceitar continua liberado mesmo ocupado, para nao perder o texto ja pronto", () => {
    setup({ busy: true });
    expect(screen.getByRole("button", { name: /aceitar sugestao/i })).toBeEnabled();
  });
});
