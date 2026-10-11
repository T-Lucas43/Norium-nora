import type { DashboardMetrics } from "./Dashboard";
import { CheckSquare, CreditCard } from "lucide-react";
import noriumMailIcon from "../../assets/generated/norium-mail.png";
import whatsappIcon from "../../assets/generated/whatsapp-premium.png";
import noriumAgendaIcon from "../../assets/generated/norium-agenda.png";

type SummaryProps = {
  metrics: DashboardMetrics;
  financeBalance?: number | null;
  myTaskCount?: number;
  todayEventCount?: number;
  onNavigate: (tab: string) => void;
};

function pluralize(value: number, singular: string, plural: string) {
  return value === 1 ? singular : plural;
}

export default function Summary({ metrics, financeBalance = null, myTaskCount = 0, todayEventCount = 0, onNavigate }: SummaryProps) {
  const balanceLabel = financeBalance === null
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(financeBalance);
  const stats = [
    {
      title: "E-mails",
      value: metrics.emails,
      subtitle: `${metrics.emails} ${pluralize(metrics.emails, "recente", "recentes")}`,
      icon: noriumMailIcon,
      tab: "E-mails",
    },
    {
      title: "WhatsApp",
      value: metrics.whatsapp,
      subtitle: `${metrics.whatsapp} ${pluralize(metrics.whatsapp, "conversa recente", "conversas recentes")}`,
      icon: whatsappIcon,
      tab: "Chat",
    },
    {
      title: "Agenda",
      value: todayEventCount,
      subtitle: pluralize(todayEventCount, "compromisso hoje", "compromissos hoje"),
      icon: noriumAgendaIcon,
      tab: "Agenda",
    },
    {
      title: "Tarefas",
      value: myTaskCount,
      subtitle: pluralize(myTaskCount, "atribuída a você", "atribuídas a você"),
      Icon: CheckSquare,
      tab: "Tarefas",
    },
    {
      title: "Financeiro",
      value: balanceLabel,
      subtitle: "saldo atual",
      Icon: CreditCard,
      tab: "Financeiro",
    },
  ];

  return (
    <section className="nxd-kpis" aria-label="Indicadores por canal">
      {stats.map((item) => (
        <button
          type="button"
          key={item.title}
          onClick={() => onNavigate(item.tab)}
          className="nx-card nxd-kpi"
        >
          <span className="nx-kpi-l">
            {"icon" in item
              ? <img src={item.icon} className="nxd-kpi-icon norium-suite-icon" alt="" />
              : <item.Icon aria-hidden="true" size={16} strokeWidth={1.75} />}
            {item.title}
          </span>
          <span className="nx-kpi-v block" title={String(item.value)}>{item.value}</span>
          <span className="nx-kpi-s block">{item.subtitle}</span>
        </button>
      ))}
    </section>
  );
}
