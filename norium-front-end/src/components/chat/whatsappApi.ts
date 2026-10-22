import { apiRequest } from "../../core/api/client";
import type { ChatConversa, MsgConteudo } from "./types";

export type WhatsAppConnection = {
  provider?: "wapi" | "evolution";
  providerLabel?: string;
  requiresPlanSelection?: boolean;
  conectado: boolean;
  qrcode?: string | null;
  status?: "conectado" | "desconectado" | "iniciando" | "aguardando_qrcode" | "erro" | "indisponivel";
  state?: string;
  detail?: string | null;
  numero?: string | null;
  conectadoEm?: string | null;
  plano?: "lite" | "pro" | null;
};

export type WhatsAppSyncProgress = {
  status: "idle" | "syncing" | "complete" | "partial" | "error";
  phase?: string;
  progress: number;
  current?: number;
  total?: number;
  message?: string;
  contactsSynced?: number;
  photosSynced?: number;
  requiresPro?: boolean;
  reconnectRequired?: boolean;
  catalogWarnings?: string[];
};

export type WhatsAppStatusItem = {
  id: string;
  contactId?: string;
  name: string;
  photoUrl?: string;
  type: "text" | "image" | "video" | "audio";
  text?: string;
  mediaUrl?: string;
  timestamp: number;
  viewed?: boolean;
  mine?: boolean;
  color?: string;
};

export type WhatsAppProfile = {
  name: string;
  phone?: string;
  photoUrl?: string;
  bio?: string;
};

export type WhatsAppStatusFeed = {
  items: WhatsAppStatusItem[];
  cursor?: number | null;
};
export type WhatsAppChannel = {
  id: string;
  name: string;
  description?: string;
  photoUrl?: string;
  verified?: boolean;
  unreadCount?: number;
  timestamp?: number;
  messages?: MsgConteudo[];
};

export type WhatsAppChannelFeed = {
  items: WhatsAppChannel[];
};


function firstStatusString(...values: unknown[]) {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value : undefined;
}

function statusBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["1", "true", "yes", "sim"].includes(value.trim().toLowerCase());
  return false;
}

/**
 * Aceita tanto o contrato público do feed quanto registros persistidos por
 * versões anteriores. Isso evita rebaixar foto, vídeo ou áudio para texto
 * quando o backend ainda devolve os aliases internos em português.
 */
