import { useCallback, useEffect, useMemo, useState } from "react";
import { Menu, X } from "lucide-react";
import AgendaSidebar from "./AgendaSidebar";
import AgendaTimeline from "./AgendaTimeline";
import { apiBaseUrl } from "../../utils/api";
import Button from "../shared/Button";

const BACKEND_URL = apiBaseUrl();

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
  calendar: string;
  source: "google" | "local";
  colorClass: string;
}

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

function colorClass(title: string, source: string) {
  const value = title.toLowerCase();
  if (source === "local") return "border-amber-400 bg-amber-500/10 text-amber-100";
  if (value.includes("call") || value.includes("reuni")) return "border-sky-400 bg-sky-500/10 text-sky-100";
  if (value.includes("projeto") || value.includes("norium")) return "border-blue-400 bg-blue-500/10 text-blue-100";
  if (value.includes("almoço") || value.includes("almoco")) return "border-emerald-400 bg-emerald-500/10 text-emerald-100";
  return "border-cyan-400 bg-cyan-500/10 text-cyan-100";
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

export default function AgendaDashboard({ userId = "lucas123" }: { userId?: string }) {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("Semana");
  const [dataSelecionada, setDataSelecionada] = useState<Date>(new Date());
  const [status, setStatus] = useState<AgendaStatus>(defaultStatus);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
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
      const res = await fetch(`${BACKEND_URL}/api/agenda/eventos?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "Não foi possível carregar sua agenda.");
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
    const timer = window.setInterval(() => void carregarEventos(true), 15000);
    return () => window.clearInterval(timer);
  }, [carregarEventos]);

  async function conectarGoogle() {
    const res = await fetch(`${BACKEND_URL}/api/agenda/auth-url?user_id=${userId}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data?.detail || "Não consegui iniciar a conexão com o Google.");
      return;
    }
    window.open(data.auth_url, "_blank", "noopener,noreferrer,width=520,height=720");
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

    const res = await fetch(`${BACKEND_URL}/api/agenda/eventos`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
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
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data?.detail || "Não consegui criar o evento.");
      return;
    }
    setShowCreate(false);
    await carregarEventos();
  }

  return (
    <div className={`norium-agenda ${mobileSidebarOpen ? "mobile-sidebar-open" : ""} flex h-full min-h-0 w-full overflow-hidden bg-[var(--background)] text-[var(--text)]`}>
      <button
        type="button"
        className="mobile-sidebar-toggle mobile-screen-fab"
        aria-label="Abrir menu da agenda"
        onClick={() => setMobileSidebarOpen(true)}
      >
        <Menu size={18} />
      </button>
      {mobileSidebarOpen && (
        <button
          type="button"
          className="mobile-sidebar-backdrop"
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
        todayKey={todayKey()}
      />

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-lg rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
              <h2 className="text-base font-bold">Novo evento</h2>
              <Button variant="ghost" size="sm" iconOnly onClick={() => setShowCreate(false)}>
                <X size={18} />
              </Button>
            </div>
            <div className="grid gap-3 p-5 text-sm">
              <input value={form.titulo} onChange={(event) => setForm({ ...form, titulo: event.target.value })} placeholder="Título" className="h-11 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 outline-none" />
              <div className="grid grid-cols-3 gap-3">
                <input type="date" value={form.data} onChange={(event) => setForm({ ...form, data: event.target.value })} className="h-11 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 outline-none" />
                <input type="time" value={form.inicio} onChange={(event) => setForm({ ...form, inicio: event.target.value })} className="h-11 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 outline-none" />
                <input type="time" value={form.fim} onChange={(event) => setForm({ ...form, fim: event.target.value })} className="h-11 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 outline-none" />
              </div>
              <input value={form.local} onChange={(event) => setForm({ ...form, local: event.target.value })} placeholder="Local ou chamada" className="h-11 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 outline-none" />
              <input value={form.participantes} onChange={(event) => setForm({ ...form, participantes: event.target.value })} placeholder="Convidados por e-mail" className="h-11 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 outline-none" />
              <textarea value={form.descricao} onChange={(event) => setForm({ ...form, descricao: event.target.value })} placeholder="Descrição" rows={3} className="resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 outline-none" />
              <label className="flex items-center gap-2 text-xs font-bold text-[var(--text-secondary)]">
                <input type="checkbox" checked={form.criar_meet} onChange={(event) => setForm({ ...form, criar_meet: event.target.checked })} className="h-4 w-4 accent-[var(--primary)]" />
                Criar Google Meet
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
              <Button onClick={() => setShowCreate(false)}>Cancelar</Button>
              <Button variant="primary" disabled={!form.titulo} onClick={() => void criarEvento()}>Salvar</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
