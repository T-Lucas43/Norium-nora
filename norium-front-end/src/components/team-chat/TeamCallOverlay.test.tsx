import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TeamCallOverlay from "./TeamCallOverlay";
import type { ReturnTypeOfTeamCall } from "./teamCallTypes";

describe("tela da reuniao do Modo Equipe", () => {
  it("exibe gravacao, chat, dispositivos, qualidade, reacoes e compartilhamento", () => {
    const call = {
      incoming: null,
      active: { callId: "call_0123456789abcdef", mode: "video", title: "Comercial", hostUserId: "owner", thread: { scope: "team", title: "Comercial" } },
      localStream: null,
      remoteStreams: [],
      muted: false,
      cameraOff: false,
      sharingScreen: false,
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
      toggleMute: vi.fn(),
      endCall: vi.fn(),
      leaveCall: vi.fn(),
      refreshDevices: vi.fn(),
      selectMicrophone: vi.fn(),
      selectCamera: vi.fn(),
      selectSpeaker: vi.fn(),
    } as unknown as ReturnTypeOfTeamCall;

    render(<TeamCallOverlay call={call} messages={[]} members={[{ id: "owner", nome: "Owner" }]} currentUserId="owner" onSendMessage={vi.fn()} onDownloadAttachment={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Gravar reunião" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transmitir tela" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Qualidade da internet: Conexão excelente" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Abrir chat da reunião" }));
    expect(screen.getByRole("heading", { name: "Chat da reunião" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enviar reação com emoji" }));
    fireEvent.click(screen.getByRole("button", { name: "Reagir com 👍" }));
    expect(call.sendReaction).toHaveBeenCalledWith("👍");

    fireEvent.click(screen.getByRole("button", { name: "Selecionar câmera e dispositivos de áudio" }));
    expect(screen.getByLabelText("Dispositivos da chamada")).toBeInTheDocument();
    expect(screen.getByText("Dispositivo de entrada")).toBeInTheDocument();
    expect(screen.getByText("Dispositivo de saída")).toBeInTheDocument();
  });
});
