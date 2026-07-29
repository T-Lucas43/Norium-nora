import type { SystemNotification } from "../../types/omnichannel";
import { notificationVisual } from "./notificationVisualConfig";

export default function NotificationVisual({
  notification,
  size = "normal",
}: {
  notification: SystemNotification;
  size?: "compact" | "normal";
}) {
  const config = notificationVisual(notification);
  const Icon = config.icon;

  return (
    <span
      className={`relative grid shrink-0 place-items-center overflow-hidden border bg-gradient-to-br shadow-lg shadow-black/15 ${config.className} ${
        size === "compact" ? "h-10 w-10 rounded-lg" : "h-12 w-12 rounded-xl"
      }`}
      title={config.label}
      aria-label={config.label}
    >
      <span className="absolute inset-x-1 top-0 h-px bg-white/45" />
      <Icon size={size === "compact" ? 19 : 22} strokeWidth={1.8} />
      <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-current opacity-80" />
    </span>
  );
}
