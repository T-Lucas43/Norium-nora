import { useCallback, useEffect, useState } from "react";
import { workspaceScope } from "../../core/api/sessionScope";

function read(key: string) {
  try { return localStorage.getItem(key) === "open"; } catch { return false; }
}

export function useRememberedPanel(userId: string) {
  let workspace = "primary";
  try { workspace = workspaceScope(); } catch { /* Storage can be unavailable. */ }
  // Stable non-secret identity; session tokens must never become storage keys.
  const key = `norium.whatsapp.client-panel:${JSON.stringify([userId, workspace])}`;
  const [state, setState] = useState(() => ({ key, open: read(key) }));
  const open = state.key === key ? state.open : read(key);
  const setOpen = useCallback((value: boolean) => {
    setState({ key, open: value });
    try { localStorage.setItem(key, value ? "open" : "closed"); } catch { /* Private browsing may deny storage. */ }
  }, [key]);
  useEffect(() => { if (state.key !== key) setState({ key, open: read(key) }); }, [key, state.key]);
  return [open, setOpen] as const;
}
