// Fixture de desenvolvimento: reutiliza hook, overlay e protocolo reais.
// Somente os dispositivos sao sinteticos; nao acessa camera/microfone fisicos.
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTeamCall } from "../../src/components/team-chat/useTeamCall";
import TeamCallOverlay from "../../src/components/team-chat/TeamCallOverlay";
import TeamActiveCallCard from "../../src/components/team-chat/TeamActiveCallCard";
import "../../src/index.css";

const userId = new URLSearchParams(location.search).get("user") === "member" ? "member" : "owner";
const members = [{ id: "owner", nome: "Owner" }, { id: "member", nome: "Member" }];
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
  getUserMedia: async ({ video }: { video: unknown }) => {
    if (video) {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 360;
      canvas.getContext("2d")!.fillRect(0, 0, 640, 360);
      return canvas.captureStream(15);
    }
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    return destination.stream;
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
    <TeamCallOverlay call={call} messages={[]} members={members} currentUserId={userId} onSendMessage={async () => {}} onDownloadAttachment={() => {}} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
