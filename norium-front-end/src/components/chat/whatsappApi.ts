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
  verifiedName?: string;
  bio?: string;
  isBusiness?: boolean;
  isMyContact?: boolean;
  isBlocked?: boolean;
};

export type HistoryPage = {
  items: MsgConteudo[];
  cursor: number | null;
  hasMore: boolean;
};

export type ConsentInfo = {
  termVersion: string;
  accepted: boolean;
  acceptedVersion?: string | null;
};

export const whatsappApi = {
  async consentStatus(signal?: AbortSignal) {
    return apiRequest<ConsentInfo>("/api/chat/consentimento", {
      cache: "no-store",
      timeoutMs: 15_000,
      signal,
    });
  },

  async acceptConsent(termVersion?: string) {
    return apiRequest<ConsentInfo>("/api/chat/consentimento", {
      method: "POST",
      body: JSON.stringify({ aceito: true, versao: termVersion ?? null }),
      timeoutMs: 20_000,
    });
  },

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

  async conversations(since?: number, refresh = false) {
    const params = new URLSearchParams();
    if (since && since > 0) params.set("since", String(since));
    if (refresh) params.set("refresh", "true");
    const query = params.size ? `?${params.toString()}` : "";
    return apiRequest<ChatConversa[] | { items: ChatConversa[]; cursor: number; hasMore: boolean }>(
      `/api/chat/conversas${query}`,
      { timeoutMs: 35_000 },
    );
  },

  async details(conversationId: string) {
    return apiRequest<ChatConversa>(`/api/chat/conversas/${encodeURIComponent(conversationId)}/detalhes`, {
      timeoutMs: 30_000,
    });
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

  async markConversation(conversationId: string, action: "lida" | "fixada" | "favorita" | "silenciada" | "arquivada", value: boolean) {
    if (action === "favorita") {
      return apiRequest<{ status: string }>("/api/chat/favoritar", {
        method: "PATCH",
        body: JSON.stringify({ conversa_id: conversationId, valor: value }),
        timeoutMs: 25_000,
      });
    }
    return apiRequest<{ status: string }>("/api/chat/modificar", {
      method: "PATCH",
      body: JSON.stringify({ conversa_id: conversationId, acao: action, valor: value }),
      timeoutMs: 25_000,
    });
  },

  async sendText(conversationId: string, text: string, quotedId?: string) {
    return apiRequest<{ status: string }>("/api/chat/enviar", {
      method: "POST",
      body: JSON.stringify({
        conversa_id: conversationId,
        canal: "whatsapp",
        texto: text,
        ...(quotedId ? { responder_a: quotedId } : {}),
      }),
      timeoutMs: 45_000,
    });
  },

  async sendMedia(payload: {
    conversationId: string;
    fileName: string;
    mimeType: string;
    dataUrl: string;
    caption?: string;
    asSticker?: boolean;
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
        como_figurinha: Boolean(payload.asSticker),
      }),
      timeoutMs: 110_000,
    });
  },

  async react(conversationId: string, messageId: string, emoji: string) {
    return apiRequest<{ status: string; emoji: string }>("/api/chat/reagir", {
      method: "POST",
      body: JSON.stringify({ conversa_id: conversationId, mensagem_id: messageId, emoji }),
      timeoutMs: 45_000,
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
