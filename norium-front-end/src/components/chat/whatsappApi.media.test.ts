import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "../../core/api/client";
import { whatsappApi } from "./whatsappApi";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));

const request = vi.mocked(apiRequest);

describe("envio de midia pelo WhatsApp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("transporta a opcao de visualizacao unica no payload do backend", async () => {
    request.mockResolvedValueOnce({ status: "enviado_real" });

    await whatsappApi.sendMedia({
      conversationId: "5511999999999@s.whatsapp.net",
      fileName: "foto.jpg",
      mimeType: "image/jpeg",
      dataUrl: "data:image/jpeg;base64,AAAA",
      viewOnce: true,
    });

    expect(request).toHaveBeenCalledWith("/api/chat/enviar-arquivo", expect.objectContaining({
      method: "POST",
      body: expect.any(String),
    }));
    const body = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(body.visualizacao_unica).toBe(true);
  });
});
