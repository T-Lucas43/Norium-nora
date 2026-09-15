import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import Header from "./Header";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));

const request = vi.mocked(apiRequest);

function renderHeader(onOpenNora = vi.fn()) {
  render(
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

describe("Header Nora quick chat", () => {
  beforeEach(() => request.mockReset());

  it("opens below the Nora button and sends a real contextual request", async () => {
    request.mockResolvedValue({ response: "Seu dia tem duas prioridades e uma reunião." });
    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Conversar com a Nora" }));
    expect(screen.getByRole("dialog", { name: "Atalho da Nora" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Perguntar à Nora" }), {
      target: { value: "Resuma meu dia" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar pergunta" }));

    await waitFor(() => expect(screen.getByText("Seu dia tem duas prioridades e uma reunião.")).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith(
      "/api/nora/natural",
      expect.objectContaining({ method: "POST" }),
    );
    const options = request.mock.calls[0]?.[1];
    expect(JSON.parse(String(options?.body))).toEqual(expect.objectContaining({
      user_id: "user-7",
      message: "Resuma meu dia",
      screen_context: expect.stringContaining("Dashboard"),
    }));
  });

  it("keeps the full Nora workspace one click away", () => {
    const onOpenNora = vi.fn();
    renderHeader(onOpenNora);
    fireEvent.click(screen.getByRole("button", { name: "Conversar com a Nora" }));
    fireEvent.click(screen.getByRole("button", { name: /Abrir conversa completa/ }));
    expect(onOpenNora).toHaveBeenCalledTimes(1);
  });

  it("runs a suggested consultation immediately and renders clean text", async () => {
    request.mockResolvedValue({ response: "**Prioridades**\n- Revisar proposta\n- Preparar reunião" });
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Conversar com a Nora" }));
    fireEvent.click(screen.getByRole("button", { name: "Resuma meu dia" }));

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).message).toBe("Resuma meu dia");
    expect(await screen.findByText(/Prioridades/)).toHaveTextContent("Prioridades");
    expect(screen.queryByText(/\*\*Prioridades\*\*/)).not.toBeInTheDocument();
  });

  it("shows detailed markdown and retries a temporarily failed request", async () => {
    request
      .mockRejectedValueOnce(new Error("A Nora falhou temporariamente."))
      .mockResolvedValueOnce({ response: "## Visão geral\n\n- **Tarefas ativas:** 3\n- **Compromissos:** 1" });
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Conversar com a Nora" }));
    fireEvent.click(screen.getByRole("button", { name: "Resuma meu dia" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A Nora falhou temporariamente.");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByRole("heading", { name: "Visão geral" })).toBeInTheDocument();
    expect(screen.getByText("Tarefas ativas:").closest("li")).toHaveTextContent("Tarefas ativas: 3");
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Resuma meu dia")).toHaveLength(1);
  });
});
