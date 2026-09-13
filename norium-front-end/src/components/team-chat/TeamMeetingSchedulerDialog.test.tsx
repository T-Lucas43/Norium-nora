import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NoriumUser } from "../../types/auth";
import TeamMeetingSchedulerDialog from "./TeamMeetingSchedulerDialog";

const member = (id: string, nome: string): NoriumUser => ({
  id, nome, email: `${id}@example.test`, role: id === "owner" ? "owner" : "member", plan: "equipe", status: "ativo", systemAdmin: false, permissions: {} as NoriumUser["permissions"],
});

describe("TeamMeetingSchedulerDialog", () => {
  it("envia título, horário, duração e convidados selecionados", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<TeamMeetingSchedulerDialog scopeLabel="Time todo" members={[member("owner", "Owner"), member("member", "Maria")]} currentUserId="owner" saving={false} onClose={vi.fn()} onSave={onSave} />);

    await user.type(screen.getByLabelText("Título"), "Planejamento semanal");
    fireEvent.change(screen.getByLabelText("Data e hora local"), { target: { value: "2099-09-01T10:00" } });
    await user.selectOptions(screen.getByLabelText("Duração"), "60");
    await user.click(screen.getByRole("button", { name: "Agendar reunião" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: "Planejamento semanal", participantIds: ["owner", "member"] }));
    expect(onSave.mock.calls[0][0].endsAt).toBeTruthy();
  });
});
