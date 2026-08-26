import { describe, expect, it } from "vitest";

import {
  normalizeWhatsAppContact,
  normalizeWhatsAppConversation,
  normalizeWhatsAppMessage,
  normalizeWhatsAppStatusItem,
} from "./whatsappApi";

describe("normalização dos dados do WhatsApp", () => {
  it("mantém juntas mensagens recebidas e enviadas pelo celular", () => {
    const conversation = normalizeWhatsAppConversation({
      id: "5591999999999@s.whatsapp.net",
      chatName: "Alexandre",
      messages: [
        { id: "received", fromMe: false, content: "Oi", type: "chat", timestamp: 1_800_000_000 },
        { key: { id: "sent", fromMe: true }, message: { conversation: "Já respondi" }, timestamp: 1_800_000_001 },
      ],
    });

    expect(conversation?.mensagens).toHaveLength(2);
    expect(conversation?.mensagens[0]).toMatchObject({ id: "received", remetente: "contato", texto: "Oi" });
    expect(conversation?.mensagens[1]).toMatchObject({ id: "sent", remetente: "usuario", texto: "Já respondi" });
  });

  it("remove eventos técnicos e mensagens vazias que virariam balões só com horário", () => {
    expect(normalizeWhatsAppMessage({ id: "empty", type: "chat", timestamp: 1_800_000_000 })).toBeNull();
    expect(normalizeWhatsAppMessage({ id: "protocol", type: "protocolMessage", body: "evento", timestamp: 1_800_000_000 })).toBeNull();
    expect(normalizeWhatsAppMessage({ id: "status", chatId: "status@broadcast", body: "status", timestamp: 1_800_000_000 })).toBeNull();
    expect(normalizeWhatsAppMessage({ id: "status-short", chatId: "status", body: "status", timestamp: 1_800_000_000 })).toBeNull();
    expect(normalizeWhatsAppConversation({ id: "contato-tecnico", metadados: { numeroCompleto: "status" }, contato: "T", mensagens: [] })).toBeNull();
    expect(normalizeWhatsAppContact({ id: "status", name: "T" })).toBeNull();
    for (const alias of ["statuses", "broadcast", "status_v3", "status-v3"]) {
      expect(normalizeWhatsAppConversation({ id: alias, contato: "T", mensagens: [] })).toBeNull();
    }
  });

  it("não interpreta a string false como mensagem enviada", () => {
    expect(normalizeWhatsAppMessage({ id: "received", fromMe: "false", body: "Recebida", timestamp: 1_800_000_000 })).toMatchObject({ remetente: "contato" });
    expect(normalizeWhatsAppMessage({ id: "sent", fromMe: "true", body: "Enviada", timestamp: 1_800_000_001 })).toMatchObject({ remetente: "usuario" });
  });

  it("mantém metadados privados de mídia para merges incrementais", () => {
    expect(normalizeWhatsAppMessage({
      id: "media",
      type: "image",
      body: "Imagem",
      timestamp: 1_800_000_001,
      midiaMeta: { mediaKey: "key", directPath: "/media", type: "image" },
    })?.midiaMeta).toEqual({ mediaKey: "key", directPath: "/media", type: "image" });
  });

  it("preserva os aliases internos de foto, vídeo e áudio no feed de Status", () => {
    expect(normalizeWhatsAppStatusItem({
      id: "status-image",
      contactName: "Maria",
      tipo: "midia",
      texto: "Legenda da foto",
      arquivoMime: "image/jpeg",
      arquivoUrl: "/api/chat/midia/status-image",
      timestamp: 1_800_000_001,
    })).toMatchObject({
      type: "image",
      text: "Legenda da foto",
      mediaUrl: "/api/chat/midia/status-image",
    });

    expect(normalizeWhatsAppStatusItem({
      id: "status-video",
      contactName: "João",
      tipo: "midia",
      texto: "Legenda do vídeo",
      arquivoUrl: "/api/chat/midia/status-video",
      midiaMeta: { type: "video", mimetype: "video/mp4" },
      timestamp: 1_800_000_002,
    })).toMatchObject({
      type: "video",
      text: "Legenda do vídeo",
      mediaUrl: "/api/chat/midia/status-video",
    });

    expect(normalizeWhatsAppStatusItem({
      id: "status-audio",
      contactName: "Ana",
      tipo: "audio",
      texto: "Áudio",
      arquivoUrl: "/api/chat/midia/status-audio",
      midiaMeta: { type: "audio", mimetype: "audio/ogg" },
      timestamp: 1_800_000_003,
    })).toMatchObject({
      type: "audio",
      text: "Áudio",
      mediaUrl: "/api/chat/midia/status-audio",
    });
  });

  it.each([
    ["contact", { contact: { jid: "5511000000001@s.whatsapp.net" } }, "5511000000001@s.whatsapp.net"],
    ["sender", { sender: { id: "5511000000002@s.whatsapp.net" } }, "5511000000002@s.whatsapp.net"],
    ["sender.contact", { sender: { contact: { phoneNumber: "5511000000003" } } }, "5511000000003"],
  ])("lê o ID aninhado de %s no Status", (_source, identity, expectedContactId) => {
    expect(normalizeWhatsAppStatusItem({
      id: `status-${expectedContactId}`,
      ...identity,
      timestamp: 1_800_000_004,
    })).toMatchObject({ contactId: expectedContactId });
  });

  it("preserva indicadores de mensagem editada e encaminhada após recarregar", () => {
    expect(normalizeWhatsAppMessage({ id: "edited", fromMe: true, body: "Corrigida", editada: true, timestamp: 1_800_000_001 })).toMatchObject({ edited: true });
    expect(normalizeWhatsAppMessage({ id: "forwarded", body: "Encaminhada", forwardingScore: 2, timestamp: 1_800_000_002 })).toMatchObject({ forwarded: true });
  });

  it("lê nomes salvos, aliases LID e fotos retornados em contratos alternativos", () => {
    expect(normalizeWhatsAppContact({
      jid: "5591999999999@s.whatsapp.net",
      senderLid: "123456789@lid",
      phoneNumber: "5591999999999",
      savedName: "Alexandre da Agenda",
      profilePicUrl: "https://example.test/alexandre.jpg",
    })).toMatchObject({
      id: "5591999999999@s.whatsapp.net",
      phone: "5591999999999",
      lid: "123456789@lid",
      name: "Alexandre da Agenda",
      photoUrl: "https://example.test/alexandre.jpg",
      aliases: expect.arrayContaining(["123456789@lid", "5591999999999@s.whatsapp.net"]),
    });
  });

  it("prioriza o nome salvo na agenda sobre o nome escolhido no perfil", () => {
    const normalized = normalizeWhatsAppContact({
      id: "5591999999999@s.whatsapp.net",
      name: "Nome escolhido no WhatsApp",
      pushName: "Nome escolhido no WhatsApp",
      savedName: "Nome salvo na agenda",
    });

    expect(normalized).toMatchObject({
      name: "Nome salvo na agenda",
      savedName: "Nome salvo na agenda",
    });
  });

  it("prioriza name da agenda sobre notify do perfil", () => {
    expect(normalizeWhatsAppContact({
      id: "5591999999999@s.whatsapp.net",
      displayName: "Nome escolhido no WhatsApp",
      name: "Nome salvo na agenda",
      notify: "Nome escolhido no WhatsApp",
      isMyContact: true,
    })?.name).toBe("Nome salvo na agenda");
  });

  it("não trata notify de um chat comum como nome salvo", () => {
    expect(normalizeWhatsAppContact({
      id: "5591999999999@s.whatsapp.net",
      name: "Nome escolhido no WhatsApp",
      notify: "Nome escolhido no WhatsApp",
      isMyContact: false,
    })?.savedName).toBeUndefined();
  });
});
