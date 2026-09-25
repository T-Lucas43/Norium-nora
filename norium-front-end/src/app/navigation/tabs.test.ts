import { beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_TAB_STORAGE,
  canonicalTab,
  initialTab,
  navigateNoriumTab,
  normalizeNoriumTabPath,
  TAB_ROUTES,
  tabFromPath,
  tabPath,
} from "./tabs";

describe("module page navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("gives every module a stable opaque application URL", () => {
    expect(tabPath("Nora")).toBe("/app/khW_OrvF3ZYPq5Io7Lf_");
    expect(tabPath("Estúdio")).toBe("/app/4UXAqQ7JdDt88e6Js6_f");
    expect(tabPath("Brainstorm")).toBe(tabPath("Estúdio"));
    expect(tabFromPath("/app/brainstorm")).toBe("Estúdio");
    expect(tabPath("Documentos")).not.toContain("documentos");
    expect(tabPath("PDF Studio")).not.toContain("pdf-studio");
    expect(tabFromPath("/app/pdf-studio")).toBe("PDF Studio");
    expect(tabPath("Agente Navegador")).not.toContain("navegador");
    expect(tabPath("E-mails")).not.toContain("emails");
    expect(tabPath("Pendencias")).toBe(tabPath("Central"));
    expect(tabFromPath("/app/pendencias")).toBe("Central");
    expect(new Set(Object.values(TAB_ROUTES)).size).toBe(Object.keys(TAB_ROUTES).length);
  });

  it("restores a module directly from its page URL", () => {
    window.history.replaceState({}, "", tabPath("Relatórios"));
    expect(tabFromPath()).toBe("Relatórios");
    expect(initialTab()).toBe("Relatórios");
  });

  it("migrates readable legacy paths immediately while preserving the query", () => {
    window.history.replaceState({}, "", "/app/relatorios?origem=favorito");
    expect(normalizeNoriumTabPath()).toBe("Relatórios");
    expect(window.location.pathname).toBe(tabPath("Relatórios"));
    expect(window.location.search).toBe("?origem=favorito");
  });

  it("pushes module navigation into browser history", () => {
    navigateNoriumTab("Documentos");
    expect(window.location.pathname).toBe(tabPath("Documentos"));
    expect(window.history.state.noriumTab).toBe("Documentos");
  });

  it("migrates old aliases without reopening hidden panels", () => {
    localStorage.setItem(ACTIVE_TAB_STORAGE, "Propostas");
    expect(canonicalTab("Propostas")).toBe("Documentos");
    expect(initialTab()).toBe("Documentos");
  });
});
