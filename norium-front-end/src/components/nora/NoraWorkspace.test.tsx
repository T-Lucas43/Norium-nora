import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import NoraWorkspace from "./NoraWorkspace";

vi.mock("../../core/api/client", async (load) => ({
  ...await load<typeof import("../../core/api/client")>(),
  apiRequest: vi.fn(),
}));

class FakeSpeechRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: null | (() => void) = null;
  onend: null | (() => void) = null;
  onerror = null;
  onresult = null;
  start() { this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
}

describe("NoraWorkspace", () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockImplementation(async (path) => {
      if (path === "/api/nora/conversations") return [];
      if (path === "/api/modelos-ia") return { providers: [] };
      return {};
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeSpeechRecognition });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  it("uses the current Nora identity and renders the redesigned workspace", async () => {
    render(<NoraWorkspace userId="user-1" profile={{ nome: "Tarcisio" } as never} eventsBySource={{}} onOpenEmail={vi.fn()} />);

    expect(await screen.findByText("Nora · Assistente inteligente")).toBeInTheDocument();
    expect(screen.getByText("O que vamos resolver hoje?")).toBeInTheDocument();
    expect(screen.getByText("Converse, crie e acione qualquer área do Norium.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Modelo e preferências da conversa" })).toBeInTheDocument();
    expect(document.querySelector(".nora-empty-portrait")).not.toBeInTheDocument();
    for (const image of screen.getAllByRole("img", { name: "Nora" })) {
      expect(image).toHaveAttribute("src", expect.stringContaining("nora-brand.png"));
      expect(image).not.toHaveAttribute("src", expect.stringContaining("nora-avatar.jpeg"));
    }
  });

  it("shows only the microphone while idle and animated sound waves while recording", async () => {
    const user = userEvent.setup();
    const { container } = render(<NoraWorkspace userId="user-1" profile={{ nome: "Tarcisio" } as never} eventsBySource={{}} onOpenEmail={vi.fn()} />);
    const voiceButton = await screen.findByRole("button", { name: "Gravar mensagem de voz" });

    expect(voiceButton.querySelector("svg")).toHaveClass("lucide-mic");
    expect(screen.queryByText("Ativar microfone")).not.toBeInTheDocument();
    expect(container.querySelector(".lucide-lock")).not.toBeInTheDocument();

    await user.click(voiceButton);

    const recordingButton = await screen.findByRole("button", { name: "Parar gravação de voz" });
    await waitFor(() => expect(recordingButton).toHaveAttribute("data-recording", "true"));
    expect(recordingButton.querySelector(".nora-voice-waveform")).toBeInTheDocument();
    expect(recordingButton.querySelector("svg")).not.toBeInTheDocument();
  });
});
