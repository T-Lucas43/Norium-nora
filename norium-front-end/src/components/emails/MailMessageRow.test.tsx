import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MailMessageRow from "./MailMessageRow";
import type { GmailMessage } from "../../features/mail/types";

const base = {
  id: "m1", threadId: "t1", subject: "Contrato 2026", snippet: "segue em anexo",
  fromName: "Ana Lima", fromEmail: "ana@x.com", dateLabel: "10:24", labels: [],
} as unknown as GmailMessage;

function setup(over: Partial<Parameters<typeof MailMessageRow>[0]> = {}) {
  const handlers = { onOpen: vi.fn(), onToggleCheck: vi.fn(), onToggleStar: vi.fn() };
  const { container } = render(
    <MailMessageRow
      message={base}
      selected={false}
      checked={false}
      compactMode={false}
      showPreview={false}
      groupByCategory={false}
      {...handlers}
      {...over}
    />,
  );
  return { ...handlers, container };
}

describe("MailMessageRow", () => {
  it("mostra remetente, assunto e horario", () => {
    setup();
    expect(screen.getByText("Ana Lima")).toBeInTheDocument();
    expect(screen.getByText("Contrato 2026")).toBeInTheDocument();
    expect(screen.getByText("10:24")).toBeInTheDocument();
  });

  it("abre a mensagem ao clicar na linha", () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalled();
  });

  it("marcar a caixa nao pode abrir a mensagem", () => {
    const { onOpen, onToggleCheck, container } = setup();
    fireEvent.click(container.querySelector("span")!);
    expect(onToggleCheck).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clicar na estrela nao pode abrir a mensagem", () => {
    const { onOpen, onToggleStar, container } = setup();
    fireEvent.click(container.querySelectorAll("span")[1]);
    expect(onToggleStar).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("so mostra a previa quando a preferencia esta ligada", () => {
    const { container } = setup();
    expect(container.textContent).not.toContain("segue em anexo");
  });

  it("mostra a previa quando ligada", () => {
    setup({ showPreview: true });
    expect(screen.getByText("segue em anexo")).toBeInTheDocument();
  });

  it("so mostra a etiqueta de categoria quando agrupado", () => {
    const { container } = setup();
    expect(container.textContent).not.toContain("Principal");
  });

  it("mostra a categoria classificada quando agrupado", () => {
    setup({ message: { ...base, subject: "Seu boleto venceu" } as GmailMessage, groupByCategory: true });
    expect(screen.getByText("Financeiro")).toBeInTheDocument();
  });

  it("destaca visualmente a mensagem nao lida", () => {
    const { container } = setup({ message: { ...base, unread: true } as GmailMessage });
    expect(container.querySelector("button")!.className).toContain("is-unread");
  });

  it("marca a linha selecionada", () => {
    const { container } = setup({ selected: true });
    expect(container.querySelector("button")!.className).toContain("mail-active");
  });

  it("usa altura reduzida no modo compacto", () => {
    const { container } = setup({ compactMode: true });
    expect(container.querySelector("button")!.className).toContain("is-compact");
  });

  it("mostra o clipe somente quando ha anexo", () => {
    const { container } = setup();
    const semAnexo = container.querySelectorAll("svg").length;
    const comAnexo = setup({ message: { ...base, hasAttachment: true } as GmailMessage });
    expect(comAnexo.container.querySelectorAll("svg").length).toBeGreaterThan(semAnexo);
  });
});
