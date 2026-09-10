import { Bell, CalendarDays, CheckSquare, Clock3, CreditCard, FileText, Globe2, ContactRound, Lightbulb, Settings, ShieldCheck, UserRound, Activity, Workflow, Play, Users, Webhook, Zap } from "lucide-react";

/** Vector marks stay sharp in compact cards, the library and the flow canvas. */
export default function IntegrationLogo({ name, size = 24, className = "" }: { name: string; size?: number; className?: string }) {
  const key = name.toLowerCase();
  if (/gmail|e-mail|mail/.test(key)) return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 32 32" className={className}><path fill="#4285F4" d="M3 9h5v19H3z"/><path fill="#34A853" d="M24 9h5v19h-5z"/><path fill="#EA4335" d="m3 8 4-3 9 7 9-7 4 3-13 10z"/><path fill="#FBBC04" d="m24 6 5 2v9l-5-4z"/><path fill="#C5221F" d="m3 8 5-2v7l-5 4z"/></svg>;
  if (/google agenda/.test(key)) return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 32 32" className={className}><path fill="#4285F4" d="M4 4h24v20l-4 4H4z"/><path fill="white" d="M8 9h16v15H8z"/><path fill="#34A853" d="M8 24h16v4H8z"/><path fill="#FBBC04" d="M24 9h4v15h-4z"/><path fill="#EA4335" d="m24 24 4 0-4 4z"/><text x="16" y="20" textAnchor="middle" fill="#4285F4" fontSize="12" fontWeight="700">31</text></svg>;
  if (/whatsapp|message-square/.test(key)) return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 32 32" className={className}><path d="M27 15.5a11 11 0 0 1-16.7 9.4L5 26.5l1.6-5.1A11 11 0 1 1 27 15.5Z" fill="none" stroke="#25d366" strokeWidth="2.2"/><path d="m11 9 2 4-1.5 1.6c1.1 2.5 2.7 4.1 5.2 5.2l1.6-1.5 4 2c-.7 2.5-2.2 3-4.2 2.3-5.2-1.7-8.4-4.9-10.1-10.1C7.3 10.5 8.5 9.4 11 9Z" fill="#25d366" transform="translate(2 0) scale(.86)"/></svg>;
  const [Icon, color] = /equipe|chat|users/.test(key) ? [Users, "#8b7cf8"] as const
    : /agenda|calendar/.test(key) ? [CalendarDays, "#60a5fa"] as const
    : /tarefa|check-square/.test(key) ? [CheckSquare, "#2dd4bf"] as const
    : /gasto|financeiro|credit-card/.test(key) ? [CreditCard, "#fbbf24"] as const
    : /relat|document|file-text/.test(key) ? [FileText, "#38bdf8"] as const
    : /webhook/.test(key) ? [Webhook, "#fb7185"] as const
    : /agendamento|clock/.test(key) ? [Clock3, "#fb923c"] as const
    : /manual/.test(key) ? [Play, "#a3e635"] as const
    : /notifica|bell/.test(key) ? [Bell, "#fbbf24"] as const
    : /cliente/.test(key) ? [ContactRound, "#38bdf8"] as const
    : /estúdio|estudio/.test(key) ? [Lightbulb, "#f59e0b"] as const
    : /configura/.test(key) ? [Settings, "#94a3b8"] as const
    : /controle/.test(key) ? [ShieldCheck, "#2dd4bf"] as const
    : /perfil/.test(key) ? [UserRound, "#a78bfa"] as const
    : /central/.test(key) ? [Activity, "#60a5fa"] as const
    : /automa/.test(key) ? [Workflow, "#818cf8"] as const
    : /api|globe/.test(key) ? [Globe2, "#22d3ee"] as const : [Zap, "#818cf8"] as const;
  return <Icon aria-hidden="true" size={size} color={color} className={className} />;
}
