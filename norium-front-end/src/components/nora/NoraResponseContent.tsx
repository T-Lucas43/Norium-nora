import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, CalendarDays, ChevronLeft, ChevronRight, Clock3, FolderKanban, MapPin, Play, UserRound, Zap } from "lucide-react";
import { displayDate, displayLabel, eventOnDay, localDateKey, normalizeLabel, validDateKey, type NoraCalendarEvent, type NoraMetric, type NoraResponseView } from "./responseView";
import "./noraResponses.css";
import { navigateNoriumTab, tabPath } from "../../app/navigation/tabs";

const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const titleOf = (event: NoraCalendarEvent) => event.titulo || event.title || "Compromisso sem título";

function ModuleLink({ tab, children }: { tab: string; children: ReactNode }) {
  return <a href={tabPath(tab)} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateNoriumTab(tab);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }}>{children}</a>;
}

export function NoraMarkdown({ text }: { text: string }) {
  return <div className="nora-message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    table: ({ children }) => <div className="nora-table-scroll" role="region" aria-label="Tabela da resposta" tabIndex={0}><table>{children}</table></div>,
  }}>{text}</ReactMarkdown></div>;
}

function Metrics({ items }: { items: NoraMetric[] }) {
  if (!items.length) return null;
  return <dl className="nora-response-metrics">{items.map((metric) => <div key={metric.label}>
    <dt>{metric.label}</dt><dd className={metric.value < 0 ? "is-negative" : undefined}>{metric.money ? money(metric.value) : metric.value.toLocaleString("pt-BR")}</dd>
  </div>)}</dl>;
}

function Intro({ text }: { text: string }) {
  const first = text.split(/\r?\n/)[0]?.trim();
  return first ? <div className="nora-response-intro"><NoraMarkdown text={first} /></div> : null;
}

export function NoraTaskCards({ view, text }: { view: Extract<NoraResponseView, { kind: "tasks" }>; text: string }) {
  const [limit, setLimit] = useState(6);
  return <section className="nora-response-view nora-tasks-response" aria-label="Tarefas da consulta">
    <Intro text={text} />
    <Metrics items={view.metrics || []} />
    {view.project && <article className="nora-task-card nora-project-card"><span className="nora-response-eyebrow"><FolderKanban size={15} /> Projeto</span>
      <h3>{view.project.name}</h3>{view.project.description && <p>{view.project.description}</p>}
      <div className="nora-task-details">{view.project.category && <span>{view.project.category}</span>}<span>Prazo: {displayDate(view.project.dueDate)}</span></div>
    </article>}
    {view.items.length > 0 && <>
      <div className="nora-response-section-heading"><h3>Tarefas</h3><span>{view.total.toLocaleString("pt-BR")} {view.total === 1 ? "tarefa" : "tarefas"}</span></div>
      <div className="nora-task-grid">{view.items.slice(0, limit).map((task, index) => <article className="nora-task-card" key={`${task.id || task.title}-${index}`}>
        <div className="nora-task-card-top">{task.status ? <span className="nora-response-status" data-status={normalizeLabel(task.status)}>{displayLabel(task.status)}</span> : <span className="nora-response-eyebrow">Tarefa</span>}
          {task.priority && <span className="nora-priority" data-priority={normalizeLabel(task.priority)}>{displayLabel(task.priority)}</span>}
        </div>
        <h4>{task.title}</h4>
        {task.description && <p className="nora-task-description">{task.description}</p>}
        <div className="nora-task-details">
          {task.projectName && <span><FolderKanban size={13} />{task.projectName}</span>}
          {task.assigneeName && <span><UserRound size={13} />{task.assigneeName}</span>}
          <span><CalendarDays size={13} />{task.dueDate ? displayDate(task.dueDate) : "Sem vencimento"}</span>
        </div>
      </article>)}</div>
      <div className="nora-response-footer"><span>Exibindo {Math.min(limit, view.items.length)} de {view.total}</span>
        {limit < view.items.length && <button type="button" onClick={() => setLimit((current) => current + 6)}>Mostrar mais tarefas</button>}
        {limit >= view.items.length && view.total > view.items.length && <ModuleLink tab="Tarefas">Ver todas em Tarefas</ModuleLink>}
      </div>
    </>}
    {!view.items.length && !view.project && !view.metrics?.length && <p className="nora-response-empty">Nenhuma tarefa encontrada neste filtro.</p>}
  </section>;
}

