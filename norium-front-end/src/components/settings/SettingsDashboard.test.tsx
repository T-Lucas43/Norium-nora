import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SettingsDashboard from "./SettingsDashboard";
import { createDefaultProfile, loadOperatorProfile, saveOperatorProfile } from "../profile/profileService";
import { apiRequest } from "../../core/api/client";
import type { NoriumUser } from "../../types/auth";
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));
vi.mock("./PrivacyStorageCard", () => ({ default: () => null }));
vi.mock("../profile/profileService", async importOriginal => {
  const original = await importOriginal<typeof import("../profile/profileService")>();
  return { ...original, loadOperatorProfile: vi.fn(), saveOperatorProfile: vi.fn() };
});
beforeEach(() => {
  window.localStorage.removeItem("norium:configuracoes-secao");
  vi.mocked(loadOperatorProfile).mockResolvedValue(createDefaultProfile());
  vi.mocked(saveOperatorProfile).mockImplementation(async (_id, profile) => profile);
});
it("opens the authenticated consumption section without saving unrelated preferences", async () => {
  const user = { id: "u1", systemAdmin: false } as NoriumUser;
  vi.mocked(apiRequest).mockRejectedValueOnce(new Error("Consulta indisponível"));
  const onSaved = vi.fn();
  render(<SettingsDashboard userId="u1" currentUser={user} onSaved={onSaved} />);
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(apiRequest).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Consumo da Nora" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Consulta indisponível");
  expect(apiRequest).toHaveBeenCalledWith("/api/auth/nora-usage", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.queryByRole("button", { name: "Salvar configurações" })).not.toBeInTheDocument();
  expect(saveOperatorProfile).not.toHaveBeenCalled();
  expect(window.localStorage.getItem("norium:configuracoes-secao")).toBe("consumo");
});
it("does not expose consumption when an authenticated person is unavailable", async () => {
  window.localStorage.setItem("norium:configuracoes-secao", "consumo");
  const onSaved = vi.fn();
  render(<SettingsDashboard userId="u1" onSaved={onSaved} />);
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Consumo da Nora" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Aparência e acessibilidade" })).toBeInTheDocument();
});
it("persists interface preferences and applies text accessibility on save", async () => {
  const onSaved = vi.fn();
  render(<SettingsDashboard userId="u1" onSaved={onSaved} />);
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText(/Estilo do menu/), { target: { value: "classic" } });
  fireEvent.change(screen.getByLabelText(/Tamanho do texto/), { target: { value: "large" } });
  fireEvent.click(screen.getByLabelText(/Reduzir animações/));
  fireEvent.click(screen.getByLabelText(/Mostrar prévia dos alertas/));
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }));
  await screen.findByRole("status");
  expect(saveOperatorProfile).toHaveBeenCalledWith("u1", expect.objectContaining({ interface_preferences: expect.objectContaining({ navigationStyle: "classic", textSize: "large", reducedMotion: true, toastPreview: false }) }));
  expect(document.documentElement.style.fontSize).toBe("18px");
  expect(document.documentElement.dataset.reducedMotion).toBe("true");
});
it("reports a save error instead of claiming preferences were applied", async () => {
  vi.mocked(saveOperatorProfile).mockRejectedValueOnce(new Error("Falha de conexão"));
  const onSaved = vi.fn();
  render(<SettingsDashboard userId="u1" onSaved={onSaved} />);
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Falha de conexão");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
