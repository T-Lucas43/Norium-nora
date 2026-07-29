import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  CreditCard,
  EyeOff,
  GitBranch,
  GripVertical,
  Inbox,
  Lightbulb,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { EventSource, OmnichannelEvent } from "../../types/omnichannel";

type InboxUniversalProps = {
  eventsBySource: Record<EventSource, OmnichannelEvent[]>;
  connected: boolean;
  onRefresh: () => void;
};

type InboxPanelConfig = {
  source: EventSource;
  title: string;
  subtitle: string;
  emptyTitle: string;
  emptyDescription: string;
  icon: LucideIcon;
  accentClassName: string;
  ringClassName: string;
};

type PanelSize = "compacto" | "medio" | "amplo";

const PANEL_ORDER_KEY = "norium:central:panel-order";
const PANEL_SIZE_KEY = "norium:central:panel-sizes";
const PANEL_HIDDEN_KEY = "norium:central:hidden-panels";

const panelHeights: Record<PanelSize, string> = {
  compacto: "h-[280px]",
  medio: "h-[340px]",
  amplo: "h-[440px]",
};

const panels: InboxPanelConfig[] = [
  {
    source: "gmail",
    title: "Gmail",
    subtitle: "E-mails recentes",
    emptyTitle: "Nenhum e-mail novo",
    emptyDescription: "Mensagens e respostas do Gmail aparecem aqui.",
    icon: Mail,
    accentClassName: "text-rose-400 bg-rose-500/12",
    ringClassName: "border-rose-400/25",
  },
  {
    source: "whatsapp",
    title: "WhatsApp",
    subtitle: "Mensagens recentes do chat",
    emptyTitle: "Nenhuma mensagem recente",
    emptyDescription: "Eventos de conversas sincronizadas entram neste bloco.",
    icon: MessageSquare,
    accentClassName: "text-emerald-400 bg-emerald-500/12",
    ringClassName: "border-emerald-400/25",
  },
  {
    source: "kanban",
    title: "Kanban / Tarefas",
    subtitle: "Atualizacoes de cards e prazos",
    emptyTitle: "Nenhuma tarefa movimentada",
    emptyDescription: "Criacoes, comentarios, anexos e mudancas de status aparecem aqui.",
    icon: CheckSquare,
    accentClassName: "text-amber-400 bg-amber-500/12",
    ringClassName: "border-amber-400/25",
  },
  {
    source: "calendar",
    title: "Calendar",
    subtitle: "Proximos compromissos",
    emptyTitle: "Nenhum compromisso recente",
    emptyDescription: "Eventos criados ou atualizados pela agenda entram aqui.",
    icon: CalendarDays,
    accentClassName: "text-blue-400 bg-blue-500/12",
    ringClassName: "border-blue-400/25",
  },
  {
    source: "financeiro",
    title: "Gastos",
    subtitle: "Lancamentos, boletos e anexos",
    emptyTitle: "Nenhum movimento financeiro",
    emptyDescription: "Entradas, saidas, boletos e comprovantes aparecem aqui.",
    icon: CreditCard,
    accentClassName: "text-cyan-400 bg-cyan-500/12",
    ringClassName: "border-cyan-400/25",
  },
  {
    source: "equipe",
    title: "Equipe",
    subtitle: "Mensagens e acessos internos",
    emptyTitle: "Nenhuma atividade da equipe",
    emptyDescription: "Chat interno, membros e permissoes aparecem aqui.",
    icon: UsersRound,
    accentClassName: "text-indigo-300 bg-indigo-500/12",
    ringClassName: "border-indigo-300/25",
  },
  {
    source: "automacoes",
    title: "Automações",
    subtitle: "Fluxos, gatilhos e execuções",
    emptyTitle: "Nenhuma automação recente",
    emptyDescription: "Criações, execuções e ações da Nora aparecem aqui.",
    icon: GitBranch,
    accentClassName: "text-sky-300 bg-sky-500/12",
    ringClassName: "border-sky-300/25",
  },
  {
    source: "brainstorm",
    title: "Brainstorm",
    subtitle: "Sessões, ideias e decisões",
    emptyTitle: "Nenhuma sessão recente",
    emptyDescription: "Criações de quadros e ideias convertidas em tarefas aparecem aqui.",
    icon: Lightbulb,
    accentClassName: "text-cyan-300 bg-cyan-500/12",
    ringClassName: "border-cyan-300/25",
  },
  {
    source: "relatorios",
    title: "Relatórios",
    subtitle: "PDFs, exportações e indicadores",
    emptyTitle: "Nenhum relatório gerado",
    emptyDescription: "Relatórios operacionais e financeiros aparecem aqui.",
    icon: BarChart3,
    accentClassName: "text-emerald-300 bg-emerald-500/12",
    ringClassName: "border-emerald-300/25",
  },
];

