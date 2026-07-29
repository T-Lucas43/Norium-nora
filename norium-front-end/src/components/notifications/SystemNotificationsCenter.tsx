import {
  Bell,
  ChevronRight,
  GripVertical,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SystemNotification, SystemNotificationSeverity } from "../../types/omnichannel";
import NotificationVisual from "./NotificationVisual";
import { notificationVisual } from "./notificationVisualConfig";

type SystemNotificationsCenterProps = {
  notifications: SystemNotification[];
  connected: boolean;
  onClear: () => void;
  onNavigate?: (tab: string) => void;
};

type NotificationDensity = "compacta" | "media" | "ampla";

const ORDER_STORAGE_KEY = "norium:system-notifications:order";
const DENSITY_STORAGE_KEY = "norium:system-notifications:density";

const severityConfig: Record<SystemNotificationSeverity, { label: string; className: string }> = {
  info: {
    label: "Informacao",
    className: "bg-sky-500/12 text-sky-400 border-sky-400/25",
  },
  success: {
    label: "Resolvido",
    className: "bg-emerald-500/12 text-emerald-400 border-emerald-400/25",
  },
  warning: {
    label: "Aviso",
    className: "bg-amber-500/12 text-amber-400 border-amber-400/25",
  },
  error: {
    label: "Critico",
    className: "bg-red-500/12 text-red-400 border-red-400/25",
  },
};

const densityConfig: Record<NotificationDensity, { label: string; row: string; description: string }> = {
  compacta: {
    label: "Compacta",
    row: "px-4 py-3",
    description: "line-clamp-1 text-xs leading-5",
  },
  media: {
    label: "Media",
    row: "px-4 py-4",
    description: "line-clamp-2 text-sm leading-6",
  },
  ampla: {
    label: "Ampla",
    row: "px-5 py-5",
    description: "line-clamp-3 text-sm leading-6",
  },
};

function formatNotificationTime(timestamp: string) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "--:--";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export default function SystemNotificationsCenter({
  notifications,
  connected,
  onClear,
  onNavigate,
}: SystemNotificationsCenterProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
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
    const context = `${metadata.source || ""} ${metadata.channel || ""} ${metadata.integration || ""} ${metadata.action || ""} ${notification.title}`.toLocaleLowerCase("pt-BR");
    if (metadata.approvalId || context.includes("aprova")) return "Controle";
    if (context.includes("gmail") || context.includes("e-mail") || context.includes("email")) return "E-mails";
    if (context.includes("agenda") || context.includes("calendar")) return "Agenda";
    if (context.includes("whatsapp") || context.includes("telegram") || context.includes("chat")) return "Chat";
    if (context.includes("tarefa") || context.includes("kanban")) return "Tarefas";
    if (context.includes("financ") || context.includes("gasto") || context.includes("boleto")) return "Gastos";
    if (context.includes("automa")) return "Automações";
    if (context.includes("equipe")) return "Equipe";
    if (context.includes("brainstorm")) return "Brainstorm";
    if (context.includes("relatorio") || context.includes("relatório")) return "Relatorios";
    return "Controle";
  }

  const densityStyle = densityConfig[density];

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-[var(--background)] text-[var(--text)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--primary)]">
            <Bell size={21} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold">Notificacoes do Sistema</h1>
            <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">
              Alertas globais, conexoes e avisos operacionais do Norium
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <label className="flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold text-[var(--text-secondary)]">
            Tamanho
            <select
              value={density}
              onChange={(event) => setDensity(event.target.value as NotificationDensity)}
              className="bg-transparent text-[var(--text)] outline-none"
              title="Ajustar tamanho das notificacoes"
            >
              {Object.entries(densityConfig).map(([key, value]) => (
                <option key={key} value={key} className="bg-[var(--surface)] text-[var(--text)]">
                  {value.label}
                </option>
              ))}
            </select>
          </label>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${connected ? "bg-emerald-500/12 text-emerald-400" : "bg-amber-500/12 text-amber-400"}`}>
            {connected ? "WebSocket online" : "WebSocket reconectando"}
          </span>
          <button
            onClick={onClear}
            disabled={notifications.length === 0}
            className="flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-bold text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-45"
            title="Limpar notificacoes"
          >
            <Trash2 size={15} />
            Limpar
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-5xl overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          {notifications.length === 0 ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
              <span className="mb-3 grid h-14 w-14 place-items-center rounded-lg bg-[var(--background)] text-[var(--text-secondary)]">
                <Bell size={26} />
              </span>
              <h2 className="text-lg font-black text-[var(--text)]">Nenhum alerta do sistema</h2>
              <p className="mt-1 max-w-md text-sm font-semibold leading-6 text-[var(--text-secondary)]">
                Este painel mostra apenas avisos globais, falhas de conexao e estados criticos do Norium.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {orderedNotifications.map((notification) => {
                const config = severityConfig[notification.severity];
                const visual = notificationVisual(notification);

                return (
                  <article
                    key={notification.id}
                    draggable
                    onDragStart={() => setDraggedId(notification.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => moveNotification(notification.id)}
                    onDragEnd={() => setDraggedId(null)}
                    className={`grid cursor-grab grid-cols-[20px_48px_1fr_auto] gap-4 transition hover:bg-[var(--surface-hover)] active:cursor-grabbing ${densityStyle.row}`}
                  >
                    <span className="mt-3 text-[var(--text-secondary)]">
                      <GripVertical size={15} />
                    </span>
                    <NotificationVisual notification={notification} />

                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="rounded-full border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[11px] font-black text-[var(--text-secondary)]">
                          {visual.label}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-black ${config.className}`}>
                          {config.label}
                        </span>
                        {!notification.read && (
                          <span className="rounded-full bg-[var(--primary)]/14 px-2 py-0.5 text-[11px] font-black text-[var(--primary)]">
                            novo
                          </span>
                        )}
                        <h3 className="min-w-0 truncate text-sm font-black text-[var(--text)]">
                          {notification.title}
                        </h3>
                      </div>
                      <p className={`mt-1 font-semibold text-[var(--text-secondary)] ${densityStyle.description}`}>
                        {notification.description}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <time className="text-xs font-bold text-[var(--text-secondary)]">
                        {formatNotificationTime(notification.timestamp)}
                      </time>
                      {onNavigate && (
                        <button
                          type="button"
                          onClick={() => onNavigate(notificationTarget(notification))}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-black text-[var(--text-secondary)] hover:bg-[var(--background)] hover:text-[var(--text)]"
                        >
                          Abrir <ChevronRight size={13} />
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
