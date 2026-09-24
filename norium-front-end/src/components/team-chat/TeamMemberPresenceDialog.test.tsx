import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NoriumUser } from "../../types/auth";
import TeamMemberPresenceDialog from "./TeamMemberPresenceDialog";
import { formatMemberLastAccess } from "./teamMemberPresence";

const member = {
  id: "member-1",
  nome: "Maria Silva",
  email: "maria@example.test",
  jobTitle: "Comercial",
  role: "member",
  plan: "equipe",
  status: "ativo",
  systemAdmin: false,
  lastLoginAt: "2026-08-30T14:35:00",
  permissions: {},
} as NoriumUser;

describe("TeamMemberPresenceDialog", () => {
  it("mostra somente presença ativa quando o membro está online", () => {
    render(<TeamMemberPresenceDialog member={member} online isCurrentUser={false} token="token" onClose={vi.fn()} onMessage={vi.fn()} onCall={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Detalhes de Maria Silva" })).toBeInTheDocument();
    expect(screen.getByText("Online agora")).toBeInTheDocument();
    expect(screen.queryByText(/Último acesso/)).not.toBeInTheDocument();
  });

  it("mostra data e hora do último acesso quando o membro está offline", () => {
    render(<TeamMemberPresenceDialog member={member} online={false} isCurrentUser={false} token="token" onClose={vi.fn()} onMessage={vi.fn()} onCall={vi.fn()} />);

    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText(/Último acesso em 30\/08\/2026 às 14:35/)).toBeInTheDocument();
  });

  it("distingue hoje, ontem e acesso não registrado", () => {
    const now = new Date("2026-09-01T18:00:00");
    expect(formatMemberLastAccess("2026-09-01T09:10:00", now)).toContain("hoje às 09:10");
    expect(formatMemberLastAccess("2026-08-31T22:45:00", now)).toContain("ontem às 22:45");
    expect(formatMemberLastAccess(null, now)).toBe("Último acesso não registrado");
  });
});
