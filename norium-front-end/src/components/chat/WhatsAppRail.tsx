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
  const [failedSource, setFailedSource] = useState("");
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
      className={`relative grid h-9 w-9 place-items-center rounded-full transition ${active ? "ring-2 ring-[var(--nx-primary)] ring-offset-2 ring-offset-[var(--nx-surface)]" : "hover:ring-2 hover:ring-[var(--nx-border-strong)]"}`}
      aria-label="Abrir meu perfil do WhatsApp"
      title="Meu perfil"
    >
      <span className="grid h-full w-full place-items-center overflow-hidden rounded-full bg-[var(--nx-hover)]">
        {photoUrl && photoUrl !== failedSource ? (
          <img src={photoUrl} alt={profile?.name || "Meu perfil"} className="h-full w-full object-cover" onError={() => setFailedSource(photoUrl)} />
        ) : (
          <span className="text-[11px] font-semibold text-[var(--nx-text)]">{initials}</span>
        )}
      </span>
      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--nx-surface)] ${online ? "bg-[var(--nx-success)]" : "bg-[var(--nx-text-3)]"}`} />
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
    <nav className="norium-whatsapp-rail nx-conv-rail z-30 flex h-full w-[60px] shrink-0 flex-col items-center px-2 py-4" aria-label="Navegação do WhatsApp">
      <div className="flex w-full flex-col items-center gap-1.5">
        {items.map(({ id, label, icon: Icon, badge }) => {
          const active = section === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className="nx-conv-rail-btn"
              aria-label={badge ? `${label}, ${badge} ${id === "status" ? "nao visualizados" : "nao lidas"}` : label}
              aria-current={active ? "page" : undefined}
              title={label}
            >
              <Icon size={18} strokeWidth={1.75} />
              {Boolean(badge) && (
                <span className="nx-conv-count">
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
