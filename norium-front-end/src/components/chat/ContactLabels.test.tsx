import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactLabels, ContactLabelsProvider } from "./ContactLabels";
import { apiRequest } from "../../core/api/client";
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
const scope = vi.hoisted(() => ({ value: "account-a" }));
vi.mock("../../core/api/sessionScope", () => ({ requestScope: () => scope.value }));
const request = vi.mocked(apiRequest);
describe("etiquetas visíveis", () => {
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); scope.value = "account-a"; });
  it("agrupa contatos visíveis em uma chamada mesmo em StrictMode", async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ items: [{ id: "a", tags: [{ id: "vip", name: "VIP", color: "#7c3aed" }] }, { id: "b", tags: [] }] });
    render(<StrictMode><ContactLabelsProvider><ContactLabels contactId="a" /><ContactLabels contactId="a" /><ContactLabels contactId="b" /></ContactLabelsProvider></StrictMode>);
    await act(async () => { vi.advanceTimersByTime(35); });
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).contactIds).toEqual(["a", "b"]);
    expect(screen.getAllByText("VIP")).toHaveLength(2);
  });
  it("descarta resposta atrasada após trocar workspace", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    request.mockImplementation(() => new Promise(done => { resolve = done; }));
    render(<ContactLabelsProvider><ContactLabels contactId="a" /></ContactLabelsProvider>);
    await act(async () => { vi.advanceTimersByTime(35); });
    scope.value = "account-b";
    await act(async () => resolve({ items: [{ id: "a", tags: [{ id: "private", name: "Private tag", color: "#123456" }] }] }));
    expect(screen.queryByText("Private tag")).not.toBeInTheDocument();
  });
});