export function normalizeWhatsAppStatusItem(value: unknown): WhatsAppStatusItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const contact = raw.contact && typeof raw.contact === "object"
    ? raw.contact as Record<string, unknown>
    : {};
  const sender = raw.sender && typeof raw.sender === "object"
    ? raw.sender as Record<string, unknown>
    : {};
  const senderContact = sender.contact && typeof sender.contact === "object"
    ? sender.contact as Record<string, unknown>
    : {};
  const identitySources = [raw, contact, sender, senderContact];
  const mediaMeta = raw.midiaMeta && typeof raw.midiaMeta === "object"
    ? raw.midiaMeta as Record<string, unknown>
    : raw.mediaMeta && typeof raw.mediaMeta === "object"
      ? raw.mediaMeta as Record<string, unknown>
      : {};
  const id = firstStatusString(raw.id, raw.statusId, raw.messageId)?.trim();
  if (!id) return null;
  const contactId = firstStatusString(
    raw.contactId,
    raw.chatId,
    contact.id,
    contact.contactId,
    contact.chatId,
    contact.jid,
    contact.lid,
    contact.phone,
    contact.phoneNumber,
    contact.number,
    sender.id,
    sender.contactId,
    sender.chatId,
    sender.jid,
    sender.lid,
    sender.phone,
    sender.phoneNumber,
    sender.number,
    senderContact.id,
    senderContact.contactId,
    senderContact.chatId,
    senderContact.jid,
    senderContact.lid,
    senderContact.phone,
    senderContact.phoneNumber,
    senderContact.number,
  );

  const mime = firstStatusString(raw.mediaMime, raw.arquivoMime, raw.mimetype, mediaMeta.mimetype)?.toLowerCase() || "";
  const typeEvidence = [raw.type, raw.kind, raw.mediaType, raw.tipo, mediaMeta.type, mime]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .join(" ")
    .toLowerCase();
  const type: WhatsAppStatusItem["type"] = typeEvidence.includes("video")
    ? "video"
    : typeEvidence.includes("audio") || mime.startsWith("audio/")
      ? "audio"
      : typeEvidence.includes("image") || typeEvidence.includes("photo") || typeEvidence.includes("foto") || mime.startsWith("image/") || String(raw.tipo || "").toLowerCase() === "midia"
        ? "image"
        : "text";
  const fallbackName = contactId ? "Contato do WhatsApp" : "Status do WhatsApp";
  const rawTimestamp = raw.timestamp ?? raw.createdAt ?? Date.now();
  const numericTimestamp = Number(rawTimestamp);
  const timestamp = Number.isFinite(numericTimestamp) ? numericTimestamp : new Date(String(rawTimestamp)).getTime();
  const photoUrl = firstStatusString(
    ...identitySources.flatMap((source) => [
      source.photoUrl,
      source.profilePicture,
      source.profilePictureUrl,
      source.profilePicUrl,
      source.imgUrl,
      source.avatar,
    ]),
  );

  return {
    id,
    contactId,
    name: firstStatusString(raw.name, raw.contactName, raw.notify, raw.verifiedName) || fallbackName,
    photoUrl,
    type,
    text: firstStatusString(raw.text, raw.caption, raw.body, raw.texto),
    mediaUrl: firstStatusString(raw.mediaUrl, raw.fileUrl, raw.arquivoUrl, raw.url),
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    viewed: statusBoolean(raw.viewed ?? raw.visualizado),
    mine: statusBoolean(raw.mine ?? raw.fromMe),
    color: firstStatusString(raw.color, raw.backgroundColor),
  };
}

export type Contact = {
  id: string;
  phone: string;
  lid?: string;
  aliases?: string[];
  name?: string;
  savedName?: string;
  notify?: string;
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
  cursorId?: string | null;
  hasMore: boolean;
};

export type ConsentInfo = {
  provider?: "wapi" | "evolution";
  termVersion: string;
  accepted: boolean;
  acceptedVersion?: string | null;
};

type UnknownRecord = Record<string, any>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? value as UnknownRecord : {};
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function isWhatsAppStatusIdentifier(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["status", "statuses", "status@broadcast", "broadcast", "status_v3", "status-v3"].includes(normalized);
}

function booleanFlag(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["1", "true", "yes", "sim"].includes(value.trim().toLowerCase());
  return false;
}

function timestampSeconds(value: unknown) {
  const parsed = typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)
    ? new Date(value).getTime()
    : Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
}

