import { CircleDot, ContactRound, MessageCircle, RadioTower, UsersRound } from "lucide-react";
import { useState } from "react";
import type { WhatsAppProfile } from "./whatsappApi";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";

export type WhatsAppSection = "conversations" | "status" | "contacts" | "groups" | "channels" | "profile";

interface WhatsAppRailProps {
  section: WhatsAppSection;
  unreadCount: number;
  statusUnreadCount?: number;
  online: boolean;
  profile?: WhatsAppProfile | null;
  onSelect: (section: WhatsAppSection) => void;
}

function ProfileButton({ profile, active, online, onClick }: { profile?: WhatsAppProfile | null; active: boolean; online: boolean; onClick: () => void }) {
  const [failed, setFailed] = useState(false);
  const photoUrl = useAuthenticatedMedia(profile?.photoUrl);
  const initials = profile?.name
    ?.split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "EU";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative grid h-11 w-11 place-items-center overflow-hidden rounded-full border transition ${active ? "border-[var(--primary)] ring-2 ring-[var(--primary)]/30" : "border-[var(--border)] hover:border-[var(--primary)]"}`}
      aria-label="Abrir meu perfil do WhatsApp"
      title="Meu perfil"
    >
      {photoUrl && !failed ? (
        <img src={photoUrl} alt={profile?.name || "Meu perfil"} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <span className="text-[10px] font-extrabold text-[var(--text)]">{initials}</span>
      )}
      <span className={`absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#080a0d] ${online ? "bg-emerald-400" : "bg-[var(--text-secondary)]"}`} />
    </button>
  );
}

export default function WhatsAppRail({ section, unreadCount, statusUnreadCount = 0, online, profile, onSelect }: WhatsAppRailProps) {
  const items: Array<{ id: Exclude<WhatsAppSection, "profile">; label: string; icon: typeof MessageCircle; badge?: number }> = [
    { id: "conversations", label: "Conversas", icon: MessageCircle, badge: unreadCount },
    { id: "status", label: "Status", icon: CircleDot, badge: statusUnreadCount },
    { id: "contacts", label: "Contatos", icon: ContactRound },
    { id: "groups", label: "Grupos", icon: UsersRound },
    { id: "channels", label: "Canais", icon: RadioTower },
  ];

  return (
    <nav className="norium-whatsapp-rail z-30 flex h-full w-[68px] shrink-0 flex-col items-center border-r border-[var(--border)] bg-[#080a0d] px-2 py-3 text-[var(--text-secondary)]" aria-label="Navegação do WhatsApp">
      <div className="grid h-10 w-10 place-items-center rounded-xl border border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_16%,transparent)] text-sm font-black text-[var(--primary)]" aria-hidden="true">N</div>

      <div className="mt-5 flex w-full flex-col items-center gap-2">
        {items.map(({ id, label, icon: Icon, badge }) => {
          const active = section === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className={`group relative grid h-11 w-11 place-items-center rounded-xl transition ${active ? "bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] text-[var(--primary)]" : "hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"}`}
              aria-label={badge ? `${label}, ${badge} ${id === "status" ? "nao visualizados" : "nao lidas"}` : label}
              aria-current={active ? "page" : undefined}
              title={label}
            >
              {active && <span className="absolute -left-2 h-7 w-[3px] rounded-r bg-[var(--primary)]" />}
              <Icon size={20} strokeWidth={active ? 2.4 : 1.9} />
              {Boolean(badge) && (
                <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full border-2 border-[#080a0d] bg-[var(--primary)] px-1 text-[9px] font-black text-white">
                  {Number(badge) > 99 ? "99+" : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-auto">
        <ProfileButton profile={profile} active={section === "profile"} online={online} onClick={() => onSelect("profile")} />
      </div>
    </nav>
  );
}
