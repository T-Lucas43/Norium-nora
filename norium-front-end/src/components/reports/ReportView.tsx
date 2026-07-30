import { Calendar, Filter, ArrowUpRight, ArrowDownRight, CheckSquare, MessageSquare, Clock, ThumbsUp } from "lucide-react";

interface ReportViewProps {
  title: string;
  onClose: () => void;
}

export default function ReportView({ title }: ReportViewProps) {
  return (
    <section className="flex-1 bg-[var(--background)] flex flex-col h-full min-w-0 overflow-y-auto p-6 space-y-6">
      {/* Topo do Relatório */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-[var(--foreground)]">{title}</h1>
          <p className="text-xs text-[var(--secondary-foreground)] font-medium">Acompanhe os principais indicadores do seu negócio.</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--secondary-foreground)] bg-[var(--card-background)] border border-[var(--border)] px-3 py-2 rounded-xl cursor-pointer hover:bg-[var(--hover-background)] transition shadow-sm">
            <Calendar size={14} />
            <span>01 - 31 Mai, 2025</span>
          </div>
          <button className="flex items-center gap-1.5 text-xs font-bold text-[var(--secondary-foreground)] bg-[var(--card-background)] border border-[var(--border)] px-3 py-2 rounded-xl hover:bg-[var(--hover-background)] transition shadow-sm">
            <Filter size={14} />
            <span>Filtros</span>
          </button>
        </div>
      </div>

      {/* Grid Superior: KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
        {[
          { label: "Projetos em andamento", value: "12", trend: "20% vs. mês anterior", isPos: true },
          { label: "Tarefas concluídas", value: "128", trend: "15% vs. mês anterior", isPos: true },
          { label: "Horas registradas", value: "342h", trend: "8% vs. mês anterior", isPos: false },
          { label: "Clientes ativos", value: "28", trend: "12% vs. mês anterior", isPos: true },
        ].map((card, i) => (
          <div key={i} className="bg-[var(--card-background)] border border-[var(--border)] p-5 rounded-2xl shadow-sm relative overflow-hidden flex flex-col justify-between min-h-[105px]">
            <div className="flex justify-between items-start">
              <p className="text-xs font-bold text-[var(--secondary-foreground)] tracking-tight">{card.label}</p>
              <div className="w-7 h-7 rounded-lg bg-[var(--background)] border border-[var(--border)] flex items-center justify-center text-[var(--secondary-foreground)]">
                {i === 0 && <CheckSquare size={13} />}
                {i === 1 && <MessageSquare size={13} />}
                {i === 2 && <Clock size={13} />}
                {i === 3 && <ThumbsUp size={13} />}
              </div>
            </div>
            <div className="mt-2">
              <p className="text-2xl font-bold text-[var(--foreground)] leading-none mb-1">{card.value}</p>
              <p className={`text-xs font-bold flex items-center gap-0.5 ${card.isPos ? "text-emerald-500" : "text-rose-500"}`}>
                {card.isPos ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                <span>{card.trend}</span>
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Gráficos do Meio */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 shrink-0">
        <div className="bg-[var(--card-background)] border border-[var(--border)] p-5 rounded-2xl shadow-sm lg:col-span-7 flex flex-col justify-between min-h-[280px]">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="text-xs font-bold text-[var(--foreground)]">Desempenho de projetos</h3>
              <p className="text-xs text-[var(--secondary-foreground)] font-medium">Progresso médio dos projetos</p>
            </div>
            <select className="text-xs font-bold text-[var(--secondary-foreground)] border border-[var(--border)] rounded-lg p-1.5 px-2 bg-[var(--background)] outline-none cursor-pointer">
              <option>Este mês</option>
            </select>
          </div>
          <div className="flex-1 flex items-end justify-between h-32 relative border-b border-l border-[var(--border)] pl-4 pb-2">
            <div className="absolute right-8 top-4 bg-blue-500/10 text-blue-500 font-bold text-xs px-2 py-0.5 rounded-md border border-blue-500/20 shadow-sm">78%</div>
            <svg className="absolute inset-x-0 bottom-6 h-20 w-full overflow-visible" preserveAspectRatio="none">
              <path d="M 0 60 Q 50 40 100 50 T 200 20 T 300 30 T 400 10" fill="none" stroke="#6366f1" strokeWidth="2.5" />
            </svg>
            {["01 Mai", "08 Mai", "15 Mai", "22 Mai", "31 Mai"].map((day, i) => (
              <span key={i} className="text-xs font-bold text-[var(--secondary-foreground)]">{day}</span>
            ))}
          </div>
        </div>

        <div className="bg-[var(--card-background)] border border-[var(--border)] p-5 rounded-2xl shadow-sm lg:col-span-5 flex flex-col justify-between min-h-[280px]">
          <div>
            <h3 className="text-xs font-bold text-[var(--foreground)]">Tarefas por status</h3>
            <p className="text-xs text-[var(--secondary-foreground)] font-medium">Distribuição das tarefas no período</p>
          </div>
          <div className="flex items-center gap-8 my-auto">
            <div className="w-28 h-28 rounded-full border-[12px] border-emerald-500 relative flex items-center justify-center shrink-0">
              <div className="absolute inset-0 rounded-full border-[12px] border-t-blue-500 border-r-amber-400 border-b-rose-500 border-l-transparent transform rotate-45" />
            </div>
            <div className="flex-1 space-y-2 text-xs font-bold text-[var(--secondary-foreground)]">
              <div className="flex justify-between items-center"><span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-500"/>Concluídas</span><span className="text-[var(--foreground)]">128 (48%)</span></div>
              <div className="flex justify-between items-center"><span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500"/>Em andamento</span><span className="text-[var(--foreground)]">82 (31%)</span></div>
              <div className="flex justify-between items-center"><span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-amber-400"/>Pausadas</span><span className="text-[var(--foreground)]">28 (11%)</span></div>
              <div className="flex justify-between items-center"><span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-rose-500"/>Atrasadas</span><span className="text-[var(--foreground)]">18 (7%)</span></div>
              <div className="flex justify-between items-center"><span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[var(--border)]"/>Não iniciadas</span><span className="text-[var(--foreground)]">12 (3%)</span></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
