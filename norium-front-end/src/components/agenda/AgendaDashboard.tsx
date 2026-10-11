import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Clock, MapPin, Users, Video, X } from "lucide-react";
import AgendaSidebar from "./AgendaSidebar";
import AgendaTimeline from "./AgendaTimeline";
import { apiRequest } from "../../core/api/client";
import "./agenda-v2.css";

export type ViewMode = "Dia" | "Semana" | "Mês" | "Ano";

export interface AgendaStatus {
  configured: boolean;
  connected: boolean;
  source: "google" | "local";
  calendar: string;
  timezone: string;
  lastSync?: string;
  detail?: string;
}

export interface Evento {
  id: string;
  title: string;
  inicio: string;
  fim: string;
  timeStart: string;
  timeEnd: string;
  dateString: string;
  allDay: boolean;
  location?: string;
  description?: string;
  platform?: string;
  htmlLink?: string;
  meetLink?: string;
  participants: string[];
  personName?: string;
  calendar: string;
  source: "google" | "local";
  colorClass: string;
}

type AgendaEventsPayload = Partial<AgendaStatus> & {
  eventos?: unknown[];
};

interface EventForm {
  titulo: string;
  data: string;
  inicio: string;
  fim: string;
  local: string;
  descricao: string;
  participantes: string;
  criar_meet: boolean;
}

const defaultStatus: AgendaStatus = {
  configured: false,
  connected: false,
  source: "local",
  calendar: "primary",
  timezone: "America/Sao_Paulo",
};

