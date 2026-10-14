import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, Bot, CalendarClock, Gauge, RefreshCw, UsersRound } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import Button from "../shared/Button";
import "./nora-usage.css";

export interface NoraUsagePerson {
  id: string;
  name: string;
  totalTokens: number;
  requests: number;
  pendingRequests: number;
  unpricedRequests: number;
  estimatedRequests: number;
  remainingTokens: number | null;
  remainingCalls?: number | null;
  limits: { monthlyTokenLimit: number | null; monthlyBudgetUsd: number | null; callsLimit?: number | null };
  cycle: { startAt: string; endAt: string; nextResetAt: string | null; status: string; active: boolean };
  alerts?: number[];
}

export interface NoraUsageOverview {
  updatedAt: string;
  trackingStartedAt: string;
  plan: { code: string; name: string; tokenAllowance: number | null; noraCallAllowance?: number | null;
    remainingTokens?: number | null; remainingCalls?: number | null; currentCycle?: { totalTokens: number; requests: number } };
  personal: NoraUsagePerson;
  canViewPeople: boolean;
  people?: NoraUsagePerson[];
}

const number = (value: number) => new Intl.NumberFormat("pt-BR").format(value);
function date(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Não informada";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(value));
}
function percentage(used: number, limit: number | null | undefined) {
  return limit == null ? null : limit === 0 ? 100 : Math.min(100, Math.max(0, Math.floor(used / limit * 100)));
}

