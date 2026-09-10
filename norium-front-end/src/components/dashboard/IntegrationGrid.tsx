import IntegrationLogo from "../shared/IntegrationLogo";
import Button from "../shared/Button";
import {
  CalendarDays,
  CheckCircle2,
  Mail,
  MessageCircle,
} from "lucide-react";

type Integration = {
  name: string;
  subtitle: string;
  tab: string;
  icon: typeof Mail;
  iconClass: string;
  iconSurface: string;
};

const integrations: Integration[] = [
  {
    name: "Gmail",
    subtitle: "E-mails e respostas",
    tab: "E-mails",
    icon: Mail,
    iconClass: "text-red-400",
    iconSurface: "bg-red-500/10",
  },
  {
    name: "Google Agenda",
    subtitle: "Eventos sincronizados",
    tab: "Agenda",
    icon: CalendarDays,
    iconClass: "text-blue-400",
    iconSurface: "bg-blue-500/10",
  },
  {
    name: "WhatsApp",
    subtitle: "Conversas pela API privada Norium",
    tab: "Chat",
    icon: MessageCircle,
    iconClass: "text-emerald-400",
    iconSurface: "bg-emerald-500/10",
  },
];

export default function IntegrationGrid({ onNavigate }: { onNavigate: (tab: string) => void }) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-[var(--text)]">Integrações</h2>
          <p className="text-sm font-semibold text-[var(--text-secondary)]">Acesse os canais e gerencie suas conexões.</p>
        </div>

        <Button
         
          onClick={() => onNavigate("Mais")}
          className="py-2"
        >
          Gerenciar
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {integrations.map((integration) => {

          return (
            <button
              type="button"
              key={integration.name}
              onClick={() => onNavigate(integration.tab)}
              className="group min-h-[152px] rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 text-left transition hover:-translate-y-0.5 hover:border-blue-500/55 hover:bg-[var(--surface-hover)]"
              aria-label={`Abrir ${integration.name}`}
            >
              <span className={`mb-4 grid h-11 w-11 place-items-center rounded-lg ${integration.iconSurface}`}>
                <IntegrationLogo name={integration.name} size={28} />
              </span>
              <h3 className="text-base font-bold text-[var(--text)]">{integration.name}</h3>
              <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">{integration.subtitle}</p>
              <span className="mt-4 inline-flex items-center gap-2 text-xs font-bold text-emerald-500">
                <CheckCircle2 size={14} /> Disponível
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
