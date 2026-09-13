import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TeamActiveCallCard from "./TeamActiveCallCard";

describe("prévia da reunião ativa", () => {
  it("mostra participantes e oferece ingresso sem criar outra reunião", () => {
    const onJoin = vi.fn();
    const { rerender } = render(<TeamActiveCallCard meeting={{ type: "CALL_INVITE", fromUserName: "Fernando", joinedUserIds: ["owner", "member"] }} busy={false} onJoin={onJoin} />);
    expect(screen.getByText("Organizada por Fernando")).toBeInTheDocument();
    expect(screen.getByText(/2 na chamada/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ingressar na reunião" }));
    expect(onJoin).toHaveBeenCalledOnce();
    rerender(<TeamActiveCallCard meeting={{ type: "CALL_INVITE" }} busy onJoin={onJoin} />);
    expect(screen.getByRole("button", { name: "Conectando..." })).toBeDisabled();
  });
});
