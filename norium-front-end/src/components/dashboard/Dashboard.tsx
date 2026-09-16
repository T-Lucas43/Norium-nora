import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CalendarClock, Check, Plus } from "lucide-react";
import Hero from "./Hero";
import Summary from "./Summary";
import IntegrationGrid from "./IntegrationGrid";
import Statistics from "./Statistics";
import RecentActivity from "./RecentActivity";
import ActiveAutomations from "./ActiveAutomations";
import DashboardRail from "./DashboardRail";
import type { EventSource, OmnichannelEvent, PerfilOperador } from "../../types/omnichannel";
import type { TaskItem } from "../../features/tasks/types";
import { apiRequest } from "../../core/api/client";

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
  userId: string;
  onNavigate: (tab: string) => void;
  onOpenNora: (prompt?: string) => void;
};

type FinanceSnapshot = {
  lancamentos?: Array<{ id: string; title: string; type: "entrada" | "saida"; amount: number; status: "pendente" | "pago" | "cancelado"; dueDate?: string | null }>;
  programados?: Array<{ id: string; title: string; type: "entrada" | "saida"; amount: number; active: boolean; nextDueDate?: string | null }>;
  resumo?: { saldo?: number; pendente?: number; vencidos?: number };
};

export type DashboardFinancePending = {
  id: string;
  title: string;
  amount: number;
  dueDate: string | null;
  scheduled: boolean;
};

const taskPriorityRank: Record<TaskItem["priority"], number> = { urgente: 0, alta: 1, media: 2, baixa: 3 };
const taskStatusLabel: Record<TaskItem["status"], string> = { pendente: "Pendente", andamento: "Em andamento", revisao: "Em revisão", concluida: "Concluída" };

function assignedOpenTasks(tasks: TaskItem[], userId: string) {
  return tasks
    .filter((task) => task.assigneeId === userId && task.status !== "concluida")
    .sort((left, right) => {
      const priority = taskPriorityRank[left.priority] - taskPriorityRank[right.priority];
      if (priority) return priority;
      if (left.dueDate && right.dueDate) return left.dueDate.localeCompare(right.dueDate);
      if (left.dueDate) return -1;
      if (right.dueDate) return 1;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
}

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

export default function Dashboard({ eventsBySource, connected, profile, userId, onNavigate, onOpenNora }: DashboardProps) {
  const [finance, setFinance] = useState<FinanceSnapshot | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
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
      total: emails + whatsapp + calendar + tasks,
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
  const financeBalance = Number.isFinite(Number(finance?.resumo?.saldo)) ? Number(finance?.resumo?.saldo) : null;
  const myTasks = useMemo(() => assignedOpenTasks(tasks, userId), [tasks, userId]);
  const financePending = useMemo<DashboardFinancePending[]>(() => {
    const entries = (finance?.lancamentos || [])
      .filter((item) => item.type === "saida" && item.status === "pendente")
      .map((item) => ({ id: item.id, title: item.title, amount: Number(item.amount || 0), dueDate: item.dueDate || null, scheduled: false }));
    const scheduled = (finance?.programados || [])
      .filter((item) => item.type === "saida" && item.active)
      .map((item) => ({ id: item.id, title: item.title, amount: Number(item.amount || 0), dueDate: item.nextDueDate || null, scheduled: true }));
    return [...entries, ...scheduled].sort((left, right) => {
      if (left.dueDate && right.dueDate) return left.dueDate.localeCompare(right.dueDate);
      if (left.dueDate) return -1;
      if (right.dueDate) return 1;
      return left.title.localeCompare(right.title, "pt-BR");
    });
  }, [finance]);

  useEffect(() => {
    let cancelled = false;
    apiRequest<FinanceSnapshot>(`/api/financeiro?user_id=${encodeURIComponent(userId)}`, { cache: "no-store" })
      .then((payload) => {
        if (!cancelled) setFinance(payload);
      })
      .catch(() => {
        if (!cancelled) setFinance(null);
      });
    setTasksLoading(true);
    apiRequest<{ tasks?: TaskItem[] }>(`/api/tarefas?user_id=${encodeURIComponent(userId)}&status=todas`, { cache: "no-store" })
      .then((payload) => { if (!cancelled) setTasks(payload.tasks || []); })
      .catch(() => { if (!cancelled) setTasks([]); })
      .finally(() => { if (!cancelled) setTasksLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

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

        <Summary metrics={metrics} financeBalance={financeBalance} onNavigate={onNavigate} />

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
              <h2>Minhas tarefas</h2>
              <button type="button" onClick={() => onNavigate("Tarefas")}>Ver todas</button>
            </div>
            <div className="norium-assigned-task-list" aria-label="Tarefas atribuídas a mim">
              {myTasks.map((task) => (
                <button type="button" key={task.id} onClick={() => onNavigate("Tarefas")} className="norium-assigned-task-card">
                  <span className={`priority-${task.priority}`} aria-hidden="true" />
                  <span>
                    <strong>{task.title}</strong>
                    <small>{taskStatusLabel[task.status]} · {task.category || "Geral"}</small>
                  </span>
                  <time>{task.dueDate ? new Date(`${task.dueDate}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) : "Sem prazo"}</time>
                </button>
              ))}
              {tasksLoading && <div className="norium-dashboard-empty"><CalendarClock size={18} />Carregando suas tarefas…</div>}
              {!tasksLoading && !myTasks.length && (
                <div className="norium-dashboard-empty"><Check size={20} />Nenhuma tarefa pendente atribuída a você.</div>
              )}
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
        financePending={financePending}
        financePendingTotal={Number(finance?.resumo?.pendente || 0)}
        financeOverdueCount={Number(finance?.resumo?.vencidos || 0)}
        onNavigate={onNavigate}
        onOpenNora={onOpenNora}
      />
    </main>
  );
}
