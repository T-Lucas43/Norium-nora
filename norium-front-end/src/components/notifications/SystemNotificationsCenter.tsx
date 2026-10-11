import {
  Bell,
  ChevronRight,
  GripVertical,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SystemNotification, SystemNotificationSeverity } from "../../types/omnichannel";
import { notificationVisual } from "./notificationVisualConfig";
import "./SystemNotificationsCenter.css";

type SystemNotificationsCenterProps = {
  notifications: SystemNotification[];
  connected: boolean;
  onClear: () => void;
  onNavigate?: (tab: string) => void;
};

type NotificationDensity = "compacta" | "media" | "ampla";
type NotificationFilter = "todas" | "nao-lidas";

const ORDER_STORAGE_KEY = "norium:system-notifications:order";
const DENSITY_STORAGE_KEY = "norium:system-notifications:density";

const severityConfig: Record<SystemNotificationSeverity, { label: string; tone: string }> = {
  info: { label: "Informação", tone: "is-blue" },
  success: { label: "Resolvido", tone: "is-green" },
  warning: { label: "Aviso", tone: "is-amber" },
  error: { label: "Crítico", tone: "is-red" },
};

const densityConfig: Record<NotificationDensity, { label: string }> = {
  compacta: { label: "Compacta" },
  media: { label: "Média" },
  ampla: { label: "Ampla" },
};

// Cor fixa por origem, como em "Tipos de notificação" do layout aprovado.
const kindTone: Record<string, string> = {
  "E-mail": "is-red",
  WhatsApp: "is-green",
  Agenda: "is-blue",
  Tarefas: "is-amber",
  Financeiro: "is-cyan",
  "Automação": "is-violet",
  Equipe: "is-blue",
  Nora: "is-blue",
  Sistema: "",
  "Informação": "is-blue",
  Resolvido: "is-green",
  Aviso: "is-amber",
  "Crítico": "is-red",
};

function formatNotificationTime(timestamp: string) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "--:--";
  const date = parsed.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = parsed.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

