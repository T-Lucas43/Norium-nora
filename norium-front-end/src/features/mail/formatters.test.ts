import { describe, expect, it } from "vitest";
import {
  accountInitials,
  classifyEmailCategory,
  inboxCategoryQuery,
  inboxCategoryUnreadCounts,
  cleanEmailSourceText,
  formatBytes,
  friendlyGmailLabel,
  initials,
  isImage,
  looksLikeBadEmailSuggestion,
  normalizeText,
  splitRecipients,
} from "./formatters";
import type { GmailMessage } from "./types";

function message(partial: Partial<GmailMessage>): GmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    subject: "",
    snippet: "",
    fromName: "",
    fromEmail: "",
    labels: [],
    ...partial,
  } as GmailMessage;
}

describe("splitRecipients", () => {
  it("separa por virgula e ponto e virgula, removendo vazios", () => {
    expect(splitRecipients("a@x.com, b@y.com; c@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(splitRecipients(" a@x.com ,, ; ")).toEqual(["a@x.com"]);
    expect(splitRecipients("")).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("trata zero e valores ausentes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("usa a unidade adequada", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("nao passa de GB mesmo em valores enormes", () => {
    expect(formatBytes(5 * 1024 ** 4)).toContain("GB");
  });
});

describe("initials / accountInitials", () => {
  it("usa as iniciais do primeiro e segundo nome", () => {
    expect(initials("Maria Silva")).toBe("MS");
  });

  it("ignora o e-mail entre sinais de menor/maior", () => {
    expect(initials("Ana Paula <ana@x.com>")).toBe("AP");
  });

  it("cai para N quando o nome e vazio", () => {
    expect(initials("")).toBe("N");
  });

  it("usa o e-mail quando a conta nao tem nome e sempre em maiusculas", () => {
    expect(accountInitials({ email: "bruno@x.com" } as never)).toBe("B");
    expect(accountInitials(null)).toBe("CN");
  });
});

describe("normalizeText", () => {
  it("remove acentos e baixa a caixa", () => {
    expect(normalizeText("Promoção ÚNICA")).toBe("promocao unica");
    expect(normalizeText("Ação")).toBe("acao");
  });
});

describe("classifyEmailCategory", () => {
  it("classifica por label do Gmail", () => {
    expect(classifyEmailCategory(message({ labels: ["CATEGORY_PROMOTIONS"] }))).toBe("promocoes");
    expect(classifyEmailCategory(message({ labels: ["CATEGORY_SOCIAL"] }))).toBe("social");
  });

  it("classifica financeiro por palavras-chave, mesmo com acento", () => {
    expect(classifyEmailCategory(message({ subject: "Seu boleto venceu" }))).toBe("financeiro");
    expect(classifyEmailCategory(message({ subject: "Nota fiscal do cartão" }))).toBe("financeiro");
  });

  it("financeiro tem prioridade sobre trabalho quando ambos aparecem", () => {
    expect(classifyEmailCategory(message({ subject: "boleto do contrato" }))).toBe("financeiro");
  });

  it("cai em principal quando nada casa", () => {
    expect(classifyEmailCategory(message({ subject: "Oi" }))).toBe("principal");
  });
});

describe("categorias da caixa de entrada", () => {
  it("usa consultas nativas do Gmail para cada aba", () => {
    expect(inboxCategoryQuery("principal")).toBe("category:primary");
    expect(inboxCategoryQuery("promocoes")).toBe("category:promotions");
    expect(inboxCategoryQuery("social")).toBe("category:social");
    expect(inboxCategoryQuery("atualizacoes")).toContain("category:forums");
  });

  it("calcula os nao lidos pelos rotulos oficiais e soma foruns em atualizacoes", () => {
    const labels = [
      { id: "CATEGORY_PERSONAL", messagesUnread: 2 },
      { id: "CATEGORY_PROMOTIONS", messagesUnread: 7 },
      { id: "CATEGORY_SOCIAL", messagesUnread: 3 },
      { id: "CATEGORY_UPDATES", messagesUnread: 4 },
      { id: "CATEGORY_FORUMS", messagesUnread: 1 },
    ].map((label) => ({ name: label.id, type: "system", messagesTotal: label.messagesUnread, ...label })) as never;

    expect(inboxCategoryUnreadCounts(labels)).toEqual({ principal: 2, promocoes: 7, social: 3, atualizacoes: 5 });
  });
});

describe("friendlyGmailLabel", () => {
  it("traduz os rotulos de sistema", () => {
    expect(friendlyGmailLabel("INBOX")).toBe("Caixa de entrada");
    expect(friendlyGmailLabel("unread")).toBe("Nao lido");
  });

  it("prefixa categorias e marcadores desconhecidos", () => {
    expect(friendlyGmailLabel("CATEGORY_OUTRA")).toBe("Categoria OUTRA");
    expect(friendlyGmailLabel("Label_15")).toBe("Marcador 15");
  });
});

describe("cleanEmailSourceText", () => {
  it("remove tags, style e script", () => {
    expect(cleanEmailSourceText("<style>p{color:red}</style><p>Oi <b>mundo</b></p>")).toBe("Oi mundo");
    expect(cleanEmailSourceText("<script>alert(1)</script>texto")).toBe("texto");
  });

  it("trata valor ausente e limita o tamanho", () => {
    expect(cleanEmailSourceText()).toBe("");
    expect(cleanEmailSourceText("a".repeat(6000))).toHaveLength(5000);
  });
});

describe("isImage", () => {
  it("reconhece apenas mime types de imagem", () => {
    expect(isImage("image/png")).toBe(true);
    expect(isImage("application/pdf")).toBe(false);
  });
});

describe("looksLikeBadEmailSuggestion", () => {
  it("detecta respostas evasivas da IA, com e sem acento", () => {
    expect(looksLikeBadEmailSuggestion("Preciso de contexto")).toBe(true);
    expect(looksLikeBadEmailSuggestion("O histórico está vazio")).toBe(true);
    expect(looksLikeBadEmailSuggestion("Nao consigo responder")).toBe(true);
  });

  it("aceita uma sugestao util", () => {
    expect(looksLikeBadEmailSuggestion("Ola, segue o retorno solicitado.")).toBe(false);
  });
});
