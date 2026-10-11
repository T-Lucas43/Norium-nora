import { useEffect, useState, type CSSProperties } from "react";

export function nameInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] || "N"}${parts[1]?.[0] || ""}`.toUpperCase();
}

/**
 * Foto circular com recorte; quando não há foto ou ela não carrega, mostra as iniciais.
 * O texto alternativo fica vazio (o nome já aparece ao lado); use `label` quando a foto estiver sozinha.
 */
export default function AvatarImage({ src, name, size = 32, className = "", style, label }: {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  const showImage = Boolean(src && src.trim()) && !failed;
  return (
    <span
      className={`nxi-avatar ${className}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)), ...style }}
    >
      {showImage
        ? <img src={src!} alt="" draggable={false} onError={() => setFailed(true)} />
        : nameInitials(name)}
    </span>
  );
}
