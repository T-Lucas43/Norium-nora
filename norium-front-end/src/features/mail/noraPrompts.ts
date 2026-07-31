// Montagem dos prompts enviados a Nora no modulo de e-mail.
// Extraido de EmailDashboard.tsx sem alteracao de texto: o comportamento do
// modelo depende literalmente dessas instrucoes.
import { cleanEmailSourceText } from "./formatters";
import type { ComposeState, GmailMessage } from "./types";

export type NoraTarget = "compose" | "reply";

export const NORA_WRITER_SYSTEM =
  "Voce esta no modulo Norium Mail. Sua unica funcao aqui e redigir e-mails. Em respostas, escreva sempre como o operador que recebeu o e-mail, nunca como o remetente original. Responda apenas com o texto do e-mail, sem comentarios.";

export const NORA_ANALYST_SYSTEM =
  "Voce e a Nora no Norium Mail. Responda em portugues do Brasil, com precisao e sem inventar fatos.";

/** Texto usado quando o modelo devolve uma resposta evasiva em vez de um e-mail. */
export function fallbackEmailSuggestion(target: NoraTarget, message: GmailMessage | null, compose: ComposeState) {
  if (target === "reply" && message) {
    const senderName = message.fromName || "tudo bem";
    const firstName = senderName.split(/\s+/)[0]?.replace(/[^\p{L}\p{N}]/gu, "") || "tudo bem";
    return [
      `Ola, ${firstName}.`,
      "",
      "Obrigado pelo envio. Vou verificar os pontos mencionados e retorno com uma posicao objetiva assim que concluir a analise.",
      "",
      "Se houver alguma prioridade ou prazo especifico, pode me sinalizar por aqui.",
      "",
      "Atenciosamente,",
      "Tarcisio",
    ].join("\n");
  }

  return [
    "Ola,",
    "",
    compose.body?.trim() || "Estou entrando em contato para alinhar os proximos passos e confirmar as informacoes necessarias.",
    "",
    "Fico no aguardo do seu retorno.",
    "",
    "Atenciosamente,",
    "Tarcisio",
  ].join("\n");
}

/** Resumo ou proxima acao sobre o e-mail aberto. */
export function buildContextualPrompt(action: "summary" | "next", message: GmailMessage) {
  const source = cleanEmailSourceText(message.bodyText || message.snippet || message.bodyHtml);
  return [
    action === "summary"
      ? "Resuma o e-mail recebido de forma objetiva. Destaque pedido, prazo, valor e proxima acao somente quando existirem."
      : "Analise o e-mail recebido e recomende a proxima acao mais segura e objetiva. Nao invente dados.",
    `Remetente: ${message.fromName} <${message.fromEmail}>`,
    `Assunto: ${message.subject || "(sem assunto)"}`,
    `Conteudo: ${source || message.snippet || "(sem conteudo disponivel)"}`,
  ].join("\n");
}

/**
 * Prompt de redacao. No modo resposta as instrucoes deixam explicito que o
 * operador RECEBEU o e-mail - sem isso o modelo escrevia como se fosse o
 * remetente original.
 */
export function buildSuggestionPrompt({
  target,
  message,
  compose,
  replyText,
  currentSuggestion,
  instruction,
}: {
  target: NoraTarget;
  message: GmailMessage | null;
  compose: ComposeState;
  replyText: string;
  currentSuggestion: string;
  instruction: string;
}) {
  const operatorDirection = instruction.trim();

  if (target === "reply" && message) {
    const sourceText = cleanEmailSourceText(message.bodyText || message.snippet || message.bodyHtml);
    return [
      "Tarefa: escreva SOMENTE o corpo final de uma resposta de e-mail.",
      "Voce esta escrevendo COMO Tarcisio, que RECEBEU o e-mail abaixo e vai responder ao remetente.",
      "Nunca escreva como se Tarcisio tivesse enviado o e-mail recebido.",
      "Nao diga que enviou, anexou, comprou, participou ou realizou algo se isso estiver apenas no e-mail recebido.",
      "Nao mencione historico de conversa, WhatsApp, falta de contexto, IA, Todoist ou analise externa.",
      "Use apenas os dados abaixo. Se o conteudo for promocional ou informativo, responda de forma curta, educada e neutra.",
      "Se o operador der uma orientacao, transforme essa orientacao em uma resposta completa e profissional.",
      "Nao explique o que voce fez. Nao use markdown.",
      "",
      `E-mail recebido de: ${message.fromName} <${message.fromEmail}>`,
      `Assunto recebido: ${message.subject || "(sem assunto)"}`,
      `Conteudo recebido: ${sourceText || message.snippet || "(sem corpo detalhado)"}`,
      `Texto que o operador ja escreveu no campo de resposta: ${replyText || "(vazio)"}`,
      `Rascunho anterior da Nora, se houver: ${currentSuggestion || "(nenhum)"}`,
      `Pedido de ajuste do operador: ${operatorDirection || "(nenhum)"}`,
    ].join("\n");
  }

  return [
    "Tarefa: escreva SOMENTE o corpo final de um e-mail profissional.",
    "Nao mencione historico de conversa, WhatsApp, falta de contexto, IA ou analise externa.",
    "Se faltarem dados, crie uma mensagem curta, neutra e segura. Nao invente promessas, anexos ou informacoes.",
    "Se o operador der uma orientacao, transforme essa orientacao em uma mensagem completa.",
    "Nao explique o que voce fez. Nao use markdown.",
    "",
    `Destinatario: ${compose.to || "(nao informado)"}`,
    `Assunto: ${compose.subject || "(sem assunto)"}`,
    `Texto que o operador ja escreveu: ${compose.body || "(vazio)"}`,
    `Rascunho anterior da Nora, se houver: ${currentSuggestion || "(nenhum)"}`,
    `Pedido de ajuste do operador: ${operatorDirection || "(nenhum)"}`,
  ].join("\n");
}
