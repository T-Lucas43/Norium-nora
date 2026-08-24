import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import NoraChatComposer from "./NoraChatComposer";
import { noraChatApi } from "./noraChatApi";

vi.mock("./noraChatApi", () => ({
  noraChatApi: {
    suggestReply: vi.fn(),
    summarizeConversation: vi.fn(),
    runCustomAction: vi.fn(),
    improveDraft: vi.fn(),
  },
}));

const mockedApi = vi.mocked(noraChatApi);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("Nora no compositor do WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.suggestReply.mockResolvedValue("Resposta sugerida pela Nora");
    mockedApi.summarizeConversation.mockResolvedValue("Resumo da conversa");
    mockedApi.runCustomAction.mockResolvedValue("Resultado personalizado");
    mockedApi.improveDraft.mockResolvedValue("Resposta melhorada");
  });

  it("abre as três ações no menu que antecede o microfone", async () => {
    const user = userEvent.setup();
    render(<NoraChatComposer conversationId="chat-1" onInsertDraft={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));

    expect(screen.getByRole("menu", { name: /ações da nora/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /sugerir resposta/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /resumir conversa/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /ação personalizada/i })).toBeInTheDocument();
  });

  it("obriga revisar e editar antes de inserir, sem enviar automaticamente", async () => {
    const user = userEvent.setup();
    const onInsertDraft = vi.fn();
    render(<NoraChatComposer conversationId="chat-1" onInsertDraft={onInsertDraft} />);

    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));
    await user.click(screen.getByRole("menuitem", { name: /sugerir resposta/i }));

    const editor = await screen.findByLabelText(/texto sugerido/i);
    expect(screen.getByRole("dialog", { name: /revisão obrigatória/i })).toBeInTheDocument();
    expect(onInsertDraft).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: "Texto revisado pelo operador" } });
    await user.click(screen.getByRole("button", { name: /confirmar e inserir/i }));

    expect(onInsertDraft).toHaveBeenCalledTimes(1);
    expect(onInsertDraft).toHaveBeenCalledWith("Texto revisado pelo operador");
  });

  it("remove a apresentação da Nora e insere somente o corpo revisado", async () => {
    const user = userEvent.setup();
    const onInsertDraft = vi.fn();
    mockedApi.suggestReply.mockResolvedValueOnce("Segue a mensagem que você pode enviar para o Nando:\n\nOi, Nando! Tudo bem?");
    render(<NoraChatComposer conversationId="chat-1" onInsertDraft={onInsertDraft} />);

    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));
    await user.click(screen.getByRole("menuitem", { name: /sugerir resposta/i }));
    expect(await screen.findByLabelText(/texto sugerido/i)).toHaveValue("Segue a mensagem que você pode enviar para o Nando:\n\nOi, Nando! Tudo bem?");
    await user.click(screen.getByRole("button", { name: /confirmar e inserir/i }));

    expect(onInsertDraft).toHaveBeenCalledOnce();
    expect(onInsertDraft).toHaveBeenCalledWith("Oi, Nando! Tudo bem?");
  });

  it("permite pedir melhoria à Nora e exige nova confirmação", async () => {
    const user = userEvent.setup();
    const onInsertDraft = vi.fn();
    render(<NoraChatComposer conversationId="chat-1" onInsertDraft={onInsertDraft} />);
    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));
    await user.click(screen.getByRole("menuitem", { name: /sugerir resposta/i }));
    await screen.findByLabelText(/texto sugerido/i);

    await user.type(screen.getByLabelText(/pedir melhoria/i), "mais curta");
    await user.click(screen.getByRole("button", { name: "Melhorar" }));

    await waitFor(() => expect(mockedApi.improveDraft).toHaveBeenCalledWith("chat-1", "Resposta sugerida pela Nora", "mais curta"));
    expect(await screen.findByDisplayValue("Resposta melhorada")).toBeInTheDocument();
    expect(onInsertDraft).not.toHaveBeenCalled();
  });

  it("gera uma ação personalizada e ainda passa pela revisão", async () => {
    const user = userEvent.setup();
    render(<NoraChatComposer conversationId="chat-1" onInsertDraft={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));
    await user.click(screen.getByRole("menuitem", { name: /ação personalizada/i }));
    await user.type(screen.getByLabelText(/instrução para a nora/i), "confirme o horário");
    await user.click(screen.getByRole("button", { name: /gerar para revisar/i }));

    await waitFor(() => expect(mockedApi.runCustomAction).toHaveBeenCalledWith("chat-1", "confirme o horário"));
    expect(await screen.findByDisplayValue("Resultado personalizado")).toBeInTheDocument();
    expect(screen.getByText(/não será enviada automaticamente/i)).toBeInTheDocument();
  });

  it("ignora a resposta tardia quando a ação personalizada é cancelada", async () => {
    const user = userEvent.setup();
    const pending = deferred<string>();
    mockedApi.runCustomAction.mockReturnValueOnce(pending.promise);
    render(<NoraChatComposer conversationId="chat-1" onInsertDraft={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));
    await user.click(screen.getByRole("menuitem", { name: /ação personalizada/i }));
    await user.type(screen.getByLabelText(/instrução para a nora/i), "confirme o horário");
    await user.click(screen.getByRole("button", { name: /gerar para revisar/i }));
    await user.click(screen.getByRole("button", { name: /cancelar/i }));

    await act(async () => {
      pending.resolve("Resposta que chegou depois do cancelamento");
      await pending.promise;
    });

    expect(screen.queryByDisplayValue("Resposta que chegou depois do cancelamento")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /abrir ações da nora/i })).not.toBeDisabled();
  });

  it("exibe o resumo somente para leitura e nunca o insere no compositor", async () => {
    const user = userEvent.setup();
    const onInsertDraft = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<NoraChatComposer conversationId="chat-1" onInsertDraft={onInsertDraft} />);
    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));
    await user.click(screen.getByRole("menuitem", { name: /resumir conversa/i }));

    const summary = await screen.findByLabelText("Resumo da conversa");
    expect(summary).toHaveValue("Resumo da conversa");
    expect(summary).toHaveAttribute("readonly");
    expect(screen.getByText(/somente para leitura e nunca será colocado/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirmar e inserir/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/pedir melhoria/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /copiar resumo/i }));
    expect(writeText).toHaveBeenCalledWith("Resumo da conversa");
    expect(onInsertDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /descartar/i }));
    expect(onInsertDraft).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  });

  it("bloqueia novas ações enquanto a Nora ainda está respondendo", async () => {
    const user = userEvent.setup();
    const pending = deferred<string>();
    mockedApi.suggestReply.mockReturnValueOnce(pending.promise);
    render(<NoraChatComposer conversationId="chat-1" onInsertDraft={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: /abrir ações da nora/i });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: /sugerir resposta/i }));

    expect(trigger).toBeDisabled();
    expect(screen.queryByRole("menu", { name: /ações da nora/i })).not.toBeInTheDocument();
    pending.resolve("Resposta única");
    expect(await screen.findByDisplayValue("Resposta única")).toBeInTheDocument();
  });

  it("não reutiliza rascunho descartado quando uma nova solicitação falha", async () => {
    const user = userEvent.setup();
    render(<NoraChatComposer conversationId="chat-1" onInsertDraft={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));
    await user.click(screen.getByRole("menuitem", { name: /sugerir resposta/i }));
    expect(await screen.findByDisplayValue("Resposta sugerida pela Nora")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /descartar/i }));

    mockedApi.suggestReply.mockRejectedValueOnce(new Error("Falha temporária"));
    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));
    await user.click(screen.getByRole("menuitem", { name: /sugerir resposta/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Falha temporária");
    expect(screen.queryByDisplayValue("Resposta sugerida pela Nora")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirmar e inserir/i })).not.toBeInTheDocument();
  });

  it("ignora uma resposta que terminou depois da troca de conversa", async () => {
    const user = userEvent.setup();
    const pending = deferred<string>();
    mockedApi.suggestReply.mockReturnValueOnce(pending.promise);
    const { rerender } = render(<NoraChatComposer conversationId="chat-1" onInsertDraft={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /abrir ações da nora/i }));
    await user.click(screen.getByRole("menuitem", { name: /sugerir resposta/i }));
    rerender(<NoraChatComposer conversationId="chat-2" onInsertDraft={vi.fn()} />);
    await act(async () => {
      pending.resolve("Resposta da conversa anterior");
      await pending.promise;
    });

    expect(screen.queryByDisplayValue("Resposta da conversa anterior")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
