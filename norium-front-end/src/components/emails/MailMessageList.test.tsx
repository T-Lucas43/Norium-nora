import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MailMessageList from "./MailMessageList";
import type { GmailMessage } from "../../features/mail/types";

const msg = (id: string, over: Partial<GmailMessage> = {}) =>
  ({ id, threadId: `t${id}`, subject: `Assunto ${id}`, snippet: "", fromName: `De ${id}`, fromEmail: "a@x.com", dateLabel: "10:00", labels: [], ...over }) as GmailMessage;

function setup(over: Partial<Parameters<typeof MailMessageList>[0]> = {}) {
  const h = {
    onRefresh: vi.fn(), onNextPage: vi.fn(), onFilterChange: vi.fn(),
    onToggleSelectAll: vi.fn(), onToggleSelectOne: vi.fn(), onToggleStar: vi.fn(),
    onOpenMessage: vi.fn(), onBulkAction: vi.fn(), onToggleGroupByCategory: vi.fn(),
    onOpenFilters: vi.fn(), onAskNora: vi.fn(),
  };
  render(
    <MailMessageList
      title="Caixa De Entrada"
      unreadCount={3}
      autoRefresh
      loading={false}
      error=""
      canUseNora
      messages={[msg("a"), msg("b")]}
      groupedMessages={[]}
      selectedIds={new Set()}
      selectedMessageId={null}
      visibleRange="1-2"
      resultSize={2}
      nextPageToken={null}
      syncActive={false}
      activeFilter="all"
      compactMode={false}
      showPreview={false}
      groupByCategory={false}
      showInboxCategories={false}
      activeInboxCategory="principal"
      inboxCategoryCounts={{ principal: 0, promocoes: 0, social: 0, atualizacoes: 0 }}
      onInboxCategoryChange={vi.fn()}
      {...h}
      {...over}
    />,
  );
  return h;
}

describe("MailMessageList", () => {
  it("mostra titulo e contagem de nao lidos", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Caixa De Entrada" })).toBeInTheDocument();
    expect(screen.getByText(/3 não lidos/)).toBeInTheDocument();
  });

  it("indica o modo de sincronizacao conforme a preferencia", () => {
    setup({ autoRefresh: false });
    expect(screen.getByText(/atualização manual/)).toBeInTheDocument();
  });

  it("renderiza uma linha por mensagem", () => {
    setup();
    expect(screen.getByText("De a")).toBeInTheDocument();
    expect(screen.getByText("De b")).toBeInTheDocument();
  });

  it("mostra o vazio quando nao ha mensagens", () => {
    setup({ messages: [] });
    expect(screen.getByText(/nenhum e-mail encontrado/i)).toBeInTheDocument();
  });

  it("mostra o carregando so quando ainda nao ha mensagens", () => {
    setup({ loading: true, messages: [] });
    expect(screen.getByText(/sincronizando gmail/i)).toBeInTheDocument();
  });

  it("mantem a lista visivel durante recarga silenciosa", () => {
    setup({ loading: true });
    expect(screen.queryByText(/sincronizando gmail/i)).not.toBeInTheDocument();
    expect(screen.getByText("De a")).toBeInTheDocument();
  });

  it("exibe erro quando existe", () => {
    setup({ error: "Falha ao carregar" });
    expect(screen.getByText("Falha ao carregar")).toBeInTheDocument();
  });

  it("desabilita paginacao sem proxima pagina", () => {
    setup();
    expect(screen.getByRole("button", { name: /proxima pagina/i })).toBeDisabled();
  });

  it("habilita a proxima pagina quando ha token", () => {
    const h = setup({ nextPageToken: "p2" });
    fireEvent.click(screen.getByRole("button", { name: /proxima pagina/i }));
    expect(h.onNextPage).toHaveBeenCalled();
  });

  it("desabilita voltar ao inicio quando cabe em uma pagina", () => {
    setup();
    expect(screen.getByRole("button", { name: /voltar ao inicio/i })).toBeDisabled();
  });

  it("so mostra acoes em lote quando ha selecao", () => {
    setup();
    expect(screen.queryByRole("button", { name: /arquivar/i })).not.toBeInTheDocument();
  });

  it("dispara arquivar e lixeira em lote", () => {
    const h = setup({ selectedIds: new Set(["a"]) });
    fireEvent.click(screen.getByRole("button", { name: /arquivar/i }));
    fireEvent.click(screen.getByRole("button", { name: /lixeira/i }));
    expect(h.onBulkAction).toHaveBeenCalledWith("archive");
    expect(h.onBulkAction).toHaveBeenCalledWith("trash");
  });

  it("marca selecionar todos apenas quando todas estao marcadas", () => {
    setup({ selectedIds: new Set(["a"]) });
    expect(screen.getByRole("button", { name: /selecionar todos/i }).className).not.toContain("bg-[#0EA5E9]");
  });

  it("troca o filtro rapido", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /nao lidos/i }));
    expect(h.onFilterChange).toHaveBeenCalledWith("unread");
  });

  it("divide a caixa de entrada em categorias funcionais", () => {
    const onInboxCategoryChange = vi.fn();
    setup({
      showInboxCategories: true,
      inboxCategoryCounts: { principal: 2, promocoes: 5, social: 1, atualizacoes: 0 },
      onInboxCategoryChange,
    });

    expect(screen.getByRole("tab", { name: /principal/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /promoções 5 novos/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /promoções/i }));
    expect(onInboxCategoryChange).toHaveBeenCalledWith("promocoes");
  });

  it("personaliza o estado vazio da categoria selecionada", () => {
    setup({ messages: [], showInboxCategories: true, activeInboxCategory: "social" });
    expect(screen.getByText("Nenhum e-mail em Social.")).toBeInTheDocument();
  });

  it("agrupa por categoria quando ligado", () => {
    setup({ groupByCategory: true, groupedMessages: [["financeiro", [msg("c")]]] });
    expect(screen.getByText("Financeiro")).toBeInTheDocument();
    expect(screen.getByText("1 e-mail(s)")).toBeInTheDocument();
  });

  it("esconde a faixa da Nora para conta sem acesso", () => {
    setup({ canUseNora: false });
    expect(screen.queryByRole("button", { name: /experimente/i })).not.toBeInTheDocument();
  });

  it("abre a mensagem clicada", () => {
    const h = setup();
    fireEvent.click(screen.getByText("De a").closest("button")!);
    expect(h.onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("rola ao topo sem recarregar ao voltar ao inicio", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(window.HTMLElement.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
    try {
      const many = Array.from({ length: 51 }, (_, i) => msg(`m${i}`));
      setup({ messages: many });
      fireEvent.click(screen.getByRole("button", { name: /voltar ao inicio/i }));
      expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    } finally {
      Reflect.deleteProperty(window.HTMLElement.prototype, "scrollTo");
    }
  });

  it("indica sincronizacao e trava a proxima pagina durante o sync", () => {
    const h = setup({ nextPageToken: "p2", syncActive: true });
    expect(screen.getByRole("button", { name: /proxima pagina/i })).toBeDisabled();
    expect(screen.getByText(/sincronizando…/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /proxima pagina/i }));
    expect(h.onNextPage).not.toHaveBeenCalled();
  });
});