function formatEventTime(timestamp: string) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "--:--";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function eventDescription(event: OmnichannelEvent) {
  return event.description || "Evento sem descricao.";
}

function MiniInboxPanel({
  config,
  events,
  size,
  onSizeChange,
  onHide,
  onDragStart,
  onDrop,
  onMoveLeft,
  onMoveRight,
  canMoveLeft,
  canMoveRight,
}: {
  config: InboxPanelConfig;
  events: OmnichannelEvent[];
  size: PanelSize;
  onSizeChange: (size: PanelSize) => void;
  onHide: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}) {
  const Icon = config.icon;
  const visibleEvents = events.slice(0, 12);

  return (
    <section
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      className={`flex ${panelHeights[size]} min-w-0 flex-col overflow-hidden rounded-lg border bg-[var(--surface)] ${config.ringClassName}`}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="cursor-grab text-[var(--text-secondary)] active:cursor-grabbing" aria-hidden="true">
            <GripVertical size={16} />
          </span>
          <span className="flex shrink-0 flex-col gap-0.5">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onMoveLeft();
              }}
              disabled={!canMoveLeft}
              aria-label={`Mover ${config.title} para cima na ordem`}
              title={`Mover ${config.title} para cima na ordem`}
              className="grid h-4 w-4 place-items-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-30"
            >
              <ChevronUp size={12} />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onMoveRight();
              }}
              disabled={!canMoveRight}
              aria-label={`Mover ${config.title} para baixo na ordem`}
              title={`Mover ${config.title} para baixo na ordem`}
              className="grid h-4 w-4 place-items-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-30"
            >
              <ChevronDown size={12} />
            </button>
          </span>
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${config.accentClassName}`}>
            <Icon size={19} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-black text-[var(--text)]">{config.title}</h2>
            <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">{config.subtitle}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <select
            value={size}
            onChange={(event) => onSizeChange(event.target.value as PanelSize)}
            onClick={(event) => event.stopPropagation()}
            className="h-7 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] font-black outline-none"
          >
            <option value="compacto">P</option>
            <option value="medio">M</option>
            <option value="amplo">G</option>
          </select>
          <span className="grid h-7 min-w-7 place-items-center rounded-full border border-[var(--border)] px-2 text-xs font-black text-[var(--text-secondary)]">
            {events.length}
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onHide();
            }}
            className="grid h-7 w-7 place-items-center rounded-lg border border-[var(--border)] text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            title={`Ocultar ${config.title}`}
            aria-label={`Ocultar ${config.title}`}
          >
            <EyeOff size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {visibleEvents.length === 0 ? (
          <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-5 text-center">
            <span className={`mb-3 grid h-12 w-12 place-items-center rounded-lg ${config.accentClassName}`}>
              <Icon size={22} />
            </span>
            <h3 className="text-sm font-black text-[var(--text)]">{config.emptyTitle}</h3>
            <p className="mt-1 max-w-[260px] text-xs font-semibold leading-5 text-[var(--text-secondary)]">
              {config.emptyDescription}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {visibleEvents.map((event) => (
              <article key={event.id} className="px-4 py-3 transition hover:bg-[var(--surface-hover)]">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <h3 className="min-w-0 truncate text-sm font-black text-[var(--text)]">{event.title}</h3>
                  <time className="shrink-0 text-[11px] font-bold text-[var(--text-secondary)]">
                    {formatEventTime(event.timestamp)}
                  </time>
                </div>
                <p className="mt-1 line-clamp-2 text-xs font-semibold leading-5 text-[var(--text-secondary)]">
                  {eventDescription(event)}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default function InboxUniversal({ eventsBySource, connected, onRefresh }: InboxUniversalProps) {
  const [panelOrder, setPanelOrder] = useState<EventSource[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_ORDER_KEY) || "[]") as EventSource[];
      const valid = saved.filter((source) => panels.some((panel) => panel.source === source));
      const missing = panels.map((panel) => panel.source).filter((source) => !valid.includes(source));
      return [...valid, ...missing];
    } catch {
      return panels.map((panel) => panel.source);
    }
  });
  const [panelSizes, setPanelSizes] = useState<Record<EventSource, PanelSize>>(() => {
    const fallback = panels.reduce<Record<EventSource, PanelSize>>((acc, panel) => {
      acc[panel.source] = "medio";
      return acc;
    }, {} as Record<EventSource, PanelSize>);
    try {
      return { ...fallback, ...(JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) || "{}") as Partial<Record<EventSource, PanelSize>>) };
    } catch {
      return fallback;
    }
  });
  const [draggingSource, setDraggingSource] = useState<EventSource | null>(null);
  const [hiddenSources, setHiddenSources] = useState<EventSource[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_HIDDEN_KEY) || "[]") as EventSource[];
      return saved.filter((source) => panels.some((panel) => panel.source === source));
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(panelOrder));
  }, [panelOrder]);

  useEffect(() => {
    localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSizes));
  }, [panelSizes]);

  useEffect(() => {
    localStorage.setItem(PANEL_HIDDEN_KEY, JSON.stringify(hiddenSources));
  }, [hiddenSources]);

  const orderedPanels = useMemo(
    () =>
      panelOrder
        .map((source) => panels.find((panel) => panel.source === source))
        .filter((panel): panel is InboxPanelConfig => Boolean(panel))
        .filter((panel) => !hiddenSources.includes(panel.source)),
    [hiddenSources, panelOrder],
  );

  const hiddenPanels = panels.filter((panel) => hiddenSources.includes(panel.source));
  const totalEvents = panels.reduce((total, panel) => total + eventsBySource[panel.source].length, 0);

  function movePanel(targetSource: EventSource) {
    if (!draggingSource || draggingSource === targetSource) return;
    setPanelOrder((current) => {
      const next = current.filter((source) => source !== draggingSource);
      const targetIndex = next.indexOf(targetSource);
      next.splice(targetIndex >= 0 ? targetIndex : next.length, 0, draggingSource);
      return next;
    });
    setDraggingSource(null);
  }

  function movePanelByStep(source: EventSource, step: -1 | 1) {
    setPanelOrder((current) => {
      const visible = current.filter((item) => !hiddenSources.includes(item));
      const fromVisibleIndex = visible.indexOf(source);
      const toVisibleIndex = fromVisibleIndex + step;
      if (fromVisibleIndex < 0 || toVisibleIndex < 0 || toVisibleIndex >= visible.length) return current;
      const swapWith = visible[toVisibleIndex];
      const next = [...current];
      const fromIndex = next.indexOf(source);
      const toIndex = next.indexOf(swapWith);
      [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
      return next;
    });
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-[var(--background)] text-[var(--text)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--primary)]">
            <Inbox size={22} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold">Central de Atividades</h1>
            <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">
              Eventos separados por integracao, atualizados em tempo real
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden rounded-full border border-[var(--border)] px-3 py-1 text-xs font-bold text-[var(--text-secondary)] md:inline-flex">
            {totalEvents} eventos
          </span>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${connected ? "bg-emerald-500/12 text-emerald-400" : "bg-amber-500/12 text-amber-400"}`}>
            {connected ? "tempo real ativo" : "reconectando"}
          </span>
          <button
            onClick={onRefresh}
            className="grid h-10 w-10 place-items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            title="Atualizar Inbox"
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {hiddenPanels.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
            <span className="text-xs font-black uppercase text-[var(--text-secondary)]">Adicionar mini tela</span>
            {hiddenPanels.map((panel) => (
              <button
                key={panel.source}
                type="button"
                onClick={() => setHiddenSources((current) => current.filter((source) => source !== panel.source))}
                className="inline-flex h-8 items-center gap-2 rounded-lg border border-[var(--border)] px-3 text-xs font-bold text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
              >
                <Plus size={14} />
                {panel.title}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-4">
          {orderedPanels.map((panel, index) => (
            <MiniInboxPanel
              key={panel.source}
              config={panel}
              events={eventsBySource[panel.source]}
              size={panelSizes[panel.source] || "medio"}
              onSizeChange={(size) => setPanelSizes((current) => ({ ...current, [panel.source]: size }))}
              onHide={() => setHiddenSources((current) => (current.includes(panel.source) ? current : [...current, panel.source]))}
              onDragStart={() => setDraggingSource(panel.source)}
              onDrop={() => movePanel(panel.source)}
              onMoveLeft={() => movePanelByStep(panel.source, -1)}
              onMoveRight={() => movePanelByStep(panel.source, 1)}
              canMoveLeft={index > 0}
              canMoveRight={index < orderedPanels.length - 1}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
