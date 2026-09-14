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
  it("keeps images only for communication and agenda while other modules use compact vectors", () => {
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

    for (const tab of ["E-mails", "Agenda", "Chat"]) {
      const button = screen.getByRole("button", { name: tab });
      expect(button.querySelector("img.norium-sidebar-channel-icon.norium-suite-icon")).not.toBeNull();
    }

    for (const tab of vectorTabs) {
      const button = screen.getByRole("button", { name: tab });
      expect(button.querySelector("img.norium-sidebar-channel-icon")).toBeNull();
      expect(button.querySelector(".norium-sidebar-item-icon svg")).not.toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: "Conhecimento" }));
    expect(onNavigate).toHaveBeenCalledWith("Conhecimento");
  });
});
