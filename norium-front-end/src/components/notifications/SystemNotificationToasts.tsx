import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import type { SystemNotificationToast } from "../../types/omnichannel";
import NotificationVisual from "./NotificationVisual";
import { notificationVisual } from "./notificationVisualConfig";

type SystemNotificationToastsProps = {
  toasts: SystemNotificationToast[];
  onDismiss: (toastId: string) => void;
  onOpenNotifications: () => void;
};

export default function SystemNotificationToasts({
  toasts,
  onDismiss,
  onOpenNotifications,
}: SystemNotificationToastsProps) {
  return (
    <div className="pointer-events-none fixed right-5 top-24 z-[70] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-3">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const visual = notificationVisual(toast.notification);

          return (
            <motion.article
              key={toast.id}
              layout
              initial={{ opacity: 0, x: 32, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 32, scale: 0.96 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="pointer-events-auto relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
            >
              <button onClick={onOpenNotifications} className="flex w-full items-start gap-3 p-4 text-left">
                <NotificationVisual notification={toast.notification} size="compact" />
                <span className="min-w-0 flex-1">
                  <span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[var(--primary)]">
                    {visual.label}
                  </span>
                  <span className="block truncate text-sm font-black text-[var(--text)]">
                    {toast.notification.title}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-xs font-semibold leading-5 text-[var(--text-secondary)]">
                    {toast.notification.description}
                  </span>
                </span>
              </button>
              <button
                onClick={() => onDismiss(toast.id)}
                className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                title="Dispensar notificacao"
              >
                <X size={14} />
              </button>
            </motion.article>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
