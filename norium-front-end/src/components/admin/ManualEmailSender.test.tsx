import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ManualEmailSender from "./ManualEmailSender";
import { apiRequest } from "../../core/api/client";
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));

describe("Manual email sender", () => {
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
});
