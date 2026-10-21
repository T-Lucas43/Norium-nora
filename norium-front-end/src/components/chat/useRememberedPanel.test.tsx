import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRememberedPanel } from "./useRememberedPanel";
vi.mock("../../core/api/sessionScope", () => ({ workspaceScope: () => "workspace-a" }));
describe("preferência do painel", () => {
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  it("persiste por pessoa sem usar token e isola outra conta", () => {
    const view = renderHook(({ user }) => useRememberedPanel(user), { initialProps: { user: "person-a" } });
    act(() => view.result.current[1](true));
    expect(view.result.current[0]).toBe(true);
    expect(localStorage.key(0)).toBe('norium.whatsapp.client-panel:["person-a","workspace-a"]');
    view.rerender({ user: "person-b" });
    expect(view.result.current[0]).toBe(false);
    view.rerender({ user: "person-a" });
    expect(view.result.current[0]).toBe(true);
  });
  it("continua abrindo quando o navegador não permite armazenamento", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const view = renderHook(() => useRememberedPanel("person-a"));
    act(() => view.result.current[1](true));
    expect(view.result.current[0]).toBe(true);
  });
});
