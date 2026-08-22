import { apiRequest } from "../../core/api/client";
import type { ChatConversa, MsgConteudo } from "./types";

export type WhatsAppConnection = {
  conectado: boolean;
  qrcode?: string | null;
  status?: "conectado" | "desconectado" | "iniciando" | "aguardando_qrcode" | "erro" | "indisponivel";
  state?: string;
  detail?: string | null;
  numero?: string | null;
  conectadoEm?: string | null;
};

export type Contact = {
  id: string;
  phone: string;
  name?: string;
  pushname?: string;
  photoUrl?: string;
};

export type HistoryPage = {
  items: MsgConteudo[];
  cursor: number | null;
  hasMore: boolean;
};

export const whatsappApi = {
  async status(signal?: AbortSignal) {
    const payload = await apiRequest<{ whatsapp: WhatsAppConnection }>("/api/chat/status-canais", {
      cache: "no-store",
      timeoutMs: 15_000,
      signal,
    });
    return payload.whatsapp;
  },

  async start(signal?: AbortSignal) {
    return apiRequest<{ status: string; qrcode?: string | null }>("/api/chat/inicializar-login", {
      method: "POST",
      body: JSON.stringify({ canal: "whatsapp" }),
      timeoutMs: 20_000,
      signal,
    });
  },

  async disconnect() {
    return apiRequest<{ status: string }>("/api/chat/desconectar", {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 40_000,
    });
  },

  async conversations(since?: number) {
    const query = since && since > 0 ? `?since=${since}` : "";
    return apiRequest<ChatConversa[] | { items: ChatConversa[]; cursor: number; hasMore: boolean }>(
      `/api/chat/conversas${query}`,
      { timeoutMs: 35_000 },
    );
  },

  async history(conversationId: string, before?: number | null, limit = 50) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", String(before));
    return apiRequest<HistoryPage>(
      `/api/chat/conversas/${encodeURIComponent(conversationId)}/mensagens?${params.toString()}`,
      { timeoutMs: 30_000 },
    );
  },

  async contacts() {
    return apiRequest<Contact[]>("/api/chat/contatos-disponiveis", { timeoutMs: 30_000 });
  },

  async markConversation(conversationId: string, action: "lida" | "fixada" | "silenciada" | "arquivada", value: boolean) {
    return apiRequest<{ status: string }>("/api/chat/modificar", {
      method: "PATCH",
      body: JSON.stringify({ conversa_id: conversationId, acao: action, valor: value }),
      timeoutMs: 25_000,
    });
  },

  async sendText(conversationId: string, text: string) {
    return apiRequest<{ status: string }>("/api/chat/enviar", {
      method: "POST",
      body: JSON.stringify({ conversa_id: conversationId, canal: "whatsapp", texto: text }),
      timeoutMs: 45_000,
    });
  },

  async sendMedia(payload: {
    conversationId: string;
    fileName: string;
    mimeType: string;
    dataUrl: string;
    caption?: string;
  }) {
    return apiRequest<{ status: string }>("/api/chat/enviar-arquivo", {
      method: "POST",
      body: JSON.stringify({
        conversa_id: payload.conversationId,
        canal: "whatsapp",
        nome_arquivo: payload.fileName,
        mime_type: payload.mimeType,
        data_url: payload.dataUrl,
        legenda: payload.caption,
      }),
      timeoutMs: 110_000,
    });
  },

  async deleteMessage(conversationId: string, messageId: string, forEveryone = false) {
    return apiRequest<{ status: string }>("/api/chat/apagar-mensagem", {
      method: "POST",
      body: JSON.stringify({ conversa_id: conversationId, mensagem_id: messageId, para_todos: forEveryone }),
      timeoutMs: 45_000,
    });
  },

  async deleteConversation(conversationId: string) {
    return apiRequest<{ status: string }>(`/api/chat/conversas/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      timeoutMs: 45_000,
    });
  },

  async forwardMessages(destinationId: string, messageIds: string[]) {
    return apiRequest<{ status: string }>("/api/chat/encaminhar", {
      method: "POST",
      body: JSON.stringify({ destino_id: destinationId, mensagens_ids: messageIds }),
      timeoutMs: 60_000,
    });
  },

  async createGroup(name: string, participants: string[]) {
    return apiRequest<{ status: string; group: unknown }>("/api/chat/grupos", {
      method: "POST",
      body: JSON.stringify({ nome: name, participantes: participants }),
      timeoutMs: 60_000,
    });
  },
};
