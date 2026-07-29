import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "../../utils/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-[var(--primary)] text-[var(--on-primary,#fff)] hover:brightness-110 border border-transparent",
  secondary:
    "bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface-hover)]",
  ghost: "bg-transparent text-[var(--text)] border border-transparent hover:bg-[var(--surface-hover)]",
  danger:
    "bg-[color-mix(in_srgb,var(--danger)_88%,black)] text-white border border-transparent hover:brightness-110",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

export default function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center rounded-lg font-bold transition disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle size={size === "sm" ? 14 : 16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
