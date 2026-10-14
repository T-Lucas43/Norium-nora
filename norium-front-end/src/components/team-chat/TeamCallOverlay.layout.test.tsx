import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TeamCallOverlay from "./TeamCallOverlay";
import type { CallSessionCommands, CallSessionSnapshot } from "./CallSession";
import { useCallSpeakers } from "./useCallSpeakers";
import inventory from "./call-control-inventory.json";

vi.mock("./useCallSpeakers", () => ({ useCallSpeakers: vi.fn() }));
vi.mock("./TeamCallStudio", () => ({ default: ({ visible }: { visible: boolean }) => visible ? <section aria-label="Estúdio aberto" /> : null }));

const members = [{ id: "owner", nome: "Ana" }, { id: "member", nome: "Bruno" }, { id: "other", nome: "Carla" }];
function fixture(overrides: Partial<CallSessionSnapshot> = {}) {
  const snapshot = {
    active: { callId: "call-layout", title: "Planejamento", hostUserId: "owner", thread: { scope: "team", title: "Time todo" } },
    incoming: null, prejoin: null, clientId: "client", localStream: null, screenStream: null,
    remoteStreams: [], remoteScreenSharingIds: [], remoteCameraEnabled: {}, muted: false, cameraOff: true,
    cameraPermission: "granted", callElapsedSeconds: 120, recording: false, connectionQuality: "good",
    reactions: [], raisedHands: {}, socketState: "open", isHost: true, devices: { microphones: [], cameras: [], speakers: [] },
    conversation: { callId: "call-layout", participantIds: ["owner", "member", "other"], messages: [] },
    ...overrides,
  } as unknown as CallSessionSnapshot;
  const commands = Object.fromEntries(["toggleMute", "toggleCamera", "toggleHand", "startRecording", "stopRecording", "leave", "end", "toggleScreenShare", "sendReaction", "requestCameraPermission", "enter", "setEntryCameraEnabled", "cancelEntry", "reject"].map((key) => [key, vi.fn().mockResolvedValue(undefined)])) as unknown as CallSessionCommands;
  const props = { snapshot, commands, members, currentUserId: "owner", onDownloadAttachment: vi.fn() };
  return props;
}

