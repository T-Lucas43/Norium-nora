import { Bell, Gauge, Palette, ShieldCheck, Sparkles, UserCircle2, UserCog, type LucideIcon } from "lucide-react";

export type SettingsSection = "perfil" | "nora" | "consumo" | "aparencia" | "notificacoes" | "privacidade" | "admin";

export const SETTINGS_SECTION_KEY = "norium:configuracoes-secao";

const items: Array<{ id: SettingsSection; label: string; icon: LucideIcon }> = [
  { id: "perfil", label: "Meu perfil", icon: UserCircle2 },
  { id: "nora", label: "Nora e IA", icon: Sparkles },
  { id: "consumo", label: "Consumo da Nora", icon: Gauge },
  { id: "aparencia", label: "Aparência e acessibilidade", icon: Palette },
  { id: "notificacoes", label: "Notificações", icon: Bell },
  { id: "privacidade", label: "Privacidade e dados", icon: ShieldCheck },
  { id: "admin", label: "Painel administrativo", icon: UserCog },
];

export function readSettingsSection(): SettingsSection | null {
  try {
    const value = window.localStorage.getItem(SETTINGS_SECTION_KEY);
    return items.some((item) => item.id === value) ? value as SettingsSection : null;
  } catch {
    return null;
  }
}

export function storeSettingsSection(section: SettingsSection) {
  try { window.localStorage.setItem(SETTINGS_SECTION_KEY, section); } catch { /* armazenamento indisponível */ }
}

/** Menu lateral de Configurações (mockup cfgNav). */
export default function SettingsNav({ active, onSelect, showPrivacy, showAdmin, showUsage = false }: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  showPrivacy: boolean;
  showAdmin: boolean;
  showUsage?: boolean;
}) {
  const visible = items.filter((item) => (item.id !== "privacidade" || showPrivacy) && (item.id !== "admin" || showAdmin) && (item.id !== "consumo" || showUsage));
  return (
    <aside className="nxi-cfg-side">
      <h1 className="nxi-cfg-title">Configurações</h1>
      <nav className="nxi-cfg-nav" aria-label="Seções das configurações">
        {visible.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`nxi-cfg-item ${active === id ? "is-active" : ""}`}
            aria-current={active === id ? "page" : undefined}
            onClick={() => onSelect(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
