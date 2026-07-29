import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "../../utils/cn";

type BannerTone = "error" | "success" | "warning" | "info";

type StatusBannerProps = {
  tone: BannerTone;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  className?: string;
};

const toneConfig: Record<BannerTone, { icon: typeof Info; colorVar: string; role: "alert" | "status" }> = {
  error: { icon: AlertTriangle, colorVar: "--danger", role: "alert" },
  warning: { icon: AlertTriangle, colorVar: "--warning", role: "status" },
  success: { icon: CheckCircle2, colorVar: "--success", role: "status" },
  info: { icon: Info, colorVar: "--primary", role: "status" },
};

export default function StatusBanner({ tone, children, action, onDismiss, className }: StatusBannerProps) {
  const { icon: Icon, colorVar, role } = toneConfig[tone];
  return (
    <div
      role={role}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm font-bold",
        className,
      )}
      style={{
        borderColor: `color-mix(in srgb, var(${colorVar}) 35%, var(--border))`,
        background: `color-mix(in srgb, var(${colorVar}) 10%, transparent)`,
        color: `var(${colorVar})`,
      }}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 font-semibold">{children}</div>
      {action}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Fechar aviso"
          className="shrink-0 rounded p-0.5 opacity-70 transition hover:opacity-100"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
