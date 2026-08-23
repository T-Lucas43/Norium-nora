import type { ChatConversa } from "./types";
import type { Contact } from "./whatsappApi";

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]/g, "");
}

export function contactDisplayName(contact: Contact) {
  return contact.name?.trim()
    || contact.verifiedName?.trim()
    || contact.pushname?.trim()
    || contact.phone
    || contact.id
    || "Sem nome";
}

export function contactConversationId(contact: Contact) {
  return contact.id || contact.phone;
}

export function contactMatchesSearch(contact: Contact, search: string) {
  const query = normalizeSearch(search);
  if (!query) return true;
  return [contact.name, contact.verifiedName, contact.pushname, contact.phone, contact.id]
    .some((value) => normalizeSearch(value || "").includes(query));
}

export function contactToConversation(contact: Contact): ChatConversa {
  const id = contactConversationId(contact);
  return {
    id,
    contato: contactDisplayName(contact),
    canal: "whatsapp",
    channel: "whatsapp",
    ultimoTexto: "Inicie uma conversa",
    horario: "",
    timestampUltimaMsg: 0,
    lida: true,
    mensagens: [],
    photoUrl: contact.photoUrl,
    metadados: {
      numeroCompleto: contact.phone || id,
      bioRecado: contact.bio,
      verifiedName: contact.verifiedName,
      isBusiness: contact.isBusiness,
      isMyContact: contact.isMyContact,
      isBlocked: contact.isBlocked,
      statusOnline: false,
      photoUrl: contact.photoUrl,
    },
  };
}

export function mergeConversationDetails(current: ChatConversa[], details: ChatConversa) {
  const index = current.findIndex((conversation) => conversation.id === details.id);
  if (index < 0) return [details, ...current];

  return current.map((conversation) => {
    if (conversation.id !== details.id) return conversation;
    const genericName = !details.contato || details.contato === details.id || details.contato === details.metadados?.numeroCompleto;
    return {
      ...conversation,
      ...details,
      contato: genericName ? conversation.contato : details.contato,
      photoUrl: details.photoUrl || conversation.photoUrl,
      mensagens: details.mensagens?.length ? details.mensagens : conversation.mensagens,
      metadados: {
        ...conversation.metadados,
        ...details.metadados,
        photoUrl: details.metadados?.photoUrl || conversation.metadados.photoUrl,
      },
    };
  });
}
