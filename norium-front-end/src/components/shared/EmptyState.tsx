import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { cn } from "../../utils/cn";

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export default function EmptyState({ icon: Icon = Inbox, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-6 py-10 text-center",
        className,
      )}
    >
      <Icon size={28} className="text-[var(--text-secondary)]" />
      <p className="text-sm font-bold text-[var(--text)]">{title}</p>
      {description && <p className="max-w-sm text-xs font-semibold text-[var(--text-secondary)]">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
