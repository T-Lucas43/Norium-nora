import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ManualEmailSender from "./ManualEmailSender";
import { apiRequest } from "../../core/api/client";
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));

describe("Manual email sender", () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it("previews before sending, selects registered users and preserves dispatch ID on retry", async () => {
    const request = vi.mocked(apiRequest);
    request.mockResolvedValueOnce({ users: [{ id: "alice", name: "Alice", email: "alice@example.invalid", enabled: true }, { id: "bob", name: "Bob", email: "bob@example.invalid", enabled: false }] });
    render(<ManualEmailSender token="admin-test" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Alice/ }));
    expect(screen.getByRole("checkbox", { name: /Bob/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Assunto"), { target: { value: "Novidades" } });
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "Novo recurso disponível." } });
    fireEvent.click(screen.getByRole("button", { name: "Pré-visualizar e-mail" }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Olá, Alice.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Assinatura da Nora" })).toHaveTextContent("Assistente virtual");
    expect(screen.getByRole("group", { name: "Assinatura da Nora" })).toHaveTextContent("NORIUM");
    expect(screen.getByRole("img", { name: "Nora" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Norium" })).toBeInTheDocument();
    request.mockRejectedValueOnce(new Error("Falha temporária"));
    fireEvent.click(screen.getByRole("button", { name: "Enviar aos selecionados" }));
    await screen.findByRole("alert");
    const first = request.mock.calls[1][1];
    request.mockResolvedValueOnce({ queued: 0, alreadyQueued: 1, skipped: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Enviar aos selecionados" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 já incluído"));
    expect(request.mock.calls[2][1]).toEqual(first);
    expect(JSON.parse(first?.body as string).recipientIds).toEqual(["alice"]);
  });

  it("uses AI context to fill an editable draft without sending it", async () => {
    const request = vi.mocked(apiRequest);
    request.mockResolvedValueOnce({ users: [{ id: "alice", name: "Alice", email: "alice@example.invalid", enabled: true }] });
    render(<ManualEmailSender token="admin-test" />);
    await screen.findByRole("checkbox", { name: /Alice/ });
    request.mockResolvedValueOnce({ subject: "Nova área financeira", message: "A nova área financeira estará disponível na segunda-feira.", provider: "Google Gemini" });
    fireEvent.change(screen.getByLabelText("Contexto para a IA"), { target: { value: "Avise sobre a nova área financeira na segunda-feira." } });
    fireEvent.change(screen.getByLabelText("Tom do e-mail"), { target: { value: "cordial" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar rascunho" }));
    expect(await screen.findByDisplayValue("Nova área financeira")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/estará disponível/)).toBeInTheDocument();
    expect(screen.getByText(/Rascunho gerado por Google Gemini/)).toBeInTheDocument();
    expect(request).toHaveBeenLastCalledWith("/api/auth/admin/system-email/draft", expect.objectContaining({ token: "admin-test", method: "POST", body: JSON.stringify({ context: "Avise sobre a nova área financeira na segunda-feira.", tone: "cordial" }) }));
    expect(screen.queryByRole("button", { name: "Enviar aos selecionados" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "Texto revisado pelo administrador." } });
    expect(screen.getByDisplayValue("Texto revisado pelo administrador.")).toBeInTheDocument();
  });
});
