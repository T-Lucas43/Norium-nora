import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "../../core/api/client";
import { noraChatApi } from "./noraChatApi";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));

const request = vi.mocked(apiRequest);

describe("noraChatApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gera sugestão pelo endpoint de rascunho sem executar envio", async () => {
    request.mockResolvedValueOnce({ draft: "Olá!" });

    await expect(noraChatApi.suggestReply("chat-1")).resolves.toBe("Olá!");
    expect(request).toHaveBeenCalledWith("/api/nora/agentes/mensagens/rascunho", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ conversa_id: "chat-1", instrucao: undefined }),
    }));
  });

  it("mantém explicitamente desativado o envio direto na ação personalizada", async () => {
    request.mockResolvedValueOnce({ response: "Texto preparado" });

    await expect(noraChatApi.runCustomAction("chat-1", "prepare uma resposta")).resolves.toBe("Texto preparado");
    expect(request).toHaveBeenCalledWith("/api/nora/chat-whatsapp", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        conversa_id: "chat-1",
        texto_usuario: "prepare uma resposta",
        enviar_direto_whatsapp: false,
      }),
    }));
  });

  it("usa o endpoint de resumo com o identificador codificado", async () => {
    request.mockResolvedValueOnce({ resumo: "Resumo real" });

    await expect(noraChatApi.summarizeConversation("55 11@s.whatsapp.net")).resolves.toBe("Resumo real");
    expect(request).toHaveBeenCalledWith(
      "/api/nora/resumir-conversa?conversa_id=55%2011%40s.whatsapp.net",
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });
});
