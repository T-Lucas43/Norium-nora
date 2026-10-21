import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MessageTranslation from "./MessageTranslation";
import { apiRequest } from "../../core/api/client";
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
const scope = vi.hoisted(() => ({ value: "workspace-a" }));
vi.mock("../../core/api/sessionScope", () => ({ requestScope: () => scope.value }));
const request = vi.mocked(apiRequest);
describe("tradução sob demanda", () => {
  afterEach(() => { vi.resetAllMocks(); scope.value = "workspace-a"; });
  it("só consulta ao clicar e mostra tradução abaixo sem enviar", async () => {
    request.mockResolvedValue({ translation: "Hello", language: "en" });
    render(<MessageTranslation conversationId="owned" messageId="selected" language="en" />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Traduzir para Inglês" }));
    expect(await screen.findByText(/Hello/)).toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe("/api/chat/conversas/owned/mensagens/selected/traducao");
  });
  it("descarta tradução atrasada de outro workspace", async () => {
    let resolve!: (value: unknown) => void;
    request.mockImplementation(() => new Promise(done => { resolve = done; }));
    render(<MessageTranslation conversationId="owned" messageId="selected" language="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Traduzir para Inglês" }));
    scope.value = "workspace-b";
    await act(async () => resolve({ translation: "Private translation", language: "en" }));
    expect(screen.queryByText(/Private translation/)).not.toBeInTheDocument();
  });
});
