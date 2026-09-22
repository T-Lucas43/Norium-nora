import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

const vectorTabs = [
  "Dashboard",
  "Controle",
  "Central",
  "Tarefas",
  "Financeiro",
  "Automações",
  "Relatórios",
  "Documentos",
  "PDF Studio",
  "Agente Navegador",
  "Conhecimento",
  "Marketplace",
  "IA e Modelos",
  "Equipe",
  "Chat da Equipe",
  "Clientes",
  "Governanca",
  "Estúdio",
  "Mais",
  "Configurações",
  "Ajuda",
];

describe("Sidebar", () => {
  it("uses compact transparent blue vectors for every module in the navigation", () => {
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

    for (const tab of [...vectorTabs, "E-mails", "Agenda", "Chat"]) {
      const button = screen.getByRole("button", { name: tab });
      expect(button.querySelector("img.norium-sidebar-channel-icon")).toBeNull();
      const icon = button.querySelector(".norium-sidebar-item-icon svg");
      expect(icon).not.toBeNull();
      expect(icon).toHaveClass("norium-sidebar-channel-icon");
    }

    fireEvent.click(screen.getByRole("button", { name: "Conhecimento" }));
    expect(onNavigate).toHaveBeenCalledWith("Conhecimento");
  });
});
