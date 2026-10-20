import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import { whatsappApi } from "./whatsappApi";
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
const request = vi.mocked(apiRequest);
describe("catálogo completo do WhatsApp", () => {
  beforeEach(() => vi.resetAllMocks());
  it("recupera o snapshot completo quando um lote de grupos excede o delta", async () => {
    const groups = Array.from({ length: 237 }, (_, index) => ({ id: `12036340000${index}@g.us`, contato: `Grupo ${index}`, esGrupo: true, mensagens: [] }));
    request.mockResolvedValueOnce({ items: groups.slice(0, 100), cursor: 1800000000, hasMore: true })
      .mockResolvedValueOnce(groups.slice(0, 50)).mockResolvedValueOnce({ items: groups });
    const result = await whatsappApi.conversations(1799999999);
    expect(result).toMatchObject({ cursor: 1800000000, hasMore: false });
    expect(Array.isArray(result) ? result : result.items).toHaveLength(237);
    expect(request).toHaveBeenLastCalledWith("/api/chat/grupos", { timeoutMs: 12_000 });
  });
});
