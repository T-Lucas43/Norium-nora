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
      if (path === "/api/nora/brain/health") return { status: "ready" };
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
    const portrait = document.querySelector(".nora-empty-portrait");
    expect(portrait).toHaveAttribute("alt", "Nora");
    expect(portrait?.nextElementSibling).toHaveTextContent("Olá, Tarcisio. O que vamos resolver hoje?");
    const composer = document.querySelector(".nora-page-empty > .nora-composer");
    expect(composer).toBeInTheDocument();
    expect(composer?.nextElementSibling).toHaveClass("nora-quick-suggestions");
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

  it("sends the stable conversation id on natural requests, switching and creating conversations", async () => {
    const summaryA = {
      id: "conversation-alpha",
      title: "Primeira conversa",
      preview: "Resposta A",
      messageCount: 2,
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:05:00.000Z",
      revision: 1,
      inLibrary: false,
    };
    const summaryB = {
      id: "conversation-beta",
      title: "Segunda conversa",
      preview: "Resposta B",
      messageCount: 2,
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:05:00.000Z",
      revision: 1,
      inLibrary: false,
    };
    const states: Record<string, { messages: Array<{ role: string; text: string }> }> = {
      "conversation-alpha": { messages: [{ role: "user", text: "Pergunta A" }, { role: "ai", text: "Resposta A" }] },
      "conversation-beta": { messages: [{ role: "user", text: "Pergunta B" }, { role: "ai", text: "Resposta B" }] },
    };
    vi.mocked(apiRequest).mockImplementation(async (path, options) => {
      if (path === "/api/nora/conversations") return [summaryA, summaryB];
      const match = String(path).match(/^\/api\/nora\/conversations\/([^/]+)$/);
      if (match) {
        const id = match[1];
        if (options?.method === "PUT") {
          const payload = JSON.parse(String(options.body));
          const base = id === summaryA.id ? summaryA : id === summaryB.id ? summaryB : {
            id, title: "Nova conversa", preview: "", messageCount: 0,
            createdAt: new Date().toISOString(), updatedAt: "", revision: 0, inLibrary: false,
          };
          return { ...base, id, title: payload.title, revision: payload.revision + 1, updatedAt: new Date().toISOString() };
        }
        const summary = id === summaryA.id ? summaryA : summaryB;
        return { ...summary, state: states[id] ?? { messages: [] } };
      }
      if (path === "/api/modelos-ia") return { providers: [] };
      return {};
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/nora/natural/stream")) throw new Error("stream indisponível no teste");
      if (url.includes("/api/nora/natural")) return {
        ok: true,
        json: async () => ({ intent: "chat", session_kind: null, session_id: null, status: "chat", response: "Resposta do teste." }),
      } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    });
    const naturalBodies = () => fetchSpy.mock.calls
      .filter(([input]) => String(input).endsWith("/api/nora/natural"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    const user = userEvent.setup();
    render(<NoraWorkspace userId="user-1" profile={{ nome: "Tarcisio" } as never} eventsBySource={{}} onOpenEmail={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Abrir histórico de conversas" }));
    await user.click(await screen.findByRole("button", { name: "Primeira conversa", expanded: false }));
    await user.click(await screen.findByRole("button", { name: "Gerar resposta novamente" }));
    await waitFor(() => expect(naturalBodies()).toHaveLength(1));
    expect(naturalBodies()[0].conversation_id).toBe("conversation-alpha");
    expect(naturalBodies()[0].conversation_id).not.toBe("Primeira conversa");

    await user.click(await screen.findByRole("button", { name: "Gerar resposta novamente" }));
    await waitFor(() => expect(naturalBodies()).toHaveLength(2));
    expect(naturalBodies()[1].conversation_id).toBe("conversation-alpha");

    await user.click(await screen.findByRole("button", { name: "Segunda conversa", expanded: false }));
    await screen.findByText("Pergunta B");
    await user.click(await screen.findByRole("button", { name: "Gerar resposta novamente" }));
    await waitFor(() => expect(naturalBodies()).toHaveLength(3));
    expect(naturalBodies()[2].conversation_id).toBe("conversation-beta");

    await user.click(screen.getAllByRole("button", { name: "Nova conversa" })[0]);
    await user.type(await screen.findByLabelText("Mensagem para a Nora"), "Nova pergunta{Enter}");
    await waitFor(() => expect(naturalBodies()).toHaveLength(4));
    const draftPut = vi.mocked(apiRequest).mock.calls
      .filter(([path, options]) => options?.method === "PUT" && String(path).startsWith("/api/nora/conversations/"))
      .map(([path]) => String(path).split("/").pop())
      .find((id) => id !== "conversation-alpha" && id !== "conversation-beta");
    expect(draftPut).toBeTruthy();
    expect(naturalBodies()[3].conversation_id).toBe(draftPut);
  });

  it("sends the conversation id on streaming requests", async () => {
    const summary = {
      id: "conversation-stream",
      title: "Conversa com stream",
      preview: "Resposta antiga",
      messageCount: 2,
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:05:00.000Z",
      revision: 1,
      inLibrary: false,
    };
    vi.mocked(apiRequest).mockImplementation(async (path, options) => {
      if (path === "/api/nora/conversations") return [summary];
      if (path === "/api/nora/conversations/conversation-stream") {
        if (options?.method === "PUT") {
          const payload = JSON.parse(String(options.body));
          return { ...summary, title: payload.title, revision: payload.revision + 1, updatedAt: new Date().toISOString() };
        }
        return { ...summary, state: { messages: [{ role: "user", text: "Pergunta S" }, { role: "ai", text: "Resposta antiga" }] } };
      }
      if (path === "/api/modelos-ia") return { providers: [] };
      return {};
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => { callback(0); return 0; },
    });
    const encoder = new TextEncoder();
    const frames = [
      'event: status\ndata: {"type":"status","response_id":"resp-1","state":"thinking"}\n\n',
      'event: status\ndata: {"type":"status","response_id":"resp-1","state":"streaming","context_ms":1,"knowledge_sources":[]}\n\nevent: delta\ndata: {"type":"delta","response_id":"resp-1","delta":"Olá stream "}\n\n',
      'event: delta\ndata: {"type":"delta","response_id":"resp-1","delta":"funcionando."}\n\nevent: done\ndata: {"type":"done","response_id":"resp-1","metrics":{}}\n\n',
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/nora/natural/stream")) {
        const queue = frames.map((frame) => encoder.encode(frame));
        return {
          ok: true,
          headers: {
            get: (name: string) => {
              const normalized = name.toLowerCase();
              if (normalized === "content-type") return "text/event-stream";
              if (normalized === "x-norium-response-id") return "resp-1";
              return null;
            },
          },
          body: { getReader: () => ({ read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }) }) },
        } as unknown as Response;
      }
      if (url.includes("/api/nora/telemetry")) return { ok: true, json: async () => ({}) } as Response;
      throw new Error(`fetch inesperado no teste de stream: ${url}`);
    });
    const user = userEvent.setup();
    render(<NoraWorkspace userId="user-1" profile={{ nome: "Tarcisio" } as never} eventsBySource={{}} onOpenEmail={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Abrir histórico de conversas" }));
    await user.click(await screen.findByRole("button", { name: "Conversa com stream", expanded: false }));
    await user.click(await screen.findByRole("button", { name: "Gerar resposta novamente" }));

    expect(await screen.findByText("Olá stream funcionando.")).toBeInTheDocument();
    const streamCalls = fetchSpy.mock.calls.filter(([input]) => String(input).includes("/api/nora/natural/stream"));
    expect(streamCalls).toHaveLength(1);
    expect(JSON.parse(String((streamCalls[0][1] as RequestInit).body)).conversation_id).toBe("conversation-stream");
    expect(fetchSpy.mock.calls.some(([input]) => String(input).endsWith("/api/nora/natural"))).toBe(false);
  });

  it("renders the approval card from natural results and decides in chat", async () => {
    const summary = {
      id: "conversation-approval",
      title: "Enviar proposta",
      preview: "Mande e-mail",
      messageCount: 2,
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:05:00.000Z",
      revision: 1,
      inLibrary: false,
    };
    const approvalItem = {
      id: "approval_email_9",
      action: "nora_email_send_exact",
      source: "email",
      title: "Enviar e-mail para chefe@empresa.com",
      status: "pending",
      digest: "cd".repeat(32),
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      metadata: { workspace: "primary", tool: "gmail", version: "nora-email-v1" },
      description: "Para: chefe@empresa.com\nAssunto: Proposta",
      payload: { emailExact: { to: ["chefe@empresa.com"], cc: [], bcc: [] } },
    };
    vi.mocked(apiRequest).mockImplementation(async (path, options) => {
      if (path === "/api/nora/conversations") return [summary];
      if (path === "/api/nora/conversations/conversation-approval") {
        if (options?.method === "PUT") {
          const payload = JSON.parse(String(options.body));
          return { ...summary, title: payload.title, revision: payload.revision + 1, updatedAt: new Date().toISOString() };
        }
        return { ...summary, state: { messages: [{ role: "user", text: "Mande e-mail" }, { role: "ai", text: "Rascunho" }] } };
      }
      if (path === "/api/operacao/aprovacoes/approval_email_9" && options?.method === "PATCH") {
        return { item: { ...approvalItem, status: "executed", decidedAt: new Date().toISOString(), execution: { response: "E-mail enviado para chefe@empresa.com." } } };
      }
      if (path === "/api/modelos-ia") return { providers: [] };
      return {};
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/nora/natural/stream")) throw new Error("stream indisponível no teste");
      if (url.includes("/api/nora/natural")) return {
        ok: true,
        json: async () => ({
          intent: "email",
          session_kind: "email",
          session_id: "email-9",
          status: "aguardando_aprovacao",
          response: "Prévia pronta. Confira o cartão abaixo.",
          agent_result: { approval: approvalItem },
        }),
      } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    });
    const user = userEvent.setup();
    render(<NoraWorkspace userId="user-1" profile={{ nome: "Tarcisio" } as never} eventsBySource={{}} onOpenEmail={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Abrir histórico de conversas" }));
    await user.click(await screen.findByRole("button", { name: "Enviar proposta", expanded: false }));
    await user.click(await screen.findByRole("button", { name: "Gerar resposta novamente" }));

    expect(await screen.findByRole("button", { name: "Permitir esta ação" })).toBeInTheDocument();
    expect(screen.getByText("chefe@empresa.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Permitir esta ação" }));

    await waitFor(() => expect(screen.getByText("Executada")).toBeInTheDocument());
    expect(screen.getByText("E-mail enviado para chefe@empresa.com.")).toBeInTheDocument();
    const patchCall = vi.mocked(apiRequest).mock.calls.find(([path, options]) => path === "/api/operacao/aprovacoes/approval_email_9" && options?.method === "PATCH");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ decision: "approved", expectedDigest: "cd".repeat(32) });
  });
});