export default function NoraUsageSettings({ userId, onOpenAdmin }: { userId: string; onOpenAdmin?: () => void }) {
  const [data, setData] = useState<NoraUsageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const cancelPending = useCallback(() => { requestId.current++; controller.current?.abort(); }, []);

  const refresh = useCallback(async () => {
    const generation = ++requestId.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true); setError("");
    try {
      const result = await apiRequest<NoraUsageOverview>("/api/auth/nora-usage", { signal: request.signal });
      if (generation !== requestId.current) return;
      // O servidor determina a pessoa e o escopo. Nunca aceita consumo de outra sessão.
      if (result.personal.id !== userId) throw new Error("Sua sessão mudou. Atualize a página para consultar o consumo.");
      setData(result);
    } catch (cause) {
      if (generation === requestId.current && !request.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Não foi possível consultar o consumo da Nora.");
      }
    } finally {
      if (generation === requestId.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    setData(null);
    void refresh();
    return cancelPending;
  }, [refresh, cancelPending]);

  const person = data?.personal.id === userId ? data.personal : undefined;
  const tokensPercent = person ? percentage(person.totalTokens, person.limits.monthlyTokenLimit) : null;
  const callsPercent = person ? percentage(person.requests, person.limits.callsLimit) : null;
  const personalHighWater = Math.max(tokensPercent ?? 0, callsPercent ?? 0, ...(person?.alerts || []));
  const sharedTokensUsed = data?.plan.tokenAllowance != null && data.plan.remainingTokens != null
    ? Math.max(0, data.plan.tokenAllowance - data.plan.remainingTokens) : data?.plan.currentCycle?.totalTokens;
  const sharedCallsUsed = data?.plan.noraCallAllowance != null && data.plan.remainingCalls != null
    ? Math.max(0, data.plan.noraCallAllowance - data.plan.remainingCalls) : data?.plan.currentCycle?.requests;
  const sharedHighWater = Math.max(percentage(sharedTokensUsed ?? 0, data?.plan.tokenAllowance) ?? 0, percentage(sharedCallsUsed ?? 0, data?.plan.noraCallAllowance) ?? 0);
  const sharedExhausted = data?.plan.remainingTokens === 0 || data?.plan.remainingCalls === 0;
  const highWater = Math.max(personalHighWater, sharedHighWater, sharedExhausted ? 100 : 0);
  const sharedWarning = sharedExhausted || sharedHighWater >= 80 && sharedHighWater > personalHighWater;
  const threshold = highWater >= 95 ? "95%" : "80%";
  const warningTitle = sharedWarning
    ? highWater >= 100 ? "A franquia compartilhada do plano foi esgotada." : `A franquia compartilhada chegou a ${threshold} do limite.`
    : highWater >= 100 ? "Você atingiu o limite deste ciclo." : `Seu consumo chegou a ${threshold} do limite.`;

  return <div className="nora-usage">
    <div className="nora-usage-toolbar">
      <p>O consumo reúne as solicitações de IA registradas para sua conta no ciclo atual.</p>
      <Button size="sm" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} aria-hidden="true" /> {loading ? "Atualizando…" : "Atualizar consumo"}</Button>
    </div>
    {error && <div role="alert" className="nora-usage-alert is-error">{error}{data && <span>Os números abaixo são da última consulta concluída.</span>}</div>}
    {loading && !data && <p role="status" className="nora-usage-empty">Consultando seu consumo…</p>}
    {!loading && !data && !error && <p className="nora-usage-empty">O consumo estará disponível após a primeira solicitação de IA.</p>}
    {data && person && <>
      {highWater >= 80 && <div role="status" className={`nora-usage-alert ${highWater >= 95 ? "is-critical" : "is-warning"}`}><AlertTriangle size={18} aria-hidden="true" /><div><strong>{warningTitle}</strong><p>{highWater >= 100 ? "Novas solicitações dependem da renovação do ciclo ou de um ajuste autorizado dos limites." : "Acompanhe o saldo para planejar suas próximas solicitações."}</p></div></div>}
      <section className="nora-usage-metrics" aria-label="Seu consumo no ciclo atual">
        <UsageMetric icon={<Gauge size={19} />} title="Tokens utilizados" used={person.totalTokens} limit={person.limits.monthlyTokenLimit} remaining={person.remainingTokens} />
        <UsageMetric icon={<Bot size={19} />} title="Chamadas de IA" used={person.requests} limit={person.limits.callsLimit} remaining={person.remainingCalls} />
        <article className="nx-card nora-usage-metric"><span className="nora-usage-label"><CalendarClock size={19} aria-hidden="true" /> Próxima renovação</span><strong>{person.cycle.nextResetAt ? date(person.cycle.nextResetAt) : "Sem renovação automática"}</strong><p>Ciclo de {date(person.cycle.startAt)} a {date(person.cycle.endAt)} · horário de Brasília.</p><span className={`nora-usage-tag ${person.cycle.active ? "" : "is-warning"}`}>{person.cycle.active ? "Ciclo ativo" : "Ciclo indisponível"}</span></article>
      </section>
      <section className="nx-card nora-usage-plan" aria-label="Franquia do plano">
        <div><h3>Plano {data.plan.name}</h3><p>Franquia compartilhada: {data.plan.tokenAllowance == null ? "sem limite de tokens" : `${number(data.plan.tokenAllowance)} tokens`}{data.plan.noraCallAllowance != null && ` e ${number(data.plan.noraCallAllowance)} chamadas`}. O saldo disponível para você considera também o limite por pessoa e as reservas em andamento.</p>{(data.plan.remainingTokens !== undefined || data.plan.remainingCalls !== undefined) && <dl className="nora-usage-plan-balance">{data.plan.remainingTokens !== undefined && <div><dt>Saldo do plano em tokens</dt><dd>{data.plan.remainingTokens == null ? "Sem limite" : number(data.plan.remainingTokens)}</dd></div>}{data.plan.remainingCalls !== undefined && <div><dt>Saldo do plano em chamadas</dt><dd>{data.plan.remainingCalls == null ? "Sem limite" : number(data.plan.remainingCalls)}</dd></div>}</dl>}</div>
        {onOpenAdmin && <Button size="sm" onClick={onOpenAdmin}>Gerenciar limites no Admin <ArrowUpRight size={14} aria-hidden="true" /></Button>}
      </section>
      {person.pendingRequests > 0 && <p className="nora-usage-note">{number(person.pendingRequests)} solicitação(ões) em andamento. O saldo pode incluir reservas para essas chamadas.</p>}
      {(person.unpricedRequests > 0 || person.estimatedRequests > 0) && <p className="nora-usage-note">{person.unpricedRequests > 0 && `${number(person.unpricedRequests)} chamada(s) com custo ainda sem tarifa. `}{person.estimatedRequests > 0 && `${number(person.estimatedRequests)} chamada(s) com medição estimada.`} Os tokens e chamadas continuam aparecendo no consumo.</p>}
      {data.canViewPeople && <section className="nx-card nora-usage-people" aria-label="Consumo por pessoa">
        <header><div><h3><UsersRound size={18} aria-hidden="true" /> Consumo por pessoa</h3><p>Pessoas que você pode consultar, com o ciclo e os limites de cada conta.</p></div></header>
        {data.people?.length ? <div className="nora-usage-table-wrap"><table><caption className="nora-usage-sr">Consumo e saldo por pessoa no ciclo atual de cada conta</caption><thead><tr><th scope="col">Pessoa</th><th scope="col">Tokens</th><th scope="col">Chamadas</th><th scope="col">Saldo de tokens</th><th scope="col">Renovação</th></tr></thead><tbody>{data.people.map(item => <tr key={item.id}><th scope="row">{item.name}{item.id === userId && <small>Você</small>}</th><td>{number(item.totalTokens)}<small>{item.limits.monthlyTokenLimit == null ? "Sem limite" : `de ${number(item.limits.monthlyTokenLimit)}`}</small></td><td>{number(item.requests)}<small>{item.limits.callsLimit == null ? "Sem limite" : `de ${number(item.limits.callsLimit)}`}</small></td><td>{item.remainingTokens == null ? "Sem limite" : number(item.remainingTokens)}</td><td>{item.cycle.nextResetAt ? date(item.cycle.nextResetAt) : "Sem renovação"}</td></tr>)}</tbody></table></div> : <p className="nora-usage-empty">Nenhuma pessoa disponível para consulta.</p>}
      </section>}
      <footer className="nora-usage-note">Última consulta: {date(data.updatedAt)}. Contabilização central desde {date(data.trackingStartedAt)}. Tokens em cache e de raciocínio já fazem parte dos totais e não são somados novamente. Custos são consultados no painel administrativo.</footer>
    </>}
  </div>;
}

function UsageMetric({ icon, title, used, limit, remaining }: { icon: ReactNode; title: string; used: number; limit?: number | null; remaining?: number | null }) {
  const percent = percentage(used, limit);
  return <article className="nx-card nora-usage-metric"><span className="nora-usage-label">{icon} {title}</span><strong>{number(used)}</strong><p>{limit == null ? "Sem limite definido" : limit === 0 ? "Novas solicitações bloqueadas" : `de ${number(limit)} no ciclo atual`}</p>{percent != null && <div className={`nora-usage-progress ${percent >= 95 ? "is-critical" : percent >= 80 ? "is-warning" : ""}`} role="progressbar" aria-label={title} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>}<span className="nora-usage-balance">{remaining == null ? "" : `${number(remaining)} disponíveis`}</span></article>;
}
