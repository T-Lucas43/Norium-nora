import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SettingsDashboard from "./SettingsDashboard";
import { createDefaultProfile, loadOperatorProfile, saveOperatorProfile } from "../profile/profileService";
vi.mock("../profile/profileService", async importOriginal => {
  const original = await importOriginal<typeof import("../profile/profileService")>();
  return { ...original, loadOperatorProfile: vi.fn(), saveOperatorProfile: vi.fn() };
});
beforeEach(() => {
  vi.mocked(loadOperatorProfile).mockResolvedValue(createDefaultProfile());
  vi.mocked(saveOperatorProfile).mockImplementation(async (_id, profile) => profile);
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
