import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PresentationAnnotations from "./PresentationAnnotations";

describe("destaques temporários na apresentação", () => {
  it("mostra só destaques válidos da apresentação e respeita o bloqueio", () => {
    const updateStage = vi.fn();
    const props = { userId: "owner", selfId: "member", updateStage, marks: [
      { id: "live", targetUserId: "owner", fromUserName: "Ana", x: .2, y: .3, expiresAt: Date.now() + 10000 },
      { id: "expired", targetUserId: "owner", fromUserName: "Bruno", x: .2, y: .3, expiresAt: Date.now() - 1 },
      { id: "other", targetUserId: "other", fromUserName: "Carla", x: .2, y: .3, expiresAt: Date.now() + 10000 },
    ] };
    const view = render(<div><PresentationAnnotations {...props} /></div>);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Destaque de Ana" })).toHaveStyle({ left: "20%", top: "30%" });
    fireEvent.click(screen.getByRole("button", { name: "Anotar" }));
    expect(screen.getByRole("button", { name: "Adicionar destaque na apresentação" })).toBeInTheDocument();
    view.rerender(<div><PresentationAnnotations {...props} locked /></div>);
    expect(screen.getByRole("button", { name: "Anotações bloqueadas" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Adicionar destaque na apresentação" })).toBeNull();
    expect(updateStage).not.toHaveBeenCalled();
  });
  it("somente quem apresenta tem o controle de bloquear as anotações", () => {
    const updateStage = vi.fn();
    render(<div><PresentationAnnotations userId="owner" selfId="owner" updateStage={updateStage} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "Bloquear anotações" }));
    expect(updateStage).toHaveBeenCalledWith({ type: "lock", locked: true });
  });
});
