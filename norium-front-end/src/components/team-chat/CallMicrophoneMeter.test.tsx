import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CallMicrophoneMeter from "./CallMicrophoneMeter";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("teste voluntário de microfone", () => {
  it("não captura sem clique e libera a faixa ao parar ou mudar para somente escuta", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    const close = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn();
    class FakeContext {
      state = "running";
      resume = vi.fn().mockResolvedValue(undefined);
      close = close;
      createMediaStreamSource() { return { connect: vi.fn(), disconnect }; }
      createAnalyser() { return { fftSize: 256, getByteTimeDomainData: (values: Uint8Array) => values.fill(128) }; }
    }
    vi.stubGlobal("AudioContext", FakeContext);
    const view = render(<CallMicrophoneMeter deviceId="mic-2" listenOnly={false} />);
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Testar microfone" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: "mic-2" } }, video: false }));
    view.rerender(<CallMicrophoneMeter deviceId="mic-2" listenOnly />);
    expect(stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Testar microfone" })).toBeDisabled();
    view.rerender(<CallMicrophoneMeter deviceId="mic-2" listenOnly={false} />);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
  it("libera uma captura tardia mesmo após fechar a pré-entrada", async () => {
    let resolve: (value: unknown) => void = () => {};
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    const view = render(<CallMicrophoneMeter deviceId="" listenOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Testar microfone" }));
    view.unmount();
    resolve({ getTracks: () => [{ stop }] });
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });
});
