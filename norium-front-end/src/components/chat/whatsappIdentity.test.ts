import { describe, expect, it } from "vitest";
import { contactToConversation, mergeConversationCatalog } from "./contactPicker";
import type { ChatConversa, MsgConteudo } from "./types";
const phone = "5511999990000@s.whatsapp.net", lid = "123456789@lid";
const message = (id: string): MsgConteudo => ({ id, texto: "Mesmo texto", timestamp: 100, remetente: "contato", tipo: "texto", horario: "10:00" });
const conversation = (id: string): ChatConversa => contactToConversation({ id, phone: id, name: "Pessoa sintética" });

describe("identidade das conversas", () => {
  it("retira o cartão antigo do LID quando chega a identidade atestada pelo servidor", () => {
    const old = { ...conversation(lid), mensagens: [message("received")] };
    const incoming = { ...conversation(phone), mensagens: [message("sent")], metadados: { ...conversation(phone).metadados, identityAliases: [phone, lid] } };
    const result = mergeConversationCatalog([old], [incoming]);
    expect(result).toHaveLength(1); expect(result[0].id).toBe(phone);
    expect(result[0].mensagens.map(row => row.id)).toEqual(["received", "sent"]);
  });
  it("o mesmo evento não vira uma segunda bolha após atualização", () => {
    const incoming = { ...conversation(phone), mensagens: [message("same")], metadados: { ...conversation(phone).metadados, identityAliases: [phone, lid] } };
    const result = mergeConversationCatalog([{ ...conversation(lid), mensagens: [message("same")] }], [incoming, incoming]);
    expect(result).toHaveLength(1); expect(result[0].mensagens).toHaveLength(1);
  });
  it("nome e texto iguais não juntam pessoas sem vínculo atestado", () => {
    expect(mergeConversationCatalog([conversation(lid)], [conversation(phone)])).toHaveLength(2);
  });
  it("mantém o nome do grupo e separa a identidade do remetente", () => {
    const group = { ...conversation("120363400000000000@g.us"), contato: "Equipe sintética", esGrupo: true, ultimoRemetenteNome: "Pessoa sintética" };
    const result = mergeConversationCatalog([group], [conversation(phone)]);
    expect(result).toHaveLength(2); expect(result.find(row => row.esGrupo)?.contato).toBe("Equipe sintética");
  });
});
