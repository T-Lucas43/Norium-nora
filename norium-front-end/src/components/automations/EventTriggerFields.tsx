import { useEffect, useState } from "react";
import { apiRequest } from "../../core/api/client";
import { whatsappApi } from "../chat/whatsappApi";
import type { AutomationNode } from "../../features/automations/types";

export const eventTriggers = [
  { value: "whatsapp.received", title: "Mensagem WhatsApp", description: "Ao receber uma mensagem no WhatsApp conectado.", icon: "message-square", category: "WhatsApp" },
  { value: "team.message", title: "Mensagem no Chat da Equipe", description: "Ao receber uma mensagem de outro membro.", icon: "users", category: "Chat da Equipe" },
  { value: "team.mentioned", title: "Menção no Chat da Equipe", description: "Quando alguém mencionar você no chat.", icon: "users", category: "Chat da Equipe" },
  { value: "gmail.received", title: "Novo e-mail", description: "Ao sincronizar um novo e-mail recebido no Gmail.", icon: "mail", category: "E-mail" },
  { value: "task.created", title: "Nova tarefa criada", description: "Quando uma tarefa for criada.", icon: "check-square", category: "Tarefas" },
  { value: "task.updated", title: "Tarefa atualizada", description: "Quando os dados ou o status da tarefa mudarem.", icon: "check-square", category: "Tarefas" },
  { value: "task.comment", title: "Comentário em tarefa", description: "Quando um comentário for adicionado.", icon: "check-square", category: "Tarefas" },
  { value: "finance.created", title: "Novo lançamento financeiro", description: "Ao registrar uma entrada ou saída.", icon: "credit-card", category: "Gastos" },
  { value: "finance.updated", title: "Lançamento financeiro atualizado", description: "Quando um lançamento for alterado.", icon: "credit-card", category: "Gastos" },
  { value: "calendar.created", title: "Compromisso criado", description: "Ao criar um compromisso pelo Norium.", icon: "calendar-days", category: "Agenda" },
  { value: "calendar.updated", title: "Compromisso atualizado", description: "Ao alterar um compromisso pelo Norium.", icon: "calendar-days", category: "Agenda" },
];
export function eventTypeForTitle(title: string) {
  return eventTriggers.find(item => item.title === title)?.value || "";
}
const field = "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm";
export default function EventTriggerFields({ node, onChange }: { node: AutomationNode; onChange: (config: Record<string, string>) => void }) {
  const config = node.config || {};
  const eventType = config.eventType || eventTypeForTitle(node.title);
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const optionKind = eventType.startsWith("whatsapp") ? "contacts" : eventType.startsWith("team") ? config.scope === "subteam" ? "subteams" : "members" : eventType.startsWith("task") ? "projects" : "";
  useEffect(() => {
    let alive = true;
    setOptions([]); setError("");
    if (!optionKind) { setLoading(false); return; }
    setLoading(true);
    const request = optionKind === "contacts" ? whatsappApi.contacts().then(items => items.map(item => ({ id: item.phone || item.id, name: item.name || item.phone })))
      : optionKind === "members" ? apiRequest<{ members: Array<{ id: string; nome?: string; name?: string }> }>("/api/team-chat/members").then(data => data.members.map(item => ({ id: item.id, name: item.nome || item.name || item.id })))
      : optionKind === "subteams" ? apiRequest<{ subteams: Array<{ id: string; name: string }> }>("/api/team-chat/subteams").then(data => data.subteams)
      : apiRequest<{ projects: Array<{ id: string; name: string; archived?: boolean }> }>("/api/tarefas/projetos").then(data => data.projects.filter(item => !item.archived));
    request.then(items => { if (alive) setOptions(items); }).catch(() => { if (alive) setError("Não foi possível carregar os filtros. Tente novamente."); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [optionKind, retry]);
  if (node.kind !== "trigger" || node.title === "Manual") return null;
  const update = (patch: Record<string, string>) => onChange({ ...config, eventType, ...patch });
  const filterKey = optionKind === "contacts" ? "sourceId" : optionKind === "members" ? "senderId" : optionKind === "subteams" ? "subteamId" : "projectId";
  return <fieldset className="space-y-3 rounded-xl border border-[var(--border)] p-3"><legend className="px-1 text-sm font-bold">Quando iniciar</legend>
    <label className="block space-y-1"><span className="text-xs">Evento do sistema</span><select className={field} value={eventType} onChange={event => onChange({ eventType: event.target.value, automatic: "false" })}><option value="">Selecione um evento</option>{eventTriggers.map(item => <option key={item.value} value={item.value}>{item.title}</option>)}</select></label>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={config.automatic === "true"} disabled={!eventType} onChange={event => update({ automatic: String(event.target.checked), enabledAt: event.target.checked ? new Date().toISOString() : "" })}/>Executar automaticamente ao receber este evento</label>
    <p className="text-xs text-[var(--text-secondary)]">Após salvar um fluxo ativo, novos eventos poderão executar suas ações reais. Eventos antigos e mensagens enviadas por automações são ignorados. Fluxos com aprovação obrigatória permanecem manuais.</p>
    {eventType.startsWith("team") && <label className="block space-y-1"><span className="text-xs">Origem no chat</span><select className={field} value={config.scope || ""} onChange={event => update({ scope: event.target.value, senderId: "", subteamId: "" })}><option value="">Qualquer conversa acessível</option><option value="team">Chat geral da equipe</option><option value="direct">Mensagem direta</option><option value="subteam">Chat de subequipe</option></select></label>}
    {optionKind && <label className="block space-y-1"><span className="text-xs">{optionKind === "contacts" ? "Contato de origem" : optionKind === "members" ? "Remetente" : optionKind === "subteams" ? "Subequipe de origem" : "Projeto de origem"}</span><select className={field} value={config[filterKey] || ""} disabled={loading} onChange={event => update({ [filterKey]: event.target.value })}><option value="">{loading ? "Carregando…" : "Todos"}</option>{options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {error && <p role="alert" className="text-xs text-[var(--danger)]">{error} <button type="button" className="underline" onClick={() => setRetry(value => value + 1)}>Recarregar</button></p>}
    <label className="block space-y-1"><span className="text-xs">Texto deve conter (opcional)</span><input className={field} value={config.contains || ""} onChange={event => update({ contains: event.target.value })} placeholder="Ex.: orçamento"/></label>
    <p className="text-xs text-[var(--text-secondary)]">O filtro procura este texto no título e na descrição do evento.</p>
  </fieldset>;
}
