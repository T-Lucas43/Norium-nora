import type { LucideIcon } from "lucide-react";
import { Folder, Mail, MailCheck, PenLine, Plus, Settings, Star, Tags, X } from "lucide-react";
import BrandLogo from "../layout/BrandLogo";
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
    <aside className="mail-sidebar flex h-full w-[260px] shrink-0 flex-col" aria-label="Pastas do e-mail">
      <div className="nx-mail-side-head">
        <BrandLogo className="h-9 w-[96px]" />
        <span className="nx-badge is-blue">
          <Mail size={12} />
          E-mail
        </span>
        <button type="button" className="mail-sidebar-mobile-close" onClick={onClose} aria-label="Fechar menu do e-mail">
          <X size={16} />
        </button>
      </div>

      <div className="nx-mail-side-compose">
        <button type="button" onClick={onCompose} className="nx-btn is-primary">
          <PenLine size={16} />
          Nova mensagem
        </button>
      </div>

      <nav className="nx-mail-side-nav">
        <div>
          {systemFolders.map((item) => {
            const Icon = item.icon;
            const count = item.countLabel ? labelById.get(item.countLabel)?.messagesUnread : undefined;
            return (
              <button
                type="button"
                key={item.key}
                onClick={() => onSelectMailbox(item.key)}
                {...hoverProps(item.key)}
                className={cn("nx-mail-nav", isActive(item.key) && "mail-active")}
              >
                <Icon size={16} />
                <span>{item.label}</span>
                {Boolean(count) && <span className="nx-mail-cnt">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="nx-mail-grp">
          <span>
            <Folder size={13} />
            Pastas
          </span>
          <button
            type="button"
            onClick={onCreateLabel}
            className="nx-mail-iconbtn"
            title="Criar marcador"
            aria-label="Criar marcador"
          >
            <Plus size={15} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => onSelectMailbox("starred")}
          {...hoverProps("starred")}
          className={cn("nx-mail-nav", isActive("starred") && "mail-active")}
        >
          <Star size={16} />
          <span>Com estrela</span>
        </button>
        <button
          type="button"
          onClick={() => onSelectMailbox("important")}
          {...hoverProps("important")}
          className={cn("nx-mail-nav", isActive("important") && "mail-active")}
        >
          <MailCheck size={16} />
          <span>Importante</span>
        </button>

        {userLabels.length > 0 && (
          <>
            <div className="nx-mail-grp">
              <span>
                <Tags size={13} />
                Marcadores
              </span>
            </div>
            {userLabels.map((label) => (
              <button
                type="button"
                key={label.id}
                onClick={() => onSelectMailbox(`label:${label.id}`)}
                {...hoverProps(`label:${label.id}`)}
                className={cn("nx-mail-nav", activeFolder === `label:${label.id}` && "mail-active")}
              >
                <Tags size={16} />
                <span>{label.name}</span>
                {Boolean(label.messagesUnread) && <span className="nx-mail-cnt">{label.messagesUnread}</span>}
              </button>
            ))}
          </>
        )}
      </nav>

      <div className="nx-mail-side-foot">
        <div>
          <span className="nx-faint">Norium Mail</span>
          <button type="button" onClick={onRefreshLabels} className="nx-mail-link">
            Atualizar
          </button>
        </div>
        <button type="button" onClick={onOpenSettings} className="nx-btn is-sm">
          <Settings size={14} />
          Configurações rápidas
        </button>
      </div>
    </aside>
  );
}
