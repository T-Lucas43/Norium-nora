import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TeamNoraDialog from "./TeamNoraDialog";
import TeamNoraMessageTools from "./TeamNoraMessageTools";
import type { TeamMessage } from "./teamChatTypes";

vi.mock("../nora/NoraResponseContent", () => ({ NoraMarkdown: ({ text }: { text: string }) => <p>{text}</p> }));
const source: TeamMessage = { id: "source", threadId: "team", scope: "team", senderId: "ana", senderName: "Ana", text: "Revisar a proposta", attachments: [], metadata: {}, createdAt: "2026-10-13T12:00:00Z" };
const answer: TeamMessage = { ...source, id: "answer", senderId: "nora", senderName: "Nora", text: "Sugestão de tarefa para revisão", metadata: { privateNora: true, noraSources: [{ messageId: "source", threadId: "team", label: "Fonte: Chat da equipe" }] } };
const base = { onClose: vi.fn(), onSource: vi.fn(), onMessage: vi.fn(), onTask: vi.fn(), onSchedule: vi.fn() };

describe("Nora contextual no Chat", () => {
  it("resumo só é gerado sob demanda, com período e fontes", async () => {
    const request = vi.fn().mockResolvedValue({ text: "Resumo privado", through: "2026-10-13T12:00:00Z", sources: [{ messageId: "source", threadId: "team", label: "Fonte: Chat da equipe" }] });
    render(<TeamNoraDialog {...base} input={{ mode: "catch-up" }} request={request} />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Período do resumo"), { target: { value: "24" } });
    fireEvent.click(screen.getByText("Gerar resumo"));
    await screen.findByText("Resumo privado");
    expect(request).toHaveBeenCalledWith("/nora/catch-up", expect.objectContaining({ body: JSON.stringify({ hours: 24 }) }));
    fireEvent.click(screen.getByText("Fonte: Chat da equipe · 1"));
    expect(base.onSource).toHaveBeenCalledWith({ messageId: "source", threadId: "team", label: "Fonte: Chat da equipe" });
  });

  it("comando de tarefa devolve proposta e exige revisão antes de criar", async () => {
    const request = vi.fn().mockResolvedValue({ message: answer });
    const onTask = vi.fn();
    render(<TeamNoraDialog {...base} onTask={onTask} input={{ mode: "ask", source, question: "Proponha uma tarefa" }} request={request} />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Consultar"));
    await screen.findByText(answer.text);
    expect(onTask).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Revisar tarefa"));
    expect(onTask).toHaveBeenCalledWith(answer);
  });

  it("envio ao cliente prepara um único cartão de aprovação sem enviar", async () => {
    const request = vi.fn(async (path: string) => path === "/nora/clients" ? { clients: [{ id: "client", name: "Cliente", email: "client@example.test", phone: "" }] } : { sent: false, approval: { id: "approval", action: "nora_email_send_exact", title: "Enviar proposta", status: "pending", digest: "a".repeat(64), payload: { emailExact: { to: ["client@example.test"], subject: "Proposta", body: "Texto revisado" } }, metadata: {} } });
    render(<TeamNoraDialog {...base} input={{ mode: "client", source }} request={request} />);
    await screen.findByText("Cliente · client@example.test");
    fireEvent.change(screen.getByLabelText("Cliente destinatário"), { target: { value: "client" } });
    fireEvent.change(screen.getByLabelText("Assunto para o cliente"), { target: { value: "Proposta" } });
    fireEvent.change(screen.getByLabelText("Texto para o cliente"), { target: { value: "Texto revisado" } });
    fireEvent.click(screen.getByText("Preparar aprovação"));
    await screen.findByText("Enviar proposta");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("/messages/source/client-approval", expect.objectContaining({ method: "POST", body: JSON.stringify({ clientId: "client", channel: "email", subject: "Proposta", body: "Texto revisado" }) }));
    expect(screen.getAllByRole("button", { name: /Permitir/ })).toHaveLength(1);
  });

  it("erro permanece visível no diálogo", async () => {
    render(<TeamNoraDialog {...base} input={{ mode: "ask", source }} request={vi.fn().mockRejectedValue(new Error("Permissão mudou"))} />);
    fireEvent.click(screen.getByText("Consultar"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permissão mudou");
  });

  it("áudio só é enviado ao transcritor após clicar e o texto é privado", async () => {
    const request = vi.fn().mockResolvedValue({ text: "Transcrição minimizada", usage: { estimated: false } });
    render(<TeamNoraMessageTools message={{ ...source, attachments: [{ id: "audio", name: "voz.webm", mimeType: "audio/webm", size: 10, url: "/api/team-chat/attachments/audio" }] }} request={request} onSource={() => {}} enabled />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Transcrever voz.webm"));
    await screen.findByText("Transcrição minimizada");
    expect(request).toHaveBeenCalledWith("/messages/source/attachments/audio/transcription", { method: "POST" });
    expect(screen.getByText(/Transcrição privada/)).toHaveTextContent("tokens de saída medidos");
    expect(screen.queryByText("Transcrever voz.webm")).toBeNull();
  });

  it("conta sem Nora não tem controle de transcrição", async () => {
    const request = vi.fn();
    render(<TeamNoraMessageTools message={{ ...source, attachments: [{ id: "audio", name: "voz.webm", mimeType: "audio/webm", size: 10, url: "" }] }} request={request} onSource={() => {}} enabled={false} />);
    await waitFor(() => expect(screen.queryByText("Transcrever voz.webm")).toBeNull());
    expect(request).not.toHaveBeenCalled();
  });
});
