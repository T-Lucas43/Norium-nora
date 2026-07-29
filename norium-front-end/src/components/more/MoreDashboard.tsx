import {
  Bell,
  Bot,
  Download,
  GitBranch,
  Landmark,
  Lightbulb,
  LogOut,
  Logs,
  Puzzle,
  Settings,
  Shield,
  ShieldCheck,
  Users,
  Webhook,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type MoreDashboardProps = {
  onNavigate: (tab: string) => void;
  onOpenNora: () => void;
  onLogout: () => void;
};

type MoreItem = {
  title: string;
  description: string;
  icon: LucideIcon;
  action: () => void;
};

export default function MoreDashboard({ onNavigate, onOpenNora, onLogout }: MoreDashboardProps) {
  const modules: MoreItem[] = [
    { title: "Controle operacional", description: "Meu Dia, aprovacoes, integracoes, auditoria e comprovantes.", icon: ShieldCheck, action: () => onNavigate("Controle") },
    { title: "Configuracoes", description: "Tema, aparencia, notificacoes e preferencias da Nora.", icon: Settings, action: () => onNavigate("Configuracoes") },
    { title: "Integracoes", description: "Central de eventos das integracoes conectadas.", icon: Puzzle, action: () => onNavigate("Central") },
    { title: "Agentes", description: "Abra a Nora e acesse os agentes de e-mail, agenda e tarefas.", icon: Bot, action: onOpenNora },
    { title: "Notificacoes", description: "Alertas globais, conexoes e avisos operacionais.", icon: Bell, action: () => onNavigate("Notificacoes") },
    { title: "Seguranca", description: "Sessoes, auditoria e politicas de acesso.", icon: Shield, action: () => onNavigate("Controle") },
    { title: "Financeiro", description: "Gastos, boletos, entradas, saidas e lembretes.", icon: Landmark, action: () => onNavigate("Gastos") },
    { title: "Automacoes", description: "Fluxos, gatilhos, execucoes e agentes da Nora.", icon: GitBranch, action: () => onNavigate("Automações") },
    { title: "Equipe", description: "Operadores, permissoes e grupos de trabalho.", icon: Users, action: () => onNavigate("Equipe") },
    { title: "Brainstorm", description: "Quadros colaborativos, ideias, votacao, comentarios e decisoes.", icon: Lightbulb, action: () => onNavigate("Brainstorm") },
    { title: "Sair da conta", description: "Encerrar sua sessao atual no Norium.", icon: LogOut, action: onLogout },
  ];

  const advanced: MoreItem[] = [
    { title: "Exportar dados", description: "Baixe relatorios e dados consolidados.", icon: Download, action: () => onNavigate("Relatorios") },
    { title: "Logs de atividades", description: "Historico operacional em tempo real.", icon: Logs, action: () => onNavigate("Controle") },
    { title: "Webhooks", description: "Gerencie webhooks de entrada e saida.", icon: Webhook, action: () => onNavigate("Automações") },
  ];

  return (
    <div className="h-full overflow-y-auto bg-[var(--background)] p-8 text-[var(--text)]">
      <header className="mb-6">
        <h1 className="text-2xl font-black">Mais</h1>
        <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">
          Atalhos administrativos e recursos disponiveis no Norium.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {modules.map((item) => (
          <button
            key={item.title}
            type="button"
            onClick={item.action}
            className="min-h-40 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-left shadow-sm transition hover:border-blue-400 hover:bg-[var(--surface-hover)]"
          >
            <span className="mb-4 grid h-11 w-11 place-items-center rounded-lg bg-blue-500/12 text-blue-300">
              <item.icon size={22} />
            </span>
            <h3 className="font-black text-[var(--text)]">{item.title}</h3>
            <p className="mt-2 line-clamp-2 text-sm font-semibold text-[var(--text-secondary)]">{item.description}</p>
          </button>
        ))}
      </div>

      <section className="mt-8 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <header className="border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-base font-black">Ferramentas avancadas</h2>
          <p className="text-xs font-semibold text-[var(--text-secondary)]">Exportacao, rastreabilidade e automacao.</p>
        </header>
        <div className="divide-y divide-[var(--border)]">
          {advanced.map((item) => (
            <button
              key={item.title}
              type="button"
              onClick={item.action}
              className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-[var(--surface-hover)]"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--background)] text-blue-300">
                  <item.icon size={18} />
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-black">{item.title}</strong>
                  <span className="block truncate text-xs font-semibold text-[var(--text-secondary)]">{item.description}</span>
                </span>
              </span>
              <span className="shrink-0 text-xs font-black text-blue-300">Abrir</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
