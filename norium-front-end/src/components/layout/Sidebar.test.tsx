import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

const iconTabs = [
  "Dashboard",
  "Controle",
  "Central",
  "E-mails",
  "Agenda",
  "Chat",
  "Tarefas",
  "Financeiro",
  "Automações",
  "Relatórios",
  "Documentos",
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
  it("uses the Norium image icon set across every module while preserving navigation", () => {
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

    for (const tab of iconTabs) {
      const button = screen.getByRole("button", { name: tab });
      expect(button.querySelector("img.norium-sidebar-channel-icon.norium-suite-icon")).not.toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: "Conhecimento" }));
    expect(onNavigate).toHaveBeenCalledWith("Conhecimento");
  });
});
