import { describe, expect, it } from "vitest";
import { canParticipateInTeamChat, defaultMemberPermissions, type NoriumUser } from "../../types/auth";
import { canAccessModule } from "./tabs";

const member: NoriumUser = {
  id: "synthetic-member", nome: "Member", email: "member@example.test", role: "member",
  status: "ativo", plan: "individual", teamOwnerId: "synthetic-owner", systemAdmin: false,
  teamChatEnabled: true, permissions: { ...defaultMemberPermissions, chat: true },
};

describe("team participation capability", () => {
  it("opens the team chat for a member without exposing management", () => {
    expect(canAccessModule(member, "Chat da Equipe")).toBe(true);
    expect(canParticipateInTeamChat(member)).toBe(true);
    expect(canAccessModule(member, "Equipe")).toBe(false);
    expect(member.permissions.admin).toBe(false);
  });

  it("requires the current server capability and active account", () => {
    for (const user of [null, { ...member, teamChatEnabled: false },
      { ...member, teamChatEnabled: undefined }, { ...member, status: "inativo" as const }]) {
      expect(canAccessModule(user, "Chat da Equipe")).toBe(false);
      expect(canParticipateInTeamChat(user)).toBe(false);
    }
    expect(canAccessModule({ ...member, teamChatEnabled: false }, "Chat")).toBe(true);
  });
});
