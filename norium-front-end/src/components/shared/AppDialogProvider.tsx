import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Info, X } from "lucide-react";
import Button from "./Button";

type DialogKind = "alert" | "confirm" | "prompt";
type DialogTone = "default" | "danger" | "warning" | "success";

type DialogOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
  tone?: DialogTone;
};

type DialogRequest = DialogOptions & {
  id: string;
  kind: DialogKind;
  resolve: (value: boolean | string | null) => void;
};

const EVENT_NAME = "norium:app-dialog";

function requestDialog(kind: DialogKind, options: DialogOptions) {
  return new Promise<boolean | string | null>((resolve) => {
    window.dispatchEvent(new CustomEvent<DialogRequest>(EVENT_NAME, {
      detail: {
        ...options,
        id: crypto.randomUUID(),
        kind,
        resolve,
      },
    }));
  });
}

export async function showConfirm(options: DialogOptions | string) {
  const result = await requestDialog("confirm", typeof options === "string" ? { title: options } : options);
  return result === true;
}

export async function showPrompt(options: DialogOptions | string) {
  const result = await requestDialog("prompt", typeof options === "string" ? { title: options } : options);
  return typeof result === "string" ? result : null;
}

export async function showAlert(options: DialogOptions | string) {
  await requestDialog("alert", typeof options === "string" ? { title: options } : options);
}

export default function AppDialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [value, setValue] = useState("");
  const active = queue[0] || null;

  useEffect(() => {
    const receive = (event: Event) => {
      const request = (event as CustomEvent<DialogRequest>).detail;
      if (!request) return;
      setQueue((current) => [...current, request]);
    };
    window.addEventListener(EVENT_NAME, receive);
    return () => window.removeEventListener(EVENT_NAME, receive);
  }, []);

  useEffect(() => {
    setValue(active?.defaultValue || "");
  }, [active?.id, active?.defaultValue]);

  const finish = useCallback((result: boolean | string | null) => {
    if (!active) return;
    active.resolve(result);
    setQueue((current) => current.slice(1));
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(active.kind === "confirm" ? false : null);
      if (event.key === "Enter" && active.kind !== "alert" && !active.multiline) {
        if (active.kind === "prompt" && active.required && !value.trim()) return;
        finish(active.kind === "prompt" ? value.trim() : true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, finish, value]);

  return (
    <>
      {children}
      {active && (
        <div
          className="norium-modern-shell fixed inset-0 z-[300] grid place-items-center bg-black/70 p-4 text-[var(--text)] backdrop-blur-sm"
          role={active.kind === "alert" ? "alertdialog" : "dialog"}
          aria-modal="true"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && active.kind !== "alert") {
              finish(active.kind === "confirm" ? false : null);
            }
          }}
        >
          <section className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
            <header className="flex items-start gap-3 border-b border-[var(--border)] p-5">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${
                active.tone === "danger"
                  ? "bg-red-500/12 text-red-400"
                  : active.tone === "warning"
                    ? "bg-amber-500/12 text-amber-400"
                    : active.tone === "success"
                      ? "bg-emerald-500/12 text-emerald-400"
                    : "bg-blue-500/12 text-blue-400"
              }`}>
                {active.tone === "success"
                  ? <CheckCircle2 size={19} />
                  : active.tone === "danger" || active.tone === "warning"
                    ? <AlertTriangle size={19} />
                    : active.kind === "prompt"
                      ? <HelpCircle size={19} />
                      : <Info size={19} />}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-black text-[var(--text)]">{active.title}</h2>
                {active.description && <p className="mt-1.5 whitespace-pre-line text-sm font-semibold leading-6 text-[var(--text-secondary)]">{active.description}</p>}
              </div>
              {active.kind !== "alert" && (
                <button type="button" onClick={() => finish(active.kind === "confirm" ? false : null)} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-[var(--surface-hover)]" aria-label="Fechar">
                  <X size={16} />
                </button>
              )}
            </header>

            {active.kind === "prompt" && (
              <div className="p-5">
                {active.multiline ? (
                  <textarea
                    autoFocus
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder={active.placeholder}
                    className="commercial-field min-h-28 resize-y"
                  />
                ) : (
                  <input
                    autoFocus
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder={active.placeholder}
                    className="commercial-field"
                  />
                )}
              </div>
            )}

            <footer className="flex justify-end gap-2 border-t border-[var(--border)] p-4">
              {active.kind !== "alert" && (
                <Button variant="ghost" onClick={() => finish(active.kind === "confirm" ? false : null)}>
                  {active.cancelLabel || "Cancelar"}
                </Button>
              )}
              <Button
                variant={active.tone === "danger" ? "danger" : "primary"}
                className={active.tone === "danger" ? undefined : "bg-[var(--primary-deep)] text-white hover:bg-[var(--primary-strong)]"}
                disabled={active.kind === "prompt" && active.required && !value.trim()}
                onClick={() => finish(active.kind === "prompt" ? value.trim() : true)}
              >
                {active.confirmLabel || (active.kind === "alert" ? "Entendi" : "Confirmar")}
              </Button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
