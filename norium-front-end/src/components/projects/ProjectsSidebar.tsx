import { Plus, LayoutGrid, Play, Calendar, CheckCircle2, Archive, ChevronDown, Trash2 } from "lucide-react";
import type { Projeto } from "./ProjectsDashboard";

interface SidebarProps {
  activeFilter: string;
  setActiveFilter: (filter: string) => void;
  projetos: Projeto[];
}

export default function ProjectsSidebar({ activeFilter, setActiveFilter, projetos }: SidebarProps) {
  const count = (status: string) => projetos.filter(p => p.status === status).length;

  const categorias = [
    { name: "Todos os projetos", icon: LayoutGrid, count: projetos.length },
    { name: "Em andamento", icon: Play, count: count("Em andamento") },
    { name: "Planejamento", icon: Calendar, count: count("Planejamento") },
    { name: "Concluídos", icon: CheckCircle2, count: count("Concluído") },
    { name: "Arquivados", icon: Archive, count: 0 },
  ];

  return (
    <aside className="w-64 bg-[var(--background)] border-r border-[var(--border)] p-4 flex flex-col gap-6 shrink-0 h-full overflow-y-auto">
      <button className="w-full h-11 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition shadow-sm">
        <Plus size={18} />
        <span>Novo projeto</span>
      </button>

      <div className="space-y-1">
        {categorias.map((cat) => {
          const Icon = cat.icon;
          const isActive = activeFilter === cat.name;
          return (
            <button
              key={cat.name}
              onClick={() => setActiveFilter(cat.name)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-bold transition ${
                isActive 
                  ? "bg-[var(--active-background)] text-blue-600" 
                  : "text-[var(--secondary-foreground)] hover:bg-[var(--hover-background)]"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Icon size={16} className={isActive ? "text-blue-600" : "text-[var(--secondary-foreground)]"} />
                <span>{cat.name}</span>
              </div>
              <span className={`px-2 py-0.5 rounded-md text-xs font-bold ${isActive ? "bg-blue-200/20" : "bg-[var(--card-background)] text-[var(--secondary-foreground)]"}`}>
                {cat.count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-bold text-[var(--secondary-foreground)] uppercase tracking-wider">Filtros rápidos</h3>
        <div className="space-y-2 text-xs font-bold text-[var(--foreground)]">
          {["Clientes", "Responsáveis", "Status", "Prazo"].map((filtro) => (
            <div key={filtro} className="flex items-center justify-between py-1 border-b border-[var(--border)]">
              <span className="text-[var(--secondary-foreground)]">{filtro}</span>
              <button className="flex items-center gap-1 text-[var(--foreground)] hover:text-blue-500">Todos <ChevronDown size={14} /></button>
            </div>
          ))}
        </div>
        <button className="text-xs font-bold text-blue-600 hover:underline flex items-center gap-1 pt-1"><Trash2 size={13} /> Limpar filtros</button>
      </div>

      <div className="space-y-2.5">
        <h3 className="text-xs font-bold text-[var(--secondary-foreground)] uppercase tracking-wider">Resumo de projetos</h3>
        <div className="grid grid-cols-2 gap-2 text-center text-[var(--foreground)]">
          <div className="bg-[var(--card-background)] border border-[var(--border)] p-2 rounded-xl">
            <p className="text-lg font-bold text-[var(--foreground)] leading-none">{projetos.length}</p>
            <p className="text-xs text-[var(--secondary-foreground)] font-bold mt-1">Total</p>
          </div>
          <div className="bg-blue-500/10 border border-blue-500/20 p-2 rounded-xl">
            <p className="text-lg font-bold text-blue-500 leading-none">{count("Em andamento")}</p>
            <p className="text-xs text-blue-400 font-bold mt-1">Em andamento</p>
          </div>
          <div className="bg-sky-500/10 border border-sky-500/20 p-2 rounded-xl">
            <p className="text-lg font-bold text-sky-500 leading-none">{count("Planejamento")}</p>
            <p className="text-xs text-sky-400 font-bold mt-1">Planejamento</p>
          </div>
          <div className="bg-emerald-500/10 border border-emerald-500/20 p-2 rounded-xl">
            <p className="text-lg font-bold text-emerald-500 leading-none">{count("Concluído")}</p>
            <p className="text-xs text-emerald-400 font-bold mt-1">Concluídos</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
