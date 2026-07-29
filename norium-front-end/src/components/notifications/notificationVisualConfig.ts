import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  CheckCircle2,
  CheckSquare2,
  CircleAlert,
  GitBranch,
  Info,
  Mail,
  MessageSquare,
  ShieldCheck,
  UsersRound,
  WalletCards,
} from "lucide-react";
import type { SystemNotification, SystemNotificationSeverity } from "../../types/omnichannel";

type NotificationKind =
  | "gmail"
  | "whatsapp"
  | "calendar"
  | "kanban"
  | "financeiro"
  | "automacoes"
  | "equipe"
  | "nora"
  | "sistema";

export type NotificationVisualConfig = {
  icon: LucideIcon;
  label: string;
  className: string;
};

const kindConfig: Record<NotificationKind, NotificationVisualConfig> = {
  gmail: { icon: Mail, label: "E-mail", className: "from-red-500/30 to-rose-500/8 text-red-300 border-red-400/25" },
  whatsapp: { icon: MessageSquare, label: "WhatsApp", className: "from-emerald-500/30 to-green-500/8 text-emerald-300 border-emerald-400/25" },
  calendar: { icon: CalendarDays, label: "Agenda", className: "from-blue-500/30 to-sky-500/8 text-blue-300 border-blue-400/25" },
  kanban: { icon: CheckSquare2, label: "Tarefas", className: "from-amber-500/30 to-yellow-500/8 text-amber-300 border-amber-400/25" },
  financeiro: { icon: WalletCards, label: "Financeiro", className: "from-cyan-500/30 to-teal-500/8 text-cyan-300 border-cyan-400/25" },
  automacoes: { icon: GitBranch, label: "Automação", className: "from-violet-500/30 to-indigo-500/8 text-violet-300 border-violet-400/25" },
  equipe: { icon: UsersRound, label: "Equipe", className: "from-indigo-500/30 to-blue-500/8 text-indigo-300 border-indigo-400/25" },
  nora: { icon: Bot, label: "Nora", className: "from-sky-500/30 to-cyan-500/8 text-sky-300 border-sky-400/25" },
  sistema: { icon: ShieldCheck, label: "Sistema", className: "from-slate-500/30 to-blue-500/8 text-slate-200 border-slate-400/25" },
};

const severityFallback: Record<SystemNotificationSeverity, NotificationVisualConfig> = {
  info: { icon: Info, label: "Informação", className: "from-sky-500/30 to-blue-500/8 text-sky-300 border-sky-400/25" },
  success: { icon: CheckCircle2, label: "Resolvido", className: "from-emerald-500/30 to-green-500/8 text-emerald-300 border-emerald-400/25" },
  warning: { icon: AlertTriangle, label: "Aviso", className: "from-amber-500/30 to-orange-500/8 text-amber-300 border-amber-400/25" },
  error: { icon: CircleAlert, label: "Crítico", className: "from-red-500/30 to-rose-500/8 text-red-300 border-red-400/25" },
};

function notificationKind(notification: SystemNotification): NotificationKind | null {
  const metadataSource = String(
    notification.metadata?.source ||
    notification.metadata?.channel ||
    notification.metadata?.integration ||
    "",
  ).toLocaleLowerCase("pt-BR");
  const content = `${metadataSource} ${notification.title} ${notification.description}`.toLocaleLowerCase("pt-BR");

  if (content.includes("gmail") || content.includes("e-mail") || content.includes("email")) return "gmail";
  if (content.includes("whatsapp") || content.includes("mensagem")) return "whatsapp";
  if (content.includes("agenda") || content.includes("calendar") || content.includes("evento")) return "calendar";
  if (content.includes("tarefa") || content.includes("kanban") || content.includes("projeto")) return "kanban";
  if (content.includes("finance") || content.includes("gasto") || content.includes("boleto") || content.includes("pagamento")) return "financeiro";
  if (content.includes("automa")) return "automacoes";
  if (content.includes("equipe") || content.includes("membro")) return "equipe";
  if (content.includes("nora") || content.includes("assistente")) return "nora";
  if (content.includes("sistema") || content.includes("websocket") || content.includes("conex")) return "sistema";
  return null;
}

export function notificationVisual(notification: SystemNotification): NotificationVisualConfig {
  const kind = notificationKind(notification);
  return kind ? kindConfig[kind] : severityFallback[notification.severity];
}
