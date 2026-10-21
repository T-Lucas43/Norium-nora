import type { ChatConversa, MsgConteudo } from "./types";
import { isWhatsAppStatusIdentifier, type Contact } from "./whatsappApi";

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]/g, "");
}

export function isTechnicalWhatsAppLabel(value?: string | null) {
  const label = String(value || "").trim();
  return !label
    || /@(?:c\.us|s\.whatsapp\.net|lid|g\.us|newsletter|broadcast)$/i.test(label)
    || /^\+?[\d\s().-]{7,}$/.test(label)
    || /^[.,;:_~\-–—]+$/u.test(label);
}

export function whatsappIdentifierKeys(value?: string | null) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return [];
  // LID, grupo e canal são identidades distintas de um número de telefone.
  if (/@(?:lid|g\.us|newsletter|broadcast)$/.test(raw)) return [raw];
  const local = raw.split("@")[0];
  const digits = local.replace(/\D/g, "");
  return [...new Set([raw, local, digits].filter(Boolean))];
}

export function formatWhatsAppPhone(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/@(?:lid|g\.us|newsletter|broadcast)$/i.test(raw)) return "";
  const digits = raw.split("@")[0].replace(/\D/g, "");
  if (!digits) return raw.includes("@") ? "" : raw;

  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const area = digits.slice(2, 4);
    const local = digits.slice(4);
    const split = local.length === 9 ? 5 : 4;
    return `+55 (${area}) ${local.slice(0, split)}-${local.slice(split)}`;
  }
  return `+${digits}`;
}

function bestHumanName(values: Array<string | null | undefined>) {
  return values.map((value) => String(value || "").trim()).find((value) => value && !isTechnicalWhatsAppLabel(value));
}

export function contactDisplayName(contact: Contact) {
  return bestHumanName([contact.savedName, contact.name, contact.notify, contact.verifiedName, contact.pushname])
    || formatWhatsAppPhone(contact.phone || contact.id)
    || "Contato do WhatsApp";
}

export function conversationDisplayName(conversation: ChatConversa) {
  const name = bestHumanName([
    conversation.contato,
    conversation.metadados?.notify,
    conversation.metadados?.verifiedName,
  ]);
  return name || (conversation.esGrupo ? "Grupo do WhatsApp" : formatWhatsAppPhone(conversation.metadados?.numeroCompleto || conversation.id) || "Contato do WhatsApp");
}

export function contactConversationId(contact: Contact) {
  return contact.id || contact.phone;
}

export function contactGroupPhone(contact: Contact) {
  const raw = String(contact.phone || "").trim();
  if (!raw || /@lid\b/i.test(raw)) return null;
  const digits = raw.split("@")[0].replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

export function contactMatchesSearch(contact: Contact, search: string) {
  const query = normalizeSearch(search);
  if (!query) return true;
  return [contact.savedName, contact.name, contact.notify, contact.verifiedName, contact.pushname, contact.phone, contact.id, contact.lid, ...(contact.aliases || [])]
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
    const hasSavedAgendaName = conversation.metadados?.isMyContact === true
      && !isTechnicalWhatsAppLabel(conversation.contato);
    const genericName = isTechnicalWhatsAppLabel(details.contato);
    const messages = mergeMessages(conversation.mensagens, details.mensagens || []);
    return {
      ...conversation,
      ...details,
      contato: hasSavedAgendaName || genericName ? conversation.contato : details.contato,
      photoUrl: details.photoUrl || conversation.photoUrl,
      mensagens: messages,
      metadados: {
        ...conversation.metadados,
        ...details.metadados,
        photoUrl: details.metadados?.photoUrl || conversation.metadados.photoUrl,
      },
    };
  });
}

const messageStatusRank: Record<NonNullable<MsgConteudo["status"]>, number> = {
  erro: 1,
  pendente: 1,
  enviado: 2,
  entregue: 3,
  lido: 4,
  reproduzido: 5,
};

function richerMessageStatus(previous?: MsgConteudo["status"], incoming?: MsgConteudo["status"]) {
  if (!incoming) return previous;
  if (!previous) return incoming;
  return messageStatusRank[incoming] >= messageStatusRank[previous] ? incoming : previous;
}

function hasRecordContent(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && Object.keys(value).length);
}

