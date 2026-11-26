import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import { WhatsAppScopeProvider, useWhatsAppScope, type AttendanceFilter } from "./WhatsAppScope";
import { whatsappApi } from "./whatsappApi";
vi.mock("../../core/api/client", async original => ({ ...await original<typeof import("../../core/api/client")>(), apiRequest: vi.fn() }));
const request = vi.mocked(apiRequest);
let current: ReturnType<typeof useWhatsAppScope>;
function Probe() { current = useWhatsAppScope(); return null; }
const setFilter = vi.fn(), onCounts = vi.fn();
function wrapper(filter: AttendanceFilter, inboxId?: string) { return <WhatsAppScopeProvider filter={filter} setFilter={setFilter} inboxId={inboxId} onCounts={onCounts} counts={{}}><Probe /></WhatsAppScopeProvider>; }
beforeEach(() => { vi.clearAllMocks(); request.mockResolvedValue({ items: [], total: 0, nextOffset: null, cursor: 0, counts: { all: 0 } }); });
describe("filtros paginados no contexto", () => {
  it("mantém a API pessoal original quando não há filtros avançados", () => {
    render(wrapper({ responsavel: "all", estado: "" })); expect(current.api).toBe(whatsappApi);
  });
  it("envia filtros pessoais no servidor e conserva a página solicitada", async () => {
    render(wrapper({ responsavel: "all", estado: "", unread: true, kind: "group", tagIds: ["vip"] }));
    await current.api.conversationPage(100);
    const url = new URL(request.mock.calls[0][0], "https://synthetic.invalid");
    expect(url.pathname).toBe("/api/chat/conversas"); expect(url.searchParams.get("offset")).toBe("100");
    expect(JSON.parse(url.searchParams.get("filtros") || "{}")).toEqual(expect.objectContaining({ unread: true, kind: "group", tagIds: ["vip"] }));
  });
  it("não reutiliza delta pessoal para uma lista filtrada", async () => {
    render(wrapper({ responsavel: "all", estado: "", unread: true })); await current.api.conversations(100);
    const url = new URL(request.mock.calls[0][0], "https://synthetic.invalid");
    expect(url.searchParams.has("since")).toBe(false); expect(url.searchParams.get("paged")).toBe("true");
  });
  it("conserva a visão selecionada ao aplicar filtros e mantém bloqueios de equipe", async () => {
    const inbox = "a".repeat(64); const result = render(wrapper({ responsavel: "all", estado: "" }, inbox));
    act(() => current.setViewId?.("saved")); result.rerender(wrapper({ responsavel: "me", estado: "open", unread: true }, inbox));
    expect(current.viewId).toBe("saved"); await current.api.conversationPage();
    expect(request.mock.calls[0][0]).toContain(`/api/chat/caixas/${inbox}/conversas`);
    await expect(current.api.disconnect()).rejects.toThrow("Meu WhatsApp");
    expect(request).toHaveBeenCalledOnce();
  });
});
