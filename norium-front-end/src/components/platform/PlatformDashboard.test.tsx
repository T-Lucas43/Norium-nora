import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import type { AuthSession } from "../../types/auth";
import PlatformDashboard from "./PlatformDashboard";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
vi.mock("../shared/AppDialogProvider", () => ({ showAlert: vi.fn(), showConfirm: vi.fn() }));
const request = vi.mocked(apiRequest);
const session = { token: "test", user: { id: "u1", role: "owner", permissions: {} } } as AuthSession;
beforeEach(() => { request.mockReset(); request.mockResolvedValue({}); });

it("opens the overview without querying the vault, documents or team", async () => {
  render(<PlatformDashboard session={session} />);
  await screen.findByText("Captura rapida universal");
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/plataforma/resumo"]);
});

it("loads only the selected area and allows returning while another area is slow", async () => {
  request.mockImplementation((path) => path.endsWith("/resumo") ? Promise.resolve({}) : new Promise(() => {}));
  render(<PlatformDashboard session={session} />);
  await screen.findByText("Captura rapida universal");
  fireEvent.click(screen.getByRole("button", { name: "Ambientes" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("/api/plataforma/empresas"));
  fireEvent.click(screen.getByRole("button", { name: "Visao geral" }));
  await screen.findByText("Captura rapida universal");
  expect(request.mock.calls.some(([path]) => path.endsWith("/cofre"))).toBe(false);
});
