import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EventSource,
  OmnichannelEvent,
  SystemNotification,
  SystemNotificationSeverity,
  SystemNotificationToast,
} from "../types/omnichannel";
import { apiBaseUrl, authenticatedWebSocketUrl, authToken, wsBaseUrl } from "../utils/api";
import type { TeamSocketEvent } from "../components/team-chat/CallSession";
import {
  SYNTHETIC_ERROR_IDS,
  forgetIds,
  isDuplicateNotification,
  loadPersistedDedup,
  notificationIdForEvent,
  rememberId,
  systemMessageStableId,
} from "./notificationDedup";

const API_URL = `${apiBaseUrl()}/api/omnichannel/inbox`;
const WS_URL = `${wsBaseUrl()}/api/omnichannel/ws`;
const CALENDAR_SYNC_URL = `${apiBaseUrl()}/api/agenda/sync`;
const GMAIL_SYNC_URL = `${apiBaseUrl()}/api/emails/gmail/sync-central`;
const NOTIFICATION_STATE_URL = `${apiBaseUrl()}/api/omnichannel/notifications/state`;
const NOTIFICATION_READ_URL = `${apiBaseUrl()}/api/omnichannel/notifications/read-all`;
const NOTIFICATION_CLEAR_URL = `${apiBaseUrl()}/api/omnichannel/notifications`;
const NOTIFICATIONS_TAB = "Notificações";

