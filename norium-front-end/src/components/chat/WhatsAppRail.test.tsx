import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import WhatsAppRail from "./WhatsAppRail";

describe("navegacao do WhatsApp", () => {
  it("abre status, grupos e o perfil pelo rail", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WhatsAppRail section="conversations" unreadCount={4} statusUnreadCount={2} online profile={{ name: "Tarcisio Lucas" }} onSelect={onSelect} />);

    const statusButton = screen.getByRole("button", { name: "Status, 2 nao visualizados" });
    expect(statusButton).toHaveTextContent("2");
    await user.click(statusButton);
    await user.click(screen.getByRole("button", { name: "Grupos" }));
    await user.click(screen.getByRole("button", { name: "Abrir meu perfil do WhatsApp" }));

    expect(onSelect).toHaveBeenNthCalledWith(1, "status");
    expect(onSelect).toHaveBeenNthCalledWith(2, "groups");
    expect(onSelect).toHaveBeenNthCalledWith(3, "profile");
  });
});
