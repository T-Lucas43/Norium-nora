import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationSearch } from "./useConversationSearch";
import { whatsappApi } from "./whatsappApi";
import type { ChatConversa } from "./types";
vi.mock("./whatsappApi", () => ({ whatsappApi: { conversationPage: vi.fn() } }));
const scope = vi.hoisted(() => ({ value: "workspace-a" }));
vi.mock("../../core/api/sessionScope", () => ({ requestScope: () => scope.value }));
const page = vi.mocked(whatsappApi.conversationPage);
describe("busca paginada no servidor", () => {
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); scope.value = "workspace-a"; });
  it("espera 300ms e cancela a busca anterior enquanto a pessoa digita", async () => {
    vi.useFakeTimers(); page.mockResolvedValue({ items: [{ id: "a" } as ChatConversa], nextOffset: null, total: 1, cursor: 0, hasMore: false });
    const view = renderHook(({ text }) => useConversationSearch(text), { initialProps: { text: "con" } });
    act(() => vi.advanceTimersByTime(200)); view.rerender({ text: "contrato" });
    act(() => vi.advanceTimersByTime(299)); expect(page).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(page).toHaveBeenCalledOnce(); expect(page.mock.calls[0].slice(0, 2)).toEqual([0, "contrato"]);
    expect(view.result.current.matching?.has("a")).toBe(true);
  });
  it("não mistura dados recebidos depois de trocar workspace", async () => {
    vi.useFakeTimers(); const onFound = vi.fn();
    let resolve!: (value: Awaited<ReturnType<typeof whatsappApi.conversationPage>>) => void;
    page.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = renderHook(() => useConversationSearch("contrato", onFound));
    act(() => vi.advanceTimersByTime(300)); scope.value = "workspace-b";
    await act(async () => resolve({ items: [{ id: "private" } as ChatConversa], nextOffset: null, total: 1, cursor: 0, hasMore: false }));
    expect(onFound).not.toHaveBeenCalled(); expect(view.result.current.matching).toBeNull();
  });
});
