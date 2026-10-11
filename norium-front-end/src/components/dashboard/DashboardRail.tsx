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
    month: "2-digit",
    year: "numeric",
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
    <aside className="nxd-col nxd-rail" aria-label="Seu dia">
      <section className="nx-card nxd-card">
        <div className="nx-card-h">
          <h2>Seu dia</h2>
        </div>
        <div className="nx-card-b">
          <div className="nx-row">
            <span className="nxd-ico is-blue"><Clock3 size={16} strokeWidth={1.75} /></span>
            <div className="nx-grow">
              <div className="nx-row-t">{now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</div>
              <div className="nx-row-sub">{dateLabel(now)}</div>
            </div>
          </div>

          {weather && !weather.error ? (
            <>
              <div className="nx-row">
                <span className="nxd-ico is-amber"><CloudSun size={16} strokeWidth={1.75} /></span>
                <div className="nx-grow">
                  <div className="nx-row-t">{weather.loading ? "..." : `${weather.temperature}°C`}</div>
                  <div className="nx-row-sub">{weather.description}</div>
                </div>
              </div>

              <div className="nx-row">
                <span className="nxd-ico"><MapPin size={16} strokeWidth={1.75} /></span>
                <div className="nx-grow">
                  <div className="nx-row-t nx-ell">{weather.city || "Localização"}</div>
                  <div className="nx-row-sub">{`Umidade ${weather.humidity ?? 0}% · Vento ${weather.wind ?? 0} km/h`}</div>
                </div>
              </div>
            </>
          ) : (
            // Sem CEP (ou falha no clima): uma linha só, que leva ao perfil para informar o CEP.
            <button type="button" className="nx-row nxd-setup" onClick={() => onNavigate("Perfil")}>
              <span className="nxd-ico is-amber"><CloudSun size={16} strokeWidth={1.75} /></span>
              <span className="nx-grow">
                <span className="nx-row-t block">Clima e localização</span>
                <span className="nx-row-sub block">{weather?.error ? "Não foi possível carregar · revisar CEP" : "Informe seu CEP no perfil para ver o clima"}</span>
              </span>
              <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}

          <button type="button" className="nxd-decision" onClick={() => onNavigate(decision.tab)}>
            <span className="nx-grow">
              <small>Próxima decisão</small>
              <strong>{decision.label}</strong>
              <em>{decision.detail}</em>
            </span>
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="nx-card nxd-card">
        <div className="nx-card-b pt-2">
          <button type="button" className="nx-row nxd-row" onClick={() => onNavigate("Agenda")}>
            <span className="nxd-ico is-blue"><CalendarDays size={16} strokeWidth={1.75} /></span>
            <span className="nx-grow">
              <span className="nx-row-sub block">Próximos passos · {todayEventCount} hoje</span>
              <span className="nx-row-t nx-ell block">{nextEvent?.title || "Agenda livre"}</span>
              <span className="nx-row-sub block">
                {nextEvent
                  ? new Date(nextEvent.timestamp).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "Nenhum compromisso próximo"}
              </span>
            </span>
          </button>

          <button type="button" className="nx-row nxd-row" onClick={() => onNavigate("Tarefas")}>
            <span className="nxd-ico is-green"><Crosshair size={16} strokeWidth={1.75} /></span>
            <span className="nx-grow">
              <span className="nx-row-sub block">Foco do dia{taskOverdueCount > 0 ? ` · ${taskOverdueCount} vencida${taskOverdueCount === 1 ? "" : "s"}` : ""}</span>
              <span className="nx-row-t nx-ell block">{focusTask?.title || "Sem tarefas atribuídas"}</span>
              <span className="nx-row-sub block">{focusTask?.meta || "Abra o Kanban para revisar"}</span>
            </span>
          </button>
        </div>
      </section>

      <section className="nx-card nxd-card">
        <div className="nx-card-h">
          <div className="nxd-card-h-col">
            <p className="nxd-eyebrow">Financeiro</p>
            <h2>Contas a pagar</h2>
          </div>
          <button type="button" className="nx-more inline-flex items-center gap-1" onClick={() => onNavigate("Financeiro")}>
            Abrir <ChevronRight size={14} strokeWidth={1.75} />
          </button>
        </div>
        <div className="nx-card-b">
          <div className="nxd-total">
            <span><ReceiptText size={16} strokeWidth={1.75} />{money.format(financePendingTotal)}</span>
            {financeOverdueCount > 0 && (
              <em className="nx-badge is-red not-italic"><AlertTriangle size={12} strokeWidth={1.75} />{financeOverdueCount} vencida{financeOverdueCount === 1 ? "" : "s"}</em>
            )}
          </div>
          <div className="nxd-list" aria-label="Pendências financeiras">
            {financePending.map((item) => (
              <button type="button" className="nx-row nxd-row" key={`${item.scheduled ? "scheduled" : "entry"}-${item.id}`} onClick={() => onNavigate("Financeiro")}>
                <span className="nx-grow">
                  <strong className="nx-row-t nx-ell block">{item.title}</strong>
                  <small className="nx-row-sub block">{item.scheduled ? "Programada" : "Pendente"}{item.dueDate ? ` · ${new Date(`${item.dueDate}T12:00:00`).toLocaleDateString("pt-BR")}` : " · Sem vencimento"}</small>
                </span>
                <b className="nxd-amount">{money.format(item.amount)}</b>
              </button>
            ))}
            {!financePending.length && <p className="nxd-empty">Nenhuma conta pendente.</p>}
          </div>
        </div>
      </section>
    </aside>
  );
}
