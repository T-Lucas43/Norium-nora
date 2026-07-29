import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, Plus } from "lucide-react";
import Hero from "./Hero";
import Summary from "./Summary";
import IntegrationGrid from "./IntegrationGrid";
import Statistics from "./Statistics";
import RecentActivity from "./RecentActivity";
import ActiveAutomations from "./ActiveAutomations";
import DashboardRail from "./DashboardRail";
import type { EventSource, OmnichannelEvent, PerfilOperador } from "../../types/omnichannel";

type EventsBySource = Record<EventSource, OmnichannelEvent[]>;

export type DashboardMetrics = {
  emails: number;
  whatsapp: number;
  calendar: number;
  tasks: number;
  total: number;
};

export type DashboardWeather = {
  city: string;
  temperature: number;
  description: string;
  humidity?: number;
  wind?: number;
  loading: boolean;
  error?: string;
};

type DashboardProps = {
  eventsBySource: EventsBySource;
  connected: boolean;
  profile: PerfilOperador | null;
  onNavigate: (tab: string) => void;
  onOpenNora: () => void;
};

function describeWeather(code: number) {
  if (code === 0) return "Ceu limpo";
  if ([1, 2, 3].includes(code)) return "Parcialmente nublado";
  if ([45, 48].includes(code)) return "Neblina";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "Chuva";
  if ([95, 96, 99].includes(code)) return "Trovoadas";
  return "Clima atualizado";
}

function useWeatherFromCep(cep?: string) {
  const [weather, setWeather] = useState<DashboardWeather | null>(null);

  useEffect(() => {
    const cleanCep = (cep || "").replace(/\D/g, "");
    if (cleanCep.length !== 8) {
      setWeather(null);
      return;
    }

    let cancelled = false;

    async function loadWeather() {
      setWeather((current) => ({
        city: current?.city || "Buscando cidade",
        temperature: current?.temperature || 0,
        description: "Atualizando clima",
        loading: true,
      }));

      try {
        const cepResponse = await fetch(`https://viacep.com.br/ws/${cleanCep}/json/`);
        const cepData = await cepResponse.json();
        if (cepData?.erro) throw new Error("CEP nao encontrado.");

        const city = `${cepData.localidade || ""}${cepData.uf ? `, ${cepData.uf}` : ""}`.trim();
        const geoResponse = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cepData.localidade)}&count=1&language=pt&format=json&countryCode=BR`,
        );
        const geoData = await geoResponse.json();
        const place = geoData?.results?.[0];
        if (!place) throw new Error("Cidade sem coordenadas para clima.");

        const weatherResponse = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=America%2FSao_Paulo`,
        );
        const weatherData = await weatherResponse.json();
        const current = weatherData?.current;
        if (!current) throw new Error("Clima indisponivel agora.");

        if (!cancelled) {
          setWeather({
            city,
            temperature: Math.round(Number(current.temperature_2m || 0)),
            humidity: Number(current.relative_humidity_2m || 0),
            wind: Number(current.wind_speed_10m || 0),
            description: describeWeather(Number(current.weather_code || 0)),
            loading: false,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setWeather({
            city: "Clima indisponivel",
            temperature: 0,
            description: err instanceof Error ? err.message : "Nao foi possivel carregar o clima.",
            loading: false,
            error: "Falha ao buscar clima.",
          });
        }
      }
    }

    void loadWeather();
    return () => {
      cancelled = true;
    };
  }, [cep]);

  return weather;
}

export default function Dashboard({ eventsBySource, connected, profile, onNavigate, onOpenNora }: DashboardProps) {
  const metrics = useMemo<DashboardMetrics>(() => {
    const emails = eventsBySource.gmail.length;
    const whatsapp = eventsBySource.whatsapp.length;
    const calendar = eventsBySource.calendar.length;
    const tasks = eventsBySource.kanban.length;
    return {
      emails,
      whatsapp,
      calendar,
      tasks,
      total: emails + whatsapp + calendar + tasks + eventsBySource.telegram.length,
    };
  }, [eventsBySource]);

  const recentEvents = useMemo(
    () =>
      Object.values(eventsBySource)
        .flat()
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, 18),
    [eventsBySource],
  );

  const weather = useWeatherFromCep(profile?.cep);

  return (
    <main className="norium-dashboard">
      <div className="norium-dashboard-main">
        <Hero
          metrics={metrics}
          profile={profile}
          connected={connected}
          onOpenNora={onOpenNora}
          onNavigate={onNavigate}
        />

        <Summary metrics={metrics} onNavigate={onNavigate} />

        <section className="norium-dashboard-detail-grid">
          <RecentActivity events={recentEvents} onNavigate={onNavigate} />

          <section className="norium-dashboard-card norium-today-agenda">
            <div className="norium-dashboard-section-heading">
              <h2>Agenda de hoje</h2>
              <button type="button" onClick={() => onNavigate("Agenda")}>Ver agenda</button>
            </div>
            <div className="norium-today-agenda-list">
              {eventsBySource.calendar.slice(0, 4).map((event, index) => (
                <button type="button" key={event.id} onClick={() => onNavigate("Agenda")}>
                  <span className={`norium-agenda-dot color-${index % 3}`} />
                  <time>
                    {new Date(event.timestamp).toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <span>
                    <strong>{event.title}</strong>
                    <small>{event.description || "Compromisso da agenda"}</small>
                  </span>
                </button>
              ))}
              {!eventsBySource.calendar.length && (
                <div className="norium-dashboard-empty">
                  <CalendarDays size={20} />
                  Nenhum compromisso recente.
                </div>
              )}
            </div>
            <button className="norium-dashboard-card-action" type="button" onClick={() => onNavigate("Agenda")}>
              <Plus size={16} />
              Novo compromisso
            </button>
          </section>

          <section className="norium-dashboard-card norium-task-status">
            <div className="norium-dashboard-section-heading">
              <h2>Tarefas</h2>
              <button type="button" onClick={() => onNavigate("Tarefas")}>Ver todas</button>
            </div>
            <div className="norium-task-status-ring">
              <span><Check size={34} /></span>
            </div>
            <div className="norium-task-status-copy">
              <strong>{metrics.tasks ? `${metrics.tasks} atualizações recentes` : "Você está em dia!"}</strong>
              <small>Acompanhe prioridades e prazos no Kanban.</small>
            </div>
            <button className="norium-dashboard-card-action" type="button" onClick={() => onNavigate("Tarefas")}>
              <Plus size={16} />
              Nova tarefa
            </button>
          </section>
        </section>

        <section className="norium-dashboard-secondary-content">
          <IntegrationGrid onNavigate={onNavigate} />
          <ActiveAutomations onNavigate={onNavigate} />
          <Statistics metrics={metrics} onOpenNora={onOpenNora} />
        </section>
      </div>

      <DashboardRail
        weather={weather}
        calendarEvents={eventsBySource.calendar}
        onNavigate={onNavigate}
        onOpenNora={onOpenNora}
      />
    </main>
  );
}
