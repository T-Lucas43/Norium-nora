import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useMailPreferences } from "./useMailPreferences";

const KEY = "norium-mail-preferences";

beforeEach(() => window.localStorage.clear());

describe("useMailPreferences", () => {
  it("comeca com os padroes quando nao ha nada salvo", () => {
    const { result } = renderHook(() => useMailPreferences());
    expect(result.current.preferences).toEqual({
      autoRefresh: true, showPreview: true, compactMode: false, groupByCategory: false,
    });
  });

  it("carrega o que estava salvo", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ compactMode: true, autoRefresh: false }));
    const { result } = renderHook(() => useMailPreferences());

    await waitFor(() => expect(result.current.preferences.compactMode).toBe(true));
    expect(result.current.preferences.autoRefresh).toBe(false);
    // as ausentes mantem o padrao
    expect(result.current.preferences.showPreview).toBe(true);
  });

  it("ignora tipos invalidos vindos do storage", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ compactMode: "sim", showPreview: 1 }));
    const { result } = renderHook(() => useMailPreferences());

    await waitFor(() => expect(result.current.preferences.compactMode).toBe(false));
    expect(result.current.preferences.showPreview).toBe(true);
  });

  it("nao quebra com JSON corrompido", () => {
    window.localStorage.setItem(KEY, "{nao e json");
    expect(() => renderHook(() => useMailPreferences())).not.toThrow();
  });

  it("nao sobrescreve o storage antes de terminar a leitura inicial", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ compactMode: true }));
    renderHook(() => useMailPreferences());
    // o primeiro render nao pode gravar os padroes por cima do salvo
    expect(JSON.parse(window.localStorage.getItem(KEY)!).compactMode).toBe(true);
  });

  it("altera uma preferencia sem afetar as outras", () => {
    const { result } = renderHook(() => useMailPreferences());
    act(() => result.current.setPreference("groupByCategory", true));

    expect(result.current.preferences.groupByCategory).toBe(true);
    expect(result.current.preferences.autoRefresh).toBe(true);
    expect(result.current.preferences.showPreview).toBe(true);
  });
});
