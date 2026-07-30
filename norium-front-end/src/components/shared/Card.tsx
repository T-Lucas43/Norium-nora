import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../utils/cn";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
};

export default function Card({ title, subtitle, actions, className, children, ...rest }: CardProps) {
  return (
    <section
      className={cn(
        "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4",
        className,
      )}
      {...rest}
    >
      {(title || actions) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-bold text-[var(--text)]">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs font-semibold text-[var(--text-secondary)]">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
