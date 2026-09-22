import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CalendarDays, CheckCircle2, Clock3, ShieldCheck } from "lucide-react";
import { apiBaseUrl } from "../../core/api/config";
import { clearSlotsCache, schedulingApi, type BookingField, type SchedulingPage, type SchedulingService } from "../../features/scheduling/api";
import { formatCpf, formatPhone, validateSchedulingField } from "../../features/scheduling/fieldValidation";

type Slot = { startAt: string; endAt: string; remaining: number };

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
  const [duration, setDuration] = useState(30);
  const [day, setDay] = useState(() => { const value = new Date(); value.setDate(value.getDate() + 1); return value.toISOString().slice(0, 10); });
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
    schedulingApi.publicPage(identifier).then((data) => {
      setPage(data.page); setService(data.service); setDuration(data.service.durations[0]);
    }).catch((reason) => setError(reason.message)).finally(() => setLoading(false));
  }, [identifier]);

  useEffect(() => {
    if (!service) return;
    const requestId = ++slotsRequestRef.current;
    const controller = new AbortController();
    let refreshTimer: number | null = null;
    const cacheKey = `${identifier}::${day}::${duration}`;
    setSlot(null); setSlotsError(""); setSlotsLoading(true);
    schedulingApi.slotsCached(identifier, day, duration, controller.signal).then((data) => {
      if (slotsRequestRef.current !== requestId) return;
      setSlots(data.slots); setCalendarVerified(data.calendarVerified !== false);
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
  }, [identifier, day, duration, service, slotsRetry]);

  const theme = useMemo(() => ({
    "--booking-primary": page?.theme?.primary || "#6d5dfc",
    "--booking-bg": page?.theme?.background || "#f7f7fb",
    "--booking-text": page?.theme?.text || "#171722",
  }) as CSSProperties, [page]);

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
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
        responses, idempotencyKey: bookingOperationKeyRef.current, honeypot: "",
      });
      setSuccess(result.booking.public_id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível confirmar."); }
    finally { setSending(false); }
  }

  if (loading) return <main className="grid min-h-dvh place-items-center bg-slate-50 text-slate-700">Carregando horários...</main>;
  if (error && !page) return <main className="grid min-h-dvh place-items-center bg-slate-50 p-6"><div role="alert" className="max-w-md rounded-2xl bg-white p-8 text-center shadow-xl"><h1 className="text-xl font-black">Página indisponível</h1><p className="mt-2 text-sm text-slate-600">{error}</p></div></main>;
  if (success) return <main style={theme} className="grid min-h-dvh place-items-center bg-[var(--booking-bg)] p-6 text-[var(--booking-text)]"><section className="max-w-lg rounded-3xl bg-white p-8 text-center shadow-2xl"><CheckCircle2 className="mx-auto text-emerald-500" size={54}/><h1 className="mt-4 text-2xl font-black">Agendamento confirmado</h1><p className="mt-2 text-sm text-slate-600">Seu horário foi reservado com segurança. Identificador: <strong>{success}</strong></p></section></main>;

  return <main style={theme} className="min-h-dvh bg-[var(--booking-bg)] p-4 text-[var(--booking-text)] sm:p-8">
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-center gap-3">
        {page?.logo_url ? <img src={`${apiBaseUrl()}${page.logo_url}`} alt="Logo" className="h-11 w-11 rounded-xl object-contain"/> : <div className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--booking-primary)] text-white"><CalendarDays/></div>}
        <div><p className="text-xs font-black uppercase tracking-widest text-[var(--booking-primary)]">Norium Agendamentos</p><h1 className="text-xl font-black">{page?.title}</h1></div>
      </header>
      <div className="grid overflow-hidden rounded-3xl bg-white shadow-2xl lg:grid-cols-[.8fr_1.2fr]">
        <aside className="border-b border-slate-200 p-6 lg:border-b-0 lg:border-r">
          <h2 className="text-2xl font-black">{service?.name}</h2><p className="mt-2 text-sm text-slate-600">{page?.description || service?.description}</p>
          <div className="mt-5 flex items-center gap-2 text-sm font-bold"><Clock3 size={18} className="text-[var(--booking-primary)]"/> Duração</div>
          <div className="mt-2 flex flex-wrap gap-2">{service?.durations.map((item) => <button key={item} onClick={() => setDuration(item)} className={`rounded-lg border px-3 py-2 text-sm font-bold ${duration === item ? "border-transparent bg-[var(--booking-primary)] text-white" : "border-slate-200"}`}>{item} min</button>)}</div>
          <p className="mt-6 flex items-center gap-2 text-xs text-slate-500"><ShieldCheck size={16}/> Seus dados são usados somente para este agendamento.</p>
        </aside>
        <section className="p-6">
          <label className="grid gap-1 text-sm font-bold">Escolha a data<input type="date" min={new Date().toISOString().slice(0, 10)} value={day} onChange={(event) => setDay(event.target.value)} className="h-11 rounded-xl border border-slate-200 px-3"/></label>
          <div className="mt-5"><p className="mb-2 text-sm font-bold">Horários disponíveis</p>
            {!calendarVerified && <p role="status" className="mb-2 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-700">Calendário externo indisponível — os horários podem estar desatualizados. A reserva será validada na confirmação.</p>}
            {slotsLoading
              ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Carregando horários">{[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="h-16 animate-pulse rounded-xl bg-slate-100"/>)}
            </div>
              : slotsError
                ? <div role="alert" className="rounded-xl bg-red-50 p-4 text-center text-sm font-semibold text-red-600">{slotsError} <button className="underline" onClick={() => setSlotsRetry((value) => value + 1)}>Tentar novamente</button></div>
                : <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
              {slots.map((item) => <button key={item.startAt} onClick={() => { bookingOperationKeyRef.current = newOperationKey(); setSlot(item); setFieldErrors({}); setError(""); }} className={`rounded-xl border p-3 text-sm font-black ${slot?.startAt === item.startAt ? "border-transparent bg-[var(--booking-primary)] text-white" : "border-slate-200"}`}>{new Date(item.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}<small className="block font-semibold opacity-75">{item.remaining} vaga(s)</small></button>)}
              {!slots.length && <p className="col-span-full rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-500">Nenhum horário disponível nesta data.</p>}
            </div>}
          </div>
          {slot && <div className="mt-6 grid gap-3">
            {bookingFields.map((field) => <Input
              key={field.id}
              label={field.label}
              required={field.required}
              type={inputType(field.type)}
              value={form[field.id] || ""}
              maxLength={field.maxLength || 500}
              error={fieldErrors[field.id]}
              onChange={(value) => setFieldValue(field, value)}
            />)}
            {error && <p role="alert" className="text-sm font-bold text-red-600">{error}</p>}
            <button disabled={sending || !form.full_name || !form.email} onClick={() => void confirm()} className="mt-2 h-12 rounded-xl bg-[var(--booking-primary)] font-black text-white disabled:opacity-50">{sending ? "Confirmando..." : "Confirmar agendamento"}</button>
          </div>}
        </section>
      </div>
    </div>
  </main>;
}

function Input({label, value, onChange, type="text", required, maxLength, error}: {label:string; value:string; onChange:(value:string)=>void; type?:string; required?:boolean; maxLength:number; error?:string}) {
  return <label className="grid gap-1 text-sm font-bold">{label}{required && <span className="sr-only">obrigatório</span>}<input aria-required={required} aria-invalid={Boolean(error)} required={required} type={type} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} className={`h-11 rounded-xl border px-3 outline-none focus:border-[var(--booking-primary)] ${error ? "border-red-400" : "border-slate-200"}`}/>{error && <span className="text-xs font-semibold text-red-600">{error}</span>}</label>;
}
