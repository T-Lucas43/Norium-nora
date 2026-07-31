import { describe, expect, it } from "vitest";
import { buildContextualPrompt, buildSuggestionPrompt, fallbackEmailSuggestion } from "./noraPrompts";
import type { ComposeState, GmailMessage } from "./types";

const compose: ComposeState = { to: "", cc: "", bcc: "", subject: "", body: "", attachments: [] };
const message = {
  id: "m1", threadId: "t1", subject: "Orcamento", snippet: "resumo curto",
  fromName: "Ana Lima", fromEmail: "ana@x.com", labels: [],
} as unknown as GmailMessage;

describe("fallbackEmailSuggestion", () => {
  it("usa o primeiro nome do remetente na resposta", () => {
    expect(fallbackEmailSuggestion("reply", message, compose)).toContain("Ola, Ana.");
  });

  it("remove pontuacao do primeiro nome", () => {
    const sujo = { ...message, fromName: '"Ana!" Lima' } as GmailMessage;
    expect(fallbackEmailSuggestion("reply", sujo, compose)).toContain("Ola, Ana.");
  });

  // Comportamento atual, preservado na extracao: sem remetente o texto cai para
  // "tudo bem", mas so o primeiro termo sobrevive ao split, gerando "Ola, tudo.".
  // A saudacao fica estranha - vale corrigir, mas em mudanca de comportamento propria.
  it("sem remetente gera a saudacao de fallback (hoje: 'Ola, tudo.')", () => {
    expect(fallbackEmailSuggestion("reply", { ...message, fromName: "" } as GmailMessage, compose)).toContain("Ola, tudo.");
  });

  it("na redacao aproveita o texto ja escrito pelo operador", () => {
    expect(fallbackEmailSuggestion("compose", null, { ...compose, body: "Segue a proposta." })).toContain("Segue a proposta.");
  });

  it("na redacao sem texto usa mensagem neutra", () => {
    expect(fallbackEmailSuggestion("compose", null, compose)).toContain("alinhar os proximos passos");
  });
});

describe("buildContextualPrompt", () => {
  it("pede resumo objetivo no modo summary", () => {
    const p = buildContextualPrompt("summary", message);
    expect(p).toContain("Resuma o e-mail recebido");
    expect(p).toContain("Ana Lima <ana@x.com>");
    expect(p).toContain("Orcamento");
  });

  it("pede proxima acao no modo next", () => {
    expect(buildContextualPrompt("next", message)).toContain("recomende a proxima acao");
  });

  it("limpa HTML do corpo antes de enviar ao modelo", () => {
    // bodyText e snippet vazios para o bodyHtml ser de fato a fonte usada
    const comHtml = { ...message, bodyText: "", snippet: "", bodyHtml: "<p>Valor <b>R$ 10</b></p>" } as GmailMessage;
    const p = buildContextualPrompt("summary", comHtml);
    expect(p).toContain("Valor R$ 10");
    expect(p).not.toContain("<b>");
  });

  it("prefere bodyText ao snippet e ao HTML", () => {
    const completo = { ...message, bodyText: "texto puro", snippet: "resumo", bodyHtml: "<p>html</p>" } as GmailMessage;
    expect(buildContextualPrompt("summary", completo)).toContain("Conteudo: texto puro");
  });

  it("marca assunto ausente em vez de deixar vazio", () => {
    expect(buildContextualPrompt("summary", { ...message, subject: "" } as GmailMessage)).toContain("(sem assunto)");
  });
});

describe("buildSuggestionPrompt", () => {
  const base = { compose, replyText: "", currentSuggestion: "", instruction: "" };

  it("no modo resposta deixa explicito que o operador RECEBEU o e-mail", () => {
    const p = buildSuggestionPrompt({ ...base, target: "reply", message });
    expect(p).toContain("RECEBEU o e-mail");
    expect(p).toContain("Nunca escreva como se Tarcisio tivesse enviado");
  });

  it("no modo redacao usa destinatario e assunto do formulario", () => {
    const p = buildSuggestionPrompt({
      ...base, target: "compose", message: null,
      compose: { ...compose, to: "bob@y.com", subject: "Parceria" },
    });
    expect(p).toContain("Destinatario: bob@y.com");
    expect(p).toContain("Assunto: Parceria");
    expect(p).not.toContain("RECEBEU o e-mail");
  });

  it("cai para o modo redacao quando pede resposta sem mensagem aberta", () => {
    const p = buildSuggestionPrompt({ ...base, target: "reply", message: null });
    expect(p).toContain("corpo final de um e-mail profissional");
  });

  it("repassa o pedido de ajuste do operador", () => {
    const p = buildSuggestionPrompt({ ...base, target: "reply", message, instruction: "  seja mais breve  " });
    expect(p).toContain("Pedido de ajuste do operador: seja mais breve");
  });

  it("marca campos vazios em vez de deixar a linha solta", () => {
    const p = buildSuggestionPrompt({ ...base, target: "reply", message });
    expect(p).toContain("Pedido de ajuste do operador: (nenhum)");
    expect(p).toContain("Rascunho anterior da Nora, se houver: (nenhum)");
    expect(p).toContain("Texto que o operador ja escreveu no campo de resposta: (vazio)");
  });

  it("inclui o rascunho anterior para a Nora refinar", () => {
    const p = buildSuggestionPrompt({ ...base, target: "reply", message, currentSuggestion: "versao 1" });
    expect(p).toContain("Rascunho anterior da Nora, se houver: versao 1");
  });
});
