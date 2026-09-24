import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Header from "./Header";

function renderHeader(onOpenNora = vi.fn()) {
  return render(
    <Header
      activeTab="Dashboard"
      setActiveTab={vi.fn()}
      onOpenNora={onOpenNora}
      onOpenNotifications={vi.fn()}
      onOpenProfile={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenLegal={vi.fn()}
      onLogout={vi.fn()}
      onToggleSidebar={vi.fn()}
      unreadNotifications={0}
      profile={null}
      currentUser={{ id: "user-7", nome: "Tarcisio", email: "user@example.com" } as never}
      canUseNora
    />,
  );
}

describe("Header Nora", () => {
  it("usa a marca do Norium no lugar do botao hamburguer", () => {
    const { container } = renderHeader();
    expect(container.querySelector('[data-lucide="menu"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Abrir navegação pelo logo do Norium" })).toBeInTheDocument();
  });

  it("usa o mesmo assistente principal em vez de manter um segundo chat", () => {
    const onOpenNora = vi.fn();
    renderHeader(onOpenNora);
    fireEvent.click(screen.getByRole("button", { name: "Conversar com a Nora" }));
    expect(onOpenNora).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Atalho da Nora" })).not.toBeInTheDocument();
  });
});
