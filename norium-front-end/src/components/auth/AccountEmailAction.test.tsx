import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountEmailAction from "./AccountEmailAction";
import { apiRequest } from "../../core/api/client";
import EmailPreferences from "../profile/EmailPreferences";
import SystemEmailSettings from "../admin/SystemEmailSettings";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
const request = vi.mocked(apiRequest);
beforeEach(() => request.mockReset());

describe("Account email actions", () => {
  it("confirms email only after the user clicks, sending the token in the body", async () => {
    request.mockResolvedValue({ message: "E-mail confirmado." });
    render(<AccountEmailAction mode="verify" token="token-example" onBack={vi.fn()} />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar meu e-mail" }));
    expect(await screen.findByRole("status")).toHaveTextContent("E-mail confirmado.");
    expect(request).toHaveBeenCalledWith("/api/auth/verify-email", expect.objectContaining({ method: "POST", token: null, body: JSON.stringify({ token: "token-example" }) }));
  });
  it("rejects mismatched passwords and clears the session after a successful reset", async () => {
    request.mockResolvedValue({ message: "Senha redefinida." });
    const reset = vi.fn();
    render(<AccountEmailAction mode="reset" token="reset-token" onBack={vi.fn()} onReset={reset} />);
    fireEvent.change(screen.getByLabelText("Nova senha"), { target: { value: "new-long-password" } });
    fireEvent.change(screen.getByLabelText("Repita a nova senha"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Redefinir senha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("As senhas precisam ser iguais");
    expect(request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Repita a nova senha"), { target: { value: "new-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Redefinir senha" }));
    await waitFor(() => expect(reset).toHaveBeenCalledOnce());
  });
  it("saves individual preferences without WhatsApp or Gmail categories", async () => {
    const prefs = { email: "alice@example.invalid", enabled: true, verified: true, sources: { kanban: true, calendar: true }, events: { task_due: true, chat_mention: true }, deliveryConfigured: true };
    request.mockResolvedValue(prefs);
    render(<EmailPreferences />);
    fireEvent.click(await screen.findByLabelText("Tarefas prestes a vencer"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar notificações" }));
    await screen.findByRole("status");
    expect(request).toHaveBeenLastCalledWith("/api/auth/email-preferences", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: true, sources: { kanban: true, calendar: true }, events: { task_due: false, chat_mention: true } }) }));
    expect(screen.queryByRole("checkbox", { name: /whatsapp|gmail/i })).not.toBeInTheDocument();
  });
  it("does not send the welcome campaign automatically when opening settings", async () => {
    request.mockResolvedValue({ sender: "suporte@norium-ai.com", ready: true, enabled: true, passwordConfigured: true, publicUrl: "https://norium.example.invalid", delivery: { counts: {}, recent: [], welcome: { title: "Boas-vindas", description: "Aqui quem fala é a Nora." } } });
    render(<SystemEmailSettings token="admin-test" />);
    const send = await screen.findByRole("button", { name: "Enviar boas-vindas aos cadastrados" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Senha da caixa de suporte")).toHaveValue("");
    request.mockResolvedValueOnce({ queued: 2, alreadyQueued: 0, skipped: 0 });
    fireEvent.click(send);
    expect(await screen.findByRole("status")).toHaveTextContent("2 e-mail(s) na fila");
    expect(request).toHaveBeenCalledWith("/api/auth/admin/system-email/welcome", { token: "admin-test", method: "POST" });
  });
});