export function NoraAutomationCards({ view, text }: { view: Extract<NoraResponseView, { kind: "automations" }>; text: string }) {
  const [limit, setLimit] = useState(6);
  const metrics: NoraMetric[] = [
    { label: "Automações", value: view.total },
    { label: "Ativas", value: view.active },
    ...(view.runsToday === undefined ? [] : [{ label: "Execuções hoje", value: view.runsToday }]),
    ...(view.savedMinutes === undefined ? [] : [{ label: "Minutos poupados", value: view.savedMinutes }]),
  ];
  return <section className="nora-response-view nora-automations-response" aria-label="Automações da consulta">
    <Intro text={text} /><Metrics items={metrics} />
    <div className="nora-response-section-heading"><h3><Zap size={16} /> Fluxos configurados</h3><ModuleLink tab="Automações">Abrir Automações</ModuleLink></div>
    {view.items.length ? <div className="nora-automation-grid">{view.items.slice(0, limit).map((item, index) => <article className="nora-automation-card" key={`${item.id || item.name}-${index}`}>
      <div className="nora-automation-card-top"><span className="nora-automation-icon">{item.aiEnabled ? <Bot size={16} /> : <Zap size={16} />}</span><span className="nora-response-status" data-status={item.active ? "ativo" : "inativo"}>{item.active ? "Ativa" : "Pausada"}</span></div>
      <div><span className="nora-response-eyebrow">{item.category || "Automação"}</span><h4>{item.name}</h4>{item.description && <p>{item.description}</p>}</div>
      <div className="nora-automation-trigger"><Play size={12} /><span><small>Gatilho</small>{item.trigger || "Manual"}</span></div>
      {item.actions.length > 0 && <div className="nora-automation-actions" aria-label="Ações do fluxo">{item.actions.map((action) => <span key={action}>{action}</span>)}</div>}
      <div className="nora-automation-meta"><span>{item.executions === undefined ? "Execuções não informadas" : `${item.executions} execuções`}</span><span>{item.savedMinutes === undefined ? "Economia não informada" : `${item.savedMinutes} min poupados`}</span></div>
    </article>)}</div> : <p className="nora-response-empty">Nenhuma automação configurada.</p>}
    <div className="nora-response-footer"><span>Exibindo {Math.min(limit, view.items.length)} de {view.total}</span>{limit < view.items.length && <button type="button" onClick={() => setLimit((current) => current + 6)}>Mostrar mais automações</button>}{limit >= view.items.length && view.total > view.items.length && <ModuleLink tab="Automações">Ver todas em Automações</ModuleLink>}</div>
  </section>;
}

