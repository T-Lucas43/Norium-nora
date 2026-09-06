import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "../../utils/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  /** Botao quadrado apenas com icone. Exige aria-label para continuar acessivel. */
  iconOnly?: boolean;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-[var(--primary)] text-[var(--on-primary,#fff)] hover:brightness-110 border border-transparent",
  secondary:
    "bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface-hover)]",
  ghost: "bg-transparent text-[var(--text)] border border-transparent hover:bg-[var(--surface-hover)]",
  danger:
    "bg-[color-mix(in_srgb,var(--danger,#e11d48)_88%,black)] text-white border border-transparent hover:brightness-110",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-11 px-5 text-sm gap-2",
};

// Alvos de toque: quadrado nunca menor que 36px para nao ficar dificil de acertar.
const iconOnlySizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 w-9",
  md: "h-10 w-10",
  lg: "h-11 w-11",
};

const iconSize: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18 };

export default function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  iconOnly = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      data-variant={variant}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg font-bold transition disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        iconOnly ? iconOnlySizeClasses[size] : sizeClasses[size],
        className,
        variant === "danger" && "text-white",
      )}
      {...rest}
    >
      {loading ? <LoaderCircle size={iconSize[size]} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
