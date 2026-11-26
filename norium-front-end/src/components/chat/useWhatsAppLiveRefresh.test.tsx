import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWhatsAppLiveRefresh, WHATSAPP_FALLBACK_MS } from "./useWhatsAppLiveRefresh";

describe("eventos do WhatsApp", () => {
  afterEach(() => vi.useRealTimers());
  it("agrupa rajadas do socket em uma atualização", () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    const view = renderHook(() => useWhatsAppLiveRefresh({ active: true, ownerId: "owner", onChange }));
    act(() => {
      window.dispatchEvent(new CustomEvent("norium:whatsapp-event", { detail: { area: "conversations" } }));
      window.dispatchEvent(new CustomEvent("norium:whatsapp-event", { detail: { area: "labels" } }));
      vi.advanceTimersByTime(180);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(new Set(["conversations", "labels"]));
    act(() => vi.advanceTimersByTime(WHATSAPP_FALLBACK_MS * 2));
    expect(onChange).toHaveBeenCalledTimes(1);
    view.unmount();
  });
  it("mantém reserva de 120 segundos e cancela ao desmontar", () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    const view = renderHook(() => useWhatsAppLiveRefresh({ active: true, ownerId: "owner", onChange }));
    act(() => vi.advanceTimersByTime(30_000)); expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(90_180)); expect(onChange).toHaveBeenCalledTimes(1);
    view.unmount(); act(() => vi.advanceTimersByTime(240_000)); expect(onChange).toHaveBeenCalledTimes(1);
  });
  it("não consulta ao receber evento com a aba oculta", () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const view = renderHook(() => useWhatsAppLiveRefresh({ active: true, onChange }));
    act(() => { window.dispatchEvent(new Event("norium:whatsapp-event")); vi.advanceTimersByTime(WHATSAPP_FALLBACK_MS * 2); });
    expect(onChange).not.toHaveBeenCalled(); view.unmount(); hidden.mockRestore();
  });
  it("isola eventos por conta e por caixa compartilhada", () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    const view = renderHook(() => useWhatsAppLiveRefresh({ active: true, ownerId: "alice", inboxId: "box-a", onChange }));
    act(() => {
      for (const detail of [{ ownerId: "alice", area: "conversations" }, { ownerId: "bob", inboxId: "box-a", area: "attendance" }, { ownerId: "alice", inboxId: "box-b", area: "attendance" }])
        window.dispatchEvent(new CustomEvent("norium:whatsapp-event", { detail }));
      vi.advanceTimersByTime(180);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new CustomEvent("norium:whatsapp-event", { detail: { ownerId: "alice", inboxId: "box-a", area: "attendance" } })); vi.advanceTimersByTime(180); });
    expect(onChange).toHaveBeenCalledTimes(1); view.unmount();
  });
});
