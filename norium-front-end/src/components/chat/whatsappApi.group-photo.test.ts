import { describe, expect, it } from "vitest";

import { normalizeWhatsAppConversation } from "./whatsappApi";

describe("fotos de grupos do WhatsApp", () => {
  it("preserva os aliases de foto retornados pela W-API", () => {
    expect(normalizeWhatsAppConversation({
      id: "120363000000000000@g.us",
      subject: "Equipe",
      isGroup: true,
      profilePicUrl: "https://example.test/equipe.jpg",
      metadata: { numeroCompleto: "120363000000000000@g.us" },
    })).toMatchObject({
      esGrupo: true,
      photoUrl: "https://example.test/equipe.jpg",
      metadados: { photoUrl: "https://example.test/equipe.jpg" },
    });

    expect(normalizeWhatsAppConversation({
      id: "120363000000000001@g.us",
      name: "Comunidade",
      imgUrl: "https://example.test/comunidade.jpg",
    })).toMatchObject({
      photoUrl: "https://example.test/comunidade.jpg",
      metadados: { photoUrl: "https://example.test/comunidade.jpg" },
    });
  });
});
