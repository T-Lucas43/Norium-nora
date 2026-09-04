// Fixture de desenvolvimento: reutiliza hook, overlay e protocolo reais.
// Somente os dispositivos sao sinteticos; nao acessa camera/microfone fisicos.
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTeamCall } from "../../src/components/team-chat/useTeamCall";
import TeamCallOverlay from "../../src/components/team-chat/TeamCallOverlay";
import TeamActiveCallCard from "../../src/components/team-chat/TeamActiveCallCard";
import "../../src/index.css";

const requestedUser = new URLSearchParams(location.search).get("user");
const userId = requestedUser === "member" || requestedUser === "other" ? requestedUser : "owner";
const members = [{ id: "owner", nome: "Owner" }, { id: "member", nome: "Member" }, { id: "other", nome: "Other" }];
function syntheticVideo(label: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 360;
  const context = canvas.getContext("2d")!;
  const draw = () => {
    context.fillStyle = label.startsWith("Tela") ? (label.endsWith("1") ? "#12539c" : "#8536b5") : "#156345";
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "white"; context.font = "30px sans-serif";
    context.fillText(`${label} · ${userId}`, 30, 80);
    context.fillText(String(Date.now()), 30, 160);
  };
  draw();
  const timer = window.setInterval(draw, 100);
  const stream = canvas.captureStream(15);
  const track = stream.getVideoTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => { window.clearInterval(timer); stop(); };
  return stream;
}
function syntheticAudio(frequency: number) {
  const context = new AudioContext();
  void context.resume();
  const destination = context.createMediaStreamDestination();
  const tone = context.createOscillator(); tone.frequency.value = frequency;
  const gain = context.createGain(); gain.gain.value = 0.05;
  tone.connect(gain).connect(destination); tone.start();
  const track = destination.stream.getAudioTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => { tone.stop(); void context.close(); stop(); };
  return destination.stream;
}
let displayNumber = 0;
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
  getUserMedia: async ({ video }: { video: unknown }) => {
    if (video) {
      return syntheticVideo("Câmera");
    }
    return syntheticAudio(220);
  },
  getDisplayMedia: async () => {
    if ((window as any).__cancelNextDisplay) { (window as any).__cancelNextDisplay = false; throw new DOMException("Cancelado", "NotAllowedError"); }
    const stream = new MediaStream([...syntheticVideo(`Tela ${++displayNumber}`).getTracks(), ...syntheticAudio(880).getTracks()]);
    ((window as any).__displayStreams ||= []).push(stream);
    return stream;
  },
  enumerateDevices: async () => [],
  addEventListener() {}, removeEventListener() {},
} });
const session = { token: userId, user: { id: userId, nome: userId, permissions: {}, role: "owner" } } as any;

export function Fixture() {
  const socket = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const sendSocketEvent = useCallback((event: Record<string, unknown>) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(event));
    return true;
  }, []);
  const call = useTeamCall({ session, thread: { scope: "team", title: "Time todo" }, sendSocketEvent });
  const handle = useRef(call.handleSocketEvent);
  handle.current = call.handleSocketEvent;
  useEffect(() => {
    const ws = new WebSocket(`ws://127.0.0.1:8000/api/team-chat/ws?ticket=${userId}`);
    socket.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (event) => void handle.current(JSON.parse(event.data));
    return () => ws.close();
  }, []);
  return <main style={{ maxWidth: 760, margin: "40px auto", padding: 24 }}>
    <h1>Teste local · {userId}</h1>
    <p>{connected ? "Conectado" : "Conectando"}</p>
    <p>Reuniões ativas: {call.availableCalls.length}</p>
    <button disabled={!connected || call.busy} onClick={() => void call.startCall()} className="m-4 rounded bg-blue-600 px-4 py-2 text-white">Iniciar reunião</button>
    {call.availableCalls.map((meeting) => <TeamActiveCallCard key={meeting.callId} meeting={meeting} busy={call.busy} onJoin={() => void call.joinActiveCall(meeting)} />)}
    <p>{call.status}</p>
    <TeamCallOverlay call={call} members={members} currentUserId={userId} onDownloadAttachment={() => {}} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