type SocketMessage = {
  type?: string;
  jobId?: string;
  workspace?: string;
  ownerId?: string;
  inboxId?: string;
  area?: string;
  revision?: number;
  event?: OmnichannelEvent;
  notification?: Partial<SystemNotification>;
  title?: string;
  description?: string;
  severity?: SystemNotificationSeverity;
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

  if (event.source === "equipe" && action === "team_member_mentioned") title = `${event.metadata?.senderName || "Um membro"} mencionou você`;
  else if (event.source === "equipe" && action === "team_message_created") title = "Nova mensagem no chat da equipe";
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
    id: notificationIdForEvent(event),
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
  const notifiedIdsRef = useRef<Set<string>>(new Set());
  const toastedIdsRef = useRef<Set<string>>(new Set());
  const dismissedToastIdsRef = useRef<Set<string>>(new Set());
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
    const persisted = loadPersistedDedup(userId);
    notifiedIdsRef.current = persisted.notified;
    toastedIdsRef.current = persisted.toasted;
    dismissedToastIdsRef.current = persisted.dismissed;
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
    dismissedToastIdsRef.current.add(toastId);
    rememberId("dismissed", currentUserIdRef.current, toastId);
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
    return () => {
      meetingNotifications.forEach((notification) => notification.close());
      meetingNotifications.clear();
    };
  }, []);

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
      if (notifiedIdsRef.current.has(notification.id)) return;
      notifiedIdsRef.current.add(notification.id);
      rememberId("notified", currentUserIdRef.current, notification.id);
      if (notifiedIdsRef.current.size > 600) {
        const oldestNotified = notifiedIdsRef.current.values().next().value;
        if (oldestNotified) notifiedIdsRef.current.delete(oldestNotified);
      }
      setSystemNotifications((current) =>
        isDuplicateNotification(current, notification.id) ? current : [notification, ...current].slice(0, 80),
      );
      // Call-end messages can arrive in the same React batch as an invite.
      notificationsRef.current = isDuplicateNotification(notificationsRef.current, notification.id)
        ? notificationsRef.current
        : [notification, ...notificationsRef.current].slice(0, 80);

      if (activeTabRef.current !== NOTIFICATIONS_TAB) {
        if (!notification.read) setSystemUnreadCount((current) => current + 1);
      }

      if (payload.showToast !== false && activeTabRef.current !== NOTIFICATIONS_TAB) {
        const toast: SystemNotificationToast = {
          id: `toast_${notification.id}`,
          notification,
          createdAt: Date.now(),
        };
        if (!toastedIdsRef.current.has(toast.id) && !dismissedToastIdsRef.current.has(toast.id)) {
          toastedIdsRef.current.add(toast.id);
          rememberId("toasted", currentUserIdRef.current, toast.id);
          if (toastedIdsRef.current.size > 600) {
            const oldestToasted = toastedIdsRef.current.values().next().value;
            if (oldestToasted) toastedIdsRef.current.delete(oldestToasted);
          }
          setSystemToasts((current) =>
            current.some((existing) => existing.id === toast.id) ? current : [...current, toast].slice(0, 20),
          );
        }
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
    (message: { id?: string; threadId?: string; senderId?: string; senderName?: string; text?: string; metadata?: Record<string, unknown> }) => {
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
      const mentioned = Array.isArray(message.metadata?.mentionedUserIds) && message.metadata.mentionedUserIds.includes(userId);
      if (message.senderId === userId || (teamChatOpenRef.current && !mentioned) || ["call_started", "call_ended", "meeting_scheduled"].includes(String(message.metadata?.action || ""))) return;

      const teamNotificationId = messageId ? `notification_team_${messageId}` : null;
      if (teamNotificationId && notifiedIdsRef.current.has(teamNotificationId)) return;
      setTeamChatUnreadCount((current) => current + 1);
      pushSystemNotification({
        id: teamNotificationId ?? undefined,
        title: mentioned ? `${message.senderName || "Um membro"} mencionou você` : "Nova mensagem no chat da equipe",
        description: `${message.senderName || "Equipe"}: ${message.text || "Uma nova mensagem foi enviada."}`,
        severity: "info",
        metadata: {
          source: "equipe",
          action: mentioned ? "team_member_mentioned" : "team_message_created",
          messageId,
          threadId: message.threadId || message.metadata?.threadId,
          senderId: message.senderId,
          mentionedUserIds: message.metadata?.mentionedUserIds,
        },
      });
      if (mentioned && "Notification" in window && document.visibilityState !== "visible" && Notification.permission === "granted") {
        new Notification(`${message.senderName || "Um membro"} mencionou você`, { body: message.text || "Abra o chat da equipe para responder.", tag: `norium-mention-${messageId}` });
      }
    },
    [pushSystemNotification, userId],
  );

  const handleTeamSocketEvent = useCallback((payload: TeamSocketEvent) => {
    if (currentUserIdRef.current !== userId) return;
    if (["TEAM_PRESENCE_CONTEXT", "PRESENCE", "CONNECTED"].includes(payload.type || "")) window.dispatchEvent(new Event("norium:team-presence-changed"));
    if (payload.type === "TEAM_CHAT_MESSAGE" && payload.message) notifyTeamMessage(payload.message);
    if (payload.type === "CALL_END" && payload.callId) {
      endedTeamCallIdsRef.current.add(payload.callId);
      dismissCallNotifications(payload.callId);
    }
    if (payload.type === "CALLS_STATE") {
      const activeIds = new Set((payload.calls || []).map((call) => call.callId));
      for (const callId of seenTeamCallIdsRef.current) {
        if (!activeIds.has(callId)) {
          endedTeamCallIdsRef.current.add(callId);
          dismissCallNotifications(callId);
        }
      }
    }
    if (payload.type !== "CALL_INVITE" || !payload.callId) return;
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
    if ("Notification" in window && document.visibilityState !== "visible" && Notification.permission === "granted") {
      const notification = new Notification("Reunião iniciada no Norium", {
        body: `${payload.fromUserName || "Um membro da equipe"} está chamando você.`,
        tag: `norium-meeting-${payload.callId}`,
      });
      meetingNotificationsRef.current.set(payload.callId, notification);
    }
  }, [dismissCallNotifications, notifyTeamMessage, pushSystemNotification, userId]);

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
      isolatedEvents.forEach((event) => {
        const historyMessageId = String(event.metadata?.messageId || "");
        if (event.source === "equipe" && historyMessageId) seenTeamMessageIdsRef.current.add(historyMessageId);
      });
      setEvents(isolatedEvents);
      const storedNotifications = isolatedEvents
        .filter(eventShouldNotify)
        .filter((event) => happenedAfter(event.timestamp, notificationState.clearedBefore))
        .map((event) => notificationForEvent(event, !happenedAfter(event.timestamp, notificationState.readBefore)));
      setSystemNotifications(storedNotifications.slice(0, 80));
      storedNotifications.forEach((notification) => notifiedIdsRef.current.add(notification.id));
      setSystemUnreadCount(storedNotifications.filter((notification) => !notification.read).length);
    } catch {
      if (currentUserIdRef.current !== requestedUserId) return;
      pushSystemNotification({
        id: SYNTHETIC_ERROR_IDS.centralUnavailable,
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
    const recurrentIds = [SYNTHETIC_ERROR_IDS.centralUnavailable, SYNTHETIC_ERROR_IDS.websocketMalformed];
    recurrentIds.forEach((id) => notifiedIdsRef.current.delete(id));
    recurrentIds.forEach((id) => toastedIdsRef.current.delete(id));
    recurrentIds.forEach((id) => dismissedToastIdsRef.current.delete(id));
    forgetIds(currentUserIdRef.current, recurrentIds);
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
        id: payload.notification?.id || systemMessageStableId({ metadata: payload.notification?.metadata, title: payload.notification?.title || payload.title }) || undefined,
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
      window.dispatchEvent(new CustomEvent("norium:omnichannel-connection", {
        detail: { ownerId: currentUserIdRef.current, state },
      }));

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
      if (!document.hidden) void syncIntegrationEvents();
    }, 300_000);

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
    let reconnectAttempts = 0;

    // Backoff exponencial com variação (1,8s até 60s): evita laço de reconexão gastando banda e tickets.
    function scheduleReconnect() {
      if (cancelled || reconnectTimerRef.current !== null) return;
      const base = Math.min(60_000, 1800 * 2 ** Math.min(reconnectAttempts, 6));
      reconnectAttempts += 1;
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (document.hidden) {
          scheduleReconnect();
          return;
        }
        void connect();
      }, delay);
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
        reconnectAttempts = 0;
        reportConnectionState("online");
        socket.send(JSON.stringify({ type: "PING" }));
      };

      socket.onmessage = (message) => {
        if (currentUserIdRef.current !== userId) return;
        try {
          const payload = JSON.parse(String(message.data)) as SocketMessage;

          if (payload.type === "WHATSAPP_CONVERSATION_UPDATED") {
            if (payload.ownerId !== userId) return;
            window.dispatchEvent(new CustomEvent("norium:whatsapp-event", { detail: { ownerId: payload.ownerId, inboxId: payload.inboxId, area: payload.area, revision: payload.revision } }));
            return;
          }

          if (payload.type === "NEW_EVENT" && payload.event) {
            if (!eventBelongsToUser(payload.event, userId)) return;
            if (seenEventIdsRef.current.has(payload.event.id)) {
              // Um ID conhecido pode trazer uma edicao material da agenda.
              // Atualize o feed sem recriar o aviso da mesma ocorrencia.
              setEvents((current) => mergeEvent(current, payload.event as OmnichannelEvent));
              return;
            }
            seenEventIdsRef.current.add(payload.event.id);
            setEvents((current) => mergeEvent(current, payload.event as OmnichannelEvent));
            if (payload.event.source === "whatsapp") {
              window.dispatchEvent(new CustomEvent("norium:whatsapp-event", { detail: payload.event }));
            }
            const isTeamMessage = payload.event.source === "equipe" && ["team_message_created", "team_member_mentioned"].includes(String(payload.event.metadata?.action || ""));
            if (isTeamMessage) {
              notifyTeamMessage({
                id: String(payload.event.metadata?.messageId || payload.event.id),
                senderId: String(payload.event.metadata?.senderId || ""),
                senderName: String(payload.event.metadata?.senderName || "Equipe"),
                text: payload.event.description,
                metadata: payload.event.metadata,
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

          if (payload.type === "BUSINESS_JOB_UPDATED") {
            window.dispatchEvent(new CustomEvent("norium:business-job-updated", { detail: { jobId: payload.jobId, workspace: payload.workspace } }));
            return;
          }
          if (payload.type === "SYSTEM_NOTIFICATION" || payload.type === "SYSTEM_ALERT") {
            handleSocketSystemMessage(payload);
          }
        } catch {
          pushSystemNotification({
            id: SYNTHETIC_ERROR_IDS.websocketMalformed,
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
    dismissCallNotifications,
    handleTeamSocketEvent,
  };
}
