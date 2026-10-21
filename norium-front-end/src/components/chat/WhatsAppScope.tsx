import { createContext, useContext, useMemo, type ReactNode } from "react";
import { apiRequest } from "../../core/api/client";
import { createWhatsAppApi, whatsappApi } from "./whatsappApi";

export type AttendanceFilter = { responsavel: "all" | "me" | "none" | "nora"; estado: string };
type Scope = { inboxId?: string; api: typeof whatsappApi; prefix: string; filter?: AttendanceFilter;
  setFilter?: (value: AttendanceFilter) => void; counts?: Record<string, number> };
const Context = createContext<Scope>({ api: whatsappApi, prefix: "/api/chat" });
export const useWhatsAppScope = () => useContext(Context);

export function WhatsAppScopeProvider({ inboxId, filter, setFilter, onCounts, counts, children }: {
  inboxId?: string; filter: AttendanceFilter; setFilter: (value: AttendanceFilter) => void;
  onCounts: (value: Record<string, number>) => void; counts: Record<string, number>; children: ReactNode;
}) {
  const prefix = inboxId ? `/api/chat/caixas/${encodeURIComponent(inboxId)}` : "/api/chat";
  const api = useMemo(() => {
    if (!inboxId) return whatsappApi;
    const request: typeof apiRequest = async <T,>(path: string, options?: Parameters<typeof apiRequest>[1]) => {
      const parsed = new URL(path, "https://norium.invalid");
      const suffix = parsed.pathname.slice("/api/chat".length);
      // Explicit allowlist: an unsupported team action cannot fall back to the
      // signed-in member's personal number, contacts, approvals or Nora context.
      if (!path.startsWith("/api/chat/") || !/^\/(status-canais|conversas(?:\/[^/]+(?:\/mensagens)?|\/[^/]+\/detalhes)?|contatos-disponiveis|sincronizacao|grupos(?:\/[^/]+)?|enviar|enviar-arquivo|reagir|apagar-mensagem|editar-mensagem|favoritar|modificar|encaminhar)$/.test(suffix))
        throw new Error("Esta ação deve ser aberta em Meu WhatsApp. A caixa da equipe continua selecionada.");
      if (suffix === "/conversas") {
        parsed.searchParams.set("responsavel", filter.responsavel);
        if (filter.estado) parsed.searchParams.set("estado", filter.estado);
      }
      const result = await apiRequest<T>(`${prefix}${suffix}${parsed.search}`, options);
      if (suffix === "/conversas" && result && typeof result === "object" && "counts" in result)
        onCounts((result as { counts: Record<string, number> }).counts);
      return result;
    };
    return createWhatsAppApi(request);
  }, [inboxId, prefix, filter.responsavel, filter.estado, onCounts]);
  return <Context.Provider value={{ inboxId, api, prefix, filter, setFilter, counts }}>{children}</Context.Provider>;
}
