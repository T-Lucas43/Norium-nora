import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { authJson } from "../../utils/authApi";
import type { AuthSession } from "../../types/auth";
import TeamDashboard from "./TeamDashboard";

vi.mock("../../utils/authApi", () => ({ authJson: vi.fn() }));
vi.mock("../shared/AppDialogProvider", () => ({ showConfirm: vi.fn() }));
const request = vi.mocked(authJson);
const user = { id: "u1", nome: "Pessoa A", role: "owner", permissions: {}, status: "ativo", email: "a@test.local", plan: "equipe" };
const second = { ...user, id: "u2", nome: "Pessoa B", email: "b@test.local", role: "member" };
const session = { token: "test", user, availableModes: ["app"] } as AuthSession;
beforeEach(() => { request.mockReset(); });

it("allows managing members while the team report is slow and does not reload on member selection", async () => {
  request.mockImplementation((path) => path === "/api/auth/users" ? Promise.resolve({ users: [user, second] }) : new Promise(() => {}));
  render(<TeamDashboard session={session} onSessionUpdate={vi.fn()} onOpenTeamChat={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Membros e acessos" }));
  const member = await screen.findByRole("button", { name: /Pessoa B/ });
  const count = request.mock.calls.length;
  fireEvent.click(member);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Pessoa B" })).toBeInTheDocument());
  expect(request.mock.calls).toHaveLength(count);
  fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path.endsWith("relatorio-equipe"))).toHaveLength(2));
});
