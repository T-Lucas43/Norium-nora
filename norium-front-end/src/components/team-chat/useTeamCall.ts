import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../types/auth";

export type TeamThreadScope = "team" | "direct" | "subteam";

export type TeamCallThread = {
  scope: TeamThreadScope;
  title: string;
  recipientId?: string | null;
  subteamId?: string | null;
};

export type TeamCallSocketEvent = {
  type: string;
  callId?: string;
  scope?: TeamThreadScope;
  threadId?: string;
  recipientId?: string | null;
  subteamId?: string | null;
  fromUserId?: string;
  fromUserName?: string;
  mode?: "audio" | "video";
  signal?: RTCSessionDescriptionInit | RTCIceCandidateInit;
  detail?: string;
};

type ActiveCall = {
  callId: string;
  mode: "audio" | "video";
  title: string;
  thread: TeamCallThread;
};

type IncomingCall = ActiveCall & {
  fromUserId: string;
  fromUserName: string;
};

function configuredIceServers(): RTCIceServer[] {
  const raw = (import.meta.env.VITE_TEAM_CALL_ICE_SERVERS as string | undefined)?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as RTCIceServer[];
    } catch {
      // Uma configuracao invalida nao deve impedir chamadas na mesma rede.
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

function callId() {
  return `call_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function useTeamCall({
  session,
  thread,
  sendSocketEvent,
}: {
  session: AuthSession;
  thread: TeamCallThread;
  sendSocketEvent: (payload: Record<string, unknown>) => boolean;
}) {
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Array<{ userId: string; stream: MediaStream }>>([]);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [status, setStatus] = useState("");
  const activeRef = useRef<ActiveCall | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const screenStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const callPayload = useCallback((call: ActiveCall) => ({
    callId: call.callId,
    mode: call.mode,
    scope: call.thread.scope,
    recipientId: call.thread.recipientId || null,
    subteamId: call.thread.subteamId || null,
  }), []);

  const closePeer = useCallback((userId: string) => {
    peersRef.current.get(userId)?.close();
    peersRef.current.delete(userId);
    pendingCandidatesRef.current.delete(userId);
    setRemoteStreams((current) => current.filter((item) => item.userId !== userId));
  }, []);

  const stopMedia = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setSharingScreen(false);
  }, []);

  const finishCall = useCallback((notify: boolean) => {
    const call = activeRef.current;
    if (notify && call) sendSocketEvent({ type: "CALL_END", ...callPayload(call) });
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    setRemoteStreams([]);
    stopMedia();
    setIncoming(null);
    setActive(null);
    activeRef.current = null;
    setMuted(false);
    setCameraOff(false);
    setStatus("");
  }, [callPayload, sendSocketEvent, stopMedia]);

  useEffect(() => () => finishCall(false), [finishCall]);

  const acquireMedia = useCallback(async (mode: "audio" | "video") => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador nao permite acesso ao microfone e a camera.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mode === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  }, []);

  const createPeer = useCallback(async (remoteUserId: string, createOffer: boolean) => {
    const call = activeRef.current;
    if (!call || remoteUserId === session.user.id) return null;
    let peer = peersRef.current.get(remoteUserId);
    if (!peer) {
      peer = new RTCPeerConnection({ iceServers: configuredIceServers() });
      peersRef.current.set(remoteUserId, peer);
      localStreamRef.current?.getTracks().forEach((track) => peer?.addTrack(track, localStreamRef.current as MediaStream));
      peer.onicecandidate = (event) => {
        const current = activeRef.current;
        if (event.candidate && current) {
          sendSocketEvent({
            type: "CALL_SIGNAL",
            ...callPayload(current),
            targetUserId: remoteUserId,
            signal: event.candidate.toJSON(),
          });
        }
      };
      peer.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        setRemoteStreams((current) => [
          ...current.filter((item) => item.userId !== remoteUserId),
          { userId: remoteUserId, stream },
        ]);
      };
      peer.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(peer?.connectionState || "")) closePeer(remoteUserId);
      };
    }
    if (createOffer && peer.signalingState === "stable") {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      sendSocketEvent({
        type: "CALL_SIGNAL",
        ...callPayload(call),
        targetUserId: remoteUserId,
        signal: offer,
      });
    }
    return peer;
  }, [callPayload, closePeer, sendSocketEvent, session.user.id]);

  const startCall = useCallback(async (mode: "audio" | "video") => {
    if (activeRef.current) return;
    setStatus("Solicitando permissao do dispositivo...");
    try {
      await acquireMedia(mode);
      const call: ActiveCall = { callId: callId(), mode, title: thread.title, thread };
      activeRef.current = call;
      setActive(call);
      setStatus("Chamando a equipe...");
      if (!sendSocketEvent({ type: "CALL_INVITE", ...callPayload(call) })) {
        throw new Error("A conexao em tempo real ainda nao esta pronta.");
      }
    } catch (error) {
      finishCall(false);
      setStatus(error instanceof Error ? error.message : "Nao foi possivel iniciar a chamada.");
    }
  }, [acquireMedia, callPayload, finishCall, sendSocketEvent, thread]);

  const acceptIncoming = useCallback(async () => {
    if (!incoming) return;
    setStatus("Conectando dispositivos...");
    try {
      await acquireMedia(incoming.mode);
      const call: ActiveCall = { ...incoming };
      activeRef.current = call;
      setActive(call);
      setIncoming(null);
      sendSocketEvent({ type: "CALL_ACCEPT", ...callPayload(call) });
      setStatus("Na chamada");
    } catch (error) {
      sendSocketEvent({ type: "CALL_REJECT", ...callPayload(incoming) });
      finishCall(false);
      setStatus(error instanceof Error ? error.message : "Nao foi possivel acessar o dispositivo.");
    }
  }, [acquireMedia, callPayload, finishCall, incoming, sendSocketEvent]);

  const rejectIncoming = useCallback(() => {
    if (incoming) sendSocketEvent({ type: "CALL_REJECT", ...callPayload(incoming) });
    setIncoming(null);
  }, [callPayload, incoming, sendSocketEvent]);

  const handleSocketEvent = useCallback(async (event: TeamCallSocketEvent) => {
    if (!event.callId || !event.fromUserId || event.fromUserId === session.user.id) {
      if (event.type === "CALL_ERROR" && event.detail) setStatus(event.detail);
      return;
    }
    if (event.type === "CALL_INVITE") {
      if (activeRef.current) {
        sendSocketEvent({
          type: "CALL_REJECT",
          callId: event.callId,
          mode: event.mode || "audio",
          scope: event.scope || "team",
          recipientId: event.recipientId || null,
          subteamId: event.subteamId || null,
        });
        return;
      }
      setIncoming({
        callId: event.callId,
        mode: event.mode || "audio",
        title: event.fromUserName || "Chamada da equipe",
        fromUserId: event.fromUserId,
        fromUserName: event.fromUserName || "Membro",
        thread: {
          scope: event.scope || "team",
          title: event.fromUserName || "Chamada da equipe",
          recipientId: event.recipientId || null,
          subteamId: event.subteamId || null,
        },
      });
      return;
    }
    const call = activeRef.current;
    if (!call || call.callId !== event.callId) return;
    if (event.type === "CALL_ACCEPT") {
      setStatus("Na chamada");
      await createPeer(event.fromUserId, true);
      return;
    }
    if (event.type === "CALL_SIGNAL" && event.signal) {
      const peer = await createPeer(event.fromUserId, false);
      if (!peer) return;
      if ("type" in event.signal && event.signal.type) {
        await peer.setRemoteDescription(event.signal as RTCSessionDescriptionInit);
        const pendingCandidates = pendingCandidatesRef.current.get(event.fromUserId) || [];
        for (const candidate of pendingCandidates) await peer.addIceCandidate(candidate);
        pendingCandidatesRef.current.delete(event.fromUserId);
        if (event.signal.type === "offer") {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          sendSocketEvent({
            type: "CALL_SIGNAL",
            ...callPayload(call),
            targetUserId: event.fromUserId,
            signal: answer,
          });
        }
      } else if ("candidate" in event.signal) {
        if (peer.remoteDescription) {
          await peer.addIceCandidate(event.signal as RTCIceCandidateInit);
        } else {
          pendingCandidatesRef.current.set(event.fromUserId, [
            ...(pendingCandidatesRef.current.get(event.fromUserId) || []),
            event.signal as RTCIceCandidateInit,
          ]);
        }
      }
      return;
    }
    if (event.type === "CALL_REJECT") {
      setStatus(`${event.fromUserName || "Um participante"} recusou a chamada.`);
      return;
    }
    if (event.type === "CALL_END") finishCall(false);
  }, [callPayload, createPeer, finishCall, sendSocketEvent, session.user.id]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOff;
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = !next; });
    setCameraOff(next);
  }, [cameraOff]);

  const stopScreenShare = useCallback(async () => {
    const activeScreen = screenStreamRef.current;
    screenStreamRef.current = null;
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;
    await Promise.all(Array.from(peersRef.current.values()).map(async (peer) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      if (sender) await sender.replaceTrack(cameraTrack);
    }));
    activeScreen?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    setSharingScreen(false);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (sharingScreen) {
      await stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus("Compartilhamento de tela indisponivel neste navegador.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = stream.getVideoTracks()[0];
      screenStreamRef.current = stream;
      await Promise.all(Array.from(peersRef.current.values()).map(async (peer) => {
        const sender = peer.getSenders().find((item) => item.track?.kind === "video");
        if (sender) await sender.replaceTrack(screenTrack);
      }));
      screenTrack.onended = () => { void stopScreenShare(); };
      setSharingScreen(true);
    } catch {
      setStatus("Compartilhamento de tela cancelado.");
    }
  }, [sharingScreen, stopScreenShare]);

  return {
    incoming,
    active,
    localStream,
    remoteStreams,
    muted,
    cameraOff,
    sharingScreen,
    status,
    startCall,
    acceptIncoming,
    rejectIncoming,
    endCall: () => finishCall(true),
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    handleSocketEvent,
  };
}