export default function SystemNotificationsCenter({
  notifications,
  connected,
  onClear,
  onNavigate,
}: SystemNotificationsCenterProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<NotificationFilter>("todas");
  const [density, setDensity] = useState<NotificationDensity>(() => {
    if (typeof window === "undefined") return "media";
    const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY) as NotificationDensity | null;
    return stored && stored in densityConfig ? stored : "media";
  });
  const [orderedIds, setOrderedIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const parsed = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  }, [density]);

  useEffect(() => {
    setOrderedIds((current) => {
      const validIds = new Set(notifications.map((notification) => notification.id));
      const kept = current.filter((id) => validIds.has(id));
      const additions = notifications.map((notification) => notification.id).filter((id) => !kept.includes(id));
      const next = [...kept, ...additions];
      window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, [notifications]);

  const orderedNotifications = useMemo(() => {
    const byId = new Map(notifications.map((notification) => [notification.id, notification]));
    const ordered = orderedIds
      .map((id) => byId.get(id))
      .filter((notification): notification is SystemNotification => Boolean(notification));
    const knownIds = new Set(ordered.map((notification) => notification.id));
    return [...ordered, ...notifications.filter((notification) => !knownIds.has(notification.id))];
  }, [notifications, orderedIds]);

  const unreadCount = useMemo(() => notifications.filter((notification) => !notification.read).length, [notifications]);
  const visibleNotifications = useMemo(
    () => (filter === "nao-lidas" ? orderedNotifications.filter((notification) => !notification.read) : orderedNotifications),
    [filter, orderedNotifications],
  );

  function moveNotification(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    setOrderedIds((current) => {
      const source = current.indexOf(draggedId);
      const target = current.indexOf(targetId);
      if (source < 0 || target < 0) return current;
      const next = [...current];
      const [removed] = next.splice(source, 1);
      next.splice(target, 0, removed);
      window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  function notificationTarget(notification: SystemNotification) {
    const metadata = notification.metadata || {};
    if (metadata.source === "equipe" && metadata.threadId) return "Chat da Equipe";
    const context = `${metadata.source || ""} ${metadata.channel || ""} ${metadata.integration || ""} ${metadata.action || ""} ${notification.title}`.toLocaleLowerCase("pt-BR");
    if (metadata.approvalId || context.includes("aprova")) return "Controle";
    if (context.includes("gmail") || context.includes("e-mail") || context.includes("email")) return "E-mails";
    if (context.includes("agenda") || context.includes("calendar")) return "Agenda";
    if (context.includes("whatsapp") || context.includes("chat")) return "Chat";
    if (context.includes("tarefa") || context.includes("kanban")) return "Tarefas";
    if (context.includes("financ") || context.includes("gasto") || context.includes("boleto")) return "Financeiro";
    if (context.includes("automa")) return "Automações";
    if (context.includes("equipe")) return "Equipe";
    if (context.includes("brainstorm")) return "Estúdio";
    if (context.includes("relatorio") || context.includes("relatório")) return "Relatórios";
    return "Controle";
  }

  const filters: Array<{ key: NotificationFilter; label: string; count: number }> = [
    { key: "todas", label: "Todas", count: notifications.length },
    { key: "nao-lidas", label: "Não lidas", count: unreadCount },
  ];

  return (
    <section className="system-notifications-center nx-page nxn">
      <header className="nx-ph">
        <div className="min-w-0">
          <h1>Notificações</h1>
          <p>Alertas globais, conexões e avisos operacionais do Norium</p>
        </div>

        <div className="nx-ph-actions">
          <div className="nx-seg" role="group" aria-label="Ajustar tamanho das notificações" title="Ajustar tamanho das notificações">
            {(Object.entries(densityConfig) as Array<[NotificationDensity, { label: string }]>).map(([key, value]) => (
              <button
                key={key}
                type="button"
                className={density === key ? "is-active" : ""}
                aria-pressed={density === key}
                onClick={() => setDensity(key)}
              >
                {value.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="nx-btn"
            onClick={onClear}
            disabled={notifications.length === 0}
            title="Limpar notificações"
            aria-label="Limpar notificações"
          >
            <Trash2 size={16} strokeWidth={1.75} />
            Limpar
          </button>
        </div>
      </header>

      <div className="nxn-filters">
        {filters.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`nx-badge nxn-chip ${filter === item.key ? "is-blue" : ""}`}
            aria-pressed={filter === item.key}
            onClick={() => setFilter(item.key)}
          >
            {item.label} <span className="nxn-chip-count">{item.count}</span>
          </button>
        ))}
        <span className="nxn-live" role="status">
          <span className={`nxn-live-dot ${connected ? "" : "is-off"}`} aria-hidden="true" />
          {connected ? "Tempo real ativo" : "Tempo real reconectando"}
        </span>
      </div>

      <div className="nx-card nxn-list">
        {notifications.length === 0 ? (
          <div className="nxn-empty">
            <span className="nxn-empty-icon">
              <Bell size={22} strokeWidth={1.75} />
            </span>
            <h2>Nenhum alerta do sistema</h2>
            <p>
              Este painel mostra apenas avisos globais, falhas de conexão e estados críticos do Norium.
            </p>
          </div>
        ) : visibleNotifications.length === 0 ? (
          <div className="nxn-empty">
            <span className="nxn-empty-icon">
              <Bell size={22} strokeWidth={1.75} />
            </span>
            <h2>Nenhuma notificação não lida</h2>
            <p>Todas as notificações já foram vistas. Selecione “Todas” para ver o histórico.</p>
          </div>
        ) : (
          visibleNotifications.map((notification) => {
            const config = severityConfig[notification.severity];
            const visual = notificationVisual(notification);
            const Icon = visual.icon;

            return (
              <article
                key={notification.id}
                draggable
                onDragStart={() => setDraggedId(notification.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => moveNotification(notification.id)}
                onDragEnd={() => setDraggedId(null)}
                className={`system-notification-row nxn-row density-${density} ${notification.read ? "" : "is-unread"}`}
              >
                <span className="nxn-grip" aria-hidden="true">
                  <GripVertical size={15} strokeWidth={1.75} />
                </span>
                <span className={`nxn-icon ${kindTone[visual.label] ?? ""}`} title={visual.label} aria-label={visual.label}>
                  <Icon size={16} strokeWidth={1.75} />
                </span>

                <div className="nx-grow">
                  <h3 className="nxn-title">{notification.title}</h3>
                  <p className="nxn-desc">{notification.description}</p>
                </div>

                <div className="nxn-meta">
                  {!notification.read && (
                    <span className="nx-badge is-blue">
                      <span className="nxn-new" aria-hidden="true" />
                      Novo
                    </span>
                  )}
                  <span className="nx-badge">{visual.label}</span>
                  <span className={`nx-badge ${config.tone}`}>{config.label}</span>
                  <time className="nxn-time" dateTime={notification.timestamp}>
                    {formatNotificationTime(notification.timestamp)}
                  </time>
                  {onNavigate && (
                    <button
                      type="button"
                      className="nxn-open"
                      onClick={() => {
                        const tab = notificationTarget(notification);
                        if (tab === "Chat da Equipe") window.dispatchEvent(new CustomEvent("norium:deep-link", { detail: { tab, entityType: "team-message", entityId: String(notification.metadata?.messageId || ""), metadata: notification.metadata } }));
                        else onNavigate(tab);
                      }}
                    >
                      Abrir origem <ChevronRight size={14} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
