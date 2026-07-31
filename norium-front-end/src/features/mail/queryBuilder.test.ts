import { describe, expect, it } from "vitest";
import {
  GMAIL_PAGE_SIZE,
  buildGmailSearchQuery,
  buildMessagesPath,
  emptyAdvancedFilters,
  resolveMailboxFolder,
} from "./queryBuilder";

describe("resolveMailboxFolder", () => {
  it("troca a pasta pelas pastas virtuais unread/starred", () => {
    expect(resolveMailboxFolder("inbox", "unread")).toBe("unread");
    expect(resolveMailboxFolder("sent", "starred")).toBe("starred");
  });

  it("mantem a pasta escolhida nos demais filtros", () => {
    expect(resolveMailboxFolder("sent", "all")).toBe("sent");
    expect(resolveMailboxFolder("drafts", "read")).toBe("drafts");
  });
});

describe("buildMessagesPath", () => {
  const base = { userId: "u1", folder: "inbox", filter: "all" as const, query: "" };

  it("monta a rota com usuario, pasta e tamanho de pagina", () => {
    const params = new URLSearchParams(buildMessagesPath(base).split("?")[1]);
    expect(params.get("user_id")).toBe("u1");
    expect(params.get("folder")).toBe("inbox");
    expect(params.get("max_results")).toBe(String(GMAIL_PAGE_SIZE));
    expect(params.get("q")).toBeNull();
  });

  it("inclui a busca quando ha texto, ignorando espacos em branco", () => {
    expect(new URLSearchParams(buildMessagesPath({ ...base, query: "   " }).split("?")[1]).get("q")).toBeNull();
    expect(new URLSearchParams(buildMessagesPath({ ...base, query: "  nota fiscal " }).split("?")[1]).get("q")).toBe("nota fiscal");
  });

  it("traduz o filtro 'read' para o operador is:read do Gmail", () => {
    expect(new URLSearchParams(buildMessagesPath({ ...base, filter: "read" }).split("?")[1]).get("q")).toBe("is:read");
  });

  it("combina busca livre com o filtro 'read'", () => {
    const params = new URLSearchParams(buildMessagesPath({ ...base, filter: "read", query: "boleto" }).split("?")[1]);
    expect(params.get("q")).toBe("boleto is:read");
  });

  it("so envia page_token quando existe", () => {
    expect(buildMessagesPath(base)).not.toContain("page_token");
    expect(new URLSearchParams(buildMessagesPath({ ...base, pageToken: "abc" }).split("?")[1]).get("page_token")).toBe("abc");
    expect(buildMessagesPath({ ...base, pageToken: null })).not.toContain("page_token");
  });

  it("escapa valores para nao quebrar a query string", () => {
    const path = buildMessagesPath({ ...base, query: "a&b=c" });
    expect(path).not.toContain("a&b=c");
    expect(new URLSearchParams(path.split("?")[1]).get("q")).toBe("a&b=c");
  });
});

describe("buildGmailSearchQuery", () => {
  it("retorna so a busca base quando nao ha filtros", () => {
    expect(buildGmailSearchQuery("relatorio", emptyAdvancedFilters)).toBe("relatorio");
  });

  it("aplica os operadores de remetente, destinatario e assunto", () => {
    const q = buildGmailSearchQuery("", { ...emptyAdvancedFilters, from: "ana@x.com", to: "bob@y.com", subject: "contrato final" });
    expect(q).toContain("from:ana@x.com");
    expect(q).toContain("to:bob@y.com");
    expect(q).toContain("subject:(contrato final)");
  });

  it("prefixa cada palavra excluida com hifen", () => {
    expect(buildGmailSearchQuery("", { ...emptyAdvancedFilters, excludes: "spam  promo" })).toBe("-spam -promo");
  });

  it("aplica periodo e anexo", () => {
    const q = buildGmailSearchQuery("nf", { ...emptyAdvancedFilters, newerThan: "7d", hasAttachment: true });
    expect(q).toBe("nf newer_than:7d has:attachment");
  });

  it("nao deixa espacos sobrando quando a base e vazia", () => {
    expect(buildGmailSearchQuery("   ", emptyAdvancedFilters)).toBe("");
    expect(buildGmailSearchQuery("  ", { ...emptyAdvancedFilters, hasAttachment: true })).toBe("has:attachment");
  });
});
