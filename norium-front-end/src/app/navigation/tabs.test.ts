import { beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_TAB_STORAGE,
  canonicalTab,
  initialTab,
  navigateNoriumTab,
  tabFromPath,
  tabPath,
} from "./tabs";

describe("module page navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("gives every module a stable application URL", () => {
    expect(tabPath("Nora")).toBe("/app/nora");
    expect(tabPath("Estúdio")).toBe("/app/estudio");
    expect(tabPath("Brainstorm")).toBe("/app/estudio");
    expect(tabFromPath("/app/brainstorm")).toBe("Estúdio");
    expect(tabPath("Documentos")).toBe("/app/documentos");
    expect(tabPath("Agente Navegador")).toBe("/app/navegador");
    expect(tabPath("E-mails")).toBe("/app/emails");
    expect(tabPath("Pendencias")).toBe("/app/central");
    expect(tabFromPath("/app/pendencias")).toBe("Central");
  });

  it("restores a module directly from its page URL", () => {
    window.history.replaceState({}, "", "/app/relatorios");
    expect(tabFromPath()).toBe("Relatórios");
    expect(initialTab()).toBe("Relatórios");
  });

  it("pushes module navigation into browser history", () => {
    navigateNoriumTab("Documentos");
    expect(window.location.pathname).toBe("/app/documentos");
    expect(window.history.state.noriumTab).toBe("Documentos");
  });

  it("migrates old aliases without reopening hidden panels", () => {
    localStorage.setItem(ACTIVE_TAB_STORAGE, "Propostas");
    expect(canonicalTab("Propostas")).toBe("Documentos");
    expect(initialTab()).toBe("Documentos");
  });
});
