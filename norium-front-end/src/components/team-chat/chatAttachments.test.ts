import { describe, expect, it } from "vitest";
import { MAX_CHAT_ATTACHMENT_BYTES, prepareChatAttachments } from "./chatAttachments";

describe("anexos do chat da equipe", () => {
  it("converte imagem selecionada em payload base64 preservando nome e tipo", async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], "equipe.png", { type: "image/png" });
    const [attachment] = await prepareChatAttachments([file]);

    expect(attachment.fileName).toBe("equipe.png");
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("informa o limite quando um arquivo nao pode ser enviado", async () => {
    const file = new File([new Uint8Array(MAX_CHAT_ATTACHMENT_BYTES + 1)], "arquivo.bin", { type: "application/octet-stream" });
    await expect(prepareChatAttachments([file])).rejects.toThrow("ultrapassa 12 MB");
  });
});
