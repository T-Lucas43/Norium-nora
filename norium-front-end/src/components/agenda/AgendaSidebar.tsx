import { CalendarPlus, ChevronLeft, ChevronRight, Cloud, Globe2, RefreshCw } from "lucide-react";
import type { AgendaStatus } from "./AgendaDashboard";
import Button from "../shared/Button";

interface SidebarProps {
  dataSelecionada: Date;
  setDataSelecionada: (date: Date) => void;
  status: AgendaStatus;
  onConnectGoogle: () => void;
  onNovoEvento: (date?: Date) => void;
  onSync: () => void;
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
}: SidebarProps) {
  const anoAtual = dataSelecionada.getFullYear();
  const mesAtualIdx = dataSelecionada.getMonth();
  const hoje = new Date();

  const mudarMes = (direcao: number) => {
    setDataSelecionada(new Date(anoAtual, mesAtualIdx + direcao, 1));
  };

  const selecionarDia = (dia: number) => {
    setDataSelecionada(new Date(anoAtual, mesAtualIdx, dia));
  };

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col gap-5 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)] p-4">
      <button
        onClick={() => onNovoEvento(dataSelecionada)}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[var(--primary)] text-sm font-bold text-white shadow-sm hover:opacity-95"
      >
        <CalendarPlus size={18} />
        Novo evento
      </button>

      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <span className="text-sm font-bold">
            {meses[mesAtualIdx]} {anoAtual}
          </span>
          <div className="flex gap-1 text-[var(--text-secondary)]">
            <Button variant="ghost" size="sm" iconOnly onClick={() => mudarMes(-1)}>
              <ChevronLeft size={16} />
            </Button>
            <Button variant="ghost" size="sm" iconOnly onClick={() => mudarMes(1)}>
              <ChevronRight size={16} />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-7 text-center text-xs font-bold text-[var(--text-secondary)]">
          {weekDays.map((day, index) => (
            <span key={`${day}-${index}`}>{day}</span>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-y-1 text-center text-xs font-semibold">
          {monthCells(dataSelecionada).map((dia, index) => {
            if (!dia) return <span key={`blank-${index}`} className="h-8" />;
            const date = new Date(anoAtual, mesAtualIdx, dia);
            const isSelected = sameDay(date, dataSelecionada);
            const isToday = sameDay(date, hoje);
            return (
              <button
                key={dia}
                onClick={() => selecionarDia(dia)}
                className={`mx-auto grid h-8 w-8 place-items-center rounded-full transition ${
                  isSelected
                    ? "bg-[var(--primary)] text-white"
                    : isToday
                      ? "border border-[var(--primary)] text-[var(--primary)]"
                      : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                {dia}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase text-[var(--text-secondary)]">Meus calendários</h3>
        <label className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold">
          <input type="checkbox" defaultChecked className="h-4 w-4 accent-[var(--primary)]" />
          Google Agenda
        </label>
        <label className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold">
          <input type="checkbox" defaultChecked className="h-4 w-4 accent-amber-500" />
          Norium local
        </label>
      </div>

      <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-bold">
            <Cloud size={16} />
            Google Agenda
          </span>
          <span className={`rounded-full px-2 py-1 text-xs font-bold ${status.connected ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-300"}`}>
            {status.connected ? "Conectado" : "Local"}
          </span>
        </div>

        <div className="flex gap-2">
          {!status.connected && (
            <Button variant="primary" size="sm" onClick={onConnectGoogle} className="flex-1">
              Conectar
            </Button>
          )}
          <Button size="sm" iconOnly onClick={onSync}>
            <RefreshCw size={15} />
          </Button>
        </div>

        <p className="text-xs font-semibold text-[var(--text-secondary)]">Sincronizado: {formatLastSync(status.lastSync)}</p>
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-[var(--border)] pt-4 text-xs font-medium text-[var(--text-secondary)]">
        <Globe2 size={16} />
        <div>
          <p className="font-bold text-[var(--text)]">Fuso horário</p>
          <p>Brasília, GMT-03:00</p>
        </div>
      </div>
    </aside>
  );
}
