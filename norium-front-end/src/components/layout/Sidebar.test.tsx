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

    const dashboard = screen.getByRole("button", { name: "Painel" });

    const nora = screen.getByRole("button", { name: "Nora" });
    const start = screen.getByRole("button", { name: "Início" });
    expect(dashboard.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nora.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const groupNames = ["Início", "Comunicação", "Trabalho", "Equipe"];
    for (const groupName of groupNames) {
      const group = screen.getByRole("button", { name: groupName });
      expect(group.querySelector(".norium-sidebar-group-icon svg")).not.toBeNull();
      expect(group).toHaveAttribute("aria-expanded", "false");
    }

    fireEvent.click(screen.getByRole("button", { name: "Comunicação" }));
    expect(screen.getByRole("button", { name: "Comunicação" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Nora" })).toBe(nora);
    fireEvent.click(screen.getByRole("button", { name: "Modelos de mensagens" }));
    expect(onNavigate).toHaveBeenCalledWith("Modelos de mensagens");

    fireEvent.click(screen.getByRole("button", { name: "Comunicação" }));
    expect(screen.queryByRole("button", { name: "Modelos de mensagens" })).toBeNull();
  });

  it("opens Inteligência as a single entry with its screens as internal tabs", () => {
    const onNavigate = vi.fn();
    const { rerender } = render(
      <Sidebar activeTab="Dashboard" collapsed={false} mobileOpen={false} profile={null}
        onCloseMobile={vi.fn()} onNavigate={onNavigate} onToggleCollapsed={vi.fn()} />,
    );
    const intelligence = screen.getByRole("button", { name: "Inteligência" });
    expect(intelligence).not.toHaveAttribute("aria-expanded");
    expect(screen.queryByRole("button", { name: "Conhecimento" })).toBeNull();
    fireEvent.click(intelligence);
    expect(onNavigate).toHaveBeenCalledWith("Conhecimento");

    rerender(
      <Sidebar activeTab="Marketplace" collapsed={false} mobileOpen={false} profile={null}
        allowedTabs={["Dashboard", "Marketplace", "IA e Modelos"]}
        onCloseMobile={vi.fn()} onNavigate={onNavigate} onToggleCollapsed={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Inteligência" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps Perfil inside Configurações and shows unread counts", () => {
    render(
      <Sidebar activeTab="Perfil" collapsed={false} mobileOpen={false} profile={null}
        counts={{ "Chat da Equipe": 3 }}
        onCloseMobile={vi.fn()} onNavigate={vi.fn()} onToggleCollapsed={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Configurações" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Comunicação" }));
    expect(screen.getByRole("button", { name: /Chat da equipe/ })).toHaveTextContent("3");
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

    expect(screen.getByRole("button", { name: "Painel" })).toBeInTheDocument();
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
