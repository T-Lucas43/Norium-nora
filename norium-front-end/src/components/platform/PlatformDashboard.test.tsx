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
  await screen.findByText("Fontes de conhecimento");
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/plataforma/resumo"]);
});

it("loads only the selected area and allows returning while another area is slow", async () => {
  request.mockImplementation((path) => path.endsWith("/resumo") ? Promise.resolve({}) : new Promise(() => {}));
  render(<PlatformDashboard session={session} />);
  await screen.findByText("Fontes de conhecimento");
  fireEvent.click(screen.getByRole("button", { name: "Estrutura" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("/api/plataforma/empresas"));
  fireEvent.click(screen.getByRole("button", { name: "Visão executiva" }));
  await screen.findByText("Fontes de conhecimento");
  expect(request.mock.calls.some(([path]) => path.endsWith("/cofre"))).toBe(false);
});

it("loads security without requesting disconnected governance features", async () => {
  request.mockImplementation((path) => Promise.resolve(path === "/api/auth/users" ? { users: [] } : path.includes("auditoria") ? { items: [] } : {}));
  render(<PlatformDashboard session={session} />);
  await screen.findByText("Fontes de conhecimento");
  fireEvent.click(screen.getByRole("button", { name: "Revisar controles" }));
  await screen.findByText("Matriz de permissões");
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/plataforma/resumo", "/api/auth/users", "/api/operacao/auditoria?limit=5"]);
  expect(screen.queryByText("Cofre de integracoes")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Ver auditoria completa/ })).toBeDisabled();
});

it("reports knowledge query failures and allows retrying", async () => {
  request.mockImplementation((path) => path.endsWith("/consultar") ? Promise.reject(new Error("Consulta indisponível")) : Promise.resolve({ items: [] }));
  render(<PlatformDashboard session={session} />);
  await screen.findByText("Fontes de conhecimento");
  fireEvent.click(screen.getByRole("button", { name: "Conhecimento" }));
  await screen.findByText("Base de conhecimento");
  fireEvent.change(screen.getByPlaceholderText("Qual e a politica de reembolso?"), { target: { value: "reembolso" } });
  fireEvent.click(screen.getByRole("button", { name: "Consultar" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Consulta indisponível");
  expect(screen.getByRole("button", { name: "Consultar" })).toBeEnabled();
});
