import { describe, expect, it } from "vitest";

import type { Contact } from "./whatsappApi";
import type { MsgConteudo } from "./types";
import {
  contactGroupPhone,
  contactMatchesSearch,
  contactToConversation,
  enrichConversationsWithContacts,
  formatWhatsAppPhone,
  isTechnicalWhatsAppLabel,
  mergeContactCatalog,
  mergeConversationCatalog,
  mergeConversationDetails,
  mergeMessages,
  conversationDisplayName,
  whatsappIdentifierKeys,
} from "./contactPicker";

const contact: Contact = {
  id: "5511999999999@c.us",
  phone: "5511999999999",
  pushname: "Joao da Silva",
  photoUrl: "https://example.test/avatar.jpg",
};

describe("contact picker", () => {
  it("encontra contatos pelo pushname e pelo telefone", () => {
    expect(contactMatchesSearch(contact, "joao")).toBe(true);
    expect(contactMatchesSearch(contact, "9999-9999")).toBe(true);
    expect(contactMatchesSearch(contact, "maria")).toBe(false);
  });

  it("prioriza notify retornado pelo WhatsApp antes de identificadores tecnicos", () => {
    expect(contactToConversation({
      id: "120363400000000000@g.us",
      phone: "120363400000000000",
      notify: "Equipe Norium",
      verifiedName: "Norium LTDA",
    }).contato).toBe("Equipe Norium");
  });

  it("nao envia LID sem telefone para criacao de grupo", () => {
    expect(contactGroupPhone({ id: "1044754458590371@lid", phone: "" })).toBeNull();
    expect(contactGroupPhone({ id: "1044754458590371@lid", phone: "5511999999999" })).toBe("5511999999999");
  });

  it("cria uma conversa utilizavel antes de carregar os detalhes", () => {
    expect(contactToConversation(contact)).toMatchObject({
      id: "5511999999999@c.us",
      contato: "Joao da Silva",
      mensagens: [],
      photoUrl: "https://example.test/avatar.jpg",
      metadados: { numeroCompleto: "5511999999999" },
    });
  });

  it("adiciona os detalhes quando a conversa ainda nao existe", () => {
    const optimistic = contactToConversation(contact);
    const detailed = { ...optimistic, contato: "Joao Silva", ultimoTexto: "Ola" };

    expect(mergeConversationDetails([], detailed)).toEqual([detailed]);
  });

  it("preserva o nome da agenda quando os detalhes retornam apenas o id", () => {
    const optimistic = contactToConversation(contact);
    const generic = {
      ...optimistic,
      contato: optimistic.id,
      metadados: { ...optimistic.metadados, numeroCompleto: optimistic.id },
    };

    expect(mergeConversationDetails([optimistic], generic)[0].contato).toBe("Joao da Silva");
  });

  it("preserva Kaio K quando os detalhes retornam o nome de perfil ponto", () => {
    const agenda = contactToConversation({
      id: "54855339126828@s.whatsapp.net",
      phone: "54855339126828",
      name: "Kaio K",
      savedName: "Kaio K",
      notify: ".",
      isMyContact: true,
    });
    const details = {
      ...agenda,
      contato: ".",
    };

    expect(mergeConversationDetails([agenda], details)[0].contato).toBe("Kaio K");
  });

  it("trata ponto isolado como rotulo tecnico do WhatsApp", () => {
    expect(isTechnicalWhatsAppLabel(".")).toBe(true);
    expect(contactToConversation({
      id: "54855339126828@lid",
      phone: "54855339126828@lid",
      name: ".",
    }).contato).toBe("Contato do WhatsApp");
  });

  it("exibe Kaio K quando agenda e perfil LID chegam no mesmo lote", () => {
    const phoneJid = "558599126828@s.whatsapp.net";
    const lid = "54855339126828@lid";
    const savedContact: Contact = {
      id: phoneJid,
      phone: "558599126828",
      name: "Kaio K",
      savedName: "Kaio K",
      isMyContact: true,
    };
    const lidProfile: Contact = {
      id: lid,
      phone: lid,
      name: ".",
      notify: ".",
      photoUrl: "https://example.test/kaio.jpg",
      bio: "Recado do Kaio",
      verifiedName: "Kaio verificado",
      isBusiness: true,
      aliases: [phoneJid],
      isMyContact: false,
    };
    const conversation = contactToConversation({
      ...lidProfile,
      photoUrl: undefined,
      bio: undefined,
      verifiedName: undefined,
      isBusiness: undefined,
    });

    const reversedContacts = mergeContactCatalog([], [lidProfile, savedContact], [conversation]);
    const [reversedEnriched] = enrichConversationsWithContacts([conversation], reversedContacts);
    expect(reversedEnriched.contato).toBe("Kaio K");
    expect(reversedEnriched.photoUrl).toBe("https://example.test/kaio.jpg");
    expect(reversedEnriched.metadados).toMatchObject({
      bioRecado: "Recado do Kaio",
      verifiedName: "Kaio verificado",
      isBusiness: true,
    });

    const contacts = mergeContactCatalog([], [savedContact, lidProfile], [conversation]);
    const [enriched] = enrichConversationsWithContacts([conversation], contacts);

    expect(formatWhatsAppPhone(enriched.metadados.numeroCompleto)).toBe("+55 (85) 9912-6828");
    expect(enriched.contato).toBe("Kaio K");
    expect(enriched.photoUrl).toBe("https://example.test/kaio.jpg");
  });

  it("aceita um nome mais rico dos detalhes para contato não salvo", () => {
    const profileOnly = contactToConversation({
      id: "5511988887777@s.whatsapp.net",
      phone: "5511988887777",
      name: "Nome anterior do perfil",
      isMyContact: false,
    });
    const details = {
      ...profileOnly,
      contato: "Nome atualizado do perfil",
    };

    expect(mergeConversationDetails([profileOnly], details)[0].contato).toBe("Nome atualizado do perfil");
  });

  it("não rebaixa um nome já conhecido para o número em uma atualização", () => {
    const existing = { ...contact, name: "Joao salvo", pushname: undefined };
    const numeric = { ...contact, name: "5511999999999", pushname: undefined };

    expect(mergeContactCatalog([existing], [numeric])[0].name).toBe("Joao salvo");
  });

  it("usa o nome humano da conversa para completar um contato numérico", () => {
    const numeric = { ...contact, name: "5511999999999", pushname: undefined };
    const conversation = { ...contactToConversation(contact), contato: "Joao salvo no WhatsApp" };
    const merged = mergeContactCatalog([], [numeric], [conversation]);

    expect(merged[0].name).toBe("Joao salvo no WhatsApp");
    expect(enrichConversationsWithContacts([{ ...conversation, contato: conversation.id }], merged)[0].contato).toBe("Joao salvo no WhatsApp");
  });

  it("promove o nome da agenda sobre o nome de perfil já persistido na conversa", () => {
    const conversation = {
      ...contactToConversation(contact),
      contato: "Nome escolhido no WhatsApp",
    };
    const savedContact = {
      ...contact,
      name: "Nome salvo na agenda",
      pushname: "Nome escolhido no WhatsApp",
      isMyContact: true,
    };

    expect(enrichConversationsWithContacts([conversation], [savedContact])[0].contato).toBe("Nome salvo na agenda");
  });

  it("não rebaixa um nome conhecido com o perfil de um contato não salvo", () => {
    const conversation = { ...contactToConversation(contact), contato: "Nome salvo na agenda" };
    const profileOnlyContact = { ...contact, name: "Nome escolhido no WhatsApp", isMyContact: false };

    expect(enrichConversationsWithContacts([conversation], [profileOnlyContact])[0].contato).toBe("Nome salvo na agenda");
  });

  it("remove pseudo-chat de Status mesmo quando o delta recebido está vazio", () => {
    const technicalStatus = {
      ...contactToConversation({ id: "status", phone: "", name: "T" }),
      id: "status",
      contato: "T",
      metadados: { numeroCompleto: "status", statusOnline: false },
    };

    expect(mergeConversationCatalog([technicalStatus], [], [])).toEqual([]);
  });

  it("formata o telefone sem expor o domínio técnico do JID", () => {
    expect(formatWhatsAppPhone("5591991550553@s.whatsapp.net")).toBe("+55 (91) 99155-0553");
  });

  it("não rebaixa estado rico da mensagem ao mesclar um snapshot parcial", () => {
    const previous: MsgConteudo = {
      id: "message-1",
      remetente: "usuario",
      texto: "Mensagem",
      tipo: "midia",
      arquivoUrl: "/api/chat/midia/message-1",
      horario: "10:00",
      timestamp: 1_800_000_000,
      status: "lido",
      reacoes: [{ emoji: "❤️", count: 1, fromMe: true }],
      citada: { id: "quoted", content: "Contexto" },
      midiaMeta: { mediaKey: "key", directPath: "/media" },
    };
    const sparse: MsgConteudo = {
      ...previous,
      status: "enviado",
      reacoes: undefined,
      citada: null,
      midiaMeta: null,
    };

    expect(mergeMessages([previous], [sparse])[0]).toMatchObject({
      status: "lido",
      reacoes: previous.reacoes,
      citada: previous.citada,
      midiaMeta: previous.midiaMeta,
      arquivoUrl: previous.arquivoUrl,
    });
  });

  it("não mistura um grupo, um LID e um telefone com os mesmos dígitos", () => {
    expect(whatsappIdentifierKeys("5511999999999@lid")).toEqual(["5511999999999@lid"]);
    expect(whatsappIdentifierKeys("5511999999999@g.us")).toEqual(["5511999999999@g.us"]);
    const contacts = mergeContactCatalog([], [
      { id: "5511999999999@s.whatsapp.net", phone: "5511999999999", name: "Agenda sintética" },
      { id: "5511999999999@lid", phone: "5511999999999@lid", name: "Outra identidade" },
    ]);
    expect(contacts.map(item => item.name)).toEqual(["Agenda sintética", "Outra identidade"]);
    const group = { ...contactToConversation(contact), id: "5511999999999@g.us", esGrupo: true, contato: "Grupo sintético" };
    expect(enrichConversationsWithContacts([group], contacts)[0].contato).toBe("Grupo sintético");
  });

  it("não apresenta identificadores privados e de grupo como telefones", () => {
    expect(formatWhatsAppPhone("120363400000000000@g.us")).toBe("");
    expect(formatWhatsAppPhone("120363400000000000@lid")).toBe("");
    const group = { ...contactToConversation(contact), id: "120363400000000000@g.us", esGrupo: true, contato: "120363400000000000@g.us" };
    expect(conversationDisplayName(group)).toBe("Grupo do WhatsApp");
  });

  it("remove uma reação quando o snapshot informa uma lista vazia explicitamente", () => {
    const msg: MsgConteudo = { id: "synthetic", remetente: "contato", texto: "Exemplo", tipo: "texto", horario: "10:00", reacoes: [{ emoji: "👍", count: 1 }] };
    expect(mergeMessages([msg], [{ ...msg, reacoes: [] }])[0].reacoes).toEqual([]);
  });
});