function FinanceTable({ group }: { group: Extract<NoraResponseView, { kind: "finance" }>["groups"][number] }) {
  const [limit, setLimit] = useState(8);
  if (!group.rows.length) return <p className="nora-response-empty">Nenhum registro nesta categoria.</p>;
  return <>
    <p className="nora-table-hint">Deslize a tabela para ver todas as colunas.</p>
    <div className="nora-table-scroll" role="region" aria-label={`Tabela de ${group.label.toLowerCase()}`} tabIndex={0}>
      <table className="nora-financial-table"><caption className="sr-only">{group.label}. Valores em reais.</caption>
        <thead><tr><th scope="col">Descrição</th><th scope="col">Vencimento</th><th scope="col">Situação</th><th scope="col" className="nora-money-cell">Valor</th></tr></thead>
        <tbody>{group.rows.slice(0, limit).map((row, index) => <tr key={`${row.id || row.title}-${index}`}>
          <td><strong>{row.title}</strong><small>{[row.type && displayLabel(row.type), row.category, row.frequency && displayLabel(row.frequency)].filter(Boolean).join(" · ")}</small></td>
          <td>{displayDate(row.dueDate)}</td><td>{row.status ? <span className="nora-response-status" data-status={normalizeLabel(row.status)}>{displayLabel(row.status)}</span> : "Não informado"}</td>
          <td className="nora-money-cell">{row.amount === undefined ? "Não informado" : money(row.amount)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="nora-response-footer"><span>Exibindo {Math.min(limit, group.rows.length)} de {group.total} · BRL</span>
      {limit < group.rows.length && <button type="button" onClick={() => setLimit((current) => current + 8)}>Mostrar mais registros</button>}
      {limit >= group.rows.length && group.total > group.rows.length && <ModuleLink tab="Financeiro">Ver todos no Financeiro</ModuleLink>}
    </div>
  </>;
}

export function NoraFinanceTable({ view, text }: { view: Extract<NoraResponseView, { kind: "finance" }>; text: string }) {
  const [selected, setSelected] = useState(view.groups.find((group) => group.rows.length)?.label || view.groups[0]?.label);
  const group = view.groups.find((item) => item.label === selected) || view.groups[0];
  return <section className="nora-response-view nora-finance-response" aria-label="Consulta financeira">
    <Intro text={text.split(" | ")[0]} /><Metrics items={view.metrics.filter((metric) => metric.money)} />
    {view.metrics.some((metric) => !metric.money) && <dl className="nora-response-indicators">{view.metrics.filter((metric) => !metric.money).map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value.toLocaleString("pt-BR")}</dd></div>)}</dl>}
    {view.groups.length > 0 && <div className="nora-financial-records">
      <div className="nora-financial-tabs" aria-label="Categorias financeiras">{view.groups.map((item) => <button key={item.label} type="button" aria-pressed={item === group} onClick={() => setSelected(item.label)}>
        {item.label}{" "}<span>{item.total}</span>
      </button>)}</div>
      {group && <FinanceTable key={group.label} group={group} />}
    </div>}
  </section>;
}

function timeLabel(event: NoraCalendarEvent) {
  const time = event.inicio?.match(/T(\d{2}:\d{2})/)?.[1];
  if (!validDateKey(event.inicio)) return "Horário não informado";
  if (!time) return "Dia inteiro";
  const end = event.fim?.match(/T(\d{2}:\d{2})/)?.[1];
  return end ? `${time} – ${end}` : time;
}

export function NoraCalendar({ view, text, onAgendaPrompt }: { view: Extract<NoraResponseView, { kind: "agenda" }>; text: string; onAgendaPrompt?: (prompt: string) => void }) {
  const today = localDateKey(new Date());
  const firstDate = validDateKey(view.date) || view.events.map((event) => validDateKey(event.inicio)).filter((date): date is string => Boolean(date)).sort()[0] || today;
  const [selected, setSelected] = useState(firstDate);
  const [month, setMonth] = useState(firstDate.slice(0, 7));
  const start = new Date(`${month}-01T12:00:00`);
  const offset = (start.getDay() + 6) % 7;
  const dayCount = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: Math.ceil((offset + dayCount) / 7) * 7 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), index - offset + 1, 12);
    const key = localDateKey(date);
    return { key, date, current: date.getMonth() === start.getMonth(), count: view.events.filter((event) => eventOnDay(event, key)).length };
  });
  const events = view.events.filter((event) => eventOnDay(event, selected)).sort((a, b) => (a.inicio || "").localeCompare(b.inicio || ""));
  const undated = view.events.filter((event) => !validDateKey(event.inicio));
  function changeMonth(delta: number) {
    const date = new Date(start.getFullYear(), start.getMonth() + delta, 1, 12);
    const key = localDateKey(date);
    setMonth(key.slice(0, 7)); setSelected(key);
  }
  const renderEvent = (event: NoraCalendarEvent, index: number) => <article className="nora-calendar-event" key={`${event.id || titleOf(event)}-${index}`}>
    <span className="nora-event-time"><Clock3 size={13} />{timeLabel(event)}</span>
    <h4>{titleOf(event)}</h4>
    {event.local && <p><MapPin size={13} />{event.local}</p>}
    {event.descricao && <p className="nora-event-description">{event.descricao}</p>}
    {onAgendaPrompt && event.id && <button type="button" className="nora-response-text-button" onClick={() => onAgendaPrompt(`editar evento ${titleOf(event)}${event.inicio ? ` em ${displayDate(event.inicio)}` : ""}`)}>Editar evento</button>}
  </article>;
  return <section className="nora-response-view nora-agenda-response" aria-label="Calendário da consulta">
    <Intro text={text} />
    <div className="nora-response-section-heading"><h3><CalendarDays size={16} />Agenda</h3><span>{view.events.length} {view.events.length === 1 ? "compromisso" : "compromissos"}</span></div>
    <div className="nora-calendar-layout"><div className="nora-calendar-month">
      <div className="nora-calendar-toolbar"><strong aria-live="polite">{start.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</strong>
        <div><button type="button" aria-label="Mês anterior" onClick={() => changeMonth(-1)}><ChevronLeft size={16} /></button>
          <button type="button" aria-label="Próximo mês" onClick={() => changeMonth(1)}><ChevronRight size={16} /></button></div>
      </div>
      <div className="nora-calendar-weekdays" aria-hidden="true">{["S", "T", "Q", "Q", "S", "S", "D"].map((day, index) => <span key={index}>{day}</span>)}</div>
      <div className="nora-calendar-days" role="group" aria-label="Dias do mês">{days.map(({ key, date, current, count }) => <button type="button" key={key}
        aria-label={`${date.toLocaleDateString("pt-BR", { dateStyle: "full" })}, ${count} ${count === 1 ? "compromisso" : "compromissos"}`}
        aria-pressed={selected === key} aria-current={key === today ? "date" : undefined} className={current ? undefined : "is-outside"}
        onClick={() => { setSelected(key); if (!current) setMonth(key.slice(0, 7)); }}>
        <span>{date.getDate()}</span>{count > 0 && <i aria-hidden="true" />}
      </button>)}</div>
      <div className="nora-calendar-legend"><span><i />Com compromisso</span><button type="button" onClick={() => { setMonth(today.slice(0, 7)); setSelected(today); }}>Hoje</button></div>
    </div><div className="nora-calendar-schedule"><h4>{new Date(`${selected}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}</h4>
      <div aria-live="polite">{events.length ? events.map(renderEvent) : <p className="nora-response-empty">Nenhum compromisso nesta data entre os resultados da consulta.</p>}</div>
    </div></div>
    {undated.length > 0 && <div className="nora-calendar-undated"><h4>Sem data definida</h4>{undated.map(renderEvent)}</div>}
    <p className="nora-response-note">O calendário mostra os compromissos retornados nesta conversa.</p>
  </section>;
}
