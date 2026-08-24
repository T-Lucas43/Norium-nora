import { apiRequest } from "../../core/api/client";

type NoraDraftResponse = {
  draft?: string;
  response?: string;
};

function requiredText(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(fallback);
  return text;
}

export const noraChatApi = {
  async suggestReply(conversationId: string, instruction?: string) {
    const data = await apiRequest<NoraDraftResponse>("/api/nora/agentes/mensagens/rascunho", {
      method: "POST",
      timeoutMs: 60_000,
      body: JSON.stringify({
        conversa_id: conversationId,
        instrucao: instruction?.trim() || undefined,
      }),
    });
    return requiredText(data.draft || data.response, "A Nora não retornou um rascunho para revisar.");
  },

  async summarizeConversation(conversationId: string) {
    const data = await apiRequest<{ resumo?: string }>(
      `/api/nora/resumir-conversa?conversa_id=${encodeURIComponent(conversationId)}`,
      { timeoutMs: 60_000 },
    );
    return requiredText(data.resumo, "A Nora não retornou um resumo para revisar.");
  },

  async runCustomAction(conversationId: string, instruction: string) {
    const data = await apiRequest<{ response?: string }>("/api/nora/chat-whatsapp", {
      method: "POST",
      timeoutMs: 60_000,
      body: JSON.stringify({
        conversa_id: conversationId,
        texto_usuario: instruction.trim(),
        enviar_direto_whatsapp: false,
      }),
    });
    return requiredText(data.response, "A Nora não retornou um texto para revisar.");
  },

  async improveDraft(conversationId: string, currentDraft: string, instruction: string) {
    return this.runCustomAction(
      conversationId,
      [
        "Revise o texto abaixo conforme a melhoria pedida.",
        "Retorne somente a versão final do texto, pronta para o operador revisar. Não envie a mensagem.",
        `Melhoria pedida: ${instruction.trim()}`,
        `Texto atual: ${currentDraft.trim()}`,
      ].join("\n\n"),
    );
  },
};
