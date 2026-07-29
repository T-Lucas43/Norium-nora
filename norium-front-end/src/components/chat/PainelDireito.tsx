import { Image as ImageIcon, MessageSquareText, ShieldAlert, Sparkles, User, Users, X } from "lucide-react";
import { useState } from "react";
import type { ChatConversa } from "./types";

interface PainelDireitoProps {
  modo: "nora" | "perfil" | "config-propria";
  conversaAtiva: ChatConversa | undefined;
  onFechar: () => void;
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
  const photoUrl = conversa.metadados?.photoUrl || conversa.photoUrl;

  return (
    <div className="h-20 w-20 rounded-full bg-[var(--surface)] border border-[var(--border)] overflow-hidden flex items-center justify-center font-bold text-lg text-[var(--text-secondary)]">
      {photoUrl && !failed ? (
        <img src={photoUrl} alt={conversa.contato} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : conversa.esGrupo ? (
        <Users size={24} />
      ) : (
        initials(conversa.contato)
      )}
    </div>
  );
}

export default function PainelDireito({ modo, conversaAtiva, onFechar, onAskNora }: PainelDireitoProps) {
  const midiasGaleria = conversaAtiva?.mensagens.filter((mensagem) => mensagem.tipo === "midia" || mensagem.tipo === "sticker") || [];
  const participantes = conversaAtiva?.metadados?.participantes || [];

  return (
    <aside className="w-[340px] p-4 flex flex-col gap-4 shrink-0 bg-[var(--surface)] border-l border-[var(--border)] overflow-y-auto text-[var(--text)] select-none">
      <div className="h-10 flex items-center justify-between border-b border-[var(--border)]">
        <h4 className="text-xs font-bold uppercase tracking-wide">
          {modo === "perfil" && (conversaAtiva?.esGrupo ? "Dados do grupo" : "Dados do contato")}
          {modo === "config-propria" && "Minhas contas"}
          {modo === "nora" && "Modulo Nora IA"}
        </h4>
        <button onClick={onFechar} aria-label="Fechar painel" className="h-8 w-8 rounded-lg hover:bg-[var(--surface-hover)] flex items-center justify-center">
          <X size={15} />
        </button>
      </div>

      {modo === "perfil" && conversaAtiva && (
        <div className="space-y-4">
          <div className="flex flex-col items-center py-5 bg-[var(--background)] border border-[var(--border)] rounded-lg text-center">
            <ProfileAvatar conversa={conversaAtiva} />
            <h3 className="mt-3 font-bold text-sm px-2 truncate w-full">{conversaAtiva.contato}</h3>
            <span className={`mt-2 inline-flex h-6 items-center rounded-full px-2 text-[10px] font-extrabold uppercase ${conversaAtiva.canal === "telegram" ? "bg-sky-500/10 text-sky-600" : "bg-emerald-500/10 text-emerald-600"}`}>
              {conversaAtiva.canal}
            </span>
          </div>

          <div className="bg-[var(--background)] p-3 rounded-lg border border-[var(--border)] space-y-1">
            <p className="text-[10px] text-[var(--text-secondary)] uppercase font-bold">Recado / descricao</p>
            <p className="text-xs font-medium opacity-90">
              {conversaAtiva.metadados?.descricaoGrupo || conversaAtiva.metadados?.bioRecado || "Nenhuma informacao disponivel."}
            </p>
          </div>

          <div className="bg-[var(--background)] p-3 rounded-lg border border-[var(--border)] space-y-2">
            <p className="text-[10px] text-[var(--text-secondary)] uppercase font-bold flex items-center gap-1">
              <ImageIcon size={12} /> Arquivos e midias ({midiasGaleria.length})
            </p>
            {midiasGaleria.length > 0 ? (
              <div className="grid grid-cols-4 gap-1.5 max-h-32 overflow-y-auto">
                {midiasGaleria.map((midia) => (
                  <button key={midia.id} aria-label="Abrir midia em nova aba" className="h-12 bg-[var(--surface)] rounded-lg overflow-hidden border border-[var(--border)]" onClick={() => midia.arquivoUrl && window.open(midia.arquivoUrl, "_blank")}>
                    {midia.arquivoUrl ? (
                      <img src={midia.arquivoUrl} alt="Midia" className="w-full h-full object-cover" />
                    ) : (
                      <ImageIcon size={16} className="mx-auto opacity-50" />
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--text-secondary)]">Nenhuma midia compartilhada recentemente.</p>
            )}
          </div>

          {conversaAtiva.esGrupo && (
            <div className="bg-[var(--background)] p-3 rounded-lg border border-[var(--border)] space-y-2">
              <p className="text-[10px] text-[var(--text-secondary)] uppercase font-bold">Membros ({participantes.length})</p>
              <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                {participantes.length > 0 ? (
                  participantes.map((membro) => (
                    <div key={membro.id} className="flex items-center justify-between gap-2 text-xs font-medium py-1.5 border-b border-[var(--border)]/50 last:border-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <User size={13} className="text-[var(--text-secondary)] shrink-0" />
                        <span className="truncate">{membro.name || membro.phone}</span>
                      </div>
                      {membro.isAdmin && (
                        <span className="h-5 inline-flex items-center gap-1 shrink-0 rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-1.5 text-[9px] font-extrabold text-[var(--primary)]">
                          <ShieldAlert size={10} /> Adm
                        </span>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="text-[11px] text-[var(--text-secondary)]">Nenhum integrante mapeado.</p>
                )}
              </div>
            </div>
          )}

          <div className="bg-[var(--background)] p-3 rounded-lg border border-[var(--border)]">
            <p className="text-[10px] text-[var(--text-secondary)] uppercase font-bold">Identificador JID</p>
            <p className="font-mono text-[11px] break-all select-all opacity-80">{conversaAtiva.id}</p>
          </div>
        </div>
      )}

      {modo === "nora" && (
        <div className="bg-[var(--background)] border border-[var(--border)] p-4 rounded-lg space-y-3 text-xs font-semibold">
          <p className="text-[var(--primary)] font-bold text-center">Nora IA ativa</p>
          {conversaAtiva ? (
            <>
              <p className="text-[var(--text-secondary)] text-center">
                Analise contextual da conversa com {conversaAtiva.contato}.
              </p>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => onAskNora?.(`Resuma a conversa com ${conversaAtiva.contato} no Chat e destaque os pontos principais.`)}
                  className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
                >
                  <MessageSquareText size={14} className="shrink-0" /> Resumir esta conversa
                </button>
                <button
                  type="button"
                  onClick={() => onAskNora?.(`Sugira uma resposta adequada para a ultima mensagem de ${conversaAtiva.contato} no Chat.`)}
                  className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
                >
                  <Sparkles size={14} className="shrink-0" /> Sugerir resposta
                </button>
                <button
                  type="button"
                  onClick={() => onAskNora?.(`Analise o tom e o sentimento da conversa com ${conversaAtiva.contato} e diga se preciso de atencao especial.`)}
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
            <span className="text-emerald-600">Ativo</span>
          </div>
        </div>
      )}
    </aside>
  );
}
