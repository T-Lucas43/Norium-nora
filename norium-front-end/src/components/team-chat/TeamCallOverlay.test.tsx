import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TeamCallOverlay from "./TeamCallOverlay";
import type { ReturnTypeOfTeamCall } from "./teamCallTypes";

describe("tela da reuniao do Modo Equipe", () => {
  it("exibe reuniao unificada, duracao, camera, anexos e compartilhamento", () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    const call = {
      incoming: null,
      active: { callId: "call_0123456789abcdef", mode: "audio", title: "Comercial", hostUserId: "owner", startedAt: new Date().toISOString(), thread: { scope: "team", title: "Comercial" } },
      localStream: null,
      screenStream: null,
      remoteStreams: [],
      remoteScreenSharingIds: [],
      muted: false,
      cameraOff: true,
      cameraPermission: "granted",
      sharingScreen: false,
      callElapsedSeconds: 65,
      recording: false,
      recordingElapsedSeconds: 0,
      connectionQuality: "good",
      reactions: [],
      status: "Na chamada",
      devices: { microphones: [], cameras: [], speakers: [] },
      selectedMicrophoneId: "",
      selectedCameraId: "",
      selectedSpeakerId: "",
      supportsSpeakerSelection: true,
      isHost: true,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      sendReaction: vi.fn(),
      toggleScreenShare: vi.fn(),
      toggleCamera: vi.fn(),
      requestCameraPermission: vi.fn(),
      toggleMute: vi.fn(),
      endCall: vi.fn(),
      leaveCall: vi.fn(),
      refreshDevices: vi.fn(),
      selectMicrophone: vi.fn(),
      selectCamera: vi.fn(),
      selectSpeaker: vi.fn(),
    } as unknown as ReturnTypeOfTeamCall;

    render(<TeamCallOverlay call={call} messages={[]} members={[{ id: "owner", nome: "Owner" }]} currentUserId="owner" onSendMessage={onSendMessage} onDownloadAttachment={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Gravar reunião" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transmitir tela" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ativar câmera" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Qualidade da internet: Conexão excelente" })).toBeInTheDocument();
    expect(screen.getByText(/01:05/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Abrir chat da reunião" }));
    expect(screen.getByRole("heading", { name: "Chat da reunião" })).toBeInTheDocument();
    const meetingFile = new File(["conteudo"], "pauta.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Anexar arquivos no chat da reunião").querySelector("input") as HTMLInputElement, { target: { files: [meetingFile] } });
    expect(screen.getByText("pauta.pdf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enviar reação com emoji" }));
    fireEvent.click(screen.getByRole("button", { name: "Reagir com 👍" }));
    expect(call.sendReaction).toHaveBeenCalledWith("👍");

    fireEvent.click(screen.getByRole("button", { name: "Selecionar câmera e dispositivos de áudio" }));
    expect(screen.getByLabelText("Dispositivos da chamada")).toBeInTheDocument();
    expect(screen.getByText("Dispositivo de entrada")).toBeInTheDocument();
    expect(screen.getByText("Dispositivo de saída")).toBeInTheDocument();
  });

  it("orienta a liberar a camera quando a permissao esta bloqueada", () => {
    const requestCameraPermission = vi.fn().mockResolvedValue(false);
    const call = {
      incoming: null,
      active: { callId: "call_0123456789abcdef", mode: "audio", title: "Time todo", hostUserId: "owner", startedAt: new Date().toISOString(), thread: { scope: "team", title: "Time todo" } },
      localStream: null,
      screenStream: null,
      remoteStreams: [],
      remoteScreenSharingIds: [],
      muted: false,
      cameraOff: true,
      cameraPermission: "denied",
      sharingScreen: false,
      callElapsedSeconds: 0,
      recording: false,
      recordingElapsedSeconds: 0,
      connectionQuality: "good",
      reactions: [],
      status: "Câmera bloqueada",
      devices: { microphones: [], cameras: [], speakers: [] },
      selectedMicrophoneId: "",
      selectedCameraId: "",
      selectedSpeakerId: "",
      supportsSpeakerSelection: true,
      isHost: true,
      requestCameraPermission,
    } as unknown as ReturnTypeOfTeamCall;

    render(<TeamCallOverlay call={call} messages={[]} members={[]} currentUserId="owner" onSendMessage={vi.fn()} onDownloadAttachment={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Câmera > Permitir");
    fireEvent.click(screen.getByRole("button", { name: "Permitir câmera" }));
    expect(requestCameraPermission).toHaveBeenCalledOnce();
  });

  it("permite liberar e listar cameras dentro do painel de dispositivos", async () => {
    const requestCameraPermission = vi.fn().mockResolvedValue(true);
    const refreshDevices = vi.fn().mockResolvedValue(undefined);
    const call = {
      incoming: null,
      active: { callId: "call_0123456789abcdef", mode: "audio", title: "Time todo", hostUserId: "owner", startedAt: new Date().toISOString(), thread: { scope: "team", title: "Time todo" } },
      localStream: null,
      screenStream: null,
      remoteStreams: [],
      remoteScreenSharingIds: [],
      muted: false,
      cameraOff: true,
      cameraPermission: "unknown",
      sharingScreen: false,
      callElapsedSeconds: 0,
      recording: false,
      recordingElapsedSeconds: 0,
      connectionQuality: "good",
      reactions: [],
      status: "Na chamada",
      devices: { microphones: [], cameras: [], speakers: [] },
      selectedMicrophoneId: "",
      selectedCameraId: "",
      selectedSpeakerId: "",
      supportsSpeakerSelection: true,
      isHost: true,
      requestCameraPermission,
      refreshDevices,
    } as unknown as ReturnTypeOfTeamCall;

    render(<TeamCallOverlay call={call} messages={[]} members={[]} currentUserId="owner" onSendMessage={vi.fn()} onDownloadAttachment={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Selecionar câmera e dispositivos de áudio" }));
    expect(screen.getByText("Câmera · permissão pendente")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Permitir e listar câmeras" }));
    await waitFor(() => expect(requestCameraPermission).toHaveBeenCalledOnce());
    await waitFor(() => expect(refreshDevices).toHaveBeenCalledOnce());
  });

  it("mostra a mini visualizacao da tela compartilhada e mantem o chat legivel", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const screenStream = {} as MediaStream;
    const call = {
      incoming: null,
      active: { callId: "call_0123456789abcdef", mode: "audio", title: "Time todo", hostUserId: "owner", startedAt: new Date().toISOString(), thread: { scope: "team", title: "Time todo" } },
      localStream: null,
      screenStream,
      remoteStreams: [],
      remoteScreenSharingIds: [],
      muted: false,
      cameraOff: true,
      cameraPermission: "granted",
      sharingScreen: true,
      callElapsedSeconds: 10,
      recording: false,
      recordingElapsedSeconds: 0,
      connectionQuality: "good",
      reactions: [],
      status: "Sua tela está visível para os participantes",
      devices: { microphones: [], cameras: [], speakers: [] },
      selectedMicrophoneId: "",
      selectedCameraId: "",
      selectedSpeakerId: "",
      supportsSpeakerSelection: true,
      isHost: true,
      toggleScreenShare: vi.fn(),
    } as unknown as ReturnTypeOfTeamCall;

    render(<TeamCallOverlay call={call} messages={[{ id: "message-1", senderId: "owner", senderName: "Owner", text: "Texto com contraste", attachments: [], createdAt: new Date().toISOString() }]} members={[]} currentUserId="owner" onSendMessage={vi.fn()} onDownloadAttachment={vi.fn()} />);

    expect(screen.getByLabelText("Prévia da sua tela compartilhada")).toBeInTheDocument();
    expect(screen.getByLabelText("Mini visualização da sua tela compartilhada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir chat da reunião" }));
    expect(screen.getByText("Texto com contraste")).toHaveClass("team-call-chat-message-mine");
  });
});
