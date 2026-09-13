import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.restoreAllMocks());

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

    expect(screen.getByRole("navigation", { name: "Navegação da Nora" })).toBeInTheDocument();
    expect(document.querySelector(".nora-history")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByLabelText("Perfil de Tarcisio")).toHaveTextContent("T");
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

  it("keeps history rows compact and opens a selected conversation at its latest message", async () => {
    const summary = {
      id: "conversation-123",
      title: "Planejamento de campanha",
      preview: "Última resposta da Nora",
      messageCount: 2,
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:05:00.000Z",
      revision: 1,
      inLibrary: false,
    };
    vi.mocked(apiRequest).mockImplementation(async (path) => {
      if (path === "/api/nora/conversations") return [summary];
      if (path === "/api/nora/conversations/conversation-123") return {
        ...summary,
        state: {
          messages: [
            { role: "user", text: "Monte a campanha" },
            { role: "ai", text: "Última resposta da Nora" },
          ],
        },
      };
      if (path === "/api/modelos-ia") return { providers: [] };
      return {};
    });
    const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo");
    const user = userEvent.setup();
    render(<NoraWorkspace userId="user-1" profile={{ nome: "Tarcisio" } as never} eventsBySource={{}} onOpenEmail={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Abrir histórico de conversas" }));
    const conversation = await screen.findByRole("button", { name: "Planejamento de campanha", expanded: false });
    expect(conversation).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Última resposta da Nora")).not.toBeInTheDocument();
    scrollTo.mockClear();

    await user.click(conversation);

    await waitFor(() => expect(conversation).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getAllByText("Última resposta da Nora")).toHaveLength(2);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    const copyActions = screen.getAllByRole("button", { name: "Copiar mensagem" });
    expect(copyActions).toHaveLength(2);
    expect(copyActions.every((button) => button.classList.contains("nora-message-action"))).toBe(true);
    expect(copyActions.every((button) => button.textContent === "")).toBe(true);
    expect(screen.getByRole("button", { name: "Gerar resposta novamente" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compartilhar resposta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mais opções da resposta" })).toBeInTheDocument();

    const positiveFeedback = screen.getByRole("button", { name: "Avaliar como boa resposta" });
    await user.click(positiveFeedback);
    expect(positiveFeedback).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      const savedFeedback = vi.mocked(apiRequest).mock.calls.some(([path, options]) => {
        if (path !== "/api/nora/conversations/conversation-123" || options?.method !== "PUT") return false;
        return JSON.parse(String(options.body)).state.messages[1]?.feedback === "positive";
      });
      expect(savedFeedback).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "Mais opções da resposta" }));
    expect(screen.getByRole("menuitem", { name: "Resposta precisa melhorar" })).toBeInTheDocument();
  });

  it("regenerates an answer from the original user message instead of duplicating the thread", async () => {
    const summary = {
      id: "conversation-regenerate",
      title: "Resposta para revisar",
      preview: "Resposta antiga",
      messageCount: 2,
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:05:00.000Z",
      revision: 1,
      inLibrary: false,
    };
    vi.mocked(apiRequest).mockImplementation(async (path) => {
      if (path === "/api/nora/conversations") return [summary];
      if (path === "/api/nora/conversations/conversation-regenerate") return {
        ...summary,
        state: { messages: [{ role: "user", text: "Explique o resultado" }, { role: "ai", text: "Resposta antiga" }] },
      };
      if (path === "/api/modelos-ia") return { providers: [] };
      return {};
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/nora/natural/stream")) throw new Error("stream indisponível no teste");
      if (url.includes("/api/nora/natural")) return {
        ok: true,
        json: async () => ({ intent: "chat", session_kind: null, session_id: null, status: "chat", response: "Resposta regenerada e melhor." }),
      } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    });
    const user = userEvent.setup();
    const { container } = render(<NoraWorkspace userId="user-1" profile={{ nome: "Tarcisio" } as never} eventsBySource={{}} onOpenEmail={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Abrir histórico de conversas" }));
    await user.click(await screen.findByRole("button", { name: "Resposta para revisar", expanded: false }));
    await user.click(await screen.findByRole("button", { name: "Gerar resposta novamente" }));

    expect(await screen.findByText("Resposta regenerada e melhor.")).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll(".nora-assistant-content")).some((element) => element.textContent?.includes("Resposta antiga"))).toBe(false);
    expect(screen.getAllByText("Explique o resultado")).toHaveLength(1);
  });
});
