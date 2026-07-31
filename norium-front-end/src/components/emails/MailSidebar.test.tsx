import { fireEvent, render, screen } from "@testing-library/react";
import { Inbox, Send, Trash2 } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import MailSidebar, { type SystemFolder } from "./MailSidebar";
import type { GmailLabel } from "../../features/mail/types";

const folders: SystemFolder[] = [
  { key: "inbox", label: "Caixa de entrada", icon: Inbox, countLabel: "INBOX" },
  { key: "sent", label: "Enviado", icon: Send },
  { key: "trash", label: "Lixo", icon: Trash2 },
];

function setup(over: Partial<Parameters<typeof MailSidebar>[0]> = {}) {
  const handlers = {
    onSelectMailbox: vi.fn(), onPrefetchMailbox: vi.fn(), onCompose: vi.fn(),
    onCreateLabel: vi.fn(), onRefreshLabels: vi.fn(), onOpenSettings: vi.fn(),
  };
  render(
    <MailSidebar
      systemFolders={folders}
      userLabels={[]}
      labelById={new Map()}
      activeFolder="inbox"
      activeFilter="all"
      {...handlers}
      {...over}
    />,
  );
  return handlers;
}

describe("MailSidebar", () => {
  it("lista as pastas do sistema", () => {
    setup();
    ["Caixa de entrada", "Enviado", "Lixo"].forEach((t) =>
      expect(screen.getByRole("button", { name: new RegExp(t, "i") })).toBeInTheDocument());
  });

  it("mostra a contagem de nao lidos da pasta", () => {
    setup({ labelById: new Map([["INBOX", { id: "INBOX", messagesUnread: 7 } as GmailLabel]]) });
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("nao mostra contador quando nao ha nao lidos", () => {
    setup({ labelById: new Map([["INBOX", { id: "INBOX", messagesUnread: 0 } as GmailLabel]]) });
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("navega e pre-carrega ao passar o mouse", () => {
    const h = setup();
    const enviados = screen.getByRole("button", { name: /enviado/i });
    fireEvent.mouseEnter(enviados);
    fireEvent.click(enviados);
    expect(h.onPrefetchMailbox).toHaveBeenCalledWith("sent");
    expect(h.onSelectMailbox).toHaveBeenCalledWith("sent");
  });

  it("pre-carrega tambem no foco por teclado", () => {
    const h = setup();
    fireEvent.focus(screen.getByRole("button", { name: /lixo/i }));
    expect(h.onPrefetchMailbox).toHaveBeenCalledWith("trash");
  });

  it("marca a pasta ativa somente sem filtro rapido aplicado", () => {
    const { rerender } = render(
      <MailSidebar
        systemFolders={folders} userLabels={[]} labelById={new Map()}
        activeFolder="inbox" activeFilter="all"
        onSelectMailbox={vi.fn()} onPrefetchMailbox={vi.fn()} onCompose={vi.fn()}
        onCreateLabel={vi.fn()} onRefreshLabels={vi.fn()} onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /caixa de entrada/i }).className).toContain("mail-active");

    rerender(
      <MailSidebar
        systemFolders={folders} userLabels={[]} labelById={new Map()}
        activeFolder="inbox" activeFilter="unread"
        onSelectMailbox={vi.fn()} onPrefetchMailbox={vi.fn()} onCompose={vi.fn()}
        onCreateLabel={vi.fn()} onRefreshLabels={vi.fn()} onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /caixa de entrada/i }).className).not.toContain("mail-active");
  });

  it("esconde a secao de marcadores quando nao ha nenhum", () => {
    setup();
    expect(screen.queryByText("Marcadores")).not.toBeInTheDocument();
  });

  it("lista marcadores do usuario e navega com o prefixo label:", () => {
    const h = setup({ userLabels: [{ id: "L1", name: "Clientes", messagesUnread: 3 } as GmailLabel] });
    expect(screen.getByText("Marcadores")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clientes/i }));
    expect(h.onSelectMailbox).toHaveBeenCalledWith("label:L1");
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("dispara as acoes de rodape e cabecalho", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /nova mensagem/i }));
    fireEvent.click(screen.getByRole("button", { name: /criar marcador/i }));
    fireEvent.click(screen.getByRole("button", { name: /^atualizar$/i }));
    fireEvent.click(screen.getByRole("button", { name: /configuracoes rapidas/i }));

    expect(h.onCompose).toHaveBeenCalled();
    expect(h.onCreateLabel).toHaveBeenCalled();
    expect(h.onRefreshLabels).toHaveBeenCalled();
    expect(h.onOpenSettings).toHaveBeenCalled();
  });

  it("navega para as pastas virtuais com estrela e importante", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /com estrela/i }));
    fireEvent.click(screen.getByRole("button", { name: /importante/i }));
    expect(h.onSelectMailbox).toHaveBeenCalledWith("starred");
    expect(h.onSelectMailbox).toHaveBeenCalledWith("important");
  });
});
