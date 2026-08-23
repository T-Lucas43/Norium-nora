import { describe, expect, it } from "vitest";

import type { Contact } from "./whatsappApi";
import { contactMatchesSearch, contactToConversation, mergeConversationDetails } from "./contactPicker";

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
