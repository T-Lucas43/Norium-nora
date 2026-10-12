import { useEffect, useState } from "react";
import { Mail, RefreshCw } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import {useAdminSearch,matchesAdminSearch} from "./layout/AdminSearch";

type Delivery = { available?: boolean; error?: string; counts: Record<string, number>; recent: Array<{ kind: string; state: string; attempts: number; error: string | null; created: number }>; welcome: { title: string; description: string } };
type Configuration = { sender: string; enabled: boolean; passwordConfigured: boolean; credentialStatus?: "ok" | "missing" | "invalid"; publicUrl: string; ready: boolean; delivery?: Delivery };
const states: Record<string, string> = { pending: "Na fila", sending: "Enviando", sent: "Aceitos pelo servidor de e-mail", failed: "Falharam", skipped: "Ignorados", expired: "Expirados" };

export default function SystemEmailSettings({ token }: { token: string }) {
  const globalSearch=useAdminSearch();
  const [tab, setTab] = useState("envios");
  const [deliveryState, setDeliveryState] = useState("");
  const [config, setConfig] = useState<Configuration | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<Configuration>("/api/auth/admin/system-email", { token, signal: controller.signal }).then((value) => setConfig({ ...value, publicUrl: value.publicUrl || window.location.origin })).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Não foi possível carregar."); });
    return () => controller.abort();
  }, [token]);
  async function action(kind: "save" | "test" | "welcome" | "refresh") {
    if (!config) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (kind === "save") {
        await apiRequest("/api/auth/admin/system-email", { token, method: "PUT", body: JSON.stringify({ password, enabled: config.enabled, publicUrl: config.publicUrl }) });
        setPassword(""); setMessage("Configuração salva. Use o teste para verificar a autenticação SMTP.");
      } else if (kind !== "refresh") {
        const result = await apiRequest<{ message: string; queued?: number; alreadyQueued?: number; skipped?: number }>(`/api/auth/admin/system-email/${kind}`, { token, method: "POST" });
        setMessage(kind === "welcome" ? `${result.queued} e-mail(s) na fila; ${result.alreadyQueued} já incluído(s); ${result.skipped} conta(s) inativa(s) ou com notificações desativadas. Acompanhe a entrega abaixo.` : result.message);
      }
      setConfig(await apiRequest<Configuration>("/api/auth/admin/system-email", { token }));
    } catch (err) { setError(err instanceof Error ? err.message : "Não foi possível concluir."); }
    finally { setBusy(false); }
  }
  const field = "mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm outline-none focus:border-[var(--primary)]";
  return <section className="nxa-email-settings">
    <nav className="nxa-form-tabs" aria-label="E-mails do sistema">{[['envios','Envios'],['modelos','Modelos'],['remetente','Remetente']].map(([id,label])=><button type="button" key={id} aria-pressed={tab===id} className={tab===id?'is-active':''} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    {!config&&!error&&<p role="status">Carregando configuração de e-mails…</p>}
    {config?.delivery?.error&&<p role="alert" className="nxa-message is-warning">{config.delivery.error}</p>}
    {config?.credentialStatus==='invalid'&&<p role="alert" className="nxa-message is-error">A senha SMTP salva foi criptografada com outra chave e não pode ser usada neste ambiente. Digite novamente a senha da caixa <strong>suporte@norium-ai.com</strong> e salve para liberar a fila.</p>}
    {config&&<>
      {tab==='remetente'&&<div className="nxa-card"><div className="nxa-card-heading"><Mail size={16}/><h2>Remetente e configuração</h2></div><div className="nxa-card-body"><p className="font-medium break-all">{config.sender}</p><p className="mt-1 text-sm text-[var(--text-secondary)]">Hostinger · smtp.hostinger.com · TLS, porta 465</p>
        <form onSubmit={event=>{event.preventDefault();void action('save');}} className="mt-5 space-y-4"><div className="grid gap-4 md:grid-cols-2"><label className="text-sm font-medium">Endereço público do Norium<input type="url" required value={config.publicUrl} onChange={event=>setConfig({...config,publicUrl:event.target.value})} className={field} placeholder="https://seu-norium.com"/></label><label className="text-sm font-medium">Senha da caixa de suporte<input type="password" autoComplete="new-password" maxLength={300} value={password} onChange={event=>setPassword(event.target.value)} className={field} placeholder={config.passwordConfigured?'Já configurada; preencha apenas para trocar':'Senha criada na Hostinger'}/></label></div><p className="text-xs text-[var(--text-secondary)]">A senha fica criptografada no servidor e não é exibida novamente.</p><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={config.enabled} onChange={event=>setConfig({...config,enabled:event.target.checked})}/>Ativar envios de e-mail</label><div className="flex flex-wrap gap-3"><button disabled={busy} className="nx-btn is-primary">Salvar configuração</button><button type="button" disabled={busy||!config.ready} onClick={()=>void action('test')} className="nx-btn">Enviar teste para minha conta</button></div></form></div></div>}
      {tab==='modelos'&&config.delivery&&<div className="nxa-card"><div className="nxa-card-heading"><h2>{config.delivery.welcome.title}</h2></div><div className="nxa-card-body"><p className="text-sm leading-7 text-[var(--text-secondary)]">{config.delivery.welcome.description}</p><p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">Envio individual para as contas ativas cadastradas que recebem notificações. Cada endereço entra uma única vez nesta campanha.</p><button type="button" disabled={busy||!config.ready} onClick={()=>void action('welcome')} className="nx-btn is-primary mt-4">Enviar boas-vindas aos cadastrados</button></div></div>}
      {tab==='envios'&&config.delivery&&<><div className="nxa-delivery-metrics">{Object.entries(states).map(([state,label])=><article className="nxa-metric" key={state}><span className="nxa-metric-label">{label}</span><strong>{config.delivery?.counts[state]||0}</strong></article>)}</div><section className="nxa-card"><div className="nxa-card-heading"><h2>Acompanhamento dos envios</h2><select aria-label="Filtrar estado dos envios" value={deliveryState} onChange={event=>setDeliveryState(event.target.value)} className="nx-input ml-auto"><option value="">Todos os estados</option>{Object.entries(states).map(([state,label])=><option key={state} value={state}>{label}</option>)}</select><button type="button" aria-label="Atualizar status dos envios" disabled={busy} onClick={()=>void action('refresh')} className="nxa-icon-button"><RefreshCw size={16}/></button></div><div className="nxa-table-scroll"><table className="nxa-table" aria-label="Acompanhamento dos envios"><thead><tr><th>Data</th><th>Tipo</th><th>Estado</th><th>Tentativas</th><th>Diagnóstico</th></tr></thead><tbody>{config.delivery.recent.filter(item=>(!deliveryState||item.state===deliveryState)&&matchesAdminSearch(globalSearch,item.kind,item.state,item.error)).map((item,index)=><tr key={`${item.created}:${index}`}><td>{new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(new Date(item.created*1000))}</td><td>{item.kind}</td><td><span className={`nx-badge ${item.state==='sent'?'is-green':item.state==='failed'?'is-red':'is-amber'}`}>{states[item.state]||item.state}</span></td><td>{item.attempts}</td><td>{item.error||'Sem erro registrado'}</td></tr>)}</tbody></table></div>{!config.delivery.recent.filter(item=>(!deliveryState||item.state===deliveryState)&&matchesAdminSearch(globalSearch,item.kind,item.state,item.error)).length&&<p className="nxa-card-body text-sm text-[var(--text-secondary)]">Nenhum envio neste filtro.</p>}</section>
        {config.delivery.recent.some(item=>item.error)&&<p className="nxa-message is-warning">{config.delivery.recent.some(item=>item.error==='authentication')?'A Hostinger recusou a autenticação. Confira a senha da caixa de suporte.':'Há envios com falha. A fila repete tentativas temporárias automaticamente; confira a configuração SMTP.'}</p>}<p className="mt-3 text-xs text-[var(--text-secondary)]">Aceito pelo servidor significa que o SMTP recebeu a mensagem. A entrega na caixa de entrada pode depender do provedor do destinatário.</p></>}
      {tab!=='remetente'&&!config.delivery&&<p className="nxa-message">Acompanhamento dos envios não disponível neste ambiente. A configuração do remetente continua acessível.</p>}
    </>}
    {error&&<p role="alert" className="nxa-message is-error">{error}</p>}{message&&<p role="status" className="nxa-message is-success">{message}</p>}
  </section>;
}
