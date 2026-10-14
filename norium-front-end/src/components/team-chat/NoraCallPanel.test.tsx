import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NoraCallPanel from "./NoraCallPanel";
import type { NoraCallSnapshot } from "./useTeamCall";
import { useTeamApiRequest } from "./CallSession";

vi.mock("./CallSession", () => ({ useTeamApiRequest: vi.fn() }));

const state: NoraCallSnapshot = { callId: "call", revision: 4, available: true, requested: true,
  state: "awaiting_consent", pendingUserIds: ["a"], notice: "Áudio enviado ao Groq em trechos, retenção 24h." };

describe("Nora na reunião", () => {
  it("recupera histórico autorizado e pergunta somente para o usuário com fontes", async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes("/question")
      ? { recipientUserId: "a", private: true, text: "A proposta precisa de revisão.", sources: [{ segmentId: "s1", userId: "b", module: "Transcrição da reunião", start: 10, quote: "Revisar a proposta" }] }
      : { callId: "call", sequence: 1, revision: 4, segments: [{ id: "s1", callId: "call", userId: "b", start: 10, end: 15, text: "Revisar a proposta" }], understanding: { summary: [], decisions: [], tasks: [], questions: [] }, visibleSegmentCount: 1 });
    vi.mocked(useTeamApiRequest).mockReturnValue(request);
    render(<NoraCallPanel state={state} currentUserId="a" isHost update={vi.fn()} clientId="a-tab" members={[{ id: "b", nome: "Bruno" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Nora ·/ }));
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    expect(await screen.findByText("Revisar a proposta")).toBeVisible();
    expect(screen.getByText("00:10 · Bruno")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Perguntar" }));
    fireEvent.change(screen.getByLabelText("Pergunte à Nora só para você"), { target: { value: "Qual foi a decisão?" } });
    fireEvent.click(screen.getByRole("button", { name: "Perguntar à Nora" }));
    expect(await screen.findByText("A proposta precisa de revisão.")).toBeVisible();
    expect(screen.getByText(/Fonte: Transcrição da reunião · Bruno · 00:10/)).toBeVisible();
    expect(request).toHaveBeenCalledWith(expect.stringContaining("/question"), expect.objectContaining({ method: "POST", body: expect.stringContaining('"clientId":"a-tab"') }));
  });
  it("descarta resposta privada enviada para outra pessoa", async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes("/question")
      ? { recipientUserId: "other", private: true, text: "Não mostrar dado privado", sources: [] }
      : { callId: "call", segments: [], understanding: { summary: [], decisions: [], tasks: [], questions: [] } });
    vi.mocked(useTeamApiRequest).mockReturnValue(request);
    render(<NoraCallPanel state={state} currentUserId="a" isHost update={vi.fn()} clientId="a-tab" />);
    fireEvent.click(screen.getByRole("button", { name: /Nora ·/ }));
    fireEvent.click(screen.getByRole("button", { name: "Perguntar" }));
    fireEvent.change(screen.getByLabelText("Pergunte à Nora só para você"), { target: { value: "Pergunta privada" } });
    fireEvent.click(screen.getByRole("button", { name: "Perguntar à Nora" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining("/question"), expect.anything()));
    expect(screen.queryByText("Não mostrar dado privado")).toBeNull();
  });
  it("exige consentimento explícito à revisão vigente, sem captura na montagem", () => {
    const update = vi.fn();
    render(<NoraCallPanel state={state} currentUserId="a" isHost update={update} />);
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Nora · Aguardando consentimento/ }));
    expect(screen.getByText(state.notice)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Autorizar transcrição nesta reunião" }));
    expect(update).toHaveBeenCalledWith({ type: "consent", accepted: true, revision: 4 });
  });
  it("permite retirar consentimento e restringe pausa ao organizador", () => {
    const update = vi.fn();
    render(<NoraCallPanel state={{ ...state, pendingUserIds: [] }} currentUserId="b" isHost={false} update={update} />);
    expect(screen.queryByRole("button", { name: "Pausar Nora" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Nora ·/ }));
    fireEvent.click(screen.getByRole("button", { name: "Retirar autorização da transcrição" }));
    expect(update).toHaveBeenCalledWith({ type: "consent", accepted: false, revision: 4 });
  });
  it("não chama consentimento completo de ouvindo e não libera flag indisponível", () => {
    const update = vi.fn();
    const view = render(<NoraCallPanel state={{ ...state, state: "awaiting_agent", pendingUserIds: [] }} currentUserId="a" isHost update={update} />);
    expect(screen.queryByText(/Ouvindo/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Aguardando conexão/ }));
    expect(screen.getByRole("status")).toHaveTextContent("quando o agente conectar");
    view.rerender(<NoraCallPanel state={{ ...state, available: false, requested: false, state: "paused" }} currentUserId="a" isHost update={update} />);
    expect(screen.getByRole("button", { name: "Ativar Nora" })).toBeDisabled();
  });
});
