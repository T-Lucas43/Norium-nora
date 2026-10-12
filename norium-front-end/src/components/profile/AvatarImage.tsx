import { useEffect, useState, type CSSProperties } from "react";
import { usePersonPhoto } from "./ProfilePeople";

export function nameInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] || "N"}${parts[1]?.[0] || ""}`.toUpperCase();
}

/**
 * Foto circular com recorte; quando não há foto ou ela não carrega, mostra as iniciais.
 * O texto alternativo fica vazio (o nome já aparece ao lado); use `label` quando a foto estiver sozinha.
 */
export default function AvatarImage({ src, userId, name, size = 32, className = "", style, label }: {
  src?: string | null;
  userId?: string;
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  const personPhoto = usePersonPhoto(userId, name);
  const source = src || personPhoto;
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [source]);
  const showImage = Boolean(source && source.trim()) && !failed;
  return (
    <span
      className={`nxi-avatar ${className}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, flexShrink: 0, display: "inline-grid", placeItems: "center", overflow: "hidden", borderRadius: "50%", fontSize: Math.max(11, Math.round(size * 0.36)), ...style }}
    >
      {showImage
        ? <img src={source!} alt="" decoding="async" draggable={false} style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", imageRendering: "auto", filter: "none", transform: "none" }} onError={() => setFailed(true)} />
        : nameInitials(name)}
    </span>
  );
}
