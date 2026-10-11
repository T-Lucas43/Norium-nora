import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LabelDialog from "./LabelDialog";

function setup(props: Partial<Parameters<typeof LabelDialog>[0]> = {}) {
  const handlers = { onNameChange: vi.fn(), onSubmit: vi.fn(), onClose: vi.fn() };
  render(<LabelDialog name="" saving={false} {...handlers} {...props} />);
  return handlers;
}

describe("LabelDialog", () => {
  it("desabilita criar enquanto o nome esta vazio ou so com espacos", () => {
    setup({ name: "   " });
    expect(screen.getByRole("button", { name: /criar marcador/i })).toBeDisabled();
  });

  it("habilita criar com nome valido", () => {
    setup({ name: "Clientes" });
    expect(screen.getByRole("button", { name: /criar marcador/i })).toBeEnabled();
  });

  it("desabilita durante o salvamento para nao criar duplicado", () => {
    setup({ name: "Clientes", saving: true });
    expect(screen.getByRole("button", { name: /criar marcador/i })).toBeDisabled();
  });

  it("avisa cada digitacao no campo", () => {
    const { onNameChange } = setup();
    fireEvent.change(screen.getByPlaceholderText(/clientes prioritários/i), { target: { value: "Fiscal" } });
    expect(onNameChange).toHaveBeenCalledWith("Fiscal");
  });

  it("envia ao submeter o formulario", () => {
    const { onSubmit } = setup({ name: "Fiscal" });
    fireEvent.click(screen.getByRole("button", { name: /criar marcador/i }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("fecha pelo X e pelo Cancelar", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("fecha ao clicar fora, mas nao ao clicar dentro do formulario", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /criar marcador/i }).closest("form")!);
    expect(onClose).not.toHaveBeenCalled();
  });
});
