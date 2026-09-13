import { useEffect, useState } from "react";
import { apiRequest } from "../../core/api/client";
import { whatsappApi } from "../chat/whatsappApi";
import type { AutomationNode } from "../../features/automations/types";

export function messageChannel(node: AutomationNode): "whatsapp" | "team" | null {
  if (node.kind === "trigger") return null;
  if (node.config?.actionType === "send_whatsapp" || /enviar whatsapp/i.test(node.title)) return "whatsapp";
  if (node.config?.actionType === "send_team" || /notificar equipe|enviar mensagem no chat|avisar equipe/i.test(node.title)) return "team";
  return null;
}
export function messageIssues(nodes: AutomationNode[]) {
  return nodes.flatMap(node => {
    const channel = messageChannel(node), config = node.config || {};
    if (!channel) return [];
    const errors: string[] = [];
    if (!config.message?.trim()) errors.push(`${node.title}: escreva a mensagem.`);
    if (channel === "whatsapp" && !config.recipient?.trim()) errors.push(`${node.title}: selecione um contato ou digite o número.`);
    if (channel === "whatsapp" && config.recipientMode === "number" && !/^\d{10,15}$/.test((config.recipient || "").replace(/[+\s()-]/g, ""))) errors.push(`${node.title}: informe DDI, DDD e número válido.`);
    if (channel === "team" && config.scope !== "team" && !config.recipientId) errors.push(`${node.title}: selecione o destino no chat.`);
    return errors;
  });
}
const field = "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none";
export default function MessageActionFields({ node, onChange }: { node: AutomationNode; onChange: (config: Record<string, string>) => void }) {
  const channel = messageChannel(node);
  const config = node.config || {};
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const mode = channel === "whatsapp" ? config.recipientMode || "contact" : config.scope || "team";
  useEffect(() => {
    let alive = true;
    setOptions([]); setError("");
    if (!channel || mode === "number" || mode === "team") { setLoading(false); return; }
    setLoading(true);
    const request = channel === "whatsapp"
      ? whatsappApi.contacts().then(items => items.map(item => ({ id: item.phone || item.id, name: `${item.name || item.savedName || item.phone} · ${item.phone}` })))
      : mode === "direct"
        ? apiRequest<{ members: Array<{ id: string; nome?: string; name?: string }> }>("/api/team-chat/members").then(data => data.members.map(item => ({ id: item.id, name: item.nome || item.name || item.id })))
        : apiRequest<{ subteams: Array<{ id: string; name: string }> }>("/api/team-chat/subteams").then(data => data.subteams);
    request.then(items => { if (alive) setOptions(items); }).catch(() => { if (alive) setError("Não foi possível carregar os destinos. Confira a conexão e suas permissões."); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [channel, mode, retry]);
  if (!channel) return null;
  const update = (patch: Record<string, string>) => onChange({ ...config, actionType: channel === "whatsapp" ? "send_whatsapp" : "send_team", scope: config.scope || "team", ...patch });
  return <fieldset className="space-y-3 rounded-xl border border-[var(--border)] p-3"><legend className="px-1 text-sm font-bold">{channel === "whatsapp" ? "Mensagem no WhatsApp" : "Mensagem no chat da equipe"}</legend>
    <label className="block space-y-1"><span className="text-xs">Tipo de destinatário</span><select className={field} value={mode} onChange={event => update({ [channel === "whatsapp" ? "recipientMode" : "scope"]: event.target.value, recipient: "", recipientId: "" })}>{channel === "whatsapp" ? <><option value="contact">Selecionar contato</option><option value="number">Digitar número</option></> : <><option value="team">Toda a equipe</option><option value="direct">Um membro</option><option value="subteam">Chat de uma subequipe</option></>}</select></label>
    {mode === "number" ? <label className="block space-y-1"><span className="text-xs">Número com DDI e DDD</span><input className={field} type="tel" value={config.recipient || ""} placeholder="+55 11 99999-9999" onChange={event => update({ recipient: event.target.value })}/></label> : mode !== "team" && <label className="block space-y-1"><span className="text-xs">{channel === "whatsapp" ? "Contato" : "Destino no chat"}</span><select className={field} disabled={loading} value={channel === "whatsapp" ? config.recipient || "" : config.recipientId || ""} onChange={event => update({ [channel === "whatsapp" ? "recipient" : "recipientId"]: event.target.value })}><option value="">{loading ? "Carregando…" : "Selecione um destino"}</option>{options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {error && <div role="alert" className="text-xs text-[var(--danger)]">{error} <button type="button" className="underline" onClick={() => setRetry(value => value + 1)}>Tentar novamente</button></div>}
    {!loading && !error && mode !== "team" && mode !== "number" && !options.length && <p className="text-xs text-[var(--text-secondary)]">Nenhum destino disponível para sua conta.</p>}
    <label className="block space-y-1"><span className="text-xs">Mensagem a enviar</span><textarea className={field} rows={4} maxLength={2000} value={config.message || ""} placeholder="Escreva a mensagem que será enviada…" onChange={event => update({ message: event.target.value })}/></label>
    <p className="text-xs text-[var(--text-secondary)]">A simulação não envia mensagens. A execução real usa a conexão e as permissões da sua conta.</p>
  </fieldset>;
}
