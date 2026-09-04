import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TeamCallOverlay from "./TeamCallOverlay";
import type { CallSessionCommands, CallSessionSnapshot } from "./CallSession";
import type { ReturnTypeOfTeamCall } from "./teamCallTypes";

function sessionProps(call: ReturnTypeOfTeamCall) {
  return {
    snapshot: call as unknown as CallSessionSnapshot,
    commands: {
      accept: call.acceptIncoming,
      reject: call.rejectIncoming,
      end: call.endCall,
      leave: call.leaveCall,
      toggleMute: call.toggleMute,
      toggleCamera: call.toggleCamera,
      requestCameraPermission: call.requestCameraPermission,
      toggleScreenShare: call.toggleScreenShare,
      changeScreenShare: call.changeScreenShare,
      startRecording: call.startRecording,
      stopRecording: call.stopRecording,
      sendReaction: call.sendReaction,
      toggleHand: call.toggleHand,
      sendMeetingMessage: call.sendMeetingMessage,
      selectMicrophone: call.selectMicrophone,
      selectCamera: call.selectCamera,
      selectSpeaker: call.selectSpeaker,
      selectScreenShareQuality: call.selectScreenShareQuality,
      selectScreenShareFps: call.selectScreenShareFps,
      refreshDevices: call.refreshDevices,
    } as unknown as CallSessionCommands,
  };
}

