import { BarChart3, CalendarPlus, CheckSquare, MailPlus, Sparkles, UserPlus } from "lucide-react";

type QuickActionsProps = {
  onNavigate: (tab: string) => void;
  onOpenNora: () => void;
};

export default function QuickActions({ onNavigate, onOpenNora }: QuickActionsProps) {
  const actions = [
    {
      title: "Novo e-mail",
      icon: MailPlus,
      color: "text-blue-600 bg-blue-50 dark:bg-blue-500/10 dark:text-blue-400",
      run: () => {
        onNavigate("E-mails");
        window.setTimeout(() => window.dispatchEvent(new Event("emails:compose")), 80);
      },
    },
    {
      title: "Agendar reuniao",
      icon: CalendarPlus,
      color: "text-sky-600 bg-sky-50 dark:bg-sky-500/10 dark:text-sky-400",
      run: () => onNavigate("Agenda"),
    },
    {
      title: "Criar tarefa",
      icon: CheckSquare,
      color: "text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10 dark:text-emerald-400",
      run: () => onNavigate("Tarefas"),
    },
    {
      title: "Chamar Nora",
      icon: Sparkles,
      color: "text-cyan-600 bg-cyan-50 dark:bg-cyan-500/10 dark:text-cyan-400",
      run: onOpenNora,
    },
    {
      title: "Perfil",
      icon: UserPlus,
      color: "text-blue-600 bg-blue-50 dark:bg-blue-500/10 dark:text-blue-400",
      run: () => onNavigate("Perfil"),
    },
    {
      title: "Relatorio",
      icon: BarChart3,
      color: "text-amber-600 bg-amber-50 dark:bg-amber-500/10 dark:text-amber-400",
      run: () => onNavigate("Relatorios"),
    },
  ];

  return (
    <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
      <div className="mb-5">
        <h2 className="text-xl font-bold">Acoes rapidas</h2>
        <p className="text-sm font-semibold text-[var(--text-secondary)]">Execute fluxos reais com um clique.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {actions.map((action) => {
          const Icon = action.icon;

          return (
            <button
              key={action.title}
              onClick={action.run}
              className="group flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition-all duration-300 hover:-translate-y-1 hover:border-blue-500/30 hover:shadow-lg"
            >
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${action.color}`}>
                <Icon size={20} />
              </div>
              <span className="text-sm font-bold">{action.title}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
