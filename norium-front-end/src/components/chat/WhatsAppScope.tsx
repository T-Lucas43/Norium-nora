import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiRequest } from "../../core/api/client";
import { createWhatsAppApi, whatsappApi } from "./whatsappApi";
import { requestScope } from "../../core/api/sessionScope";

export type AttendanceFilter = { responsavel: "all" | "me" | "none" | "nora"; estado: string;
  unread?: boolean; kind?: "all" | "individual" | "group"; fromDate?: string; toDate?: string; tagIds?: string[] };
type Scope = { inboxId?: string; api: typeof whatsappApi; prefix: string; filter?: AttendanceFilter;
  setFilter?: (value: AttendanceFilter) => void; counts?: Record<string, number>; hasListFilters?: boolean;
  viewId?: string; setViewId?: (id: string) => void };
const Context = createContext<Scope>({ api: whatsappApi, prefix: "/api/chat" });
export const useWhatsAppScope = () => useContext(Context);

export function WhatsAppScopeProvider({ inboxId, filter, setFilter, onCounts, counts, children }: {
  inboxId?: string; filter: AttendanceFilter; setFilter: (value: AttendanceFilter) => void;
  onCounts: (value: Record<string, number>) => void; counts: Record<string, number>; children: ReactNode;
}) {
  const prefix = inboxId ? `/api/chat/caixas/${encodeURIComponent(inboxId)}` : "/api/chat";
  const [viewId, setViewId] = useState(""); const scope = requestScope();
  useEffect(() => setViewId(""), [inboxId, scope]);
  const encoded = JSON.stringify(filter);
  const hasListFilters = Boolean(filter.unread || filter.kind && filter.kind !== "all" || filter.fromDate || filter.toDate || filter.tagIds?.length);
  const api = useMemo(() => {
    if (!inboxId && !hasListFilters) return whatsappApi;
    const request: typeof apiRequest = async <T,>(path: string, options?: Parameters<typeof apiRequest>[1]) => {
      const parsed = new URL(path, "https://norium.invalid");
      const suffix = parsed.pathname.slice("/api/chat".length);
      // Explicit allowlist: an unsupported team action cannot fall back to the
      // signed-in member's personal number, contacts, approvals or Nora context.
      if (inboxId && (!path.startsWith("/api/chat/") || !/^\/(status-canais|conversas(?:\/[^/]+(?:\/mensagens)?|\/[^/]+\/detalhes)?|contatos-disponiveis|sincronizacao|grupos(?:\/[^/]+)?|enviar|enviar-arquivo|reagir|apagar-mensagem|editar-mensagem|favoritar|modificar|encaminhar)$/.test(suffix)))
        throw new Error("Esta ação deve ser aberta em Meu WhatsApp. A caixa da equipe continua selecionada.");
      if (suffix === "/conversas") {
        parsed.searchParams.delete("since"); parsed.searchParams.set("paged", "true");
        parsed.searchParams.set("filtros", encoded);
      }
      const result = await apiRequest<T>(`${inboxId ? prefix + suffix : parsed.pathname}${parsed.search}`, options);
      if (suffix === "/conversas" && result && typeof result === "object" && "counts" in result)
        onCounts((result as { counts: Record<string, number> }).counts);
      return result;
    };
    return createWhatsAppApi(request);
  }, [inboxId, prefix, hasListFilters, encoded, onCounts]);
  return <Context.Provider value={{ inboxId, api, prefix, filter, setFilter, counts, hasListFilters, viewId, setViewId }}>{children}</Context.Provider>;
}
