import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MailToolbar from "./MailToolbar";
import { emptyAdvancedFilters } from "../../features/mail/queryBuilder";
import type { GmailStatus } from "../../features/mail/types";

function setup(over: Partial<Parameters<typeof MailToolbar>[0]> = {}) {
  const handlers = {
    onSearchDraftChange: vi.fn(), onApplySearch: vi.fn(), onClearSearch: vi.fn(),
    onToggleFilters: vi.fn(), onCloseFilters: vi.fn(), onAdvancedFiltersChange: vi.fn(),
    onOpenMobileSidebar: vi.fn(), onOpenNora: vi.fn(), onTogglePreview: vi.fn(),
    onOpenSettings: vi.fn(), onToggleProfile: vi.fn(),
  };
  render(
    <MailToolbar
      status={{ connected: true, email: "a@x.com" } as GmailStatus}
      canUseNora
      searchDraft=""
      filtersOpen={false}
      advancedFilters={emptyAdvancedFilters}
      {...handlers}
      {...over}
    />,
  );
  return handlers;
}

describe("MailToolbar", () => {
  it("aplica a busca com Enter", () => {
    const h = setup();
    fireEvent.keyDown(screen.getByPlaceholderText(/pesquisar email/i), { key: "Enter" });
    expect(h.onApplySearch).toHaveBeenCalled();
  });

  it("nao aplica busca em outras teclas", () => {
    const h = setup();
    fireEvent.keyDown(screen.getByPlaceholderText(/pesquisar email/i), { key: "a" });
    expect(h.onApplySearch).not.toHaveBeenCalled();
  });

  it("so mostra o limpar quando ha texto digitado", () => {
    const { rerender } = render(
      <MailToolbar
        status={null} canUseNora searchDraft="" filtersOpen={false} advancedFilters={emptyAdvancedFilters}
        onSearchDraftChange={vi.fn()} onApplySearch={vi.fn()} onClearSearch={vi.fn()}
        onToggleFilters={vi.fn()} onCloseFilters={vi.fn()} onAdvancedFiltersChange={vi.fn()}
        onOpenMobileSidebar={vi.fn()} onOpenNora={vi.fn()} onTogglePreview={vi.fn()}
        onOpenSettings={vi.fn()} onToggleProfile={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /limpar pesquisa/i })).not.toBeInTheDocument();

    rerender(
      <MailToolbar
        status={null} canUseNora searchDraft="nota" filtersOpen={false} advancedFilters={emptyAdvancedFilters}
        onSearchDraftChange={vi.fn()} onApplySearch={vi.fn()} onClearSearch={vi.fn()}
        onToggleFilters={vi.fn()} onCloseFilters={vi.fn()} onAdvancedFiltersChange={vi.fn()}
        onOpenMobileSidebar={vi.fn()} onOpenNora={vi.fn()} onTogglePreview={vi.fn()}
        onOpenSettings={vi.fn()} onToggleProfile={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /limpar pesquisa/i })).toBeInTheDocument();
  });

  it("marca o estado do painel de filtros para leitores de tela", () => {
    setup({ filtersOpen: true });
    expect(screen.getByRole("button", { name: /filtros avancados/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("mantem o painel avancado fechado por padrao", () => {
    setup();
    expect(screen.queryByText(/pesquisa avancada/i)).not.toBeInTheDocument();
  });

  it("abre o painel avancado quando filtersOpen", () => {
    setup({ filtersOpen: true });
    expect(screen.getByText(/pesquisa avancada/i)).toBeInTheDocument();
  });

  it("propaga a alteracao de um filtro avancado preservando os demais", () => {
    const h = setup({ filtersOpen: true, advancedFilters: { ...emptyAdvancedFilters, subject: "mantem" } });
    fireEvent.change(screen.getByPlaceholderText(/remetente@email\.com/i), { target: { value: "ana@x.com" } });
    expect(h.onAdvancedFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ from: "ana@x.com", subject: "mantem" }));
  });

  it("mostra a conta conectada", () => {
    setup();
    expect(screen.getByText("a@x.com")).toBeInTheDocument();
  });

  it("esconde a conta quando nao ha conexao", () => {
    setup({ status: { connected: false } as GmailStatus });
    expect(screen.queryByText(/conectado como/i)).not.toBeInTheDocument();
  });

  it("esconde a Nora quando a conta nao tem acesso", () => {
    setup({ canUseNora: false });
    expect(screen.queryByRole("button", { name: /nora para e-mails/i })).not.toBeInTheDocument();
  });

  it("cai para iniciais quando a conta nao tem foto", () => {
    setup({ status: { connected: true, email: "bruno@x.com" } as GmailStatus });
    expect(screen.getByRole("button", { name: /perfil/i })).toHaveTextContent("B");
  });

  it("dispara as acoes do lado direito", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /nora para e-mails/i }));
    fireEvent.click(screen.getByRole("button", { name: /alternar previa/i }));
    fireEvent.click(screen.getByRole("button", { name: /configuracoes do mail/i }));
    fireEvent.click(screen.getByRole("button", { name: /perfil/i }));
    fireEvent.click(screen.getByRole("button", { name: /abrir menu do e-mail/i }));

    expect(h.onOpenNora).toHaveBeenCalled();
    expect(h.onTogglePreview).toHaveBeenCalled();
    expect(h.onOpenSettings).toHaveBeenCalled();
    expect(h.onToggleProfile).toHaveBeenCalled();
    expect(h.onOpenMobileSidebar).toHaveBeenCalled();
  });
});
