import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("../../core/api/client", () => ({ apiRequest }));

import { whatsappApi } from "./whatsappApi";

describe("whatsappApi.channels", () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  it("carrega o catalogo de canais pelo endpoint cache-first", async () => {
    const payload = {
      items: [{ id: "123@newsletter", name: "Norium", verified: true }],
    };
    apiRequest.mockResolvedValue(payload);

    await expect(whatsappApi.channels()).resolves.toEqual(payload);
    expect(apiRequest).toHaveBeenCalledWith("/api/chat/canais", {
      cache: "no-store",
      timeoutMs: 30_000,
      signal: undefined,
    });
  });
});
