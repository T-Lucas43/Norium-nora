import { Bell, HelpCircle, KeyRound, Keyboard, LogOut, MessageSquare, Shield, UserRound } from "lucide-react";
import { useState } from "react";
import type { WhatsAppProfile } from "./whatsappApi";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";

interface WhatsAppProfileViewProps {
  profile?: WhatsAppProfile | null;
  connected: boolean;
  onDisconnect: () => void;
  onUnavailableSetting: (label: string) => void;
}

function OwnAvatar({ profile }: { profile?: WhatsAppProfile | null }) {
  const [failed, setFailed] = useState(false);
  const source = useAuthenticatedMedia(profile?.photoUrl);
  const initials = profile?.name?.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "EU";
  return (
    <div className="grid h-28 w-28 place-items-center overflow-hidden rounded-full bg-[var(--nx-hover)] text-xl font-semibold text-[var(--text)]">
      {source && !failed ? <img src={source} alt={profile?.name || "Meu perfil"} className="h-full w-full object-cover" onError={() => setFailed(true)} /> : initials}
    </div>
  );
}

export default function WhatsAppProfileView({ profile, connected, onDisconnect, onUnavailableSetting }: WhatsAppProfileViewProps) {
  const settings = [
    { label: "Perfil", detail: "Nome, foto do perfil e recado", icon: UserRound },
    { label: "Conta", detail: "Segurança e dados da conta", icon: KeyRound },
    { label: "Privacidade", detail: "Contatos bloqueados e mensagens temporárias", icon: Shield },
    { label: "Conversas", detail: "Tema e configurações de conversas", icon: MessageSquare },
    { label: "Notificações", detail: "Mensagens, grupos e sons", icon: Bell },
    { label: "Atalhos do teclado", detail: "Ações rápidas no painel", icon: Keyboard },
    { label: "Ajuda e feedback", detail: "Central de ajuda e políticas", icon: HelpCircle },
  ];

  return (
    <>
      <aside className="norium-chat-sidebar flex h-full min-h-0 w-[420px] min-w-[300px] flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
        <header className="shrink-0 border-b border-[var(--border)] px-6 py-5">
          <h2 className="text-lg font-semibold">{profile?.name || "Meu WhatsApp"}</h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">Perfil conectado ao Norium</p>
        </header>
        <div className="norium-chat-list min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="flex flex-col items-center text-center">
            <OwnAvatar profile={profile} />
            <h3 className="mt-4 text-lg font-semibold">{profile?.name || "Conta do WhatsApp"}</h3>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{profile?.phone || (connected ? "WhatsApp conectado" : "WhatsApp desconectado")}</p>
            {profile?.bio && <p className="mt-2 max-w-sm text-sm text-[var(--text-secondary)]">{profile.bio}</p>}
          </div>

          <div className="mt-7 divide-y divide-[var(--border)]/60 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {settings.map(({ label, detail, icon: Icon }) => (
              <button key={label} type="button" onClick={() => onUnavailableSetting(label)} className="flex w-full items-center gap-4 px-4 py-3.5 text-left transition first:rounded-t-xl last:rounded-b-xl hover:bg-[var(--surface-hover)]">
                <Icon size={19} className="shrink-0 text-[var(--text-secondary)]" />
                <span className="min-w-0"><span className="block text-sm font-semibold">{label}</span><span className="mt-0.5 block truncate text-xs text-[var(--text-secondary)]">{detail}</span></span>
              </button>
            ))}
          </div>

          <button type="button" onClick={onDisconnect} className="mt-5 flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-semibold text-[var(--nx-danger)] transition hover:bg-[var(--nx-danger-soft)]"><LogOut size={18} /> Desconectar WhatsApp</button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 items-center justify-center bg-[var(--background)] p-8 text-center text-[var(--text)]">
        <div className="max-w-md">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-xl bg-[var(--nx-primary-soft)] text-[var(--nx-primary-text)]"><Shield size={24} /></div>
          <h3 className="mt-5 text-xl font-semibold">Conta protegida por usuário</h3>
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">Esta sessão pertence somente à sua conta Norium. Outros usuários conectam o próprio WhatsApp e não compartilham histórico ou credenciais.</p>
        </div>
      </main>
    </>
  );
}
