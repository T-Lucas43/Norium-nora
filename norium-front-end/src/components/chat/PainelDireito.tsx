import { BadgeCheck, Building2, CalendarDays, Image as ImageIcon, MessageCircle, MessageSquareText, Phone, ShieldAlert, Sparkles, User, Users, X } from "lucide-react";
import { useState } from "react";
import type { ChatConversa } from "./types";
import Button from "../shared/Button";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";
import type { ParticipanteGrupo } from "./types";
import { conversationDisplayName, formatWhatsAppPhone, isTechnicalWhatsAppLabel } from "./contactPicker";

interface PainelDireitoProps {
  modo: "nora" | "perfil" | "config-propria";
  conversaAtiva: ChatConversa | undefined;
  onFechar: () => void;
  onContinuarConversa?: () => void;
  onStartMemberConversation?: (member: ParticipanteGrupo) => void;
  onAskNora?: (prompt?: string) => void;
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}

function ProfileAvatar({ conversa }: { conversa: ChatConversa }) {
  const [failed, setFailed] = useState(false);
  const photoUrl = useAuthenticatedMedia(conversa.metadados?.photoUrl || conversa.photoUrl);
  const displayName = conversationDisplayName(conversa);

  return (
    <div className="h-20 w-20 rounded-full bg-[var(--surface)] border border-[var(--border)] overflow-hidden flex items-center justify-center font-bold text-lg text-[var(--text-secondary)]">
      {photoUrl && !failed ? (
        <img src={photoUrl} alt={displayName} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : conversa.esGrupo ? (
        <Users size={24} />
      ) : !isTechnicalWhatsAppLabel(displayName) ? (
        initials(displayName)
      ) : (
        <User size={24} />
      )}
    </div>
  );
}

function PrivateMediaThumbnail({ source }: { source?: string }) {
  const mediaUrl = useAuthenticatedMedia(source);
  return mediaUrl ? <img src={mediaUrl} alt="Midia" className="h-full w-full object-cover" /> : <ImageIcon size={16} className="mx-auto opacity-50" />;
}

function MemberAvatar({ member }: { member: ParticipanteGrupo }) {
  const [failed, setFailed] = useState(false);
  const source = useAuthenticatedMedia(member.photoUrl);
  const label = member.name || member.phone;
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface)] text-[10px] font-bold text-[var(--text-secondary)]">
      {source && !failed ? <img src={source} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} /> : initials(label)}
    </span>
  );
}

function memberDisplayName(member: ParticipanteGrupo) {
  const name = String(member.name || "").trim();
  return name && !isTechnicalWhatsAppLabel(name)
    ? name
    : formatWhatsAppPhone(member.phone || member.id) || "Participante do WhatsApp";
}

