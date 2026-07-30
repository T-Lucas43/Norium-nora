import {
  ArrowUpRight,
  CheckCircle2,
  PlugZap,
} from "lucide-react";

interface IntegrationCardProps {
  title: string;
  subtitle: string;
  value: string;
  icon: React.ReactNode;
  connected: boolean;
  color: string;
}

export default function IntegrationCard({
  title,
  subtitle,
  value,
  icon,
  connected,
  color,
}: IntegrationCardProps) {
  return (
    <div
      className="
        group
        flex
        flex-col
        justify-between
        rounded-2xl
        border border-[var(--border)]
        bg-[var(--surface)]
        p-4
        transition-all
        duration-300
        hover:-translate-y-1
        hover:border-blue-500/30
        hover:shadow-xl
        min-h-[180px]
      "
    >
      {/* Top */}
      <div className="flex items-start justify-between">

        <div
          className={`flex h-10 w-10 items-center justify-center rounded-xl ${color}`}
        >
          {icon}
        </div>

        {connected ? (
          <div className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-500">
            <CheckCircle2 size={12} />
            Conectado
          </div>
        ) : (
          <div className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-500">
            <PlugZap size={12} />
            Disponível
          </div>
        )}
      </div>

      {/* Middle */}
      <div>
        <h2 className="mt-3 text-lg font-semibold leading-tight">
          {title}
        </h2>

        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          {subtitle}
        </p>

        <h3 className="mt-3 text-2xl font-bold">
          {value}
        </h3>
      </div>

      {/* Button */}
      <button
        className="
          mt-4
          flex
          items-center
          justify-center
          gap-2
          rounded-lg
          bg-[var(--background)]
          px-3
          py-2
          text-sm
          font-medium
          transition-all
          group-hover:bg-blue-600
          group-hover:text-white
        "
      >
        Abrir
        <ArrowUpRight size={16} />
      </button>
    </div>
  );
}
