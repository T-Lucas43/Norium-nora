import { Activity, BarChart3, Bell, BrainCircuit, CalendarDays, CheckSquare, CircleHelp, Clock3, ContactRound, CreditCard, Ellipsis, FileText, Globe2, LayoutDashboard, LibraryBig, Lightbulb, Mail, MessagesSquare, Network, Play, Settings, ShieldCheck, Store, UserRound, Users, Webhook, Workflow, Zap } from "lucide-react";
import noriumMailIcon from "../../assets/generated/norium-mail.png";
import whatsappIcon from "../../assets/generated/whatsapp-premium.png";
import noriumAgendaIcon from "../../assets/generated/norium-agenda.png";

type IntegrationLogoProps = {
  name: string;
  size?: number;
  className?: string;
  monochrome?: boolean;
};

function WhatsappVector({ size, className }: { size: number; className: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
    >
      <path d="M13.601 2.326A7.854 7.854 0 0 0 7.994 0C3.627 0 .068 3.558.064 7.926c0 1.399.366 2.76 1.057 3.965L0 16l4.204-1.102a7.933 7.933 0 0 0 3.79.965h.004c4.368 0 7.926-3.558 7.93-7.93a7.898 7.898 0 0 0-2.327-5.607zM7.994 14.521a6.573 6.573 0 0 1-3.356-.92l-.24-.144-2.493.654.666-2.43-.156-.25a6.56 6.56 0 0 1-1.007-3.505c0-3.626 2.957-6.584 6.591-6.584a6.56 6.56 0 0 1 4.66 1.931 6.558 6.558 0 0 1 1.928 4.66c-.004 3.639-2.961 6.588-6.593 6.588zm3.615-4.934c-.198-.099-1.17-.578-1.353-.646-.182-.062-.323-.099-.464.1-.141.198-.546.646-.67.785-.124.141-.248.157-.447.058-.198-.099-.836-.308-1.592-.985-.588-.525-.985-1.173-1.099-1.371-.116-.198-.012-.305.087-.404.089-.088.198-.23.297-.345.1-.116.132-.198.198-.33.066-.141.033-.264-.017-.363-.05-.099-.445-1.073-.61-1.47-.16-.389-.323-.336-.445-.342-.115-.006-.247-.007-.379-.007a.733.733 0 0 0-.53.247c-.182.198-.693.677-.693 1.654s.71 1.916.81 2.049c.098.132 1.396 2.132 3.383 2.992.473.205.842.326 1.129.417.474.15.905.129 1.246.078.38-.057 1.171-.48 1.337-.943.165-.462.165-.858.116-.943-.05-.084-.182-.132-.38-.23z" />
    </svg>
  );
}

/** Vector marks stay sharp in compact cards, the library and the flow canvas. */
export default function IntegrationLogo({ name, size = 24, className = "", monochrome = false }: IntegrationLogoProps) {
  const key = name.toLowerCase();
  if (monochrome && /whatsapp|message-square|^chat$/.test(key)) {
    return <WhatsappVector size={size} className={className} />;
  }
  if (!monochrome && /gmail/.test(key)) return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 32 32" className={className}><path fill="#4285F4" d="M3 9h5v19H3z"/><path fill="#34A853" d="M24 9h5v19h-5z"/><path fill="#EA4335" d="m3 8 4-3 9 7 9-7 4 3-13 10z"/><path fill="#FBBC04" d="m24 6 5 2v9l-5-4z"/><path fill="#C5221F" d="m3 8 5-2v7l-5 4z"/></svg>;
  const image = /e-mail|mail/.test(key) ? noriumMailIcon
    : /whatsapp|message-square|^chat$/.test(key) ? whatsappIcon
      : /agenda|calendar/.test(key) ? noriumAgendaIcon
        : null;
  if (!monochrome && image) return <img aria-hidden="true" src={image} width={size} height={size} className={`norium-suite-icon object-contain ${className}`} alt="" />;
  const [Icon, color] = /dashboard|resumo/.test(key) ? [LayoutDashboard, "#60a5fa"] as const
    : /e-mail|mail/.test(key) ? [Mail, "#60a5fa"] as const
    : /whatsapp|message-square|^chat$/.test(key) ? [MessagesSquare, "#60a5fa"] as const
    : /chat da equipe|messages-square/.test(key) ? [MessagesSquare, "#8b7cf8"] as const
    : /equipe|users/.test(key) ? [Users, "#8b7cf8"] as const
    : /agendamento/.test(key) ? [Clock3, "#fb923c"] as const
    : /agenda|calendar/.test(key) ? [CalendarDays, "#60a5fa"] as const
    : /tarefa|check-square/.test(key) ? [CheckSquare, "#2dd4bf"] as const
    : /gasto|financeiro|credit-card/.test(key) ? [CreditCard, "#fbbf24"] as const
    : /relat/.test(key) ? [BarChart3, "#38bdf8"] as const
    : /document|file-text/.test(key) ? [FileText, "#38bdf8"] as const
    : /webhook/.test(key) ? [Webhook, "#fb7185"] as const
    : /clock/.test(key) ? [Clock3, "#fb923c"] as const
    : /manual/.test(key) ? [Play, "#a3e635"] as const
    : /notifica|bell/.test(key) ? [Bell, "#fbbf24"] as const
    : /cliente/.test(key) ? [ContactRound, "#38bdf8"] as const
    : /estúdio|estudio/.test(key) ? [Lightbulb, "#f59e0b"] as const
    : /conhecimento/.test(key) ? [LibraryBig, "#a78bfa"] as const
    : /marketplace/.test(key) ? [Store, "#2dd4bf"] as const
    : /ia e modelos|modelos/.test(key) ? [Network, "#818cf8"] as const
    : /agente navegador|navegador|fontes web/.test(key) ? [Globe2, "#22d3ee"] as const
    : /governan/.test(key) ? [ShieldCheck, "#2dd4bf"] as const
    : /ajuda/.test(key) ? [CircleHelp, "#94a3b8"] as const
    : /mais/.test(key) ? [Ellipsis, "#94a3b8"] as const
    : /nora/.test(key) ? [BrainCircuit, "#38bdf8"] as const
    : /configura/.test(key) ? [Settings, "#94a3b8"] as const
    : /controle/.test(key) ? [ShieldCheck, "#2dd4bf"] as const
    : /perfil/.test(key) ? [UserRound, "#a78bfa"] as const
    : /central/.test(key) ? [Activity, "#60a5fa"] as const
    : /automa/.test(key) ? [Workflow, "#818cf8"] as const
    : /api|globe/.test(key) ? [Globe2, "#22d3ee"] as const : [Zap, "#818cf8"] as const;
  return <Icon aria-hidden="true" size={size} color={monochrome ? undefined : color} className={className} />;
}