export function mergeMessages(current: MsgConteudo[] = [], incoming: MsgConteudo[] = []) {
  const merged = new Map<string, MsgConteudo>();
  for (const message of [...current, ...incoming]) {
    if (!message?.id) continue;
    const previous = merged.get(message.id);
    merged.set(message.id, previous ? {
      ...previous,
      ...message,
      texto: message.texto || previous.texto,
      arquivoUrl: message.arquivoUrl || previous.arquivoUrl,
      miniaturaUrl: message.miniaturaUrl || previous.miniaturaUrl,
      remetenteNome: message.remetenteNome || previous.remetenteNome,
      status: richerMessageStatus(previous.status, message.status),
      reacoes: Array.isArray(message.reacoes) ? message.reacoes : previous.reacoes,
      citada: hasRecordContent(message.citada) ? message.citada : previous.citada,
      midiaMeta: hasRecordContent(message.midiaMeta) ? message.midiaMeta : previous.midiaMeta,
    } : message);
  }
  return [...merged.values()].sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function contactKeys(contact: Contact) {
  return [...new Set([
    ...whatsappIdentifierKeys(contact.id),
    ...whatsappIdentifierKeys(contact.phone),
    ...whatsappIdentifierKeys(contact.lid),
    ...(contact.aliases || []).flatMap(whatsappIdentifierKeys),
  ])];
}

function consolidateContactAliases(contacts: Contact[]) {
  if (contacts.length < 2) return contacts;

  const parents = contacts.map((_contact, index) => index);
  const findRoot = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const join = (left: number, right: number) => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  const ownerByKey = new Map<string, number>();
  contacts.forEach((contact, index) => {
    contactKeys(contact).forEach((key) => {
      const owner = ownerByKey.get(key);
      if (owner === undefined) ownerByKey.set(key, index);
      else join(index, owner);
    });
  });

  const membersByRoot = new Map<number, Contact[]>();
  contacts.forEach((contact, index) => {
    const root = findRoot(index);
    membersByRoot.set(root, [...(membersByRoot.get(root) || []), contact]);
  });

  return contacts.map((contact, index): Contact => {
    const members = membersByRoot.get(findRoot(index)) || [contact];
    if (members.length < 2) return contact;

    const savedMembers = members.filter((member) => member.isMyContact === true);
    const agendaName = bestHumanName([
      ...members.map((member) => member.savedName),
      ...savedMembers.flatMap((member) => [member.name, member.notify, member.verifiedName, member.pushname]),
    ]);
    const sharedName = agendaName || bestHumanName(members.flatMap((member) => [
      member.name,
      member.notify,
      member.verifiedName,
      member.pushname,
    ]));
    const sharedNotify = bestHumanName(members.map((member) => member.notify));
    const sharedPushname = bestHumanName(members.map((member) => member.pushname));
    const sharedVerifiedName = bestHumanName(members.map((member) => member.verifiedName));
    const sharedPhotoUrl = members.map((member) => member.photoUrl).find(Boolean);
    const sharedBio = members.map((member) => member.bio).find((value) => Boolean(value?.trim()));
    const sharedPhone = members.map(contactGroupPhone).find(Boolean);
    const sharedIsBusiness = members.some((member) => member.isBusiness === true)
      ? true
      : members.some((member) => member.isBusiness === false) ? false : undefined;
    const sharedIsBlocked = members.some((member) => member.isBlocked === true)
      ? true
      : members.some((member) => member.isBlocked === false) ? false : undefined;
    const aliases = [...new Set(members.flatMap((member) => [
      ...(member.aliases || []),
      member.id,
      member.phone,
      member.lid,
    ]).filter(Boolean) as string[])];
    const belongsToAgenda = Boolean(agendaName) || savedMembers.length > 0;

    return {
      ...contact,
      phone: contactGroupPhone(contact) || sharedPhone || contact.phone,
      ...(agendaName ? { savedName: agendaName } : {}),
      ...(sharedName ? { name: sharedName } : {}),
      notify: bestHumanName([contact.notify, sharedNotify]),
      pushname: bestHumanName([contact.pushname, sharedPushname]),
      verifiedName: bestHumanName([contact.verifiedName, sharedVerifiedName]),
      photoUrl: contact.photoUrl || sharedPhotoUrl,
      bio: contact.bio || sharedBio,
      isBusiness: sharedIsBusiness,
      isMyContact: belongsToAgenda ? true : contact.isMyContact,
      isBlocked: sharedIsBlocked,
      aliases,
    };
  });
}

function conversationKeys(conversation: ChatConversa) {
  return [...new Set([
    ...whatsappIdentifierKeys(conversation.id),
    ...whatsappIdentifierKeys(conversation.metadados?.numeroCompleto),
  ])];
}

export function mergeContactCatalog(current: Contact[], incoming: Contact[], conversations: ChatConversa[] = []) {
  const conversationByKey = new Map<string, ChatConversa>();
  conversations.forEach((conversation) => conversationKeys(conversation).forEach((key) => conversationByKey.set(key, conversation)));
  const currentByKey = new Map<string, Contact>();
  current.forEach((contact) => contactKeys(contact).forEach((key) => currentByKey.set(key, contact)));

  const merged: Contact[] = incoming.map((contact): Contact => {
    const keys = contactKeys(contact);
    const previous = keys.map((key) => currentByKey.get(key)).find(Boolean);
    const conversation = keys.map((key) => conversationByKey.get(key)).find(Boolean);
    const incomingName = contactDisplayName(contact);
    const previousName = previous ? contactDisplayName(previous) : "";
    const conversationName = conversation ? conversationDisplayName(conversation) : "";
    const humanName = bestHumanName([
      contact.savedName,
      contact.name,
      contact.notify,
      contact.verifiedName,
      contact.pushname,
      previousName,
      conversationName,
    ]);
    return {
      ...previous,
      ...contact,
      savedName: contact.savedName || previous?.savedName,
      name: humanName || incomingName,
      photoUrl: contact.photoUrl || previous?.photoUrl || conversation?.metadados?.photoUrl || conversation?.photoUrl,
      aliases: [...new Set([...(previous?.aliases || []), ...(contact.aliases || []), contact.id, contact.phone, contact.lid].filter(Boolean) as string[])],
    };
  });

  const incomingKeys = new Set(merged.flatMap(contactKeys));
  current.forEach((contact) => {
    if (!contactKeys(contact).some((key) => incomingKeys.has(key))) merged.push(contact);
  });
  return consolidateContactAliases(merged);
}

export function enrichConversationsWithContacts(conversations: ChatConversa[], contacts: Contact[]) {
  const contactByKey = new Map<string, Contact>();
  contacts.forEach((contact) => contactKeys(contact).forEach((key) => contactByKey.set(key, contact)));
  return conversations.map((conversation) => {
    if (conversation.esGrupo || conversation.id.endsWith("@g.us")) return conversation;
    const matched = conversationKeys(conversation).map((key) => contactByKey.get(key)).find(Boolean);
    if (!matched) return conversation;
    const matchedName = contactDisplayName(matched);
    const currentName = conversationDisplayName(conversation);
    const matchedAgendaName = bestHumanName([
      matched.savedName,
      matched.isMyContact ? matchedName : undefined,
    ]);
    const name = bestHumanName([matchedAgendaName, conversation.contato, matchedName]) || currentName;
    const photoUrl = matched.photoUrl || conversation.metadados?.photoUrl || conversation.photoUrl;
    return {
      ...conversation,
      contato: name,
      photoUrl,
      metadados: {
        ...conversation.metadados,
        numeroCompleto: matched.phone || conversation.metadados.numeroCompleto,
        notify: matched.notify || conversation.metadados.notify,
        verifiedName: matched.verifiedName || conversation.metadados.verifiedName,
        bioRecado: matched.bio || conversation.metadados.bioRecado,
        isBusiness: matched.isBusiness ?? conversation.metadados.isBusiness,
        isMyContact: matched.isMyContact ?? conversation.metadados.isMyContact,
        isBlocked: matched.isBlocked ?? conversation.metadados.isBlocked,
        photoUrl,
      },
    };
  });
}

export function mergeConversationCatalog(current: ChatConversa[], incoming: ChatConversa[], contacts: Contact[] = []) {
  const isStatusConversation = (conversation: ChatConversa) => (
    [conversation.id, conversation.metadados?.numeroCompleto].some(isWhatsAppStatusIdentifier)
  );
  const safeCurrent = current.filter((conversation) => !isStatusConversation(conversation));
  const safeIncoming = incoming.filter((conversation) => !isStatusConversation(conversation));
  const currentById = new Map(safeCurrent.map((conversation) => [conversation.id, conversation]));
  const merged = safeIncoming.map((conversation) => {
    const previous = currentById.get(conversation.id);
    if (!previous) return conversation;
    const incomingName = conversationDisplayName(conversation);
    const previousName = conversationDisplayName(previous);
    return {
      ...previous,
      ...conversation,
      contato: bestHumanName([conversation.contato, previousName]) || incomingName,
      photoUrl: conversation.photoUrl || previous.photoUrl,
      mensagens: mergeMessages(previous.mensagens, conversation.mensagens),
      metadados: {
        ...previous.metadados,
        ...conversation.metadados,
        photoUrl: conversation.metadados?.photoUrl || previous.metadados?.photoUrl,
      },
    };
  });
  const incomingIds = new Set(safeIncoming.map((conversation) => conversation.id));
  safeCurrent.forEach((conversation) => {
    if (!incomingIds.has(conversation.id)) merged.push(conversation);
  });
  return enrichConversationsWithContacts(merged, contacts);
}
