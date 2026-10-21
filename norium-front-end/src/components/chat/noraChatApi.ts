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

export function inboxNoraChatApi(inboxId?: string): typeof noraChatApi {
  if (!inboxId) return noraChatApi;
  const prepare = async (conversationId: string, action: string, instruction = "") => {
    const data = await apiRequest<{ response?: string }>(
      `/api/chat/caixas/${encodeURIComponent(inboxId)}/conversas/${encodeURIComponent(conversationId)}/nora`,
      { method: "POST", timeoutMs: 60_000, body: JSON.stringify({ action, instruction }) },
    );
    return requiredText(data.response, "A Nora não retornou um texto para revisar.");
  };
  return {
    suggestReply: (id, instruction) => prepare(id, "reply", instruction),
    summarizeConversation: id => prepare(id, "summary"),
    runCustomAction: (id, instruction) => prepare(id, "custom", instruction),
    improveDraft: (id, draft, instruction) => prepare(id, "custom", `Revise o texto conforme a instrução. Retorne somente a versão final, sem enviar.\nInstrução: ${instruction.trim()}\nTexto: ${draft.trim()}`),
  };
}
