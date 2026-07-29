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

export function useWebSockets(activeTab: string, enabled = true, userId = "lucas123") {
  const [events, setEvents] = useState<OmnichannelEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [systemNotifications, setSystemNotifications] = useState<SystemNotification[]>([]);
  const [systemUnreadCount, setSystemUnreadCount] = useState(0);
  const [systemToasts, setSystemToasts] = useState<SystemNotificationToast[]>([]);

  const activeTabRef = useRef(activeTab);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const hasOpenedRef = useRef(false);
  const lastConnectionStateRef = useRef<"online" | "offline" | null>(null);
  const integrationSyncInFlightRef = useRef(false);

  const eventsBySource = useMemo(() => groupEventsBySource(events), [events]);

  useEffect(() => {
    setEvents([]);
    setSystemNotifications([]);
    setSystemUnreadCount(0);
    setSystemToasts([]);
  }, [userId]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

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
        window.setTimeout(() => dismissSystemToast(toast.id), 5200);
      }
    },
    [dismissSystemToast],
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
            if (eventUserId && eventUserId !== userId) return;
            setEvents((current) => mergeEvent(current, payload.event as OmnichannelEvent));
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
  }, [enabled, handleSocketSystemMessage, pushSystemNotification, reportConnectionState, userId]);

  return {
    connected,
    events,
    eventsBySource,
    systemNotifications,
    systemUnreadCount,
    systemToasts,
    refreshEvents,
    clearSystemUnread,
    clearSystemNotifications,
    dismissSystemToast,
  };
}
