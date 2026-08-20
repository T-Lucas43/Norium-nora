import { beforeEach, describe, expect, it } from "vitest";

import {
  APP_MODE_STORAGE,
  currentNoriumView,
  legacyViewFromHash,
  navigateNoriumView,
  preferredAppMode,
} from "./view";

describe("internal navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("migrates legacy fragments without keeping routes in the address", () => {
    window.history.replaceState({}, "", "/#/admin");
    expect(legacyViewFromHash()).toBe("admin");
    navigateNoriumView("admin");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
    expect(localStorage.getItem(APP_MODE_STORAGE)).toBe("admin");
  });

  it("keeps the selected mode across browser restarts", () => {
    navigateNoriumView("admin");
    window.history.replaceState({}, "", "/");
    expect(preferredAppMode()).toBe("admin");
    expect(currentNoriumView()).toBe("admin");
  });

  it("does not interpret public capability links as internal routes", () => {
    window.history.replaceState({}, "", "/#/portal/token-publico");
    expect(legacyViewFromHash()).toBeNull();
  });
});
