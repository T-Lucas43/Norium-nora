import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EventSource,
  OmnichannelEvent,
  SystemNotification,
  SystemNotificationSeverity,
  SystemNotificationToast,
} from "../types/omnichannel";
import { apiBaseUrl, authToken, wsBaseUrl } from "../utils/api";

const API_URL = `${apiBaseUrl()}/api/omnichannel/inbox`;
const WS_URL = `${wsBaseUrl()}/api/omnichannel/ws`;
const TEAM_WS_URL = `${wsBaseUrl()}/api/team-chat/ws`;
const CALENDAR_SYNC_URL = `${apiBaseUrl()}/api/agenda/sync`;
const GMAIL_SYNC_URL = `${apiBaseUrl()}/api/emails/gmail/sync-central`;
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
  message?: {
    id?: string;
    senderId?: string;
    senderName?: string;
    text?: string;
  };
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
      telegram: [],
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
    title: string;
    description: string;
    severity?: SystemNotificationSeverity;
    metadata?: Record<string, unknown>;
  },
): SystemNotification {
  const timestamp = new Date().toISOString();
  return {
    id: `sys_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    title: payload.title,
    description: payload.description,
    timestamp,
    severity: payload.severity ?? "info",
    read: false,
    metadata: payload.metadata,
  };
}

function notificationForEvent(event: OmnichannelEvent): {
  title: string;
  description: string;
  severity: SystemNotificationSeverity;
  metadata: Record<string, unknown>;
} {
  const action = String(event.metadata?.action || "").toLocaleLowerCase("pt-BR");
  const normalized = `${action} ${event.title}`.toLocaleLowerCase("pt-BR");
  let title = event.title || "Nova atividade no Norium";
  let severity: SystemNotificationSeverity = "info";

  if (event.source === "equipe" && action === "team_message_created") title = "Nova mensagem no chat da equipe";
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
    title,
    description: event.description || "Uma nova atividade requer sua atencao.",
    severity,
    metadata: { ...event.metadata, source: event.source, eventId: event.id, action },
  };
}

export function useWebSockets(
  activeTab: string,
  enabled = true,
  userId = "lucas123",
  teamId = userId,
  teamChatOpen = false,
) {
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

  const eventsBySource = useMemo(() => groupEventsBySource(events), [events]);

  useEffect(() => {
    setEvents([]);
    setSystemNotifications([]);
    setSystemUnreadCount(0);
    setSystemToasts([]);
    setTeamChatUnreadCount(0);
    seenTeamMessageIdsRef.current.clear();
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

  const pushSystemNotification = useCallback(
    (payload: {
      title: string;
      description: string;
      severity?: SystemNotificationSeverity;
      metadata?: Record<string, unknown>;
      showToast?: boolean;
    }) => {
      const notification = buildSystemNotification(payload);
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
        setSystemToasts((current) => [toast, ...current].slice(0, 4));
        window.setTimeout(() => dismissSystemToast(toast.id), 9000);
      }
    },
    [dismissSystemToast],
  );

  const notifyTeamMessage = useCallback(
    (message: { id?: string; senderId?: string; senderName?: string; text?: string }) => {
      const messageId = String(message.id || "");
      if (messageId && seenTeamMessageIdsRef.current.has(messageId)) return;
      if (messageId) {
        seenTeamMessageIdsRef.current.add(messageId);
        if (seenTeamMessageIdsRef.current.size > 400) {
          const oldest = seenTeamMessageIdsRef.current.values().next().value;
          if (oldest) seenTeamMessageIdsRef.current.delete(oldest);
        }
      }
      if (message.senderId === userId || teamChatOpenRef.current) return;

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
    try {
      const params = new URLSearchParams({ user_id: userId });
      const response = await fetch(`${API_URL}?${params.toString()}`, { headers: requestHeaders() });
      if (!response.ok) throw new Error("Falha ao carregar a Central de Atividades.");
      const data = (await response.json()) as OmnichannelEvent[];
      setEvents(sortEvents(data));
    } catch {
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
  }, []);

  const clearSystemNotifications = useCallback(() => {
    setSystemUnreadCount(0);
    setSystemNotifications([]);
    setSystemToasts([]);
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
        connect();
      }, 1800);
    }

    function connect() {
      if (cancelled) return;
      const token = authToken();
      if (!token) {
        reportConnectionState("offline");
        return;
      }
      const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      socketRef.current = socket;

      socket.onopen = () => {
        reportConnectionState("online");
        socket.send(JSON.stringify({ type: "PING" }));
      };

      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as SocketMessage;

          if (payload.type === "NEW_EVENT" && payload.event) {
            const eventUserId = payload.event.metadata?.userId;
            if (eventUserId && eventUserId !== userId && eventUserId !== teamId) return;
            setEvents((current) => mergeEvent(current, payload.event as OmnichannelEvent));
            const isTeamMessage = payload.event.source === "equipe" && payload.event.metadata?.action === "team_message_created";
            if (isTeamMessage) {
              notifyTeamMessage({
                id: String(payload.event.metadata?.messageId || payload.event.id),
                senderId: String(payload.event.metadata?.senderId || ""),
                senderName: String(payload.event.metadata?.senderName || "Equipe"),
                text: payload.event.description,
              });
            } else {
              pushSystemNotification(notificationForEvent(payload.event));
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
        if (cancelled) return;
        reportConnectionState("offline");
        scheduleReconnect();
      };

      socket.onerror = () => {
        if (cancelled) return;
        reportConnectionState("offline");
        socket.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled, handleSocketSystemMessage, notifyTeamMessage, pushSystemNotification, reportConnectionState, teamId, userId]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let reconnectTimer: number | null = null;

    function connectTeamSocket() {
      if (cancelled) return;
      const token = authToken();
      if (!token) return;
      const socket = new WebSocket(`${TEAM_WS_URL}?token=${encodeURIComponent(token)}`);
      teamSocketRef.current = socket;

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data || "{}")) as TeamSocketMessage;
          if (payload.type === "TEAM_CHAT_MESSAGE" && payload.message) notifyTeamMessage(payload.message);
        } catch {
          // Pacotes de presenca ou incompatíveis nao bloqueiam o contador do chat.
        }
      };
      socket.onclose = () => {
        if (cancelled || reconnectTimer !== null) return;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connectTeamSocket();
        }, 1800);
      };
      socket.onerror = () => socket.close();
    }

    connectTeamSocket();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      teamSocketRef.current?.close();
      teamSocketRef.current = null;
    };
  }, [enabled, notifyTeamMessage, userId]);

  return {
    connected,
    events,
    eventsBySource,
    systemNotifications,
    systemUnreadCount,
    systemToasts,
    teamChatUnreadCount,
    refreshEvents,
    clearSystemUnread,
    clearSystemNotifications,
    clearTeamChatUnread,
    addTeamChatUnread,
    dismissSystemToast,
  };
}
