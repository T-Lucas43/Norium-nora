import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import NoraMessageChoices from "./NoraMessageChoices";

describe("Nora choices", () => {
  it("offers inline choices and records an alternative without a dialog", async () => {
    const choose = vi.fn().mockResolvedValue(undefined);
    render(<NoraMessageChoices text="Posso continuar?" disabled={false} onChoose={choose} />);
    await userEvent.click(screen.getByRole("button", { name: "Escrever outra opção" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "Leia somente os não lidos");
    await userEvent.click(screen.getByRole("button", { name: "Enviar resposta" }));
    expect(choose).toHaveBeenCalledWith("Leia somente os não lidos");
  });
  it("prevents decisions on a used or disabled message", () => {
    const choose = vi.fn();
    const { rerender } = render(<NoraMessageChoices text="Posso continuar?" disabled onChoose={choose} />);
    expect(screen.getByRole("button", { name: /^Continuar$/ })).toBeDisabled();
    rerender(<NoraMessageChoices text="Posso continuar?" selected="cancelar" disabled={false} onChoose={choose} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
