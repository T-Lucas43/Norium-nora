import { CalendarDays, ChevronLeft, ChevronRight, Globe2, Plus, RefreshCw, X } from "lucide-react";
import type { AgendaStatus } from "./AgendaDashboard";
import googleLogo from "../../assets/integrations/google.svg";

interface SidebarProps {
  dataSelecionada: Date;
  setDataSelecionada: (date: Date) => void;
  status: AgendaStatus;
  onConnectGoogle: () => void;
  onNovoEvento: (date?: Date) => void;
  onSync: () => void;
  onClose: () => void;
}

const meses = [
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

const weekDays = ["D", "S", "T", "Q", "Q", "S", "S"];

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function monthCells(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [];
  for (let i = 0; i < firstDay; i += 1) cells.push(null);
  for (let day = 1; day <= totalDays; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatLastSync(value?: string) {
  if (!value) return "Aguardando";
  return new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export default function AgendaSidebar({
  dataSelecionada,
  setDataSelecionada,
  status,
  onConnectGoogle,
  onNovoEvento,
  onSync,
  onClose,
}: SidebarProps) {
  const anoAtual = dataSelecionada.getFullYear();
  const mesAtualIdx = dataSelecionada.getMonth();
  const hoje = new Date();
  const anos = Array.from({ length: 21 }, (_, index) => hoje.getFullYear() - 10 + index);

  const mudarMes = (direcao: number) => {
    setDataSelecionada(new Date(anoAtual, mesAtualIdx + direcao, 1));
  };

  const selecionarDia = (dia: number) => {
    setDataSelecionada(new Date(anoAtual, mesAtualIdx, dia));
  };

  return (
    <aside className="nx-ag-side" aria-label="Menu da agenda">
      <div className="nx-ag-side-head">
        <span><CalendarDays size={18} /> Agenda</span>
        <button type="button" className="nx-btn is-ghost nx-ag-icon is-sm" onClick={onClose} aria-label="Fechar menu da agenda">
          <X size={18} />
        </button>
      </div>

      <div className="nx-card nx-ag-box">
        <div className="nx-ag-picker">
          <select
            aria-label="Escolher mês"
            value={mesAtualIdx}
            onChange={(event) => setDataSelecionada(new Date(anoAtual, Number(event.target.value), 1))}
            className="nx-ag-select"
          >
            {meses.map((mes, index) => <option key={mes} value={index}>{mes}</option>)}
          </select>
          <select
            aria-label="Escolher ano"
            value={anoAtual}
            onChange={(event) => setDataSelecionada(new Date(Number(event.target.value), mesAtualIdx, 1))}
            className="nx-ag-select"
          >
            {anos.map((ano) => <option key={ano} value={ano}>{ano}</option>)}
          </select>
          <span className="nx-ag-nav">
            <button type="button" className="nx-btn is-ghost nx-ag-icon is-sm" aria-label="Mês anterior" onClick={() => mudarMes(-1)}>
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="nx-btn is-ghost nx-ag-icon is-sm" aria-label="Próximo mês" onClick={() => mudarMes(1)}>
              <ChevronRight size={16} />
            </button>
          </span>
        </div>

        <div className="nx-ag-mini">
          {weekDays.map((day, index) => (
            <span key={`${day}-${index}`}>{day}</span>
          ))}
          {monthCells(dataSelecionada).map((dia, index) => {
            if (!dia) return <span key={`blank-${index}`} />;
            const date = new Date(anoAtual, mesAtualIdx, dia);
            const isSelected = sameDay(date, dataSelecionada);
            const isToday = sameDay(date, hoje);
            return (
              <button
                key={dia}
                type="button"
                onClick={() => selecionarDia(dia)}
                aria-pressed={isSelected}
                className={isSelected ? "is-selected" : isToday ? "is-today" : ""}
              >
                {dia}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => onNovoEvento(dataSelecionada)}
          className="nx-btn is-sm"
          style={{ width: "100%", marginTop: 12 }}
        >
          <Plus size={14} />
          Novo evento
        </button>
      </div>

      <div className="nx-card nx-ag-box">
        <div className="nx-ag-box-t">Meus calendários</div>
        <label className="nx-ag-cal">
          <input type="checkbox" defaultChecked />
          <span className="nx-ag-sq" style={{ background: "var(--nx-primary)" }} />
          Google Agenda
          <span className="nx-faint nx-small">{status.connected ? "Conectado" : "Local"}</span>
        </label>
        <label className="nx-ag-cal">
          <input type="checkbox" defaultChecked />
          <span className="nx-ag-sq" style={{ background: "var(--nx-warning)" }} />
          Norium local
          <span className="nx-faint nx-small">Local</span>
        </label>
      </div>

      <div className="nx-card nx-ag-box">
        <div className="nx-ag-box-t">
          <img src={googleLogo} alt="" className="nx-ag-google" />
          Google Agenda
          <span className={`nx-badge ${status.connected ? "is-green" : "is-amber"}`} style={{ marginLeft: "auto" }}>
            {status.connected ? "Conectado" : "Local"}
          </span>
        </div>
        <div className="nx-ag-sync">
          {!status.connected && (
            <button type="button" className="nx-btn is-primary is-sm" onClick={onConnectGoogle}>
              Conectar
            </button>
          )}
          <button type="button" className="nx-btn is-sm nx-ag-icon" aria-label="Sincronizar agenda" title="Sincronizar agenda" onClick={onSync}>
            <RefreshCw size={14} />
          </button>
        </div>
        <p className="nx-faint nx-small" style={{ margin: "10px 0 0" }}>Sincronizado: {formatLastSync(status.lastSync)}</p>
      </div>

      <div className="nx-card nx-ag-box">
        <div className="nx-ag-box-t"><Globe2 size={16} className="nx-faint" />Fuso horário</div>
        <div className="nx-muted nx-small" style={{ marginTop: 6 }}>Brasília (GMT−3)</div>
      </div>
    </aside>
  );
}
