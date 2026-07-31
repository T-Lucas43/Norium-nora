import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MailSettingsDrawer, { type MailPreferences } from "./MailSettingsDrawer";
import type { GmailStatus } from "../../../features/mail/types";

const prefs: MailPreferences = { compactMode: false, groupByCategory: false, showPreview: true, autoRefresh: true };

function setup(over: { preferences?: Partial<MailPreferences>; status?: GmailStatus | null } = {}) {
  const handlers = {
    onPreferenceChange: vi.fn(), onRefreshNow: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn(), onClose: vi.fn(),
  };
  render(
    <MailSettingsDrawer
      preferences={{ ...prefs, ...over.preferences }}
      status={over.status === undefined ? ({ connected: true, email: "a@x.com" } as GmailStatus) : over.status}
      {...handlers}
    />,
  );
  return handlers;
}

describe("MailSettingsDrawer", () => {
  it("avisa a troca de densidade", () => {
    const { onPreferenceChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /compacta/i }));
    expect(onPreferenceChange).toHaveBeenCalledWith("compactMode", true);
  });

  it("alterna cada preferencia da caixa e da sincronizacao", () => {
    const { onPreferenceChange } = setup();
    fireEvent.click(screen.getByLabelText(/agrupar por categorias/i));
    fireEvent.click(screen.getByLabelText(/mostrar texto de previa/i));
    fireEvent.click(screen.getByLabelText(/atualizar automaticamente/i));

    expect(onPreferenceChange).toHaveBeenCalledWith("groupByCategory", true);
    expect(onPreferenceChange).toHaveBeenCalledWith("showPreview", false);
    expect(onPreferenceChange).toHaveBeenCalledWith("autoRefresh", false);
  });

  it("reflete o estado atual nos interruptores", () => {
    setup({ preferences: { showPreview: false, autoRefresh: true } });
    expect(screen.getByLabelText(/mostrar texto de previa/i)).not.toBeChecked();
    expect(screen.getByLabelText(/atualizar automaticamente/i)).toBeChecked();
  });

  it("mostra o e-mail da conta conectada", () => {
    setup();
    expect(screen.getByText("a@x.com")).toBeInTheDocument();
  });

  it("mostra 'Desconectada' e bloqueia acoes que exigem conexao", () => {
    setup({ status: { connected: false } as GmailStatus });
    expect(screen.getByText("Desconectada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /atualizar agora/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /desconectar/i })).toBeDisabled();
  });

  it("informa quando ainda nao houve sincronizacao", () => {
    setup();
    expect(screen.getByText(/aguardando autorizacao/i)).toBeInTheDocument();
  });

  it("mostra a data da ultima sincronizacao quando existe", () => {
    setup({ status: { connected: true, email: "a@x.com", lastSync: "2026-01-15T10:00:00Z" } as GmailStatus });
    expect(screen.getByText(/ultima sincronizacao:/i)).toBeInTheDocument();
  });

  it("fecha ao clicar fora, mas nao ao clicar dentro do painel", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByText("Ajustes rapidos").closest("aside")!);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
