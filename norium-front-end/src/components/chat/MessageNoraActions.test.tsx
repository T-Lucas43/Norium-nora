import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MessageNoraActions from "./MessageNoraActions";
import type { MsgConteudo } from "./types";

const mocks = vi.hoisted(() => ({
  runCustomAction: vi.fn(),
  improveDraft: vi.fn(),
  listProjects: vi.fn(),
  createFromMessage: vi.fn(),
}));

vi.mock("./noraChatApi", () => ({
  noraChatApi: {
    runCustomAction: mocks.runCustomAction,
    improveDraft: mocks.improveDraft,
  },
}));

vi.mock("./messageTaskApi", () => ({
  messageTaskApi: {
    listProjects: mocks.listProjects,
    createFromMessage: mocks.createFromMessage,
  },
}));

const message: MsgConteudo = {
  id: "msg-1",
  remetente: "contato",
  tipo: "texto",
  texto: "Enviar orçamento até sexta",
  horario: "10:00",
};

describe("ações contextuais da Nora", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runCustomAction.mockResolvedValue("Resposta revisável");
    mocks.improveDraft.mockResolvedValue("Resposta melhorada");
    mocks.listProjects.mockResolvedValue([{ id: "project-1", name: "Operação Norium" }]);
    mocks.createFromMessage.mockResolvedValue({ task: { id: "task-1", title: "Enviar orçamento" } });
  });

  it("exige revisão antes de inserir a resposta no composer", async () => {
    const user = userEvent.setup();
    const onUseReply = vi.fn();
    render(<MessageNoraActions conversationId="chat-1" request={{ mode: "reply", message }} onClose={vi.fn()} onUseReply={onUseReply} />);

    const draft = await screen.findByDisplayValue("Resposta revisável");
    await user.clear(draft);
    await user.type(draft, "Resposta aprovada pelo operador");
    expect(onUseReply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Usar como resposta" }));
    expect(onUseReply).toHaveBeenCalledWith(message, "Resposta aprovada pelo operador");
  });

  it("não leva a apresentação da Nora para a resposta contextual", async () => {
    const user = userEvent.setup();
    const onUseReply = vi.fn();
    mocks.runCustomAction.mockResolvedValueOnce("**Mensagem sugerida:**\n\nConfirmo o recebimento. Obrigado!");
    render(<MessageNoraActions conversationId="chat-1" request={{ mode: "reply", message }} onClose={vi.fn()} onUseReply={onUseReply} />);

    expect(await screen.findByLabelText("Texto para validação")).toHaveValue("**Mensagem sugerida:**\n\nConfirmo o recebimento. Obrigado!");
    await user.click(screen.getByRole("button", { name: "Usar como resposta" }));

    expect(onUseReply).toHaveBeenCalledOnce();
    expect(onUseReply).toHaveBeenCalledWith(message, "Confirmo o recebimento. Obrigado!");
  });

  it("carrega projetos reais e só cria a tarefa depois da escolha", async () => {
    const user = userEvent.setup();
    render(<MessageNoraActions conversationId="chat-1" request={{ mode: "task", message }} onClose={vi.fn()} onUseReply={vi.fn()} />);

    const project = await screen.findByRole("combobox", { name: "Projeto da tarefa" });
    await waitFor(() => expect(project).toHaveValue("project-1"));
    expect(mocks.createFromMessage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Criar tarefa" }));
    expect(mocks.createFromMessage).toHaveBeenCalledWith(expect.objectContaining({
      project: { id: "project-1", name: "Operação Norium" },
      title: "Enviar orçamento até sexta",
      description: "Resposta revisável",
    }));
  });
});
