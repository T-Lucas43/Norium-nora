import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PrivacyStorageCard from "./PrivacyStorageCard";
import { apiRequest } from "../../core/api/client";
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
const api = vi.mocked(apiRequest);
describe("PrivacyStorageCard", () => {
  beforeEach(() => { api.mockReset(); });
  it("mostra quota e alerta do workspace autenticado", async () => {
    api.mockResolvedValue({ usedBytes: 90 * 1024 * 1024, quotaBytes: 100 * 1024 * 1024, percent: 90, warning: true });
    render(<PrivacyStorageCard />);
    await waitFor(() => expect(screen.getByText(/90 MB de 100 MB/)).toBeTruthy());
    expect(api).toHaveBeenCalledWith("/api/auth/privacy/storage");
    expect(screen.getByText(/próximo do limite/)).toBeTruthy();
  });
  it("informa falha sem inventar consumo", async () => {
    api.mockImplementation(async () => { throw new Error("Consulta indisponível"); });
    await act(async () => { render(<PrivacyStorageCard />); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Consulta indisponível");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
