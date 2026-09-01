import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TeamMeetingMessageCard from "./TeamMeetingMessageCard";

describe("TeamMeetingMessageCard", () => {
  it("permite ao convidado adicionar a reunião à própria agenda", async () => {
    const user = userEvent.setup();
    const onAddToCalendar = vi.fn().mockResolvedValue(undefined);
    render(<TeamMeetingMessageCard metadata={{ meetingId: "meeting-1", title: "Revisão", startsAt: "2026-09-02T15:00:00Z", participantIds: ["user-1"], agendaAddedBy: [] }} currentUserId="user-1" onAddToCalendar={onAddToCalendar} onStart={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Adicionar à minha agenda" }));
    expect(onAddToCalendar).toHaveBeenCalledWith("meeting-1");
    expect(await screen.findByRole("button", { name: "Adicionada à agenda" })).toBeInTheDocument();
  });

  it("não oferece adicionar quando a pessoa não foi convidada", () => {
    render(<TeamMeetingMessageCard metadata={{ meetingId: "meeting-2", title: "Privada", participantIds: ["other"], agendaAddedBy: [] }} currentUserId="user-1" onAddToCalendar={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Adicionar à minha agenda" })).toBeDisabled();
  });
});
