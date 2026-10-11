import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, CalendarDays, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Globe2, MapPin, Moon, Sun, Video } from "lucide-react";
import BrandLogo from "../layout/BrandLogo";
import "./publicScheduling.css";
import { apiBaseUrl } from "../../core/api/config";
import { clearSlotsCache, schedulingApi, type BookingField, type SchedulingPage, type SchedulingService } from "../../features/scheduling/api";
import { formatCpf, formatPhone, validateSchedulingField } from "../../features/scheduling/fieldValidation";

type Slot = { startAt: string; endAt: string; remaining: number };

export function localDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function dateFromKey(value: string) { return new Date(`${value}T12:00:00`); }
function zonedDateKey(value: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function dateLabel(value: string) { return dateFromKey(value).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }); }
function safeColor(value: string | undefined, fallback: string) { return /^#[0-9a-f]{6}$/i.test(value || "") ? value! : fallback; }
function onColor(value: string) {
  const rgb = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? "#101828" : "#ffffff";
}

function newOperationKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `booking-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function inputType(fieldType: string) {
  if (fieldType === "date") return "date";
  if (fieldType === "email") return "email";
  if (fieldType === "phone") return "tel";
  if (fieldType === "number") return "number";
  return "text";
}

function formatFieldValue(fieldType: string, value: string) {
  if (fieldType === "cpf") return formatCpf(value);
  if (fieldType === "phone") return formatPhone(value);
  return value;
}

export default function PublicSchedulingPage({ identifier }: { identifier: string }) {
  const [page, setPage] = useState<SchedulingPage | null>(null);
  const [service, setService] = useState<SchedulingService | null>(null);
  const [services, setServices] = useState<SchedulingService[]>([]);
  const [professionals, setProfessionals] = useState<Array<{id:string;name:string;avatarUrl?:string;profession:string;position:string;color:string}>>([]);
  const [teamMode, setTeamMode] = useState(false);
  const [responsibleId, setResponsibleId] = useState("");
  const [duration, setDuration] = useState(30);
  const [day, setDay] = useState(() => { const value = new Date(); value.setDate(value.getDate() + 1); return localDateKey(value); });
  const [dark, setDark] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [slotTimezone, setSlotTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo");
  const [pageRetry, setPageRetry] = useState(0);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState<Record<string, string>>({ full_name: "", email: "", phone: "" });
  const [loading, setLoading] = useState(true);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [calendarVerified, setCalendarVerified] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [slotsError, setSlotsError] = useState("");
  const [success, setSuccess] = useState("");
  const [slotsRetry, setSlotsRetry] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const slotsRequestRef = useRef(0);
  const bookingOperationKeyRef = useRef(newOperationKey());
  const calendarRefreshAttemptRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setPage(null); setService(null); setSlot(null); setSuccess("");
    schedulingApi.publicPage(identifier).then((data) => {
      if (cancelled) return;
      setPage(data.page); setService(data.service); setServices(data.services || [data.service]); setProfessionals(data.professionals || []); setTeamMode(Boolean(data.teamMode)); setDuration(data.service.durations[0]);
      document.title = `${data.page.title} · Agendamento | Norium`;
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Não foi possível abrir este agendamento."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [identifier, pageRetry]);

  useEffect(() => {
    if (!service || (teamMode && !responsibleId)) return;
    const requestId = ++slotsRequestRef.current;
    const controller = new AbortController();
    let refreshTimer: number | null = null;
    const cacheKey = `${identifier}::${day}::${duration}::${responsibleId}::${service.id}`;
    setSlot(null); setSlotsError(""); setSlotsLoading(true);
    schedulingApi.slotsCached(identifier, day, duration, controller.signal, responsibleId, service.id).then((data) => {
      if (slotsRequestRef.current !== requestId) return;
      setSlots(data.slots); setCalendarVerified(data.calendarVerified !== false);
      if (data.timezone) setSlotTimezone(data.timezone);
      if (data.calendarVerified === false && calendarRefreshAttemptRef.current !== cacheKey) {
        calendarRefreshAttemptRef.current = cacheKey;
        refreshTimer = window.setTimeout(() => {
          clearSlotsCache(identifier);
          setSlotsRetry((value) => value + 1);
        }, 1200);
      }
    }).catch((reason) => {
      if (slotsRequestRef.current !== requestId || controller.signal.aborted) return;
      setSlotsError(reason instanceof Error ? reason.message : "Não foi possível carregar os horários.");
    }).finally(() => {
      if (slotsRequestRef.current === requestId) setSlotsLoading(false);
    });
    return () => { controller.abort(); if (refreshTimer !== null) window.clearTimeout(refreshTimer); };
  }, [identifier, day, duration, service, responsibleId, teamMode, slotsRetry]);

  const availableServices = useMemo(() => teamMode && responsibleId ? services.filter((item) => item.professionalIds?.includes(responsibleId)) : services, [responsibleId, services, teamMode]);

  function selectProfessional(userId: string) {
    setResponsibleId(userId); setSlot(null); setSlots([]);
    const first = services.find((item) => item.professionalIds?.includes(userId)) || null;
    setService(first); if (first) setDuration(first.durations[0]);
  }

  const theme = useMemo(() => {
    const primary = safeColor(page?.theme?.primary, "#2563eb");
    return {
      "--booking-primary": primary, "--booking-on-primary": onColor(primary),
      "--booking-bg": dark ? "#0d1421" : safeColor(page?.theme?.background, "#f4f7fc"),
      "--booking-text": dark ? "#edf2fa" : safeColor(page?.theme?.text, "#17243b"),
    } as CSSProperties;
  }, [page, dark]);

  const bookingFields = useMemo<BookingField[]>(() => {
    const configured = page?.fields || [];
    const configuredById = new Map(configured.map((field) => [field.id, field]));
    return [
      configuredById.get("full_name") || { id: "full_name", type: "full_name", label: "Nome completo", required: true, maxLength: 160 },
      configuredById.get("email") || { id: "email", type: "email", label: "E-mail", required: true, maxLength: 254 },
      configuredById.get("phone") || { id: "phone", type: "phone", label: "WhatsApp", required: false, maxLength: 32 },
      ...configured.filter((field) => !["full_name", "email", "phone"].includes(field.id)),
    ];
  }, [page]);

  function setFieldValue(field: BookingField, rawValue: string) {
    const value = formatFieldValue(field.type, rawValue);
    bookingOperationKeyRef.current = newOperationKey();
    setForm((current) => ({ ...current, [field.id]: value }));
    setFieldErrors((current) => ({
      ...current,
      [field.id]: validateSchedulingField(field.type, value, Boolean(field.required), field.maxLength || 500),
    }));
  }

  async function confirm() {
    if (!slot) return;
    const nextErrors = Object.fromEntries(
      bookingFields
        .map((field) => [field.id, validateSchedulingField(field.type, form[field.id] || "", Boolean(field.required), field.maxLength || 500)])
        .filter(([, message]) => Boolean(message)),
    );
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setError("Revise os campos destacados antes de confirmar.");
      return;
    }
    setSending(true); setError("");
    const responses = Object.fromEntries((page?.fields || []).filter((field) => !["full_name", "email", "phone"].includes(field.id)).map((field) => [field.id, form[field.id] || ""]));
    try {
      const result = await schedulingApi.book(identifier, {
        startAt: slot.startAt, duration, name: form.full_name.trim(), email: form.email.trim(), phone: form.phone || null,
        responsibleId: responsibleId || null, serviceId: service?.id || null,
        timezone: slotTimezone,
        responses, idempotencyKey: bookingOperationKeyRef.current, honeypot: "",
      });
      setSuccess(result.booking.public_id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível confirmar."); }
    finally { setSending(false); }
  }

  const clock = (value: string) => new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: slotTimezone });
  const selectedProfessional = professionals.find((item) => item.id === responsibleId);
  const selectionReady = !teamMode || Boolean(responsibleId && service);
  const today = localDateKey(new Date());
  const maximum = new Date(); maximum.setDate(maximum.getDate() + (service?.maximum_days || 365));
  const maxDay = localDateKey(maximum);
  const footer = <footer className="booking-footer"><span>Agendamento organizado com <strong>Norium</strong></span><span><Globe2 size={14} aria-hidden="true"/> Português · Brasil</span></footer>;
  const brand = <header className="booking-topbar"><BrandLogo className="h-9 w-[112px]"/><span className="booking-topbar-label"><CalendarDays size={15} aria-hidden="true"/> Agendamento online</span><button type="button" className="booking-icon-button" aria-label={dark ? "Usar tema claro" : "Usar tema escuro"} onClick={() => setDark((value) => !value)}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button></header>;
  const summary = slot && <div className="booking-summary"><CalendarDays size={21} aria-hidden="true"/><div><strong>{dateLabel(zonedDateKey(slot.startAt, slotTimezone))}</strong><span>{clock(slot.startAt)} – {clock(slot.endAt)} · {duration} min{selectedProfessional ? ` · ${selectedProfessional.name}` : ""}</span><span className="booking-muted">{slotTimezone.replace(/_/g, " ")}</span></div><Check size={18} aria-hidden="true"/></div>;

  return <main style={theme} className={`norium-booking${dark ? " booking-dark" : ""}`}>
    <div className="booking-shell">
      {brand}
      {loading ? <section className="booking-state" aria-label="Carregando agendamento"><div className="booking-state-icon"><CalendarDays size={28}/></div><h1>Preparando seu agendamento</h1><p>Estamos buscando os serviços e horários.</p><div className="booking-skeleton" aria-hidden="true"/></section>
        : !page ? <section className="booking-state" role="alert"><div className="booking-state-icon"><CalendarDays size={28}/></div><h1>Página indisponível</h1><p>{error || "Este link não está disponível. Confira o endereço com quem compartilhou o agendamento."}</p><button type="button" className="booking-primary-button" onClick={() => setPageRetry((value) => value + 1)}>Tentar novamente</button></section>
        : success ? <section className="booking-state booking-success"><div className="booking-success-icon"><CheckCircle2 size={38}/></div><p className="booking-eyebrow">Tudo pronto</p><h1>Agendamento confirmado</h1><p>Seu horário foi reservado. Confira os detalhes abaixo.</p><h2>{service?.name || page.title}</h2>{summary}<div className="booking-confirmation-id"><span>Identificador da reserva</span><strong>{success}</strong></div></section>
        : <>
          <div className="booking-intro"><p className="booking-eyebrow">Um tempo reservado para você</p><h2>Vamos encontrar seu melhor horário.</h2><p>Escolha a data, selecione um horário e confirme seus dados.</p></div>
          <div className="booking-card">
            <aside className="booking-service">
              {page.logo_url ? <img src={`${apiBaseUrl()}${page.logo_url}`} alt={page.title} className="booking-custom-logo"/> : <div className="booking-service-icon"><CalendarDays size={27} aria-hidden="true"/></div>}
              <p className="booking-eyebrow">Seu atendimento</p><h1>{page.title}</h1>
              {service?.name && service.name !== page.title && <p className="booking-service-name">{service.name}</p>}
              {(page.description || service?.description) && <p className="booking-description">{page.description || service?.description}</p>}
              <div className="booking-service-meta"><span><Clock3 size={17} aria-hidden="true"/>{duration} minutos</span>{service?.location_type === "online" && <span><Video size={17} aria-hidden="true"/> Atendimento online</span>}{service?.location && <span><MapPin size={17} aria-hidden="true"/>{service.location}</span>}</div>
              {teamMode && <div className="booking-service-options"><h2>Escolha o profissional</h2><div className="booking-professionals">{professionals.map((item) => <button key={item.id} type="button" aria-pressed={responsibleId === item.id} onClick={() => selectProfessional(item.id)} className={`booking-professional${responsibleId === item.id ? " is-selected" : ""}`}>{item.avatarUrl ? <img src={item.avatarUrl} alt=""/> : <span className="booking-avatar">{item.name.slice(0, 2).toUpperCase()}</span>}<span><strong>{item.name}</strong><small>{item.profession || item.position || "Profissional"}</small></span>{responsibleId === item.id && <Check size={17} aria-hidden="true"/>}</button>)}</div>
                <label className="booking-field">Escolha o serviço<select disabled={!responsibleId} value={service?.id || ""} onChange={(event) => { const next = availableServices.find((item) => item.id === event.target.value) || null; setService(next); if (next) setDuration(next.durations[0]); }}><option value="">Selecione</option>{availableServices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>}
              {service && service.durations.length > 1 && <div className="booking-service-options"><h2>Duração do atendimento</h2><div className="booking-duration">{service.durations.map((item) => <button type="button" key={item} aria-pressed={duration === item} className={duration === item ? "is-selected" : ""} onClick={() => setDuration(item)}>{item} min</button>)}</div></div>}
              {service?.instructions && <div className="booking-instructions"><h2>Antes do atendimento</h2><p>{service.instructions}</p></div>}
              <div className="booking-service-note"><span className="booking-note-line"/><p>Escolha com calma.<br/>Seu próximo encontro começa aqui.</p></div>
            </aside>
            <section className="booking-workspace" aria-label="Reserve seu horário">
              <ol className="booking-steps" aria-label="Etapas do agendamento"><li className={slot ? "is-complete" : "is-current"} aria-current={!slot ? "step" : undefined}><span>{slot ? <Check size={14}/> : "1"}</span>Data e horário</li><li className={slot ? "is-current" : ""} aria-current={slot ? "step" : undefined}><span>2</span>Seus dados</li><li><span>3</span>Confirmação</li></ol>
              <div className="booking-availability">
                <div className="booking-calendar-panel"><div className="booking-section-heading"><h2>Escolha a data</h2><label className="booking-date-input"><span className="sr-only">Escolha a data</span><input aria-label="Escolha a data" type="date" min={today} max={maxDay} value={day} disabled={!selectionReady || sending} onChange={(event) => { if (event.target.value) setDay(event.target.value); }}/></label></div><BookingCalendar day={day} min={today} max={maxDay} disabled={!selectionReady || sending} onChange={setDay}/><p className="booking-timezone"><Globe2 size={14} aria-hidden="true"/> Horários em {slotTimezone.replace(/_/g, " ")}</p></div>
                <div className="booking-time-panel"><h2>Horários disponíveis</h2><p className="booking-time-date">{dateLabel(day)}</p>
                  {!selectionReady ? <div className="booking-empty"><Clock3 size={23} aria-hidden="true"/><p>Escolha um profissional e um serviço para consultar os horários.</p></div>
                    : slotsLoading ? <div className="booking-times" aria-label="Carregando horários">{[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="booking-time-skeleton"/>)}</div>
                      : slotsError ? <div role="alert" className="booking-warning">{slotsError}<button type="button" className="booking-text-button" onClick={() => setSlotsRetry((value) => value + 1)}>Tentar novamente</button></div>
                        : slots.length ? <div className="booking-times">{slots.map((item) => <button type="button" key={item.startAt} disabled={sending} aria-pressed={slot?.startAt === item.startAt} className={`booking-time${slot?.startAt === item.startAt ? " is-selected" : ""}`} onClick={() => { bookingOperationKeyRef.current = newOperationKey(); setSlot(item); setFieldErrors({}); setError(""); }}><span>{clock(item.startAt)}{slot?.startAt === item.startAt && <Check size={14} aria-hidden="true"/>}</span><small>{item.remaining} vaga(s)</small></button>)}</div>
                          : <div className="booking-empty"><CalendarDays size={25} aria-hidden="true"/><p>Nenhum horário disponível nesta data.</p><span>Selecione outro dia no calendário.</span></div>}
                  {!calendarVerified && <p role="status" className="booking-warning">Calendário externo indisponível — os horários podem estar desatualizados. A reserva será validada na confirmação.</p>}
                </div>
              </div>
              {slot ? <form className="booking-form" onSubmit={(event) => { event.preventDefault(); if (!sending) void confirm(); }} noValidate>
                <div className="booking-form-heading"><div><p className="booking-eyebrow">Quase lá</p><h2>Como podemos chamar você?</h2><p>Preencha seus dados para confirmar o atendimento.</p></div></div>{summary}
                <fieldset disabled={sending}><legend className="sr-only">Dados do agendamento</legend><div className="booking-fields">{bookingFields.map((field) => <Input key={field.id} id={`booking-${field.id}`} label={field.label} required={field.required} type={inputType(field.type)} value={form[field.id] || ""} maxLength={field.maxLength || 500} error={fieldErrors[field.id]} onChange={(value) => setFieldValue(field, value)}/>)}</div></fieldset>
                {error && <p role="alert" className="booking-warning booking-error">{error}</p>}
                <button type="submit" disabled={sending || !form.full_name || !form.email} className="booking-primary-button booking-confirm-button">{sending ? "Confirmando..." : "Confirmar agendamento"}{!sending && <ArrowRight size={18} aria-hidden="true"/>}</button>
              </form> : <p className="booking-next-hint"><span>2</span>Depois de escolher um horário, você poderá preencher seus dados.</p>}
            </section>
          </div>
        </>}
      {footer}
    </div>
  </main>;
}

function BookingCalendar({ day, min, max, disabled, onChange }: { day: string; min: string; max: string; disabled: boolean; onChange: (value: string) => void }) {
  const [month, setMonth] = useState(() => new Date(dateFromKey(day).getFullYear(), dateFromKey(day).getMonth(), 1, 12));
  useEffect(() => { const value = dateFromKey(day); setMonth(new Date(value.getFullYear(), value.getMonth(), 1, 12)); }, [day]);
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const offset = (month.getDay() + 6) % 7;
  function move(amount: number) { setMonth((value) => new Date(value.getFullYear(), value.getMonth() + amount, 1, 12)); }
  const previous = new Date(month.getFullYear(), month.getMonth(), 0, 12);
  const next = new Date(month.getFullYear(), month.getMonth() + 1, 1, 12);
  return <div className="booking-calendar"><div className="booking-month"><strong>{month.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</strong><div><button type="button" aria-label="Mês anterior" className="booking-icon-button" disabled={disabled || localDateKey(previous) < min} onClick={() => move(-1)}><ChevronLeft size={17}/></button><button type="button" aria-label="Próximo mês" className="booking-icon-button" disabled={disabled || localDateKey(next) > max} onClick={() => move(1)}><ChevronRight size={17}/></button></div></div>
    <div className="booking-calendar-grid" role="group" aria-label="Calendário de datas">{["seg", "ter", "qua", "qui", "sex", "sáb", "dom"].map((label) => <span key={label} className="booking-weekday" aria-hidden="true">{label}</span>)}{Array.from({ length: offset }, (_, i) => <span key={`empty-${i}`} aria-hidden="true"/>)}{Array.from({ length: count }, (_, i) => { const value = localDateKey(new Date(month.getFullYear(), month.getMonth(), i + 1, 12)); return <button type="button" key={value} aria-label={dateLabel(value)} aria-pressed={value === day} aria-current={value === min ? "date" : undefined} disabled={disabled || value < min || value > max} onClick={() => onChange(value)} className={`booking-day${value === day ? " is-selected" : ""}${value === min ? " is-today" : ""}`}>{i + 1}</button>; })}</div>
  </div>;
}

function Input({ id, label, value, onChange, type = "text", required, maxLength, error }: { id: string; label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean; maxLength: number; error?: string }) {
  return <label className="booking-field" htmlFor={id}><span>{label}{required ? <span aria-hidden="true" className="booking-required"> *</span> : <small> (opcional)</small>}{required && <span className="sr-only">obrigatório</span>}</span><input id={id} aria-required={required} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} required={required} type={type} autoComplete={id === "booking-full_name" ? "name" : type === "email" ? "email" : type === "tel" ? "tel" : undefined} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)}/>{error && <span id={`${id}-error`} className="booking-field-error">{error}</span>}</label>;
}
