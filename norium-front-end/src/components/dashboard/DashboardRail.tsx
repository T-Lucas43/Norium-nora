import { AlertTriangle, CalendarDays, ChevronRight, Clock3, CloudSun, Crosshair, MapPin, ReceiptText, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import noraDigital from "../../assets/nora-brand.png";
import type { OmnichannelEvent } from "../../types/omnichannel";
import type { DashboardFinancePending, DashboardWeather } from "./Dashboard";

type DashboardRailProps = {
  weather: DashboardWeather | null;
  calendarEvents: OmnichannelEvent[];
  financePending: DashboardFinancePending[];
  financePendingTotal: number;
  financeOverdueCount: number;
  onNavigate: (tab: string) => void;
  onOpenNora: () => void;
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
  onNavigate,
  onOpenNora,
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
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const money = useMemo(() => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }), []);

  return (
    <aside className="norium-dashboard-rail">
      <section className="norium-dashboard-card norium-day-summary">
        <p className="norium-dashboard-card-label">Resumo do dia</p>

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
      </section>

      <section className="norium-dashboard-card norium-next-steps">
        <button type="button" onClick={() => onNavigate("Agenda")}>
          <CalendarDays />
          <span>
            <small>Próximos passos</small>
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
            <small>Foco do dia</small>
            <strong>Finalizar prioridades</strong>
            <em>Abra o Kanban para revisar</em>
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

      <section className="norium-nora-portrait-card">
        <div className="norium-nora-portrait-copy">
          <h2>NORA <span>Online</span></h2>
          <p>Sua assistente inteligente</p>
        </div>
        <img src={noraDigital} alt="Nora, assistente digital do Norium" />
        <button type="button" onClick={onOpenNora}>
          <span>Fale com a Nora...</span>
          <Send size={17} />
        </button>
      </section>
    </aside>
  );
}
