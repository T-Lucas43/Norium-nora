import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SessionDevices from "./SessionDevices";

const api = vi.hoisted(() => vi.fn());
const closed = vi.hoisted(() => vi.fn());
vi.mock("../../core/api/client", () => ({ apiRequest: api }));
vi.mock("../../core/api/cookieSession", () => ({ notifySessionClosed: closed }));
const device = { id: "session-one", label: "<img src=x onerror=synthetic>", browser: "Chrome",
  system: "Windows", kind: "Computador", createdAt: 1, lastUsedAt: 2,
  expiresAt: 100, current: true, persistent: true };

beforeEach(() => {
  api.mockReset().mockResolvedValue({ sessions: [device] });
  closed.mockReset(); vi.restoreAllMocks(); vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("session devices", () => {
  it("shows the current browser and treats a custom label as plain input text", async () => {
    const { container } = render(<SessionDevices />);
    await screen.findByText("Este navegador");
    expect(screen.getByLabelText("Nome da sessão Chrome")).toHaveValue(device.label);
    expect(container.querySelector("img")).toBeNull();
  });

  it("requires a password and human confirmation before bulk revocation", async () => {
    render(<SessionDevices />); await screen.findByText("Este navegador");
    fireEvent.click(screen.getByText("Encerrar outras sessões"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Informe sua senha atual");
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Senha atual para encerrar sessões"), { target: { value: "synthetic-password" } });
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByText("Encerrar outras sessões"));
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("reauthenticates before revoking all and clears the password afterward", async () => {
    render(<SessionDevices />); await screen.findByText("Este navegador");
    fireEvent.change(screen.getByLabelText("Senha atual para encerrar sessões"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByText("Sair de todos os dispositivos"));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(api.mock.calls[1][0]).toBe("/api/auth/reauthenticate");
    expect(api.mock.calls[2][0]).toBe("/api/auth/sessions/revoke-all");
    expect(screen.getByLabelText("Senha atual para encerrar sessões")).toHaveValue("");
  });

  it("keeps the current session when server revocation fails", async () => {
    render(<SessionDevices />); await screen.findByText("Este navegador");
    api.mockRejectedValueOnce(new Error("Servidor indisponível"));
    fireEvent.click(screen.getByText("Encerrar sessão"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Servidor indisponível");
    expect(closed).not.toHaveBeenCalled();
  });
});
