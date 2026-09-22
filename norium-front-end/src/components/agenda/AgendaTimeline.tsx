import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  MapPin,
  RefreshCw,
  Users,
  Video,
} from "lucide-react";
import type { AgendaStatus, Evento, ViewMode } from "./AgendaDashboard";
import Button from "../shared/Button";

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
  todayKey: string;
}

const views: ViewMode[] = ["Dia", "Semana", "Mês", "Ano"];
const hours = Array.from({ length: 24 }, (_, index) => index);
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

function eventHour(evento: Evento) {
  if (evento.allDay || !evento.timeStart.includes(":")) return -1;
  return Number(evento.timeStart.slice(0, 2));
}

function compactRange(start: Date) {
  const end = addDays(start, 6);
  const first = start.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  const last = end.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  return `${first} - ${last}`;
}

function headerTitle(mode: ViewMode, date: Date) {
  if (mode === "Dia") {
    return date.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  if (mode === "Semana") return compactRange(startOfWeek(date));
  if (mode === "Mês") return date.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
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

function EventChip({ evento, dense = false, onOpenEvent }: { evento: Evento; dense?: boolean; onOpenEvent: (evento: Evento) => void }) {
  const content = (
    <div className={`min-w-0 rounded-md border-l-4 px-2.5 py-2 text-left shadow-sm ${evento.colorClass}`}>
      <div className="flex min-w-0 items-center gap-1.5">
        {evento.meetLink && <Video size={13} className="shrink-0" />}
        <span className={`${dense ? "text-sm" : "text-sm"} truncate font-bold leading-4`}>{evento.title}</span>
      </div>
      {!dense && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs font-bold opacity-85">
          <span>{evento.allDay ? "Dia todo" : `${evento.timeStart} - ${evento.timeEnd}`}</span>
          {evento.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin size={11} />
              {evento.location}
            </span>
          )}
          {evento.participants.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Users size={11} />
              {evento.participants.length}
            </span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div
      role="button"
      tabIndex={0}
      title={evento.title}
      className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      onClick={(event) => { event.stopPropagation(); onOpenEvent(evento); }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onOpenEvent(evento);
        }
      }}
    >
      {content}
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
  todayKey,
}: TimelineProps) {
  const dayKey = formatDateKey(dataSelecionada);

  const renderDay = () => {
    const dayEvents = eventsForDate(eventos, dayKey);
    const allDay = dayEvents.filter((evento) => evento.allDay);
    const timed = dayEvents.filter((evento) => !evento.allDay);
    return (
      <div className="agenda-day-view min-w-[760px]">
        <div className="grid grid-cols-[72px_1fr] border-b border-[var(--border)]">
          <div className="p-3 text-right text-xs font-bold text-[var(--text-secondary)]">Dia todo</div>
          <div className="flex min-h-14 flex-wrap gap-2 border-l border-[var(--border)] p-2">
            {allDay.map((evento) => <EventChip key={evento.id} evento={evento} dense onOpenEvent={onOpenEvent} />)}
          </div>
        </div>
        {hours.map((hour) => {
          const hourEvents = timed.filter((evento) => eventHour(evento) === hour);
          return (
            <div key={hour} className="grid min-h-20 grid-cols-[72px_1fr] border-b border-[var(--border)]">
              <div className="pr-3 pt-2 text-right text-xs font-bold text-[var(--text-secondary)]">{formatHour(hour)}</div>
              <div className="space-y-2 border-l border-[var(--border)] p-2">
                {hourEvents.map((evento) => <EventChip key={evento.id} evento={evento} onOpenEvent={onOpenEvent} />)}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderWeek = () => {
    const start = startOfWeek(dataSelecionada);
    const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    return (
      <>
        <div className="agenda-week-view min-w-[980px]">
          <div className="grid grid-cols-[64px_repeat(7,minmax(120px,1fr))] border-b border-[var(--border)]">
            <div />
            {days.map((day) => {
              const key = formatDateKey(day);
              return (
                <button
                  key={key}
                  onClick={() => setDataSelecionada(day)}
                  className={`border-l border-[var(--border)] px-2 py-3 text-center hover:bg-[var(--surface-hover)] ${key === todayKey ? "text-[var(--primary)]" : ""}`}
                >
                  <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">{weekLabels[day.getDay()]}</p>
                  <p className={`mx-auto mt-1 grid h-8 w-8 place-items-center rounded-full text-sm font-bold ${key === todayKey ? "bg-[var(--primary)] text-white" : ""}`}>
                    {day.getDate()}
                  </p>
                </button>
              );
            })}
          </div>
          {hours.map((hour) => (
            <div key={hour} className="grid min-h-24 grid-cols-[64px_repeat(7,minmax(120px,1fr))] border-b border-[var(--border)]">
              <div className="pr-2 pt-2 text-right text-xs font-bold text-[var(--text-secondary)]">{formatHour(hour)}</div>
              {days.map((day) => {
                const key = formatDateKey(day);
                const hourEvents = eventsForDate(eventos, key).filter((evento) => evento.allDay || eventHour(evento) === hour);
                return (
                  <div key={`${key}-${hour}`} className="space-y-1 border-l border-[var(--border)] p-1.5">
                    {hourEvents.slice(0, 3).map((evento) => <EventChip key={evento.id} evento={evento} dense onOpenEvent={onOpenEvent} />)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="agenda-week-mobile hidden space-y-2 p-3">
          {days.map((day) => {
            const key = formatDateKey(day);
            const dayEvents = eventsForDate(eventos, key);
            return (
              <button
                key={`mobile-${key}`}
                type="button"
                onClick={() => { setDataSelecionada(day); setViewMode("Dia"); }}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-left"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <strong className="text-sm capitalize">{day.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "short" })}</strong>
                  <span className="text-xs font-bold text-[var(--text-secondary)]">{dayEvents.length} evento(s)</span>
                </div>
                <div className="space-y-2">
                  {dayEvents.length
                    ? dayEvents.map((evento) => <EventChip key={evento.id} evento={evento} onOpenEvent={onOpenEvent} />)
                    : <span className="text-xs font-semibold text-[var(--text-secondary)]">Sem compromissos.</span>}
                </div>
              </button>
            );
          })}
        </div>
      </>
    );
  };

  const renderMonth = () => (
    <div className="agenda-month-view grid min-h-full min-w-[920px] grid-cols-7 border-l border-t border-[var(--border)]">
      {weekLabels.map((label) => (
        <div key={label} className="border-b border-r border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-center text-xs font-bold uppercase text-[var(--text-secondary)]">
          {label}
        </div>
      ))}
      {monthGrid(dataSelecionada).map((day) => {
        const key = formatDateKey(day);
        const dayEvents = eventsForDate(eventos, key);
        return (
          <button
            key={key}
            onDoubleClick={() => onCreateEvent(day)}
            onClick={() => setDataSelecionada(day)}
            className={`min-h-32 border-b border-r border-[var(--border)] p-2 text-left hover:bg-[var(--surface-hover)] ${sameMonth(day, dataSelecionada) ? "bg-[var(--background)]" : "bg-[var(--surface)] opacity-45"}`}
          >
            <span className={`mb-2 grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${key === todayKey ? "bg-[var(--primary)] text-white" : ""}`}>
              {day.getDate()}
            </span>
            <div className="space-y-1">
              {dayEvents.slice(0, 4).map((evento) => <EventChip key={evento.id} evento={evento} dense onOpenEvent={onOpenEvent} />)}
              {dayEvents.length > 4 && <p className="text-xs font-bold text-[var(--primary)]">+{dayEvents.length - 4} mais</p>}
            </div>
          </button>
        );
      })}
    </div>
  );

  const renderYear = () => (
    <div className="agenda-year-view grid min-w-[980px] grid-cols-3 gap-4 p-1 xl:grid-cols-4">
      {monthNames.map((month, monthIndex) => {
        const monthDate = new Date(dataSelecionada.getFullYear(), monthIndex, 1);
        return (
          <div key={month} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
            <button onClick={() => { setDataSelecionada(monthDate); setViewMode("Mês"); }} className="mb-3 text-sm font-bold hover:text-[var(--primary)]">
              {month}
            </button>
            <div className="grid grid-cols-7 text-center text-xs font-bold text-[var(--text-secondary)]">
              {weekLabels.map((label) => <span key={`${month}-${label}`}>{label[0]}</span>)}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-y-1 text-center text-xs">
              {monthGrid(monthDate).map((day) => {
                const key = formatDateKey(day);
                const count = eventsForDate(eventos, key).length;
                return (
                  <button
                    key={`${month}-${key}`}
                    onClick={() => { setDataSelecionada(day); setViewMode("Dia"); }}
                    className={`relative mx-auto grid h-7 w-7 place-items-center rounded-full font-semibold ${sameMonth(day, monthDate) ? "hover:bg-[var(--surface-hover)]" : "opacity-25"} ${key === todayKey ? "bg-[var(--primary)] text-white" : ""}`}
                  >
                    {day.getDate()}
                    {count > 0 && <span className="absolute bottom-0 h-1 w-1 rounded-full bg-emerald-400" />}
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
    <section className="agenda-timeline flex h-full min-w-0 flex-1 flex-col bg-[var(--background)]">
      <div className="agenda-timeline-toolbar flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="agenda-date-navigation flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" iconOnly onClick={() => setDataSelecionada(navigate(dataSelecionada, viewMode, -1))}>
            <ChevronLeft size={18} />
          </Button>
          <Button variant="ghost" size="sm" iconOnly onClick={() => setDataSelecionada(navigate(dataSelecionada, viewMode, 1))}>
            <ChevronRight size={18} />
          </Button>
          <Button size="sm" onClick={() => setDataSelecionada(new Date())}>
            Hoje
          </Button>
          <h1 className="truncate px-2 text-lg font-bold capitalize">{headerTitle(viewMode, dataSelecionada)}</h1>
        </div>

        <div className="agenda-view-actions flex items-center gap-2">
          <span className={`hidden rounded-full px-2 py-1 text-xs font-bold md:inline-flex ${status.connected ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-300"}`}>
            {status.connected ? "Google em tempo real" : "Modo local"}
          </span>
          <Button size="sm" iconOnly onClick={onRefresh}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </Button>
          <Button variant="primary" size="sm" iconOnly onClick={() => onCreateEvent(dataSelecionada)}>
            <CalendarPlus size={17} />
          </Button>
          <div className="agenda-view-switcher flex rounded-lg border border-[var(--border)] bg-[var(--background)] p-1">
            {views.map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`h-8 rounded-md px-3 text-xs font-bold ${viewMode === mode ? "bg-[var(--surface)] shadow-sm" : "text-[var(--text-secondary)] hover:text-[var(--text)]"}`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs font-bold text-amber-300">
          {error}
        </div>
      )}

      <div className="agenda-scroll flex-1 overflow-auto">
        {eventos.length === 0 && !loading && (
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--text-secondary)]">
            <span>Nenhum evento neste período.</span>
            <Button onClick={() => onCreateEvent(dataSelecionada)} className="py-2">
              <CalendarPlus size={14} />
              Criar
            </Button>
          </div>
        )}

        {viewMode === "Dia" && renderDay()}
        {viewMode === "Semana" && renderWeek()}
        {viewMode === "Mês" && renderMonth()}
        {viewMode === "Ano" && renderYear()}
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--surface)] px-4 text-xs font-semibold text-[var(--text-secondary)]">
        <span>{eventos.length} eventos carregados</span>
        <span className="inline-flex items-center gap-1">
          {status.connected && <ExternalLink size={12} />}
          {status.calendar}
        </span>
      </div>
    </section>
  );
}
