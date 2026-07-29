import { LoaderCircle } from "lucide-react";
import { cn } from "../../utils/cn";

type LoadingStateProps = {
  label?: string;
  className?: string;
  compact?: boolean;
};

export default function LoadingState({ label = "Carregando...", className, compact = false }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center gap-2 text-[var(--text-secondary)]",
        compact ? "py-4 text-xs" : "py-10 text-sm",
        className,
      )}
    >
      <LoaderCircle size={compact ? 14 : 18} className="animate-spin text-[var(--primary)]" />
      <span className="font-semibold">{label}</span>
    </div>
  );
}
