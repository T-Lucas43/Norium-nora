import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession, NoriumUser, PlanInfo } from "../../types/auth";
import { ownerPermissions } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import AdminDashboard from "./AdminDashboard";

vi.mock("../../utils/authApi", () => ({ authJson: vi.fn() }));
vi.mock("../shared/AppDialogProvider", () => ({ showConfirm: vi.fn().mockResolvedValue(true) }));

const plans: PlanInfo[] = [
  { code: "free", name: "Free", description: "Plano gratuito", teamSeats: 1, monthlyPrice: 0, features: [] },
  { code: "enterprise", name: "Enterprise", description: "Plano completo", teamSeats: 50, monthlyPrice: 399, features: [] },
];

const owner: NoriumUser = {
  id: "norium-admin",
  nome: "Tarcisio Lucas",
  email: "tarcisio@example.com",
  role: "owner",
  plan: "enterprise",
  status: "ativo",
  systemAdmin: true,
  systemAdminRole: "owner",
  permissions: ownerPermissions,
  createdAt: "2026-08-20T10:00:00Z",
};

const fernando: NoriumUser = {
  id: "usr_1111111111111111",
  nome: "Fernando",
  email: "fernando@example.com",
  role: "owner",
  plan: "free",
  status: "ativo",
  systemAdmin: false,
  systemAdminRole: null,
  permissions: ownerPermissions,
  createdAt: "2026-08-29T10:00:00Z",
};

function session(user = owner): AuthSession {
  return { token: "token-test", user, availableModes: ["app", "admin"] };
}

function mockApi(users: NoriumUser[]) {
  vi.mocked(authJson).mockImplementation(async (path, _token, options) => {
    if (path === "/api/auth/admin/overview") return { totalUsers: users.length, activeUsers: users.length, teamUsers: 0, adminUsers: users.filter((item) => item.systemAdmin).length, planCounts: { free: 1, enterprise: 1 }, plans };
    if (path === "/api/auth/admin/users") return { users };
    if (path === "/api/auth/plans") return { plans };
    if (path === "/api/auth/teams") return { teams: [] };
    if (path === "/api/auth/admin/audit") return { items: [] };
    if (path === "/api/auth/admin/monitoring") return { status: "operational", checkedAt: "2026-08-29T12:00:00Z", userStore: "online", totalUsers: users.length, activeUsers: users.length, adminUsers: 1, gmailConfigured: true, googleCalendarConfigured: true, gmailRedirectUri: "https://norium.example/api/auth/callback/gmail", googleRedirectUri: "https://norium.example/api/integracoes/google/callback" };
    if (path === "/api/auth/admin/system-logs?limit=300") return { items: [] };
    if (path === `/api/auth/users/${fernando.id}` && options?.method === "PATCH") return { user: { ...fernando, systemAdmin: true, systemAdminRole: "assistant" } };
    throw new Error(`Rota inesperada: ${path}`);
  });
}

describe("AdminDashboard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lista contas registradas globalmente e permite definir admin auxiliar", async () => {
    mockApi([owner, fernando]);
    const user = userEvent.setup();
    render(<AdminDashboard session={session()} onUseSystem={vi.fn()} onSessionUpdate={vi.fn()} />);

    expect(await screen.findByText("Fernando")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Fernando/ }));
    await user.click(await screen.findByRole("button", { name: /Tornar admin auxiliar/i }));

    await waitFor(() => expect(authJson).toHaveBeenCalledWith(
      `/api/auth/users/${fernando.id}`,
      "token-test",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ systemAdmin: true }) }),
    ));
  });

  it("impede o admin auxiliar de editar o proprietário", async () => {
    const assistant = { ...fernando, systemAdmin: true, systemAdminRole: "assistant" as const };
    mockApi([owner, assistant]);
    const user = userEvent.setup();
    render(<AdminDashboard session={session(assistant)} onUseSystem={vi.fn()} onSessionUpdate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Tarcisio Lucas/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("protegida contra alterações");
    expect(screen.getByRole("combobox", { name: "Plano do usuário selecionado" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Tornar admin auxiliar/i })).not.toBeInTheDocument();
  });
});