function timeLabel(timestamp: number, provided?: unknown) {
  const explicit = firstText(provided);
  if (explicit) return explicit;
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function normalizeMessageType(rawType: unknown, mime: string, mediaUrl: string): MsgConteudo["tipo"] {
  const value = String(rawType || "").toLowerCase();
  if (value.includes("sticker")) return "sticker";
  if (value.includes("audio") || value === "ptt" || mime.startsWith("audio/")) return "audio";
  if (value.includes("document") || value.includes("file") || (!mime.startsWith("image/") && !mime.startsWith("video/") && Boolean(mime))) return "documento";
  if (value.includes("image") || value.includes("video") || value.includes("media") || mime.startsWith("image/") || mime.startsWith("video/") || mediaUrl) return "midia";
  return "texto";
}

export function normalizeWhatsAppMessage(value: unknown, index = 0): MsgConteudo | null {
  const raw = record(value);
  const key = record(raw.key);
  const nested = record(raw.message);
  const extended = record(nested.extendedTextMessage || raw.extendedTextMessage);
  const image = record(nested.imageMessage || raw.imageMessage);
  const video = record(nested.videoMessage || raw.videoMessage);
  const documentMessage = record(nested.documentMessage || raw.documentMessage);
  const audio = record(nested.audioMessage || raw.audioMessage);
  const sticker = record(nested.stickerMessage || raw.stickerMessage);
  const mediaRecord = Object.keys(image).length ? image : Object.keys(video).length ? video : Object.keys(documentMessage).length ? documentMessage : Object.keys(audio).length ? audio : sticker;
  const chatId = firstText(raw.chatId, raw.conversationId, raw.remoteJid, key.remoteJid);
  if (isWhatsAppStatusIdentifier(chatId) || /@newsletter$/i.test(chatId)) return null;

  const rawType = firstText(raw.tipo, raw.type, raw.messageType, raw.kind, mediaRecord.mimetype ? "media" : "text");
  if (/protocol|sender.?key|notification|call.?log|reaction|poll.?update|revok/i.test(rawType)) return null;
  const text = firstText(
    raw.texto,
    raw.text,
    raw.body,
    raw.content,
    raw.caption,
    raw.messageText,
    typeof raw.message === "string" ? raw.message : "",
    nested.conversation,
    nested.text,
    extended.text,
    image.caption,
    video.caption,
    documentMessage.caption,
  );
  const mediaUrl = firstText(raw.arquivoUrl, raw.mediaUrl, raw.fileUrl, raw.downloadUrl, raw.url, mediaRecord.url);
  const mime = firstText(raw.arquivoMime, raw.mimetype, raw.mimeType, mediaRecord.mimetype);
  const tipo = normalizeMessageType(rawType, mime, mediaUrl);
  if (!text && !mediaUrl && tipo === "texto") return null;

  const timestamp = timestampSeconds(raw.timestamp ?? raw.createdAt ?? raw.messageTimestamp ?? key.timestamp);
  const fromMe = raw.remetente === "usuario" || booleanFlag(raw.fromMe ?? raw.isFromMe ?? key.fromMe);
  const id = firstText(raw.id, raw.messageId, raw.msgId, key.id) || `whatsapp-${timestamp || Date.now()}-${index}`;
  const placeholder = tipo === "midia" ? "Mídia indisponível" : tipo === "audio" ? "Áudio indisponível" : tipo === "documento" ? "Documento indisponível" : tipo === "sticker" ? "Figurinha indisponível" : "";
  return {
    id,
    remetente: fromMe ? "usuario" : "contato",
    remetenteNome: firstText(raw.remetenteNome, raw.senderName, raw.notify, raw.pushName) || undefined,
    remetenteId: firstText(raw.remetenteId, raw.senderId, raw.participant, key.participant) || undefined,
    texto: text || placeholder,
    tipo,
    arquivoUrl: mediaUrl || undefined,
    miniaturaUrl: firstText(raw.miniaturaUrl) || undefined,
    arquivoMime: mime || undefined,
    duracaoAudio: firstText(raw.duracaoAudio, raw.duration, audio.seconds) || undefined,
    nomeArquivo: firstText(raw.nomeArquivo, raw.filename, raw.fileName, documentMessage.fileName) || undefined,
    horario: timeLabel(timestamp, raw.horario),
    timestamp,
    status: raw.status,
    reacoes: Array.isArray(raw.reacoes) ? raw.reacoes : Array.isArray(raw.reactions) ? raw.reactions : undefined,
    citada: raw.citada || raw.quoted || null,
    midiaMeta: raw.midiaMeta && typeof raw.midiaMeta === "object" ? raw.midiaMeta : null,
    edited: booleanFlag(raw.edited ?? raw.editada ?? raw.isEdited),
    forwarded: booleanFlag(raw.forwarded ?? raw.encaminhada ?? raw.isForwarded) || Number(raw.forwardingScore || 0) > 0,
    viewOnce: booleanFlag(raw.viewOnce ?? raw.view_once ?? raw.visualizacaoUnica),
    canal: "whatsapp",
    channel: "whatsapp",
  };
}

export function normalizeWhatsAppConversation(value: unknown): ChatConversa | null {
  const raw = record(value);
  const metadata = record(raw.metadados || raw.metadata);
  const id = firstText(raw.id, raw.chatId, raw.jid, raw.phone, raw.remoteJid);
  const isStatusConversation = [id, raw.chatId, raw.jid, raw.phone, raw.remoteJid, metadata.numeroCompleto]
    .some(isWhatsAppStatusIdentifier);
  if (!id || isStatusConversation || /@newsletter$/i.test(id)) return null;
  const rawMessages = Array.isArray(raw.mensagens) ? raw.mensagens : Array.isArray(raw.messages) ? raw.messages : [];
  const mensagens = rawMessages.map(normalizeWhatsAppMessage).filter((item): item is MsgConteudo => Boolean(item));
  const timestamp = timestampSeconds(raw.timestampUltimaMsg ?? raw.timestamp ?? raw.lastMessageTime);
  const contactName = firstText(raw.contato, raw.name, raw.chatName, raw.notify, raw.subject, metadata.notify, metadata.verifiedName, id);
  return {
    id,
    assignee: raw.assignee,
    attendanceRef: raw.attendanceRef,
    contato: contactName,
    canal: "whatsapp",
    channel: "whatsapp",
    ultimoTexto: firstText(raw.ultimoTexto, raw.lastMessage?.text, raw.lastMessage?.body, raw.lastMessage, mensagens[mensagens.length - 1]?.texto),
    horario: timeLabel(timestamp, raw.horario),
    timestampUltimaMsg: timestamp,
    lida: (raw.lida === undefined || booleanFlag(raw.lida)) && Number(raw.naoLidasCount ?? raw.unreadCount ?? 0) === 0,
    naoLidasCount: Number(raw.naoLidasCount ?? raw.unreadCount ?? 0),
    fixada: booleanFlag(raw.fixada ?? raw.pinned),
    favorita: booleanFlag(raw.favorita ?? raw.favorite),
    silenciada: booleanFlag(raw.silenciada ?? raw.muted),
    arquivada: booleanFlag(raw.arquivada ?? raw.archived),
    esGrupo: booleanFlag(raw.esGrupo ?? raw.isGroup) || /@g\.us$/i.test(id),
    mensagens,
    photoUrl: firstText(raw.photoUrl, raw.profilePictureUrl, raw.profilePicUrl, raw.imgUrl, metadata.photoUrl) || undefined,
    metadados: {
      ...metadata,
      numeroCompleto: firstText(metadata.numeroCompleto, raw.phone, raw.phoneNumber, id),
      notify: firstText(metadata.notify, raw.notify) || undefined,
      verifiedName: firstText(metadata.verifiedName, raw.verifiedName) || undefined,
      statusOnline: booleanFlag(metadata.statusOnline),
      photoUrl: firstText(metadata.photoUrl, raw.photoUrl, raw.profilePictureUrl, raw.profilePicUrl, raw.imgUrl) || undefined,
    },
  };
}

export function normalizeWhatsAppContact(value: unknown): Contact | null {
  const raw = record(value);
  const id = firstText(raw.id, raw.jid, raw.lid, raw.phone, raw.phoneNumber, raw.number, raw.remoteJid, raw.remoteJidAlt);
  if (!id || [id, raw.jid, raw.phone, raw.phoneNumber, raw.number].some(isWhatsAppStatusIdentifier) || /@g\.us$|@newsletter$/i.test(id)) return null;
  const phone = firstText(raw.phone, raw.phoneNumber, raw.number, id);
  const isMyContact = booleanFlag(raw.isMyContact ?? raw.isContact);
  const savedName = firstText(raw.savedName, raw.contactName, isMyContact ? raw.name : undefined);
  const aliases = [raw.id, raw.jid, raw.lid, raw.senderLid, raw.phone, raw.phoneNumber, raw.remoteJid, raw.remoteJidAlt, ...(Array.isArray(raw.aliases) ? raw.aliases : [])]
    .map((item) => firstText(item)).filter(Boolean);
  return {
    id,
    phone,
    lid: firstText(raw.lid, raw.senderLid) || undefined,
    aliases: [...new Set(aliases)],
    name: firstText(savedName, raw.name, raw.displayName, raw.fullName, raw.shortName) || undefined,
    savedName: savedName || undefined,
    notify: firstText(raw.notify, raw.subject) || undefined,
    pushname: firstText(raw.pushname, raw.pushName) || undefined,
    photoUrl: firstText(raw.photoUrl, raw.profilePictureUrl, raw.profilePicUrl, raw.imgUrl) || undefined,
    verifiedName: firstText(raw.verifiedName, raw.businessName) || undefined,
    bio: firstText(raw.bio, raw.status, raw.about) || undefined,
    isBusiness: booleanFlag(raw.isBusiness),
    isMyContact,
    isBlocked: booleanFlag(raw.isBlocked),
  };
}

export function createWhatsAppApi(request: typeof apiRequest = apiRequest) {
const client = {
  async consentStatus(signal?: AbortSignal) {
    return request<ConsentInfo>("/api/chat/consentimento", {
      cache: "no-store",
      timeoutMs: 15_000,
      signal,
    });
  },

  async acceptConsent(termVersion?: string) {
    return request<ConsentInfo>("/api/chat/consentimento", {
      method: "POST",
      body: JSON.stringify({ aceito: true, versao: termVersion ?? null }),
      timeoutMs: 20_000,
    });
  },

  async status(signal?: AbortSignal, live = false) {
    const payload = await request<{ whatsapp: WhatsAppConnection }>(`/api/chat/status-canais${live ? "?live=true" : ""}`, {
      cache: "no-store",
      timeoutMs: live ? 12_000 : 6_000,
      signal,
    });
    return payload.whatsapp;
  },

  async start(signal?: AbortSignal, plan?: "lite" | "pro" | null) {
    return request<Pick<WhatsAppConnection, "status" | "qrcode" | "plano" | "provider" | "providerLabel" | "requiresPlanSelection">>("/api/chat/inicializar-login", {
      method: "POST",
      body: JSON.stringify({ canal: "whatsapp", plano: plan ?? null }),
      timeoutMs: 20_000,
      signal,
    });
  },

  async disconnect() {
    return request<{ status: string }>("/api/chat/desconectar", {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 40_000,
    });
  },

  async conversations(since?: number, refresh = false) {
    if (!since) return client.conversationPage(0, "", undefined, refresh);
    const params = new URLSearchParams();
    if (since && since > 0) params.set("since", String(since));
    if (refresh) params.set("refresh", "true");
    const query = params.size ? `?${params.toString()}` : "";
    const payload = await request<unknown[] | { items: unknown[]; cursor: number; hasMore: boolean }>(
      `/api/chat/conversas${query}`,
      { timeoutMs: refresh ? 12_000 : 8_000 },
    );
    const normalizeItems = (items: unknown[]) => items.map(normalizeWhatsAppConversation).filter((item): item is ChatConversa => Boolean(item));
    if (!Array.isArray(payload) && payload.hasMore) {
      // Um lote de metadados pode atualizar centenas de grupos no mesmo segundo.
      // O snapshot completo evita avançar o cursor além dos itens não entregues.
      const [full, groupPayload] = await Promise.all([
        client.allConversationSummaries(),
        request<{ items: unknown[] }>("/api/chat/grupos", { timeoutMs: 12_000 }),
      ]);
      const items = new Map(normalizeItems(groupPayload.items || []).map(item => [item.id, item]));
      normalizeItems(full).forEach(item => items.set(item.id, item));
      return { items: [...items.values()], cursor: payload.cursor, hasMore: false };
    }
    return Array.isArray(payload) ? normalizeItems(payload) : { ...payload, items: normalizeItems(payload.items || []) };
  },

  async conversationPage(offset = 0, search = "", signal?: AbortSignal, refresh = false): Promise<{
    items: ChatConversa[]; total: number; nextOffset: number | null; cursor: number; hasMore: boolean;
  }> {
    const params = new URLSearchParams({ paged: "true", offset: String(offset), limit: "100" });
    if (search.trim()) params.set("search", search.trim());
    if (refresh) params.set("refresh", "true");
    const payload = await request<unknown[] | { items: unknown[]; total: number; nextOffset: number | null; cursor: number }>(
      `/api/chat/conversas?${params}`, { timeoutMs: 12_000, signal });
    const items = (Array.isArray(payload) ? payload : payload.items || []).map(normalizeWhatsAppConversation)
      .filter((item): item is ChatConversa => Boolean(item));
    if (!Array.isArray(payload) && payload.nextOffset !== null &&
      (!Number.isSafeInteger(payload.nextOffset) || payload.nextOffset <= offset)) throw new Error("Cursor de conversas inválido.");
    return Array.isArray(payload) ? { items, total: items.length, nextOffset: null, cursor: 0, hasMore: false }
      : { ...payload, items, hasMore: false };
  },

  async allConversationSummaries(): Promise<ChatConversa[]> {
    const items = new Map<string, ChatConversa>();
    let offset: number | null = 0;
    for (let page = 0; page < 500 && offset !== null; page++) {
      const response = await client.conversationPage(offset);
      response.items.forEach(item => items.set(item.id, item));
      if (response.nextOffset !== null && response.nextOffset <= offset) throw new Error("Cursor de conversas inválido.");
      offset = response.nextOffset;
    }
    if (offset !== null) throw new Error("Catálogo de conversas excedeu o limite de páginas.");
    return [...items.values()];
  },

  async details(conversationId: string) {
    const payload = await request<unknown>(`/api/chat/conversas/${encodeURIComponent(conversationId)}/detalhes`, {
      timeoutMs: 30_000,
    });
    const normalized = normalizeWhatsAppConversation(payload);
    if (!normalized) throw new Error("Os detalhes retornados pelo WhatsApp são inválidos.");
    return normalized;
  },

  async history(conversationId: string, before?: number | null, limit = 50, beforeId?: string | null) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", String(before));
    if (before && beforeId) params.set("beforeId", beforeId);
    const payload = await request<{ items?: unknown[]; cursor?: number | null; cursorId?: string | null; hasMore?: boolean }>(
      `/api/chat/conversas/${encodeURIComponent(conversationId)}/mensagens?${params.toString()}`,
      { timeoutMs: 30_000 },
    );
    return {
      items: (payload.items || []).map(normalizeWhatsAppMessage).filter((item): item is MsgConteudo => Boolean(item)),
      cursor: payload.cursor ?? null,
      cursorId: payload.cursorId ?? null,
      hasMore: Boolean(payload.hasMore),
    };
  },

  async contacts() {
    const payload = await request<unknown[]>("/api/chat/contatos-disponiveis", { timeoutMs: 8_000 });
    return payload.map(normalizeWhatsAppContact).filter((item): item is Contact => Boolean(item));
  },

  async syncStatus(signal?: AbortSignal) {
    return request<WhatsAppSyncProgress>("/api/chat/sincronizacao", {
      cache: "no-store",
      timeoutMs: 8_000,
      signal,
    });
  },

  async startSync() {
    return request<WhatsAppSyncProgress>("/api/chat/sincronizacao", {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 10_000,
    });
  },

  async statuses(signal?: AbortSignal) {
    return request<WhatsAppStatusFeed>("/api/chat/status-whatsapp", {
      cache: "no-store",
      timeoutMs: 8_000,
      signal,
    });
  },

  async markStatusViewed(statusId: string) {
    return request<{ status: string }>(`/api/chat/status-whatsapp/${encodeURIComponent(statusId)}/visualizar`, {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 30_000,
    });
  },

  async profile(signal?: AbortSignal) {
    return request<WhatsAppProfile | { profile: WhatsAppProfile }>("/api/chat/perfil-whatsapp", {
      cache: "no-store",
      timeoutMs: 6_000,
      signal,
    });
  },

  async channels(signal?: AbortSignal) {
    return request<WhatsAppChannelFeed>("/api/chat/canais", {
      cache: "no-store",
      timeoutMs: 8_000,
      signal,
    });
  },

  async groups(signal?: AbortSignal) {
    return request<{ items: unknown[] } | unknown[]>("/api/chat/grupos", {
      cache: "no-store",
      timeoutMs: 8_000,
      signal,
    });
  },

  async groupDetails(groupId: string) {
    return request<ChatConversa | { group: unknown }>(`/api/chat/grupos/${encodeURIComponent(groupId)}`, {
      cache: "no-store",
      timeoutMs: 35_000,
    });
  },

  async markConversation(conversationId: string, action: "lida" | "fixada" | "favorita" | "silenciada" | "arquivada", value: boolean) {
    if (action === "favorita") {
      return request<{ status: string }>("/api/chat/favoritar", {
        method: "PATCH",
        body: JSON.stringify({ conversa_id: conversationId, valor: value }),
        timeoutMs: 25_000,
      });
    }
    return request<{ status: string }>("/api/chat/modificar", {
      method: "PATCH",
      body: JSON.stringify({ conversa_id: conversationId, acao: action, valor: value }),
      timeoutMs: 25_000,
    });
  },

  async sendText(conversationId: string, text: string, quotedId?: string) {
    return request<{ status: string }>("/api/chat/enviar", {
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
    quotedId?: string;
    viewOnce?: boolean;
  }) {
    return request<{ status: string }>("/api/chat/enviar-arquivo", {
      method: "POST",
      body: JSON.stringify({
        conversa_id: payload.conversationId,
        canal: "whatsapp",
        nome_arquivo: payload.fileName,
        mime_type: payload.mimeType,
        data_url: payload.dataUrl,
        legenda: payload.caption,
        como_figurinha: Boolean(payload.asSticker),
        visualizacao_unica: Boolean(payload.viewOnce),
        ...(payload.quotedId ? { responder_a: payload.quotedId } : {}),
      }),
      timeoutMs: 110_000,
    });
  },

  async react(conversationId: string, messageId: string, emoji: string) {
    return request<{ status: string; emoji: string }>("/api/chat/reagir", {
      method: "POST",
      body: JSON.stringify({ conversa_id: conversationId, mensagem_id: messageId, emoji }),
      timeoutMs: 45_000,
    });
  },

  async deleteMessage(conversationId: string, messageId: string, forEveryone = false) {
    return request<{ status: string }>("/api/chat/apagar-mensagem", {
      method: "POST",
      body: JSON.stringify({ conversa_id: conversationId, mensagem_id: messageId, para_todos: forEveryone }),
      timeoutMs: 45_000,
    });
  },

  async editMessage(conversationId: string, messageId: string, text: string) {
    return request<{ status: string }>("/api/chat/editar-mensagem", {
      method: "PATCH",
      body: JSON.stringify({ conversa_id: conversationId, mensagem_id: messageId, texto: text.trim() }),
      timeoutMs: 45_000,
    });
  },

  async deleteConversation(conversationId: string) {
    return request<{ status: string }>(`/api/chat/conversas/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      timeoutMs: 45_000,
    });
  },

  async forwardMessages(destinationId: string, messageIds: string[], sourceId?: string) {
    return request<{ status: string }>("/api/chat/encaminhar", {
      method: "POST",
      body: JSON.stringify({ destino_id: destinationId, mensagens_ids: messageIds, ...(sourceId && request !== apiRequest ? { origem_id: sourceId } : {}) }),
      timeoutMs: 60_000,
    });
  },

  async createGroup(name: string, participants: string[]) {
    return request<{ status: string; group: unknown }>("/api/chat/grupos", {
      method: "POST",
      body: JSON.stringify({ nome: name, participantes: participants }),
      timeoutMs: 60_000,
    });
  },
};
return client;
}

export const whatsappApi = createWhatsAppApi();
