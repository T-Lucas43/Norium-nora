import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EventSource,
  OmnichannelEvent,
  SystemNotification,
  SystemNotificationSeverity,
  SystemNotificationToast,
} from "../types/omnichannel";
import { apiBaseUrl, authenticatedWebSocketUrl, authToken, wsBaseUrl } from "../utils/api";
import type { TeamCallSocketEvent } from "../components/team-chat/useTeamCall";

const API_URL = `${apiBaseUrl()}/api/omnichannel/inbox`;
const WS_URL = `${wsBaseUrl()}/api/omnichannel/ws`;
const TEAM_WS_URL = `${wsBaseUrl()}/api/team-chat/ws`;
const CALENDAR_SYNC_URL = `${apiBaseUrl()}/api/agenda/sync`;
const GMAIL_SYNC_URL = `${apiBaseUrl()}/api/emails/gmail/sync-central`;
const NOTIFICATION_STATE_URL = `${apiBaseUrl()}/api/omnichannel/notifications/state`;
const NOTIFICATION_READ_URL = `${apiBaseUrl()}/api/omnichannel/notifications/read-all`;
const NOTIFICATION_CLEAR_URL = `${apiBaseUrl()}/api/omnichannel/notifications`;
const NOTIFICATIONS_TAB = "Notificações";

type SocketMessage = {
  type?: string;
  event?: OmnichannelEvent;
  notification?: Partial<SystemNotification>;
  title?: string;
  description?: string;
  severity?: SystemNotificationSeverity;
};

type TeamSocketMessage = {
  type?: string;
  callId?: string;
  scope?: "team" | "direct" | "subteam";
  threadId?: string;
  recipientId?: string | null;
  subteamId?: string | null;
  fromUserId?: string;
  fromUserName?: string;
  mode?: "audio" | "video";
  startedAt?: string;
  calls?: TeamCallSocketEvent[];
  message?: {
    id?: string;
    senderId?: string;
    senderName?: string;
    text?: string;
    metadata?: Record<string, unknown>;
  };
};

type NotificationState = {
  userId: string;
  readBefore?: string | null;
  clearedBefore?: string | null;
};

