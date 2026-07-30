import { BarChart3, LineChart, FolderHeart, CheckSquare, Users, UserCheck, Activity, Settings, Plus } from "lucide-react";

interface SidebarProps {
  activeReport: string;
  onSelect: (name: string) => void;
}

export default function ReportsSidebar({ activeReport, onSelect }: SidebarProps) {
  const categorias = [
    { name: "Visão geral", icon: BarChart3 },
    { name: "Desempenho", icon: LineChart },
    { name: "Projetos", icon: FolderHeart },
    { name: "Tarefas", icon: CheckSquare },
    { name: "Clientes", icon: Users },
    { name: "Equipe", icon: UserCheck },
    { name: "Atividades", icon: Activity },
    { name: "Personalizados", icon: Settings },
  ];

  return (
    <aside className="w-60 bg-[var(--background)] border-r border-[var(--border)] p-4 flex flex-col gap-6 shrink-0 h-full overflow-y-auto">
      <div>
        <h3 className="text-xs font-bold text-[var(--secondary-foreground)] uppercase tracking-wider pl-2 mb-2">Relatórios</h3>
        <div className="space-y-1">
          {categorias.map((item) => {
            const Icon = item.icon;
            const isActive = activeReport === item.name;
            return (
              <button
                key={item.name}
                onClick={() => onSelect(item.name)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-bold transition ${
                  isActive
                    ? "bg-[var(--active-background)] text-[var(--active-foreground)]"
                    : "text-[var(--secondary-foreground)] hover:bg-[var(--hover-background)]"
                }`}
              >
                <Icon size={16} className={isActive ? "text-[var(--active-foreground)]" : "text-[var(--secondary-foreground)]"} />
                <span>{item.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pt-2 border-t border-[var(--border)]">
        <h3 className="text-xs font-bold text-[var(--secondary-foreground)] uppercase tracking-wider pl-2 mb-2">Favoritos</h3>
        <button className="w-full h-10 border border-dashed border-[var(--border)] hover:border-blue-400 text-[var(--secondary-foreground)] hover:text-blue-600 font-semibold rounded-xl flex items-center justify-center gap-1.5 transition text-xs">
          <Plus size={14} />
          <span>Criar relatório</span>
        </button>
      </div>
    </aside>
  );
}
