import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TeamVoiceRecorder from "./TeamVoiceRecorder";

class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  state: RecordingState = "inactive";
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || "audio/webm";
  }

  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
}

describe("TeamVoiceRecorder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records through the browser microphone and returns an audio file for sending", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onSend = vi.fn();

    render(<TeamVoiceRecorder onSend={onSend} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Gravar áudio" }));
    await screen.findByRole("status", { name: "Gravação de áudio em andamento" });
    fireEvent.click(screen.getByRole("button", { name: "Enviar áudio" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const file = onSend.mock.calls[0][0] as File;
    expect(file.type).toContain("audio/webm");
    expect(file.name).toMatch(/^audio-norium-\d+\.webm$/);
    expect(stop).toHaveBeenCalled();
  });
});
