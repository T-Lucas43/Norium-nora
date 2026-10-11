import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Menu,
  Plus,
  RefreshCw,
  Users,
  Video,
} from "lucide-react";
import type { AgendaStatus, Evento, ViewMode } from "./AgendaDashboard";

interface TimelineProps {
  eventos: Evento[];
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  dataSelecionada: Date;
  setDataSelecionada: (date: Date) => void;
  loading: boolean;
  error: string;
  status: AgendaStatus;
  onRefresh: () => void;
  onCreateEvent: (date?: Date) => void;
  onOpenEvent: (evento: Evento) => void;
  onOpenMenu: () => void;
  todayKey: string;
}

const views: ViewMode[] = ["Dia", "Semana", "Mês", "Ano"];
const hours = Array.from({ length: 24 }, (_, index) => index);
const HOUR_HEIGHT = 58;
const FIRST_VISIBLE_HOUR = 7;
const weekLabels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const monthNames = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function sameMonth(date: Date, base: Date) {
  return date.getFullYear() === base.getFullYear() && date.getMonth() === base.getMonth();
}

function startOfWeek(date: Date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(date.getDate() - date.getDay());
  return start;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

function monthGrid(date: Date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

function eventsForDate(eventos: Evento[], key: string) {
  return eventos
    .filter((evento) => evento.dateString === key)
    .sort((a, b) => a.timeStart.localeCompare(b.timeStart));
}

function toMinutes(value: string) {
  if (!/^\d{2}:\d{2}$/.test(value)) return -1;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/** Semana ISO (segunda a domingo) do dia informado, como no cabeçalho do layout aprovado. */
function isoWeek(date: Date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function capitalize(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function compactRange(start: Date) {
  const end = addDays(start, 6);
  const first = start.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const last = end.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${first} a ${last}`;
}

function headerTitle(mode: ViewMode, date: Date) {
  if (mode === "Dia") {
    return capitalize(date.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
  }
  if (mode === "Semana") {
    const start = startOfWeek(date);
    const month = capitalize(date.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }));
    return `${month} · semana ${isoWeek(addDays(start, 1))} · ${compactRange(start)}`;
  }
  if (mode === "Mês") return capitalize(date.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }));
  return String(date.getFullYear());
}

function navigate(date: Date, mode: ViewMode, direction: number) {
  const next = new Date(date);
  if (mode === "Dia") next.setDate(date.getDate() + direction);
  if (mode === "Semana") next.setDate(date.getDate() + direction * 7);
  if (mode === "Mês") next.setMonth(date.getMonth() + direction);
  if (mode === "Ano") next.setFullYear(date.getFullYear() + direction);
  return next;
}

type Placed = { evento: Evento; start: number; end: number; lane: number; lanes: number };

/** Distribui eventos sobrepostos lado a lado, sem esconder nenhum. */
function layoutTimed(eventos: Evento[]): Placed[] {
  const items = eventos
    .map((evento) => {
      const start = Math.max(0, toMinutes(evento.timeStart));
      const rawEnd = toMinutes(evento.timeEnd);
      const end = rawEnd > start ? rawEnd : Math.min(24 * 60, start + 30);
      return { evento, start, end: Math.max(end, start + 20), lane: 0, lanes: 1 };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const closeCluster = () => {
    const lanes = cluster.reduce((max, item) => Math.max(max, item.lane + 1), 1);
    cluster.forEach((item) => { item.lanes = lanes; });
    cluster = [];
  };

  items.forEach((item) => {
    if (cluster.length && item.start >= clusterEnd) closeCluster();
    const laneEnds: number[] = [];
    cluster.forEach((other) => { laneEnds[other.lane] = Math.max(laneEnds[other.lane] ?? -1, other.end); });
    let lane = 0;
    while (laneEnds[lane] !== undefined && laneEnds[lane] > item.start) lane += 1;
    item.lane = lane;
    cluster.push(item);
    placed.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  });
  if (cluster.length) closeCluster();
  return placed;
}

function eventLabel(evento: Evento) {
  return evento.allDay ? "Dia todo" : `${evento.timeStart} - ${evento.timeEnd}`;
}

function openHandlers(evento: Evento, onOpenEvent: (evento: Evento) => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    title: [evento.title, eventLabel(evento), evento.personName, evento.location].filter(Boolean).join(" · "),
    onClick: (event: MouseEvent) => { event.stopPropagation(); onOpenEvent(evento); },
    onDoubleClick: (event: MouseEvent) => event.stopPropagation(),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        onOpenEvent(evento);
      }
    },
  };
}

/** Etiqueta curta usada no mês, na linha "Dia todo" e na lista do celular. */
function EventPill({ evento, onOpenEvent }: { evento: Evento; onOpenEvent: (evento: Evento) => void }) {
  return (
    <div className={`nx-ag-ev is-pill ${evento.colorClass}`} {...openHandlers(evento, onOpenEvent)}>
      {evento.meetLink && <Video size={12} />}
      <span>
        {evento.allDay ? "Dia todo" : evento.timeStart} {evento.title}
        {evento.personName ? ` · ${evento.personName}` : ""}
      </span>
    </div>
  );
}

function EventCard({ evento, onOpenEvent }: { evento: Evento; onOpenEvent: (evento: Evento) => void }) {
  return (
    <div className={`nx-ag-ev is-card ${evento.colorClass}`} {...openHandlers(evento, onOpenEvent)}>
      <div className="nx-ag-ev-t">
        {evento.meetLink && <Video size={13} />}
        <span>{evento.title}</span>
      </div>
      <div className="nx-ag-ev-m">
        {eventLabel(evento)}
        {evento.personName && <> · <Users size={11} style={{ verticalAlign: "-1px" }} /> {evento.personName}</>}
        {evento.location && ` · ${evento.location}`}
        {evento.participants.length > 0 && ` · ${evento.participants.length} participante(s)`}
      </div>
    </div>
  );
}

export default function AgendaTimeline({
  eventos,
  viewMode,
  setViewMode,
  dataSelecionada,
  setDataSelecionada,
  loading,
  error,
  status,
  onRefresh,
  onCreateEvent,
  onOpenEvent,
  onOpenMenu,
  todayKey,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Abre a grade de horários a partir das 07:00, como no layout aprovado; as demais horas seguem acessíveis pela rolagem.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = viewMode === "Dia" || viewMode === "Semana" ? FIRST_VISIBLE_HOUR * HOUR_HEIGHT : 0;
  }, [viewMode]);

  const renderTimeGrid = (days: Date[], week: boolean) => {
    const keys = days.map(formatDateKey);
    const byDay = keys.map((key) => eventsForDate(eventos, key));
    const hasAllDay = byDay.some((list) => list.some((evento) => evento.allDay));
    const cols = { "--nx-ag-cols": days.length } as CSSProperties;
    return (
      <div className={`nx-ag-grid ${week ? "is-week" : "is-day"}`}>
        <div className="nx-ag-row nx-ag-dhead" style={cols}>
          <div />
          {days.map((day, index) => (
            <button
              key={keys[index]}
              type="button"
              onClick={() => setDataSelecionada(day)}
              className={keys[index] === todayKey ? "is-today" : ""}
            >
              {week
                ? <>{weekLabels[day.getDay()]} <b>{String(day.getDate()).padStart(2, "0")}</b></>
                : <>{capitalize(day.toLocaleDateString("pt-BR", { weekday: "long" }))} <b>{day.toLocaleDateString("pt-BR")}</b></>}
            </button>
          ))}
        </div>
        {hasAllDay && (
          <div className="nx-ag-row nx-ag-allday" style={cols}>
            <span>Dia todo</span>
            {byDay.map((list, index) => (
              <div key={`allday-${keys[index]}`}>
                {list.filter((evento) => evento.allDay).map((evento) => <EventPill key={evento.id} evento={evento} onOpenEvent={onOpenEvent} />)}
              </div>
            ))}
          </div>
        )}
        <div className="nx-ag-row" style={cols}>
          <div className="nx-ag-hours">
            {hours.map((hour) => (
              <span key={hour} style={{ top: hour * HOUR_HEIGHT + 4 }}>{formatHour(hour)}</span>
            ))}
          </div>
          {days.map((day, index) => {
            const weekend = day.getDay() === 0 || day.getDay() === 6;
            return (
              <div key={`col-${keys[index]}`} className={`nx-ag-col ${week && weekend ? "is-weekend" : ""}`}>
                {layoutTimed(byDay[index].filter((evento) => !evento.allDay)).map(({ evento, start, end, lane, lanes }) => {
                  const height = Math.max(22, ((end - start) / 60) * HOUR_HEIGHT - 4);
                  return (
                    <div
                      key={evento.id}
                      className={`nx-ag-ev is-block ${evento.colorClass}`}
                      style={{
                        top: (start / 60) * HOUR_HEIGHT + 2,
                        height,
                        left: `calc(${(lane / lanes) * 100}% + 4px)`,
                        width: `calc(${100 / lanes}% - 8px)`,
                      }}
                      {...openHandlers(evento, onOpenEvent)}
                    >
                      <div className="nx-ag-ev-t">
                        {evento.meetLink && <Video size={12} />}
                        <span>{evento.title}</span>
                      </div>
                      {height > 30 && (
                        <div className="nx-ag-ev-m">
                          {evento.timeStart} - {evento.timeEnd}
                          {evento.personName ? ` · ${evento.personName}` : ""}
                        </div>
                      )}
                      {height > 52 && !week && evento.location && <div className="nx-ag-ev-m">{evento.location}</div>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderDay = () => renderTimeGrid([dataSelecionada], false);

  const renderWeek = () => {
    const start = startOfWeek(dataSelecionada);
    const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    return (
      <>
        {renderTimeGrid(days, true)}

        <div className="nx-ag-wlist">
          {days.map((day) => {
            const key = formatDateKey(day);
            const dayEvents = eventsForDate(eventos, key);
            return (
              <div
                key={`mobile-${key}`}
                role="button"
                tabIndex={0}
                onClick={() => { setDataSelecionada(day); setViewMode("Dia"); }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setDataSelecionada(day); setViewMode("Dia"); }
                }}
                className="nx-card nx-ag-wday"
              >
                <div className="nx-ag-wday-h">
                  <strong>{day.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" })}</strong>
                  <span className="nx-faint nx-small">{dayEvents.length} evento(s)</span>
                </div>
                <div className="nx-ag-wday-b">
                  {dayEvents.length
                    ? dayEvents.map((evento) => <EventCard key={evento.id} evento={evento} onOpenEvent={onOpenEvent} />)
                    : <span className="nx-faint nx-small">Sem compromissos.</span>}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  };

  const renderMonth = () => (
    <div className="nx-ag-month">
      {weekLabels.map((label) => (
        <div key={label} className="nx-ag-wd">{label}</div>
      ))}
      {monthGrid(dataSelecionada).map((day) => {
        const key = formatDateKey(day);
        const dayEvents = eventsForDate(eventos, key);
        const classes = [
          "nx-ag-mcell",
          sameMonth(day, dataSelecionada) ? "" : "is-out",
          key === todayKey ? "is-today" : "",
          key === formatDateKey(dataSelecionada) ? "is-selected" : "",
        ].filter(Boolean).join(" ");
        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            aria-label={day.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}
            onDoubleClick={() => onCreateEvent(day)}
            onClick={() => setDataSelecionada(day)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setDataSelecionada(day); }
            }}
            className={classes}
          >
            <span className="nx-ag-mday">{day.getDate()}</span>
            {dayEvents.slice(0, 4).map((evento) => <EventPill key={evento.id} evento={evento} onOpenEvent={onOpenEvent} />)}
            {dayEvents.length > 4 && <span className="nx-ag-more">+{dayEvents.length - 4} eventos</span>}
          </div>
        );
      })}
    </div>
  );

  const renderYear = () => (
    <div className="nx-ag-year">
      {monthNames.map((month, monthIndex) => {
        const monthDate = new Date(dataSelecionada.getFullYear(), monthIndex, 1);
        return (
          <div key={month} className="nx-card nx-ag-ymonth">
            <button type="button" onClick={() => { setDataSelecionada(monthDate); setViewMode("Mês"); }}>
              {month}
            </button>
            <div className="nx-ag-ygrid">
              {weekLabels.map((label) => <span key={`${month}-${label}`}>{label[0]}</span>)}
              {monthGrid(monthDate).map((day) => {
                const key = formatDateKey(day);
                const count = eventsForDate(eventos, key).length;
                return (
                  <button
                    key={`${month}-${key}`}
                    type="button"
                    onClick={() => { setDataSelecionada(day); setViewMode("Dia"); }}
                    className={[sameMonth(day, monthDate) ? "" : "is-out", key === todayKey ? "is-today" : ""].filter(Boolean).join(" ")}
                    aria-label={`${day.toLocaleDateString("pt-BR")}${count ? ` · ${count} evento(s)` : ""}`}
                  >
                    {day.getDate()}
                    {count > 0 && <i />}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <header className="nx-ph nx-ag-head">
        <div>
          <h1>Agenda</h1>
          <p className="nx-ag-sub">{headerTitle(viewMode, dataSelecionada)}</p>
        </div>
        <div className="nx-ph-actions">
          <button type="button" className="nx-btn nx-ag-icon nx-ag-menu" aria-label="Abrir menu da agenda" onClick={onOpenMenu}>
            <Menu size={16} />
          </button>
          <span className="nx-ag-nav">
            <button type="button" className="nx-btn is-ghost nx-ag-icon" aria-label="Período anterior" onClick={() => setDataSelecionada(navigate(dataSelecionada, viewMode, -1))}>
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="nx-btn is-ghost nx-ag-icon" aria-label="Próximo período" onClick={() => setDataSelecionada(navigate(dataSelecionada, viewMode, 1))}>
              <ChevronRight size={16} />
            </button>
            <button type="button" className="nx-btn" onClick={() => setDataSelecionada(new Date())}>
              Hoje
            </button>
          </span>
          <span className={`nx-badge ${status.connected ? "is-green" : "is-amber"}`} style={{ alignSelf: "center" }}>
            {status.connected ? "Google em tempo real" : "Modo local"}
          </span>
          <button type="button" className="nx-btn nx-ag-icon" aria-label="Atualizar agenda" title="Atualizar agenda" onClick={onRefresh}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
          <div className="nx-seg" role="group" aria-label="Visualização da agenda">
            {views.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
                className={viewMode === mode ? "is-active" : ""}
              >
                {mode}
              </button>
            ))}
          </div>
          <button type="button" className="nx-btn is-primary" onClick={() => onCreateEvent(dataSelecionada)}>
            <Plus size={16} />
            Novo evento
          </button>
        </div>
      </header>

      <section className="nx-card nx-ag-main" aria-label="Calendário">
        {error && <div className="nx-ag-alert" role="alert">{error}</div>}

        {eventos.length === 0 && !loading && (
          <div className="nx-ag-empty">
            <span>Nenhum evento neste período.</span>
            <button type="button" className="nx-btn is-sm" onClick={() => onCreateEvent(dataSelecionada)}>
              <CalendarPlus size={14} />
              Criar
            </button>
          </div>
        )}

        <div className="nx-ag-scroll" ref={scrollRef}>
          {viewMode === "Dia" && renderDay()}
          {viewMode === "Semana" && renderWeek()}
          {viewMode === "Mês" && renderMonth()}
          {viewMode === "Ano" && renderYear()}
        </div>

        <div className="nx-ag-foot">
          <span>{eventos.length} eventos carregados</span>
          <span>
            {status.connected && <ExternalLink size={12} />}
            {status.calendar}
          </span>
        </div>
      </section>
    </>
  );
}