export default function PainelDireito({ modo, conversaAtiva, onFechar, onContinuarConversa, onStartMemberConversation, onAskNora }: PainelDireitoProps) {
  const midiasGaleria = conversaAtiva?.mensagens.filter((mensagem) => mensagem.tipo === "midia") || [];
  const participantes = conversaAtiva?.metadados?.participantes || [];
  const createdValue = conversaAtiva?.metadados?.criadoEm;
  const createdDate = createdValue
    ? new Date(typeof createdValue === "number" && createdValue < 10_000_000_000 ? createdValue * 1000 : createdValue)
    : null;
  const displayName = conversaAtiva ? conversationDisplayName(conversaAtiva) : "";
  const phoneLabel = conversaAtiva ? formatWhatsAppPhone(conversaAtiva.metadados?.numeroCompleto || conversaAtiva.id) : "";

  return (
    <aside className="norium-chat-details flex h-full min-h-0 w-[380px] shrink-0 select-none flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--surface)] p-4 text-[var(--text)]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border)]">
        <h4 className="text-[15px] font-semibold">
          {modo === "perfil" && (conversaAtiva?.esGrupo ? "Dados do grupo" : "Dados do contato")}
          {modo === "config-propria" && "Minhas contas"}
          {modo === "nora" && "Nora"}
        </h4>
        <Button variant="ghost" size="sm" iconOnly onClick={onFechar} aria-label="Fechar painel">
          <X size={15} />
        </Button>
      </div>

      <div className="norium-chat-details-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pt-4 pr-1">

      {modo === "perfil" && conversaAtiva && (
        <div className="space-y-4">
          <div className="flex flex-col items-center py-5 bg-[var(--background)] border border-[var(--border)] rounded-lg text-center">
            <ProfileAvatar conversa={conversaAtiva} />
            <h3 className="mt-3 font-bold text-sm px-2 truncate w-full">{displayName}</h3>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 px-2">
              <span className="nx-badge is-green">WhatsApp</span>
              {conversaAtiva.metadados?.verifiedName && <span className="inline-flex h-6 items-center gap-1 rounded-full border border-[var(--primary)]/30 px-2 text-xs font-bold text-[var(--primary)]"><BadgeCheck size={12} /> Verificado</span>}
              {conversaAtiva.metadados?.isBusiness && <span className="inline-flex h-6 items-center gap-1 rounded-full border border-[var(--border)] px-2 text-xs font-bold"><Building2 size={12} /> Empresa</span>}
            </div>
            <Button variant="primary" size="sm" className="mt-3 inline-flex items-center gap-2" onClick={onContinuarConversa || onFechar}><MessageCircle size={14} /> Continuar conversa</Button>
          </div>

          <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-xs">
            {!conversaAtiva.esGrupo && phoneLabel && <p className="flex items-center gap-2 font-medium"><Phone size={13} className="text-[var(--primary)]" /> <span>{phoneLabel}</span></p>}
            {conversaAtiva.esGrupo && <p className="flex items-center gap-2 font-medium"><Users size={13} className="text-[var(--primary)]" /> {participantes.length} integrante(s)</p>}
            {createdDate && !Number.isNaN(createdDate.getTime()) && <p className="flex items-center gap-2 font-medium"><CalendarDays size={13} className="text-[var(--primary)]" /> Criado em {createdDate.toLocaleDateString("pt-BR")}</p>}
          </div>

          <div className="bg-[var(--background)] p-3 rounded-lg border border-[var(--border)] space-y-1">
            <p className="text-xs text-[var(--text-secondary)] uppercase font-bold">Recado / descrição</p>
            <p className="text-xs font-medium opacity-90">
              {conversaAtiva.metadados?.descricaoGrupo || conversaAtiva.metadados?.bioRecado || "Nenhuma informação disponível."}
            </p>
          </div>

          <div className="bg-[var(--background)] p-3 rounded-lg border border-[var(--border)] space-y-2">
            <p className="text-xs text-[var(--text-secondary)] uppercase font-bold flex items-center gap-1">
              <ImageIcon size={12} /> Arquivos e midias ({midiasGaleria.length})
            </p>
            {midiasGaleria.length > 0 ? (
              <div className="grid grid-cols-4 gap-1.5 max-h-32 overflow-y-auto">
                {midiasGaleria.map((midia) => (
                  <Button key={midia.id} aria-label="Visualizar midia" className="h-12 overflow-hidden">
                    <PrivateMediaThumbnail source={midia.arquivoUrl} />
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--text-secondary)]">Nenhuma mídia compartilhada recentemente.</p>
            )}
          </div>

          {conversaAtiva.esGrupo && (
            <div className="bg-[var(--background)] p-3 rounded-lg border border-[var(--border)] space-y-2">
              <p className="text-xs text-[var(--text-secondary)] uppercase font-bold">Membros ({participantes.length})</p>
              <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                {participantes.length > 0 ? (
                  participantes.map((membro) => (
                    <div key={membro.id} className="flex items-center justify-between gap-2 border-b border-[var(--border)]/50 py-1.5 text-xs font-medium last:border-0">
                      <button type="button" onClick={() => onStartMemberConversation?.(membro)} disabled={!onStartMemberConversation} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left transition hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:hover:bg-transparent" aria-label={`Iniciar conversa com ${memberDisplayName(membro)}`}>
                        <MemberAvatar member={membro} />
                        <span className="min-w-0 flex-1"><span className="block truncate">{memberDisplayName(membro)}</span><span className="block truncate text-[10px] text-[var(--text-secondary)]">{formatWhatsAppPhone(membro.phone || membro.id)}</span></span>
                      </button>
                      {(membro.isAdmin || membro.isSuperAdmin) && <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-1.5 text-[10px] font-extrabold text-[var(--primary)]"><ShieldAlert size={10} /> {membro.isSuperAdmin ? "Superadmin" : "Admin"}</span>}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-[var(--text-secondary)]">Nenhum integrante mapeado.</p>
                )}
              </div>
            </div>
          )}

        </div>
      )}

      {modo === "nora" && (
        <div className="bg-[var(--background)] border border-[var(--border)] p-4 rounded-lg space-y-3 text-xs font-semibold">
          <p className="text-[var(--primary)] font-bold text-center">Nora IA ativa</p>
          {conversaAtiva ? (
            <>
              <p className="text-[var(--text-secondary)] text-center">
                Análise contextual da conversa com {displayName}.
              </p>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => onAskNora?.(`Resuma a conversa com ${displayName} no Chat e destaque os pontos principais.`)}
                  className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
                >
                  <MessageSquareText size={14} className="shrink-0" /> Resumir esta conversa
                </button>
                <button
                  type="button"
                  onClick={() => onAskNora?.(`Sugira uma resposta adequada para a ultima mensagem de ${displayName} no Chat.`)}
                  className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
                >
                  <Sparkles size={14} className="shrink-0" /> Sugerir resposta
                </button>
                <button
                  type="button"
                  onClick={() => onAskNora?.(`Analise o tom e o sentimento da conversa com ${displayName} e diga se preciso de atencao especial.`)}
                  className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
                >
                  <ShieldAlert size={14} className="shrink-0" /> Analisar tom da conversa
                </button>
              </div>
            </>
          ) : (
            <p className="text-[var(--text-secondary)] text-center">Selecione uma conversa para a Nora analisar o contexto.</p>
          )}
        </div>
      )}

      {modo === "config-propria" && (
        <div className="bg-[var(--background)] border border-[var(--border)] p-4 rounded-lg space-y-3 text-xs font-semibold">
          <div className="flex items-center justify-between border-b border-[var(--border)]/60 pb-2">
            <span>WhatsApp Engine</span>
            <span className="text-[var(--primary)]">Ativo</span>
          </div>
        </div>
      )}
      </div>
    </aside>
  );
}
