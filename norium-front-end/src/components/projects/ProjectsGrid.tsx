import { Grid, List, ChevronDown, MoreVertical, Rocket, ShoppingCart, BarChart3, User, Smartphone, CheckCircle, Plus } from "lucide-react";
import type { Projeto } from "./ProjectsDashboard";

interface GridProps {
  projetos: Projeto[];
}

export default function ProjectsGrid({ projetos }: GridProps) {
  const getIcon = (type: string, className: string) => {
    switch (type) {
      case "rocket": return <Rocket className={className} size={18} />;
      case "cart": return <ShoppingCart className={className} size={18} />;
      case "chart": return <BarChart3 className={className} size={18} />;
      case "user": return <User className={className} size={18} />;
      case "phone": return <Smartphone className={className} size={18} />;
      case "check": return <CheckCircle className={className} size={18} />;
      default: return <Rocket className={className} size={18} />;
    }
  };

  return (
    <section className="flex-1 bg-[var(--background)] flex flex-col h-full min-w-0 overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-[var(--foreground)]">Meus projetos</h1>
          <p className="text-xs text-[var(--secondary-foreground)] font-medium">Acompanhe todos os projetos em andamento.</p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center bg-[var(--card-background)] p-1 rounded-xl text-xs font-bold text-[var(--secondary-foreground)] border border-[var(--border)]">
            <button className="px-3 py-1.5 rounded-lg bg-[var(--background)] text-[var(--foreground)] shadow-sm flex items-center gap-1.5 border border-[var(--border)]"><Grid size={14} /> Grade</button>
            <button className="px-3 py-1.5 rounded-lg text-[var(--secondary-foreground)] hover:text-[var(--foreground)] flex items-center gap-1.5"><List size={14} /> Lista</button>
          </div>
          
          <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--secondary-foreground)] bg-[var(--card-background)] border border-[var(--border)] px-3 py-2 rounded-xl cursor-pointer hover:bg-[var(--hover-background)] transition">
            <span>Ordenar por: <strong className="text-[var(--foreground)] font-bold">Recentes</strong></span>
            <ChevronDown size={14} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {projetos.map((projeto) => (
          <div key={projeto.id} className="bg-[var(--card-background)] border border-[var(--border)] p-5 rounded-2xl shadow-sm flex flex-col justify-between gap-5 relative group hover:shadow-md transition duration-300">
            <div className="flex items-start justify-between">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${projeto.iconBgColor}`}>
                {getIcon(projeto.iconType, projeto.iconColor)}
              </div>
              <div className="flex items-center gap-1">
                <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${projeto.badgeColor}`}>
                  {projeto.status}
                </span>
                <button className="p-1 text-[var(--secondary-foreground)] hover:text-[var(--foreground)] rounded-lg"><MoreVertical size={16} /></button>
              </div>
            </div>

            <div className="space-y-1.5">
              <h3 className="text-sm font-bold text-[var(--foreground)] group-hover:text-blue-600 transition">{projeto.title}</h3>
              <p className="text-[11px] text-[var(--secondary-foreground)] font-bold">Cliente: <span className="text-[var(--foreground)]">{projeto.client}</span></p>
              <p className="text-xs text-[var(--secondary-foreground)] font-medium line-clamp-2 leading-relaxed">{projeto.description}</p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-bold">
                <span className="text-[var(--secondary-foreground)]">Progresso</span>
                <span className="text-[var(--foreground)]">{projeto.progress}%</span>
              </div>
              <div className="w-full h-2 bg-[var(--background)] rounded-full overflow-hidden border border-[var(--border)]">
                <div 
                  className={`h-full transition-all duration-500 rounded-full ${projeto.progress === 100 ? "bg-emerald-500" : "bg-blue-600"}`} 
                  style={{ width: `${projeto.progress}%` }} 
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-[var(--border)] text-[11px]">
              <div>
                <p className="text-[var(--secondary-foreground)] font-bold">{projeto.status === "Concluído" ? "Concluído em" : "Prazo"}</p>
                <p className="text-[var(--foreground)] font-bold mt-0.5">{projeto.dueDate}</p>
              </div>
              <div className="flex items-center -space-x-2.5">
                {projeto.team.map((avatar, i) => (
                  <img key={i} src={avatar} className="w-6 h-6 rounded-full border-2 border-[var(--card-background)] object-cover shadow-sm" alt="membro" />
                ))}
              </div>
            </div>
          </div>
        ))}

        <div className="border-2 border-dashed border-[var(--border)] p-6 rounded-2xl flex flex-col items-center justify-center text-center gap-1 cursor-pointer hover:border-blue-400 hover:bg-[var(--hover-background)] group transition duration-300 min-h-[240px]">
          <div className="w-9 h-9 rounded-full bg-[var(--background)] border border-[var(--border)] flex items-center justify-center text-[var(--secondary-foreground)] group-hover:bg-blue-50 group-hover:text-blue-600 transition">
            <Plus size={18} />
          </div>
          <h4 className="text-xs font-bold text-[var(--foreground)] mt-2">Criar novo projeto</h4>
          <p className="text-[11px] text-[var(--secondary-foreground)] font-medium">Comece um novo projeto do zero</p>
        </div>
      </div>
    </section>
  );
}
