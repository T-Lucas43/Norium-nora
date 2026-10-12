import { useMemo } from "react";
import { DEFAULT_BOOKING_COPY, type BookingCopy } from "../../features/scheduling/pageCopy";
import type { SchedulingService } from "../../features/scheduling/api";
import PublicSchedulingPage, { type SchedulingPreview } from "./PublicSchedulingPage";

export type PreviewField = { id: string; label: string; type: string; required?: boolean; maxLength?: number };
export type PreviewIdentity = { primary: string; secondary: string; accent: string; background: string; text: string; mode: string; surface?: string; muted?: string; border?: string; fontFamily?: string; cardStyle?: string; layout?: string; showHeader?: string; showFooter?: string; darkBackground?: string; darkText?: string; darkSurface?: string; darkMuted?: string; darkBorder?: string };

export default function PagePreview({ onThemeChange, serviceName, service, professionals, teamMode, title, description, identity, logoSrc, fields, durations, copy = DEFAULT_BOOKING_COPY }: {
  onThemeChange?: (mode: "light" | "dark") => void;
  serviceName: string; service?: SchedulingService; professionals?: SchedulingPreview["professionals"]; teamMode?: boolean;
  title: string; description: string; identity: PreviewIdentity; logoSrc: string;
  fields: PreviewField[]; durations?: number[]; copy?: BookingCopy;
}) {
  const preview = useMemo<SchedulingPreview>(() => ({
    page: { id: "preview", public_id: "preview", service_id: service?.id || "preview", title: title || "Título da página", description, fields, theme: { ...identity, ...copy }, active: true },
    service: service || { id: "preview", name: serviceName, description: "", durations: durations?.length ? durations : [30], color: identity.primary, capacity: 1, buffer_before: 0, buffer_after: 0, slot_interval: 15, active: true, location_type: "online" },
    professionals, teamMode, logoSrc, onThemeChange: onThemeChange ? (dark) => onThemeChange(dark ? "dark" : "light") : undefined,
  }), [onThemeChange, title, description, fields, identity, copy, service, serviceName, durations, professionals, teamMode, logoSrc]);
  return <section role="region" aria-label="Prévia da página pública" className="booking-preview-panel">
    <header><strong>Prévia ao vivo · antes de publicar</strong><p>Mesmo layout da página pública. Horários ilustrativos; nenhuma reserva será criada.</p></header>
    <PublicSchedulingPage identifier="preview" preview={preview}/>
  </section>;
}