describe("tela da reuniao do Modo Equipe", () => {
  it("exibe reuniao unificada, duracao, camera, anexos e compartilhamento", () => {
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
      recording: true,
      recordingElapsedSeconds: 10,
      recordingUploadState: "uploading",
      recordingUploadedBytes: 1024,
      recordingPendingBytes: 1024,
      recordingUploadProgress: 50,
      connectionQuality: "good",
      reactions: [],
      status: "Na chamada",
      devices: { microphones: [], cameras: [], speakers: [] },
      selectedMicrophoneId: "",
      selectedCameraId: "",
      selectedSpeakerId: "",
      screenShareQuality: "1080p",
      screenShareFps: 30,
      supportsSpeakerSelection: true,
      isHost: true,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      sendReaction: vi.fn(),
      toggleHand: vi.fn(),
      sendMeetingMessage: vi.fn().mockRejectedValue(new Error("Sem conexão")),
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
      selectScreenShareQuality: vi.fn(),
      selectScreenShareFps: vi.fn(),
    } as unknown as ReturnTypeOfTeamCall;

    render(<TeamCallOverlay {...sessionProps(call)} members={[{ id: "owner", nome: "Owner" }]} currentUserId="owner" onDownloadAttachment={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Parar gravação" })).toBeInTheDocument();
    expect(screen.getByText("Todos foram avisados")).toBeInTheDocument();
    expect(screen.getByText(/Upload 50%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transmitir tela" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ativar câmera" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Qualidade da internet: Conexão excelente" })).toBeInTheDocument();
    expect(screen.getByText(/01:05/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Configurar qualidade da transmissão" }));
    fireEvent.change(screen.getByLabelText("Qualidade da transmissão"), { target: { value: "720p" } });
    fireEvent.change(screen.getByLabelText("Taxa de quadros"), { target: { value: "60" } });
    expect(call.selectScreenShareQuality).toHaveBeenCalledWith("720p");
    expect(call.selectScreenShareFps).toHaveBeenCalledWith(60);

    fireEvent.click(screen.getByRole("button", { name: "Abrir chat da reunião" }));
    expect(screen.getByRole("heading", { name: "Chat da reunião" })).toBeInTheDocument();
    const meetingFile = new File(["conteudo"], "pauta.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Anexar arquivos no chat da reunião").querySelector("input") as HTMLInputElement, { target: { files: [meetingFile] } });
    expect(screen.getByText("pauta.pdf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enviar reação com emoji" }));
    fireEvent.click(screen.getByRole("button", { name: "Reagir com 👍" }));
    expect(call.sendReaction).toHaveBeenCalledWith("👍");
    fireEvent.click(screen.getByRole("button", { name: "Levantar a mão" }));
    expect(call.toggleHand).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Minimizar chamada" }));
    expect(screen.getByLabelText("Chamada minimizada")).toBeVisible();
    expect(call.endCall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restaurar chamada" }));
    expect(screen.queryByLabelText("Chamada minimizada")).toBeNull();

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

    render(<TeamCallOverlay {...sessionProps(call)} members={[]} currentUserId="owner" onDownloadAttachment={vi.fn()} />);

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

    render(<TeamCallOverlay {...sessionProps(call)} members={[]} currentUserId="owner" onDownloadAttachment={vi.fn()} />);
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

    const callWithMessage = { ...call, meetingMessages: [{ id: "message-1", senderId: "owner", senderName: "Owner", text: "Texto com contraste", attachments: [], createdAt: new Date().toISOString() }] } as unknown as ReturnTypeOfTeamCall;
    render(<TeamCallOverlay {...sessionProps(callWithMessage)} members={[]} currentUserId="owner" onDownloadAttachment={vi.fn()} />);

    expect(screen.getByLabelText("Prévia da sua tela compartilhada")).toBeInTheDocument();
    expect(screen.getByLabelText("Mini visualização da sua tela compartilhada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir chat da reunião" }));
    expect(screen.getByText("Texto com contraste")).toHaveClass("team-call-chat-message-mine");
  });

  it("permite abrir a tela compartilhada remota em tela cheia", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: requestFullscreen });
    const remoteVideoTrack = {
      id: "remote-screen",
      kind: "video",
      muted: false,
      readyState: "live",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaStreamTrack;
    class FakeMediaStream {
      private readonly tracks: MediaStreamTrack[];
      constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks; }
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
      getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
    }
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const remoteStream = new FakeMediaStream([remoteVideoTrack]) as unknown as MediaStream;
    const call = {
      incoming: null,
      active: { callId: "call_0123456789abcdef", mode: "audio", title: "Time todo", hostUserId: "owner", startedAt: new Date().toISOString(), thread: { scope: "team", title: "Time todo" } },
      localStream: null,
      screenStream: null,
      remoteStreams: [{ userId: "member", stream: remoteStream }],
      remoteScreenSharingIds: ["member"],
      muted: false,
      cameraOff: true,
      cameraPermission: "granted",
      sharingScreen: false,
      callElapsedSeconds: 10,
      recording: false,
      recordingElapsedSeconds: 0,
      connectionQuality: "good",
      reactions: [],
      status: "Transmissão de tela recebida",
      devices: { microphones: [], cameras: [], speakers: [] },
      selectedMicrophoneId: "",
      selectedCameraId: "",
      selectedSpeakerId: "",
      screenShareQuality: "1080p",
      screenShareFps: 30,
      supportsSpeakerSelection: true,
      isHost: true,
    } as unknown as ReturnTypeOfTeamCall;

    const props = { members: [{ id: "member", nome: "Fernando" }], currentUserId: "owner", onDownloadAttachment: vi.fn() };
    const { rerender } = render(<TeamCallOverlay {...sessionProps(call)} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver tela de Fernando em tela cheia" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("slider", { name: "Volume de Fernando" }), { target: { value: "175" } });
    expect(screen.getByText("175%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Silenciar Fernando para mim" }));
    expect(screen.getByLabelText("Áudio de Fernando")).toHaveProperty("muted", true);
    const audioElement = screen.getByLabelText("Áudio de Fernando");
    fireEvent.click(screen.getByRole("button", { name: "Minimizar chamada" }));
    expect(document.querySelector('audio[aria-label="Áudio de Fernando"]')).toBe(audioElement);
    fireEvent.click(screen.getByRole("button", { name: "Restaurar chamada" }));
    expect(screen.getByText("175%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fixar transmissão de Fernando" }));
    expect(document.querySelector('[data-participant="member"]')).toHaveAttribute("data-pinned", "true");
    const oldVideo = screen.getByLabelText("Tela compartilhada por Fernando");
    const cameraOffCall = { ...call, remoteScreenSharingIds: [], remoteCameraEnabled: { member: false } } as unknown as ReturnTypeOfTeamCall;
    rerender(<TeamCallOverlay {...sessionProps(cameraOffCall)} {...props} />);
    expect(oldVideo).toHaveProperty("srcObject", null);
    expect(screen.getByLabelText("Câmera de Fernando")).toHaveProperty("srcObject", null);
    expect(screen.getByText("Fernando está sem câmera")).toBeInTheDocument();
    expect(document.querySelector('[data-participant="member"]')).not.toHaveAttribute("data-pinned");
    expect(screen.getByText("175%")).toBeInTheDocument();
    expect(screen.getByLabelText("Áudio de Fernando")).toHaveProperty("muted", true);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir Fernando para mim" }));
    fireEvent.click(screen.getByRole("button", { name: "Fixar Fernando" }));
    expect(document.querySelector('[data-participant="member"]')).toHaveAttribute("data-pinned", "true");
    const participantLeftCall = { ...call, remoteStreams: [] } as unknown as ReturnTypeOfTeamCall;
    rerender(<TeamCallOverlay {...sessionProps(participantLeftCall)} {...props} />);
    expect(document.querySelector('[data-pinned]')).toBeNull();
  });
});
