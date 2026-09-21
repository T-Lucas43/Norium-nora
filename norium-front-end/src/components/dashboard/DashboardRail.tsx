import { AlertTriangle, ArrowRight, CalendarDays, ChevronRight, Clock3, CloudSun, Crosshair, MapPin, ReceiptText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OmnichannelEvent } from "../../types/omnichannel";
import type { DashboardFinancePending, DashboardWeather } from "./Dashboard";

export type DayFocusTask = {
  title: string;
  meta: string;
};

type DashboardRailProps = {
  weather: DashboardWeather | null;
  calendarEvents: OmnichannelEvent[];
  financePending: DashboardFinancePending[];
  financePendingTotal: number;
  financeOverdueCount: number;
  focusTask: DayFocusTask | null;
  taskOverdueCount: number;
  todayEventCount: number;
  onNavigate: (tab: string) => void;
};

function dateLabel(value: Date) {
  return value.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

export default function DashboardRail({
  weather,
  calendarEvents,
  financePending,
  financePendingTotal,
  financeOverdueCount,
  focusTask,
  taskOverdueCount,
  todayEventCount,
  onNavigate,
}: DashboardRailProps) {
  const [now, setNow] = useState(() => new Date());
  const nextEvent = useMemo(
    () =>
      [...calendarEvents]
        .filter((event) => Date.parse(event.timestamp) >= Date.now() - 60_000)
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0],
    [calendarEvents],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const money = useMemo(() => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }), []);

  const decision = taskOverdueCount > 0
    ? { tab: "Tarefas", label: "Resolver pendências", detail: `${taskOverdueCount} ${taskOverdueCount === 1 ? "tarefa vencida" : "tarefas vencidas"} precisam de você` }
    : nextEvent
      ? { tab: "Agenda", label: "Preparar próximo compromisso", detail: nextEvent.title }
      : focusTask
        ? { tab: "Tarefas", label: "Avançar o foco do dia", detail: focusTask.title }
        : { tab: "Central", label: "Ver a Central", detail: "Nenhuma pendência urgente" };

  return (
    <aside className="norium-dashboard-rail" aria-label="Seu dia">
      <section className="norium-dashboard-card norium-day-summary">
        <p className="norium-dashboard-card-label">Seu dia</p>

        <div className="norium-day-summary-row">
          <Clock3 />
          <div>
            <strong>{now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</strong>
            <span>{dateLabel(now)}</span>
          </div>
        </div>

        <div className="norium-day-summary-row">
          <CloudSun className="is-weather" />
          <div>
            <strong>{weather?.loading ? "..." : weather ? `${weather.temperature}°C` : "--"}</strong>
            <span>{weather?.description || "Informe seu CEP"}</span>
          </div>
        </div>

        <div className="norium-day-summary-row">
          <MapPin />
          <div>
            <strong>{weather?.city || "Localização não configurada"}</strong>
            <span>
              {weather && !weather.error
                ? `Umidade ${weather.humidity ?? 0}% · Vento ${weather.wind ?? 0} km/h`
                : "Atualize o CEP no perfil"}
            </span>
          </div>
        </div>

        <button type="button" className="norium-day-decision" onClick={() => onNavigate(decision.tab)}>
          <span>
            <small>Próxima decisão</small>
            <strong>{decision.label}</strong>
            <em>{decision.detail}</em>
          </span>
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </section>

      <section className="norium-dashboard-card norium-next-steps">
        <button type="button" onClick={() => onNavigate("Agenda")}>
          <CalendarDays />
          <span>
            <small>Próximos passos · {todayEventCount} hoje</small>
            <strong>{nextEvent?.title || "Agenda livre"}</strong>
            <em>
              {nextEvent
                ? new Date(nextEvent.timestamp).toLocaleString("pt-BR", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "Nenhum compromisso próximo"}
            </em>
          </span>
        </button>

        <button type="button" onClick={() => onNavigate("Tarefas")}>
          <Crosshair className="is-focus" />
          <span>
            <small>Foco do dia{taskOverdueCount > 0 ? ` · ${taskOverdueCount} vencida${taskOverdueCount === 1 ? "" : "s"}` : ""}</small>
            <strong>{focusTask?.title || "Sem tarefas atribuídas"}</strong>
            <em>{focusTask?.meta || "Abra o Kanban para revisar"}</em>
          </span>
        </button>
      </section>

      <section className="norium-dashboard-card norium-finance-pending">
        <div className="norium-finance-pending-heading">
          <div><p className="norium-dashboard-card-label">Financeiro</p><h2>Contas a pagar</h2></div>
          <button type="button" onClick={() => onNavigate("Financeiro")}>Abrir <ChevronRight size={14} /></button>
        </div>
        <div className="norium-finance-pending-summary">
          <span><ReceiptText size={17} />{money.format(financePendingTotal)}</span>
          {financeOverdueCount > 0 && <em><AlertTriangle size={13} />{financeOverdueCount} vencida{financeOverdueCount === 1 ? "" : "s"}</em>}
        </div>
        <div className="norium-finance-pending-list" aria-label="Pendências financeiras">
          {financePending.map((item) => (
            <button type="button" key={`${item.scheduled ? "scheduled" : "entry"}-${item.id}`} onClick={() => onNavigate("Financeiro")}>
              <span><strong>{item.title}</strong><small>{item.scheduled ? "Programada" : "Pendente"}{item.dueDate ? ` · ${new Date(`${item.dueDate}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}` : " · Sem vencimento"}</small></span>
              <b>{money.format(item.amount)}</b>
            </button>
          ))}
          {!financePending.length && <p>Nenhuma conta pendente.</p>}
        </div>
      </section>
    </aside>
  );
}
