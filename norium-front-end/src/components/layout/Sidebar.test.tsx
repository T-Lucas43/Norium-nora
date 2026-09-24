import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

describe("Sidebar", () => {
  it("shows icon-led collapsible groups and navigates from an expanded group", () => {
    const onNavigate = vi.fn();

    render(
      <Sidebar
        activeTab="Dashboard"
        collapsed={false}
        mobileOpen={false}
        profile={null}
        onCloseMobile={vi.fn()}
        onNavigate={onNavigate}
        onToggleCollapsed={vi.fn()}
      />,
    );

    const groupNames = ["Início", "Comunicação", "Trabalho", "Inteligência", "Equipe"];
    for (const groupName of groupNames) {
      const group = screen.getByRole("button", { name: groupName });
      expect(group.querySelector(".norium-sidebar-group-icon svg")).not.toBeNull();
      expect(group).toHaveAttribute("aria-expanded", "false");
    }

    fireEvent.click(screen.getByRole("button", { name: "Inteligência" }));
    expect(screen.getByRole("button", { name: "Inteligência" })).toHaveAttribute("aria-expanded", "true");
    const knowledge = screen.getByRole("button", { name: "Conhecimento" });
    expect(knowledge.querySelector(".norium-sidebar-item-icon svg")).toHaveClass("norium-sidebar-channel-icon");
    fireEvent.click(screen.getByRole("button", { name: "Conhecimento" }));
    expect(onNavigate).toHaveBeenCalledWith("Conhecimento");

    fireEvent.click(screen.getByRole("button", { name: "Inteligência" }));
    expect(screen.queryByRole("button", { name: "Conhecimento" })).toBeNull();
  });

  it("keeps the classic navigation available by profile preference", () => {
    render(
      <Sidebar
        activeTab="Dashboard"
        collapsed={false}
        mobileOpen={false}
        profile={null}
        navigationStyle="classic"
        onCloseMobile={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nora" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Comunicação" })).toBeNull();
  });

  it("keeps a compact icon rail and expands a grouped category", () => {
    const onToggleCollapsed = vi.fn();
    render(
      <Sidebar
        activeTab="Dashboard"
        collapsed
        mobileOpen={false}
        profile={null}
        onCloseMobile={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Comunicação" }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });
});
