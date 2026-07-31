import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProfilePopover from "./ProfilePopover";
import type { GmailStatus } from "../../../features/mail/types";

const conectado = { connected: true, name: "Ana Lima", email: "ana@x.com" } as GmailStatus;

function setup(status: GmailStatus | null = conectado) {
  const handlers = {
    onClose: vi.fn(), onOpenSettings: vi.fn(), onRefresh: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn(),
  };
  render(<ProfilePopover status={status} {...handlers} />);
  return handlers;
}

describe("ProfilePopover", () => {
  it("mostra nome e e-mail da conta conectada", () => {
    setup();
    expect(screen.getByText("Ana Lima")).toBeInTheDocument();
    expect(screen.getByText("ana@x.com")).toBeInTheDocument();
  });

  it("mostra textos neutros quando nao ha conta", () => {
    setup(null);
    expect(screen.getByText("Perfil Norium")).toBeInTheDocument();
    expect(screen.getByText("Gmail nao conectado")).toBeInTheDocument();
  });

  it("usa iniciais quando a conta nao tem foto", () => {
    setup();
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("usa a foto quando existe", () => {
    setup({ ...conectado, picture: "https://x/f.png" } as GmailStatus);
    expect(screen.getByAltText("Foto do perfil")).toHaveAttribute("src", "https://x/f.png");
  });

  it("oferece reconectar quando ja esta conectado", () => {
    setup();
    expect(screen.getByRole("button", { name: /reconectar gmail/i })).toBeInTheDocument();
  });

  it("oferece conectar quando esta desconectado", () => {
    setup({ connected: false } as GmailStatus);
    expect(screen.getByRole("button", { name: /^conectar gmail/i })).toBeInTheDocument();
  });

  it("impede sair da conta quando nao ha conexao", () => {
    setup({ connected: false } as GmailStatus);
    expect(screen.getByRole("button", { name: /sair desta conta/i })).toBeDisabled();
  });

  it("dispara cada acao do cartao", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /configuracoes/i }));
    fireEvent.click(screen.getByRole("button", { name: /atualizar perfil/i }));
    fireEvent.click(screen.getByRole("button", { name: /reconectar gmail/i }));
    fireEvent.click(screen.getByRole("button", { name: /sair desta conta/i }));
    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));

    expect(h.onOpenSettings).toHaveBeenCalled();
    expect(h.onRefresh).toHaveBeenCalled();
    expect(h.onConnect).toHaveBeenCalled();
    expect(h.onDisconnect).toHaveBeenCalled();
    expect(h.onClose).toHaveBeenCalled();
  });
});
