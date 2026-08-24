import { describe, expect, it } from "vitest";

import type { Contact } from "./whatsappApi";
import { contactGroupPhone, contactMatchesSearch, contactToConversation, mergeConversationDetails } from "./contactPicker";

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
});
