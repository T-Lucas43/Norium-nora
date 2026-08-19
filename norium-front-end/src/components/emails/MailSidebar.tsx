import type { LucideIcon } from "lucide-react";
import { Folder, Mail, MailCheck, PenLine, Plus, Settings, Star, Tags, X } from "lucide-react";
import BrandLogo from "../layout/BrandLogo";
import Button from "../shared/Button";
import { cn } from "../../utils/cn";
import type { GmailLabel, MailQuickFilter } from "../../features/mail/types";

export type SystemFolder = { key: string; label: string; icon: LucideIcon; countLabel?: string };

type MailSidebarProps = {
  systemFolders: SystemFolder[];
  userLabels: GmailLabel[];
  labelById: Map<string, GmailLabel>;
  activeFolder: string;
  activeFilter: MailQuickFilter;
  onSelectMailbox: (folder: string) => void;
  /** Aquece a caixa no hover/foco para a troca parecer instantanea. */
  onPrefetchMailbox: (folder: string) => void;
  onCompose: () => void;
  onCreateLabel: () => void;
  onRefreshLabels: () => void;
  onOpenSettings: () => void;
  onClose?: () => void;
};

/** Coluna de pastas, marcadores e atalhos do Norium Mail. */
export default function MailSidebar({
  systemFolders,
  userLabels,
  labelById,
  activeFolder,
  activeFilter,
  onSelectMailbox,
  onPrefetchMailbox,
  onCompose,
  onCreateLabel,
  onRefreshLabels,
  onOpenSettings,
  onClose = () => undefined,
}: MailSidebarProps) {
  /** Pastas virtuais so ficam ativas quando nenhum filtro rapido esta aplicado. */
  const isActive = (folder: string) => activeFolder === folder && activeFilter === "all";
  const hoverProps = (folder: string) => ({
    onMouseEnter: () => onPrefetchMailbox(folder),
    onFocus: () => onPrefetchMailbox(folder),
  });

  return (
    <aside className="mail-sidebar flex h-full w-[260px] shrink-0 flex-col border-r border-white/10 bg-[#18181B]">
      <div className="mail-sidebar-header flex h-[76px] items-center justify-between border-b border-white/10 px-5">
        <BrandLogo className="h-12 w-[118px]" />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-200/20 bg-cyan-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-cyan-50 shadow-[0_12px_30px_rgba(8,47,73,0.2)]">
          <Mail size={12} />
          Mail
        </span>
        <button type="button" className="mail-sidebar-mobile-close" onClick={onClose} aria-label="Fechar menu do e-mail">
          <X size={19} />
        </button>
      </div>

      <div className="p-4">
        <button
          onClick={onCompose}
          className="mail-primary flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#0EA5E9] text-sm font-bold text-white transition hover:bg-[#0284C7]"
        >
          <PenLine size={17} />
          Nova mensagem
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        <div className="space-y-1">
          {systemFolders.map((item) => {
            const Icon = item.icon;
            const count = item.countLabel ? labelById.get(item.countLabel)?.messagesUnread : undefined;
            return (
              <button
                key={item.key}
                onClick={() => onSelectMailbox(item.key)}
                {...hoverProps(item.key)}
                className={cn(
                  "mail-hover flex h-10 w-full items-center justify-between rounded-lg px-3 text-sm font-semibold text-white/82 transition",
                  isActive(item.key) ? "mail-active bg-white/10 text-white" : "hover:bg-white/7 hover:text-white",
                )}
              >
                <span className="flex items-center gap-3">
                  <Icon size={18} className="text-white/70" />
                  {item.label}
                </span>
                {Boolean(count) && (
                  <span className="rounded-full bg-white/18 px-2 py-0.5 text-xs text-white/80">{count}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between px-3 pb-2 text-xs font-bold text-white/55">
            <span className="flex items-center gap-2">
              <Folder size={14} />
              Pastas
            </span>
            <Button
              variant="ghost"
              iconOnly
              onClick={onCreateLabel}
              className="mail-hover h-7 w-7 hover:bg-white/7 hover:text-white"
              title="Criar marcador"
              aria-label="Criar marcador"
            >
              <Plus size={15} />
            </Button>
          </div>
          <button
            onClick={() => onSelectMailbox("starred")}
            {...hoverProps("starred")}
            className={cn(
              "mail-hover flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-semibold text-white/82 hover:bg-white/7",
              isActive("starred") && "mail-active bg-white/10 text-white",
            )}
          >
            <Star size={18} className="text-white/70" />
            Com estrela
          </button>
          <button
            onClick={() => onSelectMailbox("important")}
            {...hoverProps("important")}
            className={cn(
              "mail-hover flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-semibold text-white/82 hover:bg-white/7",
              isActive("important") && "mail-active bg-white/10 text-white",
            )}
          >
            <MailCheck size={18} className="text-white/70" />
            Importante
          </button>
        </div>

        {userLabels.length > 0 && (
          <div className="mt-5">
            <div className="flex items-center justify-between px-3 pb-2 text-xs font-bold text-white/55">
              <span className="flex items-center gap-2">
                <Tags size={14} />
                Marcadores
              </span>
            </div>
            <div className="space-y-1">
              {userLabels.map((label) => (
                <button
                  key={label.id}
                  onClick={() => onSelectMailbox(`label:${label.id}`)}
                  {...hoverProps(`label:${label.id}`)}
                  className={cn(
                    "flex h-9 w-full items-center justify-between rounded-lg px-3 text-sm font-semibold text-white/75 hover:bg-white/7",
                    activeFolder === `label:${label.id}` && "bg-white/10 text-white",
                  )}
                >
                  <span className="min-w-0 truncate">{label.name}</span>
                  {Boolean(label.messagesUnread) && (
                    <span className="rounded-full bg-[#0EA5E9]/45 px-2 py-0.5 text-xs">{label.messagesUnread}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className="border-t border-white/10 p-4">
        <div className="mb-2 h-1 rounded-full bg-white/15">
          <div className="h-full w-[21%] rounded-full bg-[#38BDF8]" />
        </div>
        <div className="flex items-center justify-between text-xs font-bold">
          <span className="text-white">Norium Mail</span>
          <button onClick={onRefreshLabels} className="text-white/70 hover:text-white">
            Atualizar
          </button>
        </div>
        <button
          onClick={onOpenSettings}
          className="mail-hover mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-white/12 text-xs font-bold text-white/80 hover:bg-white/7"
        >
          <Settings size={14} />
          Configuracoes rapidas
        </button>
      </div>
    </aside>
  );
}