const todayKey = () => formatDateKey(new Date());

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateAt(date: Date, hour = 0, minute = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function viewRange(date: Date, mode: ViewMode) {
  if (mode === "Ano") {
    return {
      start: new Date(date.getFullYear(), 0, 1),
      end: new Date(date.getFullYear() + 1, 0, 1),
    };
  }
  if (mode === "Mês") {
    return {
      start: new Date(date.getFullYear(), date.getMonth(), 1),
      end: new Date(date.getFullYear(), date.getMonth() + 1, 1),
    };
  }
  if (mode === "Semana") {
    const start = dateAt(date);
    start.setDate(date.getDate() - date.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end };
  }
  const start = dateAt(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
}

// Cor do evento nas cores do layout aprovado (azul, violeta, verde, ciano; âmbar para eventos locais).
function colorClass(title: string, source: string) {
  const value = title.toLowerCase();
  if (source === "local") return "is-amber";
  if (value.includes("call") || value.includes("reuni")) return "is-blue";
  if (value.includes("projeto") || value.includes("norium")) return "is-violet";
  if (value.includes("almoço") || value.includes("almoco")) return "is-green";
  return "is-cyan";
}

function normalizeEvent(raw: any, index: number): Evento {
  const inicio = String(raw.inicio || raw.start || "");
  const fim = String(raw.fim || raw.end || "");
  const allDay = Boolean(raw.allDay || (inicio && !inicio.includes("T")));
  const dateString = inicio.includes("T") ? inicio.slice(0, 10) : inicio;
  const timeStart = allDay ? "Dia todo" : inicio.slice(11, 16);
  const timeEnd = allDay ? "" : fim.slice(11, 16);
  const source = raw.source === "local" ? "local" : "google";
  const participants = Array.isArray(raw.participantes)
    ? raw.participantes.map((item: any) => item?.nome || item?.email || item).filter(Boolean)
    : [];

  return {
    id: String(raw.id || `event-${index}`),
    title: raw.titulo || raw.summary || "Compromisso sem título",
    inicio,
    fim,
    timeStart,
    timeEnd,
    dateString,
    allDay,
    location: raw.local,
    description: raw.descricao,
    platform: raw.link_reuniao ? "Google Meet" : undefined,
    htmlLink: raw.htmlLink,
    meetLink: raw.link_reuniao,
    participants,
    personName: String(raw.attendee_name || raw.cliente || raw.professional_name || participants[0] || "").trim() || undefined,
    calendar: raw.calendar || "Google Agenda",
    source,
    colorClass: colorClass(raw.titulo || "", source),
  };
}

function emptyForm(selectedDate: Date): EventForm {
  return {
    titulo: "",
    data: formatDateKey(selectedDate),
    inicio: "09:00",
    fim: "10:00",
    local: "",
    descricao: "",
    participantes: "",
    criar_meet: false,
  };
}

export default function AgendaDashboard({ userId = "primary" }: { userId?: string }) {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("Semana");
  const [dataSelecionada, setDataSelecionada] = useState<Date>(new Date());
  const [status, setStatus] = useState<AgendaStatus>(defaultStatus);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<Evento | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [form, setForm] = useState<EventForm>(() => emptyForm(new Date()));

  const range = useMemo(() => viewRange(dataSelecionada, viewMode), [dataSelecionada, viewMode]);

  const carregarEventos = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError("");
      const params = new URLSearchParams({
        user_id: userId,
        time_min: range.start.toISOString(),
        time_max: range.end.toISOString(),
      });
      const data = await apiRequest<AgendaEventsPayload>(`/api/agenda/eventos?${params.toString()}`, {
        cache: "no-store",
        timeoutMs: 45_000,
      });
      setStatus({ ...defaultStatus, ...data });
      setEventos((data.eventos || []).map(normalizeEvent));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao sincronizar agenda.");
    } finally {
      setLoading(false);
    }
  }, [range.end, range.start, userId]);

  useEffect(() => {
    void carregarEventos();
    // Economia de banda e de cota do Google: atualiza a cada 90s e só com a aba visível.
    const timer = window.setInterval(() => { if (!document.hidden) void carregarEventos(true); }, 90_000);
    return () => window.clearInterval(timer);
  }, [carregarEventos]);

  async function conectarGoogle() {
    const useSameWindow = window.matchMedia("(max-width: 900px)").matches;
    const popup = useSameWindow
      ? null
      : window.open("about:blank", "norium-google-agenda", "width=560,height=760");
    try {
      setError("");
      const data = await apiRequest<{ auth_url: string }>(`/api/agenda/auth-url?user_id=${encodeURIComponent(userId)}`);
      if (popup) popup.location.href = data.auth_url;
      else window.location.assign(data.auth_url);
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : "Não consegui iniciar a conexão com o Google.");
    }
  }

  function abrirCriacao(date = dataSelecionada) {
    setForm(emptyForm(date));
    setShowCreate(true);
  }

  async function criarEvento() {
    const inicio = new Date(`${form.data}T${form.inicio}:00`);
    const fim = new Date(`${form.data}T${form.fim}:00`);
    const participantes = form.participantes
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    try {
      await apiRequest("/api/agenda/eventos", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        titulo: form.titulo,
        inicio: inicio.toISOString(),
        fim: fim.toISOString(),
        descricao: form.descricao,
        local: form.local,
        participantes,
        criar_meet: form.criar_meet,
      }),
      timeoutMs: 45_000,
      });
      setShowCreate(false);
      await carregarEventos();
      window.dispatchEvent(new CustomEvent("norium:agenda-mutated"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui criar o evento.");
    }
  }

  const fecharCriacao = () => setShowCreate(false);

  return (
    <div className={`nx-page nx-ag ${mobileSidebarOpen ? "is-side-open" : ""}`}>
      {mobileSidebarOpen && (
        <button
          type="button"
          className="nx-ag-backdrop"
          aria-label="Fechar menu da agenda"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <AgendaSidebar
        dataSelecionada={dataSelecionada}
        setDataSelecionada={setDataSelecionada}
        status={status}
        onConnectGoogle={() => void conectarGoogle()}
        onNovoEvento={abrirCriacao}
        onSync={() => void carregarEventos()}
        onClose={() => setMobileSidebarOpen(false)}
      />

      <AgendaTimeline
        eventos={eventos}
        viewMode={viewMode}
        setViewMode={setViewMode}
        dataSelecionada={dataSelecionada}
        setDataSelecionada={setDataSelecionada}
        loading={loading}
        error={error}
        status={status}
        onRefresh={() => void carregarEventos()}
        onCreateEvent={abrirCriacao}
        onOpenEvent={setSelectedEvent}
        onOpenMenu={() => setMobileSidebarOpen(true)}
        todayKey={todayKey()}
      />

      {selectedEvent && (
        <div className="nx-ag-overlay" onMouseDown={() => setSelectedEvent(null)}>
          <div className="nx-card nx-ag-modal" style={{ maxWidth: 560 }} role="dialog" aria-modal="true" aria-label={selectedEvent.title} onMouseDown={(event) => event.stopPropagation()}>
            <div className="nx-ag-modal-h">
              <div className="nx-grow">
                <span className="nx-faint nx-small">Evento</span>
                <h2 title={selectedEvent.title}>{selectedEvent.title}</h2>
              </div>
              <button type="button" className="nx-btn is-ghost nx-ag-icon is-sm" aria-label="Fechar" onClick={() => setSelectedEvent(null)}>
                <X size={18} />
              </button>
            </div>
            <dl className="nx-ag-modal-b nx-ag-dl">
              <dt>Data e hora</dt>
              <dd>
                {new Date(selectedEvent.inicio).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}
                {!selectedEvent.allDay && ` · ${selectedEvent.timeStart} - ${selectedEvent.timeEnd}`}
              </dd>
              {selectedEvent.location && (
                <>
                  <dt>Endereço</dt>
                  <dd>{selectedEvent.location}</dd>
                </>
              )}
              {selectedEvent.description && (
                <>
                  <dt>Descrição</dt>
                  <dd style={{ lineHeight: 1.55 }}>{selectedEvent.description}</dd>
                </>
              )}
              {selectedEvent.participants.length > 0 && (
                <>
                  <dt>Participantes</dt>
                  <dd>{selectedEvent.participants.join(", ")}</dd>
                </>
              )}
              {selectedEvent.meetLink && (
                <>
                  <dt>Reunião</dt>
                  <dd>
                    <a href={selectedEvent.meetLink} target="_blank" rel="noreferrer" className="nx-ag-link">
                      <Video size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                      Entrar na reunião
                    </a>
                  </dd>
                </>
              )}
            </dl>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="nx-ag-overlay">
          <div className="nx-card nx-ag-modal" style={{ maxWidth: 600 }} role="dialog" aria-modal="true" aria-label="Novo evento">
            <div className="nx-ag-modal-h">
              <h2 className="nx-grow">Novo evento</h2>
              <button type="button" className="nx-btn is-ghost nx-ag-icon is-sm" aria-label="Fechar" onClick={fecharCriacao}>
                <X size={18} />
              </button>
            </div>
            <div className="nx-ag-modal-b">
              <label className="nx-ag-field">
                <span className="nx-ag-lbl">Título <em>*</em></span>
                <span className="nx-input"><input value={form.titulo} onChange={(event) => setForm({ ...form, titulo: event.target.value })} placeholder="Título" /></span>
              </label>
              <div className="nx-ag-3">
                <label className="nx-ag-field">
                  <span className="nx-ag-lbl">Data</span>
                  <span className="nx-input"><CalendarDays size={16} /><input type="date" value={form.data} onChange={(event) => setForm({ ...form, data: event.target.value })} /></span>
                </label>
                <label className="nx-ag-field">
                  <span className="nx-ag-lbl">Início</span>
                  <span className="nx-input"><Clock size={16} /><input type="time" value={form.inicio} onChange={(event) => setForm({ ...form, inicio: event.target.value })} /></span>
                </label>
                <label className="nx-ag-field">
                  <span className="nx-ag-lbl">Fim</span>
                  <span className="nx-input"><Clock size={16} /><input type="time" value={form.fim} onChange={(event) => setForm({ ...form, fim: event.target.value })} /></span>
                </label>
              </div>
              <label className="nx-ag-field">
                <span className="nx-ag-lbl">Local ou chamada</span>
                <span className="nx-input"><MapPin size={16} /><input value={form.local} onChange={(event) => setForm({ ...form, local: event.target.value })} placeholder="Local ou chamada" /></span>
              </label>
              <label className="nx-ag-field">
                <span className="nx-ag-lbl">Convidados</span>
                <span className="nx-input"><Users size={16} /><input value={form.participantes} onChange={(event) => setForm({ ...form, participantes: event.target.value })} placeholder="Convidados por e-mail" /></span>
              </label>
              <label className="nx-ag-field">
                <span className="nx-ag-lbl">Descrição</span>
                <textarea value={form.descricao} onChange={(event) => setForm({ ...form, descricao: event.target.value })} placeholder="Descrição" rows={3} />
              </label>
            </div>
            <div className="nx-ag-modal-f">
              <label className="nx-ag-switch">
                <input type="checkbox" checked={form.criar_meet} onChange={(event) => setForm({ ...form, criar_meet: event.target.checked })} />
                <i aria-hidden="true" />
                <Video size={16} />
                Criar Google Meet
              </label>
              <button type="button" className="nx-btn" onClick={fecharCriacao}>Cancelar</button>
              <button type="button" className="nx-btn is-primary" disabled={!form.titulo} onClick={() => void criarEvento()}>Salvar evento</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