beforeEach(() => {
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } getVideoTracks() { return []; } getAudioTracks() { return []; } });
  localStorage.clear(); sessionStorage.clear();
  vi.mocked(useCallSpeakers).mockReturnValue({ speakerId: null, speakingIds: [], recentSpeakers: [], localLevel: 0 });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("nova interface da chamada", () => {
  it("mantém presença sem faixa assinada e não mostra um convidado ainda não admitido", () => {
    const props = fixture({ participantIds: ["owner"] });
    const view = render(<TeamCallOverlay {...props} />);
    expect(document.querySelector('[data-participant="member"]')).toBeNull();
    view.rerender(<TeamCallOverlay {...props} snapshot={{ ...props.snapshot, participantIds: ["owner", "member"] }} />);
    expect(document.querySelector('[data-participant="member"]')).not.toBeNull();
    view.rerender(<TeamCallOverlay {...props} />);
    expect(document.querySelector('[data-participant="member"]')).toBeNull();
  });
  it("preserva o inventário fixo de acessibilidade da interface anterior", () => {
    const source = readFileSync("src/components/team-chat/TeamCallOverlay.tsx", "utf-8");
    for (const label of inventory) expect(source, label).toContain(`aria-label="${label}"`);
  });
  it("muda automaticamente para apresentação local e persiste o layout por usuário", () => {
    const props = fixture({ screenStream: {} as MediaStream, sharingScreen: true });
    const view = render(<TeamCallOverlay {...props} />);
    expect(screen.getByLabelText("Palco da chamada")).toHaveAttribute("data-layout", "presentation");
    fireEvent.change(screen.getByLabelText("Layout da chamada"), { target: { value: "gallery" } });
    expect(screen.getByLabelText("Palco da chamada")).toHaveAttribute("data-layout", "gallery");
    view.unmount();
    render(<TeamCallOverlay {...fixture()} />);
    expect(screen.getByLabelText("Layout da chamada")).toHaveValue("gallery");
  });
  it("mantém um único painel e apresenta a fila de fala na ordem dos eventos", () => {
    const props = fixture({ raisedHands: { other: "2026-10-13T10:02:00Z", member: "2026-10-13T10:01:00Z" } });
    render(<TeamCallOverlay {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver pessoas na reunião" }));
    const queue = screen.getByLabelText("Fila de fala");
    expect(within(queue).getAllByRole("listitem").map((item) => item.querySelector("span")?.textContent)).toEqual(["Bruno", "Carla"]);
    fireEvent.click(screen.getByRole("button", { name: "Abrir chat da reunião" }));
    expect(screen.queryByLabelText("Fila de fala")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir estúdio da chamada" }));
    expect(screen.queryByRole("heading", { name: "Chat da reunião" })).toBeNull();
    expect(screen.getByLabelText("Estúdio aberto")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver pessoas na reunião" }));
    expect(screen.queryByLabelText("Estúdio aberto")).toBeNull();
  });
  it("aplica atalhos apenas fora do formulário", () => {
    const props = fixture();
    render(<TeamCallOverlay {...props} />);
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    fireEvent.keyDown(window, { key: "h", ctrlKey: true, altKey: true });
    expect(props.commands.toggleMute).toHaveBeenCalledOnce();
    expect(props.commands.toggleCamera).toHaveBeenCalledOnce();
    expect(props.commands.toggleHand).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Abrir chat da reunião" }));
    fireEvent.keyDown(screen.getByPlaceholderText("Digite uma mensagem"), { key: "d", ctrlKey: true });
    expect(props.commands.toggleMute).toHaveBeenCalledOnce();
  });
  it("diferencia sair de encerrar para todos e preserva as opções de gravação", async () => {
    const props = fixture({ isHost: false });
    const view = render(<TeamCallOverlay {...props} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sair da reunião" })); });
    expect(props.commands.leave).toHaveBeenCalledOnce();
    expect(props.commands.end).not.toHaveBeenCalled();
    view.rerender(<TeamCallOverlay {...props} snapshot={{ ...props.snapshot, isHost: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Mais opções da chamada" }));
    fireEvent.click(screen.getByRole("button", { name: "Gravar reunião" }));
    expect(props.commands.startRecording).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Mais opções da chamada" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Encerrar reunião" })); });
    expect(props.commands.end).toHaveBeenCalledOnce();
  });
  it("mostra o selo de acesso apenas com socket autenticado aberto", () => {
    const view = render(<TeamCallOverlay {...fixture({ socketState: "reconnecting" })} />);
    expect(screen.queryByText("Sala autenticada")).toBeNull();
    view.rerender(<TeamCallOverlay {...fixture({ socketState: "open" })} />);
    fireEvent.click(screen.getByText("Sala autenticada"));
    expect(screen.getByRole("dialog", { name: "Privacidade da chamada" })).toHaveTextContent("autorização na equipe");
    expect(screen.queryByText("Nora transcrevendo")).toBeNull();
  });
  it("responder no chat recusa o convite e abre o rascunho sem enviar mensagem", () => {
    const onReplyIncoming = vi.fn();
    const props = fixture({ active: null, incoming: { fromUserName: "Bruno", thread: { scope: "team" } } as CallSessionSnapshot["incoming"] });
    render(<TeamCallOverlay {...props} onReplyIncoming={onReplyIncoming} />);
    fireEvent.click(screen.getByRole("button", { name: "Responder no chat" }));
    expect(props.commands.reject).toHaveBeenCalledOnce();
    expect(onReplyIncoming).toHaveBeenCalledOnce();
  });
  it("avisa a vez pelo chat e exige confirmação antes da remoção pelo organizador", async () => {
    const props = fixture({ raisedHands: { member: "2026-10-13T10:00:00Z" } });
    props.commands.sendMeetingMessage = vi.fn().mockResolvedValue(undefined);
    props.commands.removeParticipant = vi.fn();
    render(<TeamCallOverlay {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver pessoas na reunião" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dar a vez a Bruno" })); });
    expect(props.commands.sendMeetingMessage).toHaveBeenCalledWith("Bruno, é sua vez de falar.", []);
    fireEvent.click(screen.getByRole("button", { name: "Remover Bruno da reunião" }));
    expect(props.commands.removeParticipant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remover participante" }));
    expect(props.commands.removeParticipant).toHaveBeenCalledWith("member");
  });
  it("destaca controles em Document PiP e fecha a janela ao parar a apresentação", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const popupDocument = iframe.contentDocument!;
    const close = vi.fn();
    const requestWindow = vi.fn().mockResolvedValue({ document: popupDocument, close, addEventListener: vi.fn() });
    vi.stubGlobal("documentPictureInPicture", { requestWindow });
    const props = fixture({ sharingScreen: true, screenStream: {} as MediaStream });
    const view = render(<TeamCallOverlay {...props} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Destacar controles de apresentação" })); });
    expect(requestWindow).toHaveBeenCalledWith({ width: 650, height: 160 });
    const controls = within(popupDocument.body);
    expect(popupDocument.body.contains(controls.getByLabelText("Controles de quem apresenta"))).toBe(true);
    fireEvent.click(controls.getByRole("button", { name: "Alternar microfone durante apresentação" }));
    expect(props.commands.toggleMute).toHaveBeenCalledOnce();
    view.rerender(<TeamCallOverlay {...props} snapshot={{ ...props.snapshot, sharingScreen: false, screenStream: null }} />);
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    iframe.remove();
  });
});