function sortEvents(events: OmnichannelEvent[]) {
  return [...events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function mergeEvent(events: OmnichannelEvent[], nextEvent: OmnichannelEvent) {
  const withoutDuplicate = events.filter((event) => event.id !== nextEvent.id);
  return sortEvents([nextEvent, ...withoutDuplicate]).slice(0, 1000);
}

function requestHeaders(): HeadersInit {
  const token = authToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function groupEventsBySource(events: OmnichannelEvent[]) {
  return events.reduce<Record<EventSource, OmnichannelEvent[]>>(
    (groups, event) => {
      if (!groups[event.source]) groups[event.source] = [];
      groups[event.source] = [...groups[event.source], event];
      return groups;
    },
    {
      gmail: [],
      whatsapp: [],
      calendar: [],
      kanban: [],
      financeiro: [],
      equipe: [],
      automacoes: [],
      brainstorm: [],
      relatorios: [],
      sistema: [],
    },
  );
}

function buildSystemNotification(
  payload: {
    id?: string;
    title: string;
    description: string;
    timestamp?: string;
    severity?: SystemNotificationSeverity;
    read?: boolean;
    metadata?: Record<string, unknown>;
  },
): SystemNotification {
  const timestamp = payload.timestamp || new Date().toISOString();
  return {
    id: payload.id || `sys_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    title: payload.title,
    description: payload.description,
    timestamp,
    severity: payload.severity ?? "info",
    read: payload.read ?? false,
    metadata: payload.metadata,
  };
}

function eventBelongsToUser(event: OmnichannelEvent, userId: string) {
  return String(event.metadata?.userId || "") === userId;
}

function notificationForEvent(event: OmnichannelEvent, read = false): SystemNotification {
  const action = String(event.metadata?.action || "").toLocaleLowerCase("pt-BR");
  const normalized = `${action} ${event.title}`.toLocaleLowerCase("pt-BR");
  let title = event.title || "Nova atividade no Norium";
  let severity: SystemNotificationSeverity = "info";

  if (event.source === "equipe" && action === "team_message_created") title = "Nova mensagem no chat da equipe";
  else if (event.source === "equipe" && action === "team_meeting_scheduled") title = "Reunião agendada no chat da equipe";
  else if (event.source === "equipe" && action === "team_meeting_reminder") {
    title = "Reunião em 10 minutos";
    severity = "warning";
  }
  else if (event.source === "kanban" && event.metadata?.assigneeId) title = "Tarefa atribuida ou atualizada";
  else if (event.source === "gmail") title = "Nova atividade de e-mail";
  else if (event.source === "calendar") title = "Atualizacao na agenda";

  if (normalized.includes("approval_requested") || normalized.includes("aprovacao pendente")) {
    title = "Nova aprovacao pendente";
    severity = "warning";
  } else if (normalized.includes("error") || normalized.includes("falh") || normalized.includes("interromp")) {
    severity = "error";
  } else if (normalized.includes("conclu") || normalized.includes("resolvid") || normalized.includes("aprovad")) {
    severity = "success";
  }

  return {
    id: `notification_${event.id}`,
    title,
    description: event.description || "Uma nova atividade requer sua atencao.",
    timestamp: event.timestamp,
    severity,
    read,
    metadata: { ...event.metadata, source: event.source, eventId: event.id, action },
  };
}

function eventShouldNotify(event: OmnichannelEvent) {
  if (event.source !== "gmail") return true;
  const folder = String(event.metadata?.folder || "").toLocaleLowerCase("pt-BR");
  return folder !== "sent" && folder !== "drafts";
}

function happenedAfter(timestamp: string, boundary?: string | null) {
  if (!boundary) return true;
  const itemTime = Date.parse(timestamp);
  const boundaryTime = Date.parse(boundary);
  return Number.isNaN(itemTime) || Number.isNaN(boundaryTime) || itemTime > boundaryTime;
}

export function useWebSockets(
  activeTab: string,
  enabled = true,
  userId = "primary",
  teamChatOpen = false,
) {
  const [stateUserId, setStateUserId] = useState(userId);
  const [events, setEvents] = useState<OmnichannelEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [systemNotifications, setSystemNotifications] = useState<SystemNotification[]>([]);
  const [systemUnreadCount, setSystemUnreadCount] = useState(0);
  const [systemToasts, setSystemToasts] = useState<SystemNotificationToast[]>([]);
  const [teamChatUnreadCount, setTeamChatUnreadCount] = useState(0);

  const activeTabRef = useRef(activeTab);
  const socketRef = useRef<WebSocket | null>(null);
  const teamSocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const hasOpenedRef = useRef(false);
  const lastConnectionStateRef = useRef<"online" | "offline" | null>(null);
  const integrationSyncInFlightRef = useRef(false);
  const teamChatOpenRef = useRef(teamChatOpen);
  const seenTeamMessageIdsRef = useRef<Set<string>>(new Set());
  const seenTeamCallIdsRef = useRef<Set<string>>(new Set());
  const endedTeamCallIdsRef = useRef<Set<string>>(new Set());
  const meetingNotificationsRef = useRef(new Map<string, Notification>());
  const notificationsRef = useRef(systemNotifications);
  notificationsRef.current = systemNotifications;
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const currentUserIdRef = useRef(userId);
  currentUserIdRef.current = userId;
  const isolatedForCurrentUser = stateUserId === userId;

  const visibleEvents = useMemo(
    () => (isolatedForCurrentUser ? events : []),
    [events, isolatedForCurrentUser],
  );
  const eventsBySource = useMemo(() => groupEventsBySource(visibleEvents), [visibleEvents]);

  useEffect(() => {
    setEvents([]);
    setSystemNotifications([]);
    setSystemUnreadCount(0);
    setSystemToasts([]);
    setTeamChatUnreadCount(0);
    seenTeamMessageIdsRef.current.clear();
    seenTeamCallIdsRef.current.clear();
    endedTeamCallIdsRef.current.clear();
    meetingNotificationsRef.current.forEach((notification) => notification.close());
    meetingNotificationsRef.current.clear();
    seenEventIdsRef.current.clear();
    hasOpenedRef.current = false;
    lastConnectionStateRef.current = null;
    integrationSyncInFlightRef.current = false;
    setStateUserId(userId);
  }, [userId]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    teamChatOpenRef.current = teamChatOpen;
    if (teamChatOpen) setTeamChatUnreadCount(0);
  }, [teamChatOpen]);

  const dismissSystemToast = useCallback((toastId: string) => {
    setSystemToasts((current) => current.filter((toast) => toast.id !== toastId));
  }, []);

  const dismissCallNotifications = useCallback((callId: string) => {
    meetingNotificationsRef.current.get(callId)?.close();
    meetingNotificationsRef.current.delete(callId);
    const removedUnread = notificationsRef.current.filter((notification) => notification.metadata?.callId === callId && !notification.read).length;
    notificationsRef.current = notificationsRef.current.filter((notification) => notification.metadata?.callId !== callId);
    setSystemNotifications((current) => current.filter((notification) => notification.metadata?.callId !== callId));
    setSystemToasts((current) => current.filter((toast) => toast.notification.metadata?.callId !== callId));
    setSystemUnreadCount((current) => Math.max(0, current - removedUnread));
  }, []);

  useEffect(() => {
    const meetingNotifications = meetingNotificationsRef.current;
    const onDismiss = (event: Event) => {
      const callId = (event as CustomEvent<{ callId?: string }>).detail?.callId;
      if (callId) dismissCallNotifications(callId);
    };
    const onEnd = (event: Event) => {
      const payload = (event as CustomEvent<TeamCallSocketEvent>).detail;
      if (payload?.type === "CALL_END" && payload.callId) {
        endedTeamCallIdsRef.current.add(payload.callId);
        dismissCallNotifications(payload.callId);
      }
    };
    window.addEventListener("norium:team-call-dismiss", onDismiss);
    window.addEventListener("norium:team-call", onEnd);
    return () => {
      window.removeEventListener("norium:team-call-dismiss", onDismiss);
      window.removeEventListener("norium:team-call", onEnd);
      meetingNotifications.forEach((notification) => notification.close());
      meetingNotifications.clear();
    };
  }, [dismissCallNotifications]);

  const pushSystemNotification = useCallback(
    (payload: {
      id?: string;
      title: string;
      description: string;
      timestamp?: string;
      severity?: SystemNotificationSeverity;
      read?: boolean;
      metadata?: Record<string, unknown>;
      showToast?: boolean;
    }) => {
      const notification = buildSystemNotification(payload);
      // An invite and its end can arrive in one React batch. Keep the unread
      // bookkeeping synchronous so ending it cannot leave a ghost badge.
      notificationsRef.current = [notification, ...notificationsRef.current].slice(0, 80);
      setSystemNotifications((current) => [notification, ...current].slice(0, 80));

      if (activeTabRef.current !== NOTIFICATIONS_TAB) {
        setSystemUnreadCount((current) => current + 1);
      }

      if (payload.showToast !== false && activeTabRef.current !== NOTIFICATIONS_TAB) {
        const toast: SystemNotificationToast = {
          id: `toast_${notification.id}`,
          notification,
          createdAt: Date.now(),
        };
        setSystemToasts((current) => [...current, toast].slice(0, 20));
      }
    },
    [],
  );

  const activeSystemToastId = systemToasts[0]?.id;
  useEffect(() => {
    if (!activeSystemToastId) return undefined;
    const timer = window.setTimeout(() => dismissSystemToast(activeSystemToastId), 9000);
    return () => window.clearTimeout(timer);
  }, [activeSystemToastId, dismissSystemToast]);

  const notifyTeamMessage = useCallback(
    (message: { id?: string; senderId?: string; senderName?: string; text?: string; metadata?: Record<string, unknown> }) => {
      if (currentUserIdRef.current !== userId) return;
      const messageId = String(message.id || "");
      if (messageId && seenTeamMessageIdsRef.current.has(messageId)) return;
      if (messageId) {
        seenTeamMessageIdsRef.current.add(messageId);
        if (seenTeamMessageIdsRef.current.size > 400) {
          const oldest = seenTeamMessageIdsRef.current.values().next().value;
          if (oldest) seenTeamMessageIdsRef.current.delete(oldest);
        }
      }
      if (message.senderId === userId || teamChatOpenRef.current || ["call_started", "call_ended", "meeting_scheduled"].includes(String(message.metadata?.action || ""))) return;

      setTeamChatUnreadCount((current) => current + 1);
      pushSystemNotification({
        title: "Nova mensagem no chat da equipe",
        description: `${message.senderName || "Equipe"}: ${message.text || "Uma nova mensagem foi enviada."}`,
        severity: "info",
        metadata: {
          source: "equipe",
          action: "team_message_created",
          messageId,
          senderId: message.senderId,
        },
      });
    },
    [pushSystemNotification, userId],
  );

  const refreshEvents = useCallback(async () => {
    const requestedUserId = userId;
    try {
      const params = new URLSearchParams({ user_id: userId });
      const [response, stateResponse] = await Promise.all([
        fetch(`${API_URL}?${params.toString()}`, { headers: requestHeaders() }),
        fetch(NOTIFICATION_STATE_URL, { headers: requestHeaders() }),
      ]);
      if (!response.ok || !stateResponse.ok) throw new Error("Falha ao carregar a Central de Atividades.");
      const data = (await response.json()) as OmnichannelEvent[];
      const notificationState = (await stateResponse.json()) as NotificationState;
      if (currentUserIdRef.current !== requestedUserId) return;
      if (notificationState.userId !== requestedUserId) throw new Error("Estado de notificacao pertence a outro usuario.");
      const isolatedEvents = sortEvents(data.filter((event) => eventBelongsToUser(event, requestedUserId)));
      isolatedEvents.forEach((event) => seenEventIdsRef.current.add(event.id));
      setEvents(isolatedEvents);
      const storedNotifications = isolatedEvents
        .filter(eventShouldNotify)
        .filter((event) => happenedAfter(event.timestamp, notificationState.clearedBefore))
        .map((event) => notificationForEvent(event, !happenedAfter(event.timestamp, notificationState.readBefore)));
      setSystemNotifications(storedNotifications.slice(0, 80));
      setSystemUnreadCount(storedNotifications.filter((notification) => !notification.read).length);
    } catch {
      if (currentUserIdRef.current !== requestedUserId) return;
      pushSystemNotification({
        title: "Central de Atividades indisponivel",
        description: "Nao foi possivel carregar os eventos das integracoes agora.",
        severity: "error",
      });
      setEvents([]);
    }
  }, [pushSystemNotification, userId]);

  const syncIntegrationEvents = useCallback(async () => {
    if (integrationSyncInFlightRef.current) return;
    integrationSyncInFlightRef.current = true;
    try {
      let shouldRefresh = false;
      try {
        const calendarResponse = await fetch(`${CALENDAR_SYNC_URL}?user_id=${encodeURIComponent(userId)}`, { method: "POST", headers: requestHeaders() });
        shouldRefresh = shouldRefresh || calendarResponse.ok;
      } catch {
        // A sincronizacao silenciosa evita alertas repetidos quando a agenda ainda nao esta conectada.
      }

      try {
        const gmailResponse = await fetch(`${GMAIL_SYNC_URL}?user_id=${encodeURIComponent(userId)}`, { method: "POST", headers: requestHeaders() });
        shouldRefresh = shouldRefresh || gmailResponse.ok;
      } catch {
        // Gmail pode ainda nao estar conectado; a Central continua operando com os demais canais.
      }

      if (shouldRefresh) {
        await refreshEvents();
      }
    } finally {
      integrationSyncInFlightRef.current = false;
    }
  }, [refreshEvents, userId]);

  const clearSystemUnread = useCallback(() => {
    setSystemUnreadCount(0);
    setSystemNotifications((current) => current.map((notification) => ({ ...notification, read: true })));
    void fetch(NOTIFICATION_READ_URL, { method: "POST", headers: requestHeaders() });
  }, []);

  const clearSystemNotifications = useCallback(() => {
    setSystemUnreadCount(0);
    setSystemNotifications([]);
    setSystemToasts([]);
    void fetch(NOTIFICATION_CLEAR_URL, { method: "DELETE", headers: requestHeaders() });
  }, []);

  const clearTeamChatUnread = useCallback(() => {
    setTeamChatUnreadCount(0);
  }, []);

  const addTeamChatUnread = useCallback((count = 1) => {
    setTeamChatUnreadCount((current) => current + Math.max(0, count));
  }, []);

  const handleSocketSystemMessage = useCallback(
    (payload: SocketMessage) => {
      pushSystemNotification({
        title: payload.notification?.title || payload.title || "Aviso do sistema",
        description:
          payload.notification?.description ||
          payload.description ||
          "O Norium recebeu uma atualizacao operacional.",
        severity: payload.notification?.severity || payload.severity || "info",
        metadata: payload.notification?.metadata,
      });
    },
    [pushSystemNotification],
  );

  const reportConnectionState = useCallback(
    (state: "online" | "offline") => {
      if (lastConnectionStateRef.current === state) return;
      const hadOpenedBefore = hasOpenedRef.current;
      lastConnectionStateRef.current = state;

      if (state === "online") {
        setConnected(true);
        hasOpenedRef.current = true;
        if (hadOpenedBefore) {
          pushSystemNotification({
            title: "Tempo real reconectado",
            description: "A conexao WebSocket da Central de Atividades foi restabelecida.",
            severity: "success",
          });
        }
        return;
      }

      setConnected(false);
      if (hadOpenedBefore) {
        pushSystemNotification({
          title: "Tempo real interrompido",
          description: "O Norium perdeu a conexao WebSocket e esta tentando reconectar.",
          severity: "warning",
        });
      }
    },
    [pushSystemNotification],
  );

  useEffect(() => {
    if (!enabled) return;
    void refreshEvents();
  }, [enabled, refreshEvents]);

  useEffect(() => {
    if (!enabled) return undefined;
    const firstSyncTimer = window.setTimeout(() => {
      void syncIntegrationEvents();
    }, 8000);
    const timer = window.setInterval(() => {
      void syncIntegrationEvents();
    }, 120000);

    return () => {
      window.clearTimeout(firstSyncTimer);
      window.clearInterval(timer);
    };
  }, [enabled, syncIntegrationEvents]);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return undefined;
    }
    let cancelled = false;

    function scheduleReconnect() {
      if (cancelled || reconnectTimerRef.current !== null) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect();
      }, 1800);
    }

    async function connect() {
      if (cancelled) return;
      const token = authToken();
      if (!token) {
        reportConnectionState("offline");
        return;
      }
      let socket: WebSocket;
      try {
        const socketUrl = await authenticatedWebSocketUrl(WS_URL, token);
        if (cancelled) return;
        socket = new WebSocket(socketUrl);
      } catch {
        if (!cancelled) {
          reportConnectionState("offline");
          scheduleReconnect();
        }
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (currentUserIdRef.current !== userId) {
          socket.close();
          return;
        }
        reportConnectionState("online");
        socket.send(JSON.stringify({ type: "PING" }));
      };

      socket.onmessage = (message) => {
        if (currentUserIdRef.current !== userId) return;
        try {
          const payload = JSON.parse(String(message.data)) as SocketMessage;

          if (payload.type === "NEW_EVENT" && payload.event) {
            if (!eventBelongsToUser(payload.event, userId)) return;
            if (seenEventIdsRef.current.has(payload.event.id)) return;
            seenEventIdsRef.current.add(payload.event.id);
            setEvents((current) => mergeEvent(current, payload.event as OmnichannelEvent));
            if (payload.event.source === "whatsapp") {
              window.dispatchEvent(new CustomEvent("norium:whatsapp-event", { detail: payload.event }));
            }
            const isTeamMessage = payload.event.source === "equipe" && payload.event.metadata?.action === "team_message_created";
            if (isTeamMessage) {
              notifyTeamMessage({
                id: String(payload.event.metadata?.messageId || payload.event.id),
                senderId: String(payload.event.metadata?.senderId || ""),
                senderName: String(payload.event.metadata?.senderName || "Equipe"),
                text: payload.event.description,
              });
            } else if (eventShouldNotify(payload.event)) {
              pushSystemNotification(notificationForEvent(payload.event));
              const eventAction = String(payload.event.metadata?.action || "");
              if (eventAction === "team_meeting_reminder" && "Notification" in window && document.visibilityState !== "visible" && Notification.permission === "granted") {
                new Notification("Reunião em 10 minutos", {
                  body: payload.event.description || "Sua reunião da equipe começará em 10 minutos.",
                  tag: `norium-meeting-reminder-${payload.event.metadata?.meetingId || payload.event.id}`,
                });
              }
            }
            return;
          }

          if (payload.type === "SYSTEM_NOTIFICATION" || payload.type === "SYSTEM_ALERT") {
            handleSocketSystemMessage(payload);
          }
        } catch {
          pushSystemNotification({
            title: "Mensagem WebSocket ignorada",
            description: "O Norium recebeu um pacote em formato inesperado.",
            severity: "warning",
          });
        }
      };

      socket.onclose = () => {
        if (cancelled || currentUserIdRef.current !== userId) return;
        reportConnectionState("offline");
        scheduleReconnect();
      };

      socket.onerror = () => {
        if (cancelled || currentUserIdRef.current !== userId) return;
        reportConnectionState("offline");
        socket.close();
      };
    }

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled, handleSocketSystemMessage, notifyTeamMessage, pushSystemNotification, reportConnectionState, userId]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let reconnectTimer: number | null = null;

    async function connectTeamSocket() {
      if (cancelled) return;
      const token = authToken();
      if (!token) return;
      let socket: WebSocket;
      try {
        const socketUrl = await authenticatedWebSocketUrl(TEAM_WS_URL, token);
        if (cancelled) return;
        socket = new WebSocket(socketUrl);
      } catch {
        if (!cancelled && reconnectTimer === null) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            void connectTeamSocket();
          }, 1800);
        }
        return;
      }
      teamSocketRef.current = socket;

      socket.onmessage = (event) => {
        if (currentUserIdRef.current !== userId) return;
        try {
          const payload = JSON.parse(String(event.data || "{}")) as TeamSocketMessage;
          if (payload.type === "TEAM_CHAT_MESSAGE" && payload.message) notifyTeamMessage(payload.message);
          if (payload.type === "CALL_END" && payload.callId) {
            endedTeamCallIdsRef.current.add(payload.callId);
            dismissCallNotifications(payload.callId);
            window.dispatchEvent(new CustomEvent("norium:team-call", { detail: payload }));
          }
          if (payload.type === "CALLS_STATE") {
            const activeIds = new Set((payload.calls || []).map((call) => call.callId));
            for (const callId of seenTeamCallIdsRef.current) {
              if (!activeIds.has(callId)) {
                endedTeamCallIdsRef.current.add(callId);
                dismissCallNotifications(callId);
              }
            }
            window.dispatchEvent(new CustomEvent("norium:team-call", { detail: payload }));
          }
          if (payload.type === "CALL_INVITE" && payload.callId) {
            if (payload.fromUserId === userId || seenTeamCallIdsRef.current.has(payload.callId) || endedTeamCallIdsRef.current.has(payload.callId)) return;
            seenTeamCallIdsRef.current.add(payload.callId);
            if (seenTeamCallIdsRef.current.size > 100) {
              const oldest = seenTeamCallIdsRef.current.values().next().value;
              if (oldest) seenTeamCallIdsRef.current.delete(oldest);
            }
            pushSystemNotification({
              id: `meeting_${payload.callId}`,
              title: "Reunião iniciada",
              description: `${payload.fromUserName || "Um membro da equipe"} convidou você para entrar.`,
              severity: "info",
              metadata: { source: "equipe", action: "call_started", callId: payload.callId },
            });
            window.dispatchEvent(new CustomEvent("norium:team-call", { detail: payload }));
            if ("Notification" in window && document.visibilityState !== "visible" && Notification.permission === "granted") {
              const notification = new Notification("Reunião iniciada no Norium", {
                body: `${payload.fromUserName || "Um membro da equipe"} está chamando você.`,
                tag: `norium-meeting-${payload.callId}`,
              });
              meetingNotificationsRef.current.set(payload.callId, notification);
            }
          }
        } catch {
          // Pacotes de presenca ou incompatíveis nao bloqueiam o contador do chat.
        }
      };
      socket.onclose = () => {
        if (cancelled || currentUserIdRef.current !== userId || reconnectTimer !== null) return;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          void connectTeamSocket();
        }, 1800);
      };
      socket.onerror = () => socket.close();
    }

    void connectTeamSocket();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      teamSocketRef.current?.close();
      teamSocketRef.current = null;
    };
  }, [dismissCallNotifications, enabled, notifyTeamMessage, pushSystemNotification, userId]);

  return {
    connected: isolatedForCurrentUser ? connected : false,
    events: visibleEvents,
    eventsBySource,
    systemNotifications: isolatedForCurrentUser ? systemNotifications : [],
    systemUnreadCount: isolatedForCurrentUser ? systemUnreadCount : 0,
    systemToasts: isolatedForCurrentUser ? systemToasts : [],
    teamChatUnreadCount: isolatedForCurrentUser ? teamChatUnreadCount : 0,
    refreshEvents,
    clearSystemUnread,
    clearSystemNotifications,
    clearTeamChatUnread,
    addTeamChatUnread,
    dismissSystemToast,
  };
}
