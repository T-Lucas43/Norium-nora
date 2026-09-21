import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { CalendarDays, CheckCircle2, Clock3, ShieldCheck } from "lucide-react";
import { apiBaseUrl } from "../../core/api/config";
import { schedulingApi, type SchedulingPage, type SchedulingService } from "../../features/scheduling/api";

type Slot = { startAt: string; endAt: string; remaining: number };

export default function PublicSchedulingPage({ identifier }: { identifier: string }) {
  const [page, setPage] = useState<SchedulingPage | null>(null);
  const [service, setService] = useState<SchedulingService | null>(null);
  const [duration, setDuration] = useState(30);
  const [day, setDay] = useState(() => { const value = new Date(); value.setDate(value.getDate() + 1); return value.toISOString().slice(0, 10); });
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState<Record<string, string>>({ full_name: "", email: "", phone: "" });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    schedulingApi.publicPage(identifier).then((data) => {
      setPage(data.page); setService(data.service); setDuration(data.service.durations[0]);
    }).catch((reason) => setError(reason.message)).finally(() => setLoading(false));
  }, [identifier]);
  useEffect(() => {
    if (!service) return;
    setSlot(null);
    schedulingApi.slots(identifier, day, duration).then((data) => setSlots(data.slots)).catch((reason) => setError(reason.message));
  }, [identifier, day, duration, service]);

  const theme = useMemo(() => ({
    "--booking-primary": page?.theme?.primary || "#6d5dfc",
    "--booking-bg": page?.theme?.background || "#f7f7fb",
    "--booking-text": page?.theme?.text || "#171722",
  }) as CSSProperties, [page]);

  async function confirm() {
    if (!slot || !form.full_name || !form.email) return;
    setSending(true); setError("");
    const responses = Object.fromEntries((page?.fields || []).filter((field) => !["full_name", "email", "phone"].includes(field.id)).map((field) => [field.id, form[field.id] || ""]));
    try {
      const result = await schedulingApi.book(identifier, {
        startAt: slot.startAt, duration, name: form.full_name, email: form.email, phone: form.phone || null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
        responses, idempotencyKey: crypto.randomUUID(), honeypot: "",
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
          <div className="mt-5"><p className="mb-2 text-sm font-bold">Horários disponíveis</p><div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
            {slots.map((item) => <button key={item.startAt} onClick={() => setSlot(item)} className={`rounded-xl border p-3 text-sm font-black ${slot?.startAt === item.startAt ? "border-transparent bg-[var(--booking-primary)] text-white" : "border-slate-200"}`}>{new Date(item.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}<small className="block font-semibold opacity-75">{item.remaining} vaga(s)</small></button>)}
            {!slots.length && <p className="col-span-full rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-500">Nenhum horário disponível nesta data.</p>}
          </div></div>
          {slot && <div className="mt-6 grid gap-3">
            <Input label="Nome completo" required value={form.full_name} maxLength={160} onChange={(value) => setForm({...form, full_name: value})}/>
            <Input label="E-mail" required type="email" value={form.email} maxLength={254} onChange={(value) => setForm({...form, email: value})}/>
            <Input label="WhatsApp" type="tel" value={form.phone} maxLength={32} onChange={(value) => setForm({...form, phone: value})}/>
            {page?.fields.filter((field) => !["full_name", "email", "phone"].includes(field.id)).map((field) => <Input key={field.id} label={field.label} required={field.required} type={field.type === "date" ? "date" : "text"} value={form[field.id] || ""} maxLength={field.maxLength || 500} onChange={(value) => setForm({...form, [field.id]: value})}/>)}
            {error && <p role="alert" className="text-sm font-bold text-red-600">{error}</p>}
            <button disabled={sending || !form.full_name || !form.email} onClick={() => void confirm()} className="mt-2 h-12 rounded-xl bg-[var(--booking-primary)] font-black text-white disabled:opacity-50">{sending ? "Confirmando..." : "Confirmar agendamento"}</button>
          </div>}
        </section>
      </div>
    </div>
  </main>;
}

function Input({label, value, onChange, type="text", required, maxLength}: {label:string; value:string; onChange:(value:string)=>void; type?:string; required?:boolean; maxLength:number}) {
  return <label className="grid gap-1 text-sm font-bold">{label}{required && <span className="sr-only">obrigatório</span>}<input aria-required={required} required={required} type={type} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} className="h-11 rounded-xl border border-slate-200 px-3 outline-none focus:border-[var(--booking-primary)]"/></label>;
}
