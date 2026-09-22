import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarCheck, Clock3, Copy, Link2, Pencil, Plus, Trash2, Users, type LucideIcon } from "lucide-react";
import Button from "../shared/Button";
import { apiBaseUrl } from "../../core/api/config";
import { schedulingApi, type AvailabilityPeriod, type Booking, type SchedulingPage, type SchedulingService } from "../../features/scheduling/api";
import { WEEKDAYS, defaultPeriods, periodsFromWeekly, weeklyFromPeriods, type DayPeriod } from "../../features/scheduling/availability";
import PagePreview from "./PagePreview";
import RescheduleDialog from "./RescheduleDialog";

const BUILTIN_FIELDS = [
  { id: "full_name", type: "full_name", label: "Nome completo", required: true, maxLength: 160 },
  { id: "email", type: "email", label: "E-mail", required: true, maxLength: 254 },
  { id: "phone", type: "phone", label: "WhatsApp", required: false, maxLength: 32 },
];
const EMPTY_SERVICE_FORM = { name: "", description: "", durations: "30", capacity: 1, bufferBefore: 0, bufferAfter: 0 };
const EMPTY_PAGE_FORM = { serviceId: "", title: "", slug: "", description: "", primary: "#6d5dfc", secondary: "#4338ca", accent: "#14b8a6", background: "#f7f7fb", text: "#171722", mode: "auto" };

function customFieldMaxLength(type: string) {
  if (type === "cpf") return 14;
  if (type === "cnpj") return 18;
  if (type === "phone") return 20;
  if (type === "email") return 254;
  if (type === "textarea") return 2000;
  return 500;
}

export default function SchedulingDashboard() {
  const [services, setServices] = useState<SchedulingService[]>([]);
  const [pages, setPages] = useState<SchedulingPage[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [section, setSection] = useState("Agendamentos");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [serviceForm, setServiceForm] = useState(EMPTY_SERVICE_FORM);
  const [editingServiceId, setEditingServiceId] = useState("");
  const [pageForm, setPageForm] = useState(EMPTY_PAGE_FORM);
  const [editingPageId, setEditingPageId] = useState("");
  const [pageLogo, setPageLogo] = useState({ base64: "", preview: "", name: "" });
  const [currentLogoUrl, setCurrentLogoUrl] = useState("");
  const [customField, setCustomField] = useState({ label: "CPF", type: "cpf", required: true });
  const [pageFields, setPageFields] = useState<Array<{id:string;type:string;label:string;required:boolean;maxLength:number}>>([]);
  const [availabilityService, setAvailabilityService] = useState("");
  const [periods, setPeriods] = useState<Record<string, DayPeriod>>(defaultPeriods);
  const [lunch, setLunch] = useState({ enabled: true, start: "12:00", end: "14:00" });
  const [availLoading, setAvailLoading] = useState(false);
  const [availTimezone, setAvailTimezone] = useState("");
  const [availNotice, setAvailNotice] = useState("");
  const [advanced, setAdvanced] = useState<{exceptions: Record<string, AvailabilityPeriod[]>; blocked: Array<{start:string;end:string}>}>({ exceptions: {}, blocked: [] });
  const [rescheduling, setRescheduling] = useState<Booking | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{kind: string; id: string} | null>(null);

  const reload = async () => {
    setLoading(true); setError("");
    try { const data = await schedulingApi.dashboard(); setServices(data.services); setPages(data.pages); setBookings(data.bookings); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao carregar."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);
  useEffect(() => { if (!pageForm.serviceId && services[0]) setPageForm((v) => ({ ...v, serviceId: services[0].id })); if (!availabilityService && services[0]) setAvailabilityService(services[0].id); }, [services, pageForm.serviceId, availabilityService]);

  useEffect(() => {
    if (!availabilityService) return;
    let cancelled = false;
    setAvailLoading(true); setAvailNotice(""); setError("");
    schedulingApi.getAvailability(availabilityService).then((data) => {
      if (cancelled) return;
      setPeriods(periodsFromWeekly(data.weekly));
      setLunch((current) => ({ ...current, enabled: false }));
      setAvailTimezone(data.timezone || "");
      setAdvanced({ exceptions: data.exceptions || {}, blocked: data.blocked || [] });
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Falha ao carregar disponibilidade."); })
      .finally(() => { if (!cancelled) setAvailLoading(false); });
    return () => { cancelled = true; };
  }, [availabilityService]);

  const today = new Date().toISOString().slice(0, 10);
  const counters = useMemo(() => ({ today: bookings.filter((item) => item.start_at.startsWith(today)).length, confirmed: bookings.filter((item) => item.status === "CONFIRMED").length, pending: bookings.filter((item) => item.status === "PENDING").length, cancelled: bookings.filter((item) => item.status === "CANCELLED").length }), [bookings, today]);
  const cards: Array<{ label: string; value: number; Icon: LucideIcon }> = [{label:"Hoje",value:counters.today,Icon:CalendarCheck},{label:"Confirmados",value:counters.confirmed,Icon:Clock3},{label:"Pendentes",value:counters.pending,Icon:Users},{label:"Cancelados",value:counters.cancelled,Icon:CalendarCheck}];

  function parseDurations(value: string) {
    return value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item >= 5 && item <= 1440);
  }

  async function saveService() {
    const durations = parseDurations(serviceForm.durations);
    if (!serviceForm.name.trim() || !durations.length) { setError("Informe nome e ao menos uma duração válida (5–1440 min)."); return; }
    try {
      if (editingServiceId) {
        const current = services.find((item) => item.id === editingServiceId);
        if (!current) { setError("Serviço não encontrado para edição."); return; }
        await schedulingApi.updateService(editingServiceId, {
          name: serviceForm.name.trim(), description: serviceForm.description.trim(), durations,
          color: current.color, locationType: current.location_type || "online", location: current.location || "",
          instructions: current.instructions || "", bufferBefore: serviceForm.bufferBefore, bufferAfter: serviceForm.bufferAfter,
          capacity: serviceForm.capacity, minimumNoticeMinutes: current.minimum_notice_minutes ?? 60,
          maximumDays: current.maximum_days ?? 60, slotInterval: current.slot_interval, active: current.active,
        });
        setNotice("Serviço atualizado.");
      } else {
        await schedulingApi.createService({ ...serviceForm, name: serviceForm.name.trim(), description: serviceForm.description.trim(), durations, color: "#6d5dfc", locationType: "online", location: "", instructions: "", minimumNoticeMinutes: 60, maximumDays: 60, slotInterval: 15, active: true });
        setNotice("Serviço criado.");
      }
      setServiceForm(EMPTY_SERVICE_FORM); setEditingServiceId(""); setError(""); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao salvar serviço."); }
  }

  function startEditService(item: SchedulingService) {
    setEditingServiceId(item.id);
    setServiceForm({ name: item.name, description: item.description || "", durations: item.durations.join(", "), capacity: item.capacity, bufferBefore: item.buffer_before, bufferAfter: item.buffer_after });
    setNotice(""); setError("");
  }

  async function archiveService(id: string) {
    if (pendingConfirm?.kind !== "service" || pendingConfirm.id !== id) { setPendingConfirm({ kind: "service", id }); return; }
    setPendingConfirm(null);
    try {
      const result = await schedulingApi.archiveService(id);
      setNotice(`Serviço arquivado. ${result.activePages} página(s) e ${result.activeBookings} agendamento(s) ativo(s) preservados, indisponíveis para novas reservas.`);
      setError(""); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao arquivar serviço."); }
  }

  async function saveAvailability() {
    try {
      const saved = await schedulingApi.setAvailability({
        serviceId: availabilityService || null,
        timezone: availTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
        weekly: weeklyFromPeriods(periods, lunch), exceptions: advanced.exceptions, blocked: advanced.blocked,
      });
      setPeriods(periodsFromWeekly(saved.weekly));
      setAvailTimezone(saved.timezone);
      setAdvanced({ exceptions: saved.exceptions || {}, blocked: saved.blocked || [] });
      setAvailNotice(`Disponibilidade salva às ${new Date().toLocaleTimeString("pt-BR")} · ${saved.timezone}`);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao salvar disponibilidade."); }
  }

  function updateSlot(day: string, index: number, patch: Partial<{start:string;end:string}>) {
    setPeriods((current) => ({ ...current, [day]: { ...current[day], slots: current[day].slots.map((slot, position) => position === index ? { ...slot, ...patch } : slot) } }));
  }
  function addSlot(day: string) {
    setPeriods((current) => current[day].slots.length >= 8 ? current : ({ ...current, [day]: { ...current[day], slots: [...current[day].slots, { start: "08:00", end: "12:00" }] } }));
  }
  function removeSlot(day: string, index: number) {
    setPeriods((current) => ({ ...current, [day]: { ...current[day], slots: current[day].slots.filter((_, position) => position !== index) } }));
  }

  function startEditPage(item: SchedulingPage) {
    setEditingPageId(item.id);
    setPageForm({
      serviceId: item.service_id, title: item.title, slug: item.slug || "", description: item.description || "",
      primary: item.theme?.primary || "#6d5dfc", secondary: item.theme?.secondary || "#4338ca", accent: item.theme?.accent || "#14b8a6",
      background: item.theme?.background || "#f7f7fb", text: item.theme?.text || "#171722", mode: item.theme?.mode || "auto",
    });
    setPageFields((item.fields || []).filter((field) => !["full_name", "email", "phone"].includes(field.id)).map((field) => ({ id: field.id, type: field.type, label: field.label, required: Boolean(field.required), maxLength: field.maxLength || 500 })));
    setPageLogo({ base64: "", preview: "", name: "" });
    setCurrentLogoUrl(item.logo_url || "");
    setNotice(""); setError("");
  }

  function resetPageForm() {
    setPageForm((v) => ({ ...EMPTY_PAGE_FORM, serviceId: v.serviceId || services[0]?.id || "" }));
    setEditingPageId(""); setPageFields([]); setPageLogo({ base64: "", preview: "", name: "" }); setCurrentLogoUrl("");
  }

  async function savePage() {
    if (!pageForm.serviceId || !pageForm.title.trim()) { setError("Escolha o serviço e informe o título da página."); return; }
    const fields = [...BUILTIN_FIELDS, ...pageFields];
    const theme = { primary: pageForm.primary, secondary: pageForm.secondary, accent: pageForm.accent, background: pageForm.background, text: pageForm.text, mode: pageForm.mode };
    try {
      if (editingPageId) {
        const current = pages.find((item) => item.id === editingPageId);
        await schedulingApi.updatePage(editingPageId, { serviceId: pageForm.serviceId, title: pageForm.title.trim(), slug: pageForm.slug || null, description: pageForm.description.trim(), fields, theme, logoUrl: current?.logo_url || null, active: current?.active ?? true });
        if (pageLogo.base64) await schedulingApi.uploadLogo(editingPageId, pageLogo.base64);
        setNotice("Página atualizada.");
      } else {
        const created = await schedulingApi.createPage({ serviceId: pageForm.serviceId, title: pageForm.title.trim(), slug: pageForm.slug || null, description: pageForm.description.trim(), fields, theme, active: true });
        if (pageLogo.base64) await schedulingApi.uploadLogo(created.id, pageLogo.base64);
        setNotice("Página publicada.");
      }
      resetPageForm(); setError(""); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao salvar página."); }
  }

  async function archivePage(id: string) {
    if (pendingConfirm?.kind !== "page" || pendingConfirm.id !== id) { setPendingConfirm({ kind: "page", id }); return; }
    setPendingConfirm(null);
    try { await schedulingApi.archivePage(id); setNotice("Página arquivada. O link público sai do ar e o histórico é preservado."); setError(""); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao arquivar página."); }
  }

  async function selectPageLogo(file?: File) {
    if (!file) { setPageLogo({base64:"",preview:"",name:""}); return; }
    if (file.size > 2_000_000) { setError("O logo deve possuir no máximo 2 MB."); return; }
    if (!["image/png","image/jpeg","image/webp"].includes(file.type)) { setError("Use um logo PNG, JPEG ou WebP."); return; }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror=()=>reject(new Error("Falha ao ler logo.")); reader.onload=()=>resolve(String(reader.result)); reader.readAsDataURL(file); });
      setPageLogo({base64:dataUrl.split(",")[1]||"",preview:dataUrl,name:file.name}); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao ler logo."); }
  }
  async function uploadLogo(pageId: string, file?: File) {
    if (!file) return; if (file.size > 2_000_000) { setError("O logo deve possuir no máximo 2 MB."); return; }
    const encoded = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror=()=>reject(new Error("Falha ao ler logo.")); reader.onload=()=>resolve(String(reader.result).split(",")[1]||""); reader.readAsDataURL(file); });
    try { await schedulingApi.uploadLogo(pageId, encoded); setNotice("Logo atualizado."); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao enviar logo."); }
  }

  async function cancelBooking(id: string) {
    if (pendingConfirm?.kind !== "booking" || pendingConfirm.id !== id) { setPendingConfirm({ kind: "booking", id }); return; }
    setPendingConfirm(null);
    try { await schedulingApi.updateBookingStatus(id, "CANCELLED"); setNotice("Agendamento cancelado. O histórico é preservado."); setError(""); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao cancelar agendamento."); }
  }

  const previewService = services.find((item) => item.id === pageForm.serviceId);
  const previewFields = [...BUILTIN_FIELDS.map((field) => ({ id: field.id, type: field.type, label: field.label, required: field.required })), ...pageFields];

  return <div className="min-h-full bg-[var(--background)] p-4 text-[var(--text)] sm:p-6">
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[.18em] text-[var(--primary)]">Norium</p><h1 className="text-2xl font-black">Agendamentos</h1><p className="text-sm text-[var(--text-secondary)]">Serviços, disponibilidade, páginas públicas e reservas.</p></div><Button variant="primary" icon={<Plus size={16}/>} onClick={() => setSection("Serviços")}>Novo serviço</Button></header>
    <nav className="mb-5 flex gap-2 overflow-x-auto" aria-label="Seções de agendamentos">{["Agendamentos","Serviços","Disponibilidade","Páginas"].map((item) => <button key={item} onClick={() => setSection(item)} className={`rounded-lg px-4 py-2 text-sm font-bold ${section===item ? "bg-[var(--primary)] text-white" : "border border-[var(--border)] bg-[var(--surface)]"}`}>{item}</button>)}</nav>
    {error && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-400/40 bg-red-500/10 p-3 text-sm font-semibold text-red-500"><span>{error}</span><Button size="sm" onClick={() => void reload()}>Tentar novamente</Button></div>}
    {notice && !error && <div role="status" className="mb-4 rounded-lg border border-emerald-400/40 bg-emerald-500/10 p-3 text-sm font-semibold text-emerald-600">{notice}</div>}
    {loading ? <p className="p-8 text-center text-sm text-[var(--text-secondary)]">Carregando agendamentos...</p> : section === "Agendamentos" ? <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({label,value,Icon}) => <article key={label} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><Icon size={20} className="text-[var(--primary)]"/><p className="mt-3 text-2xl font-black">{value}</p><p className="text-xs font-bold text-[var(--text-secondary)]">{label}</p></article>)}</div>
      <div className="mt-5 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]"><table className="w-full min-w-[860px] text-left text-sm"><thead><tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--text-secondary)]"><th className="p-4">Cliente</th><th>Data</th><th>Status</th><th>E-mail</th><th>Telefone</th><th>Ações</th></tr></thead><tbody>{bookings.map((item) => <tr key={item.id} className="border-b border-[var(--border)]"><td className="p-4 font-bold">{item.attendee_name}</td><td>{new Date(item.start_at).toLocaleString("pt-BR")}</td><td>{item.status}</td><td>{item.attendee_email}</td><td>{item.attendee_phone || "—"}</td><td><div className="flex flex-wrap gap-2 py-2 pr-4">{item.status !== "CANCELLED" && <><Button size="sm" icon={<Pencil size={14}/>} onClick={() => setRescheduling(item)}>Reagendar</Button><Button size="sm" icon={<Trash2 size={14}/>} onClick={() => void cancelBooking(item.id)}>{pendingConfirm?.kind === "booking" && pendingConfirm.id === item.id ? "Confirmar cancelamento" : "Cancelar"}</Button></>}</div></td></tr>)}{!bookings.length && <tr><td colSpan={6} className="p-8 text-center text-[var(--text-secondary)]">Nenhum agendamento ainda.</td></tr>}</tbody></table></div>
      {rescheduling && <RescheduleDialog key={rescheduling.id} booking={rescheduling} services={services} onClose={() => setRescheduling(null)} onSaved={() => void reload()} />}
    </> : section === "Serviços" ? <div className="grid gap-5 lg:grid-cols-[380px_1fr]"><FormCard title={editingServiceId ? "Editar serviço" : "Novo serviço"}><Field label="Nome"><input value={serviceForm.name} maxLength={120} onChange={(e)=>setServiceForm({...serviceForm,name:e.target.value})}/></Field><Field label="Descrição"><textarea value={serviceForm.description} maxLength={2000} onChange={(e)=>setServiceForm({...serviceForm,description:e.target.value})}/></Field><Field label="Durações em minutos, separadas por vírgula"><input value={serviceForm.durations} onChange={(e)=>setServiceForm({...serviceForm,durations:e.target.value})}/></Field><div className="grid grid-cols-3 gap-2"><Field label="Capacidade"><input type="number" min={1} max={500} value={serviceForm.capacity} onChange={(e)=>setServiceForm({...serviceForm,capacity:Number(e.target.value)})}/></Field><Field label="Buffer antes"><input type="number" min={0} value={serviceForm.bufferBefore} onChange={(e)=>setServiceForm({...serviceForm,bufferBefore:Number(e.target.value)})}/></Field><Field label="Buffer depois"><input type="number" min={0} value={serviceForm.bufferAfter} onChange={(e)=>setServiceForm({...serviceForm,bufferAfter:Number(e.target.value)})}/></Field></div><div className="flex gap-2"><Button variant="primary" disabled={!serviceForm.name} onClick={() => void saveService()}>{editingServiceId ? "Atualizar serviço" : "Criar serviço"}</Button>{editingServiceId && <Button onClick={() => { setEditingServiceId(""); setServiceForm(EMPTY_SERVICE_FORM); }}>Cancelar</Button>}</div></FormCard><div className="grid content-start gap-3">{services.map((item)=><article key={item.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="flex items-start justify-between"><div><h3 className="font-black">{item.name}</h3><p className="text-sm text-[var(--text-secondary)]">{item.description || "Sem descrição"}</p></div><span className="rounded-full bg-[var(--background)] px-3 py-1 text-xs font-bold">{item.capacity} vaga(s)</span></div><p className="mt-3 text-xs font-bold">{item.durations.join(" / ")} min · buffers {item.buffer_before}/{item.buffer_after} min</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" icon={<Pencil size={14}/>} onClick={() => startEditService(item)}>Editar</Button><Button size="sm" icon={<Trash2 size={14}/>} onClick={() => void archiveService(item.id)}>{pendingConfirm?.kind === "service" && pendingConfirm.id === item.id ? "Confirmar arquivamento" : "Arquivar"}</Button></div></article>)}</div></div>
    : section === "Disponibilidade" ? <FormCard title="Disponibilidade semanal">
      <Field label="Serviço"><select value={availabilityService} onChange={(e)=>setAvailabilityService(e.target.value)}>{services.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      {availLoading
        ? <p className="rounded-lg bg-[var(--background)] p-4 text-center text-sm text-[var(--text-secondary)]">Carregando disponibilidade salva…</p>
        : <><div className="grid gap-3">{WEEKDAYS.map((label,index)=>{const key=String(index);const item=periods[key];return <div key={label} className="rounded-lg border border-[var(--border)] p-3"><label className="flex gap-2 text-sm font-bold"><input type="checkbox" checked={item.enabled} onChange={(e)=>setPeriods({...periods,[key]:{...item,enabled:e.target.checked}})}/>{label}</label>{item.enabled && <div className="mt-2 grid gap-2">{item.slots.map((slot, position) => <div key={position} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2"><input aria-label={`${label} início ${position + 1}`} type="time" value={slot.start} onChange={(e)=>updateSlot(key,position,{start:e.target.value})}/><input aria-label={`${label} fim ${position + 1}`} type="time" value={slot.end} onChange={(e)=>updateSlot(key,position,{end:e.target.value})}/>{item.slots.length > 1 ? <Button size="sm" onClick={() => removeSlot(key, position)}>Remover</Button> : <span />}</div>)}<div><Button size="sm" disabled={item.slots.length >= 8} onClick={() => addSlot(key)}>Adicionar período</Button></div></div>}</div>})}</div>
      <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={lunch.enabled} onChange={(e)=>setLunch({...lunch,enabled:e.target.checked})}/> Intervalo aplicado ao salvar</label>{lunch.enabled && <div className="grid grid-cols-2 gap-2"><input aria-label="Início do intervalo" type="time" value={lunch.start} onChange={(e)=>setLunch({...lunch,start:e.target.value})}/><input aria-label="Fim do intervalo" type="time" value={lunch.end} onChange={(e)=>setLunch({...lunch,end:e.target.value})}/></div>}
      <p className="text-xs font-semibold text-[var(--text-secondary)]">Fuso horário: {availTimezone || "carregando…"}</p>
      <div><Button variant="primary" disabled={!availabilityService} onClick={() => void saveAvailability()}>Salvar disponibilidade</Button></div>
      {availNotice && <p role="status" className="rounded-lg border border-emerald-400/40 bg-emerald-500/10 p-3 text-sm font-semibold text-emerald-600">{availNotice}</p>}</>}
    </FormCard>
    : <div className="grid gap-5 lg:grid-cols-[420px_1fr]">
      <FormCard title={editingPageId ? "Editar página" : "Nova página"}>
        <Field label="Serviço"><select value={pageForm.serviceId} onChange={(e)=>setPageForm({...pageForm,serviceId:e.target.value})}>{services.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="Título"><input value={pageForm.title} maxLength={120} onChange={(e)=>setPageForm({...pageForm,title:e.target.value})}/></Field>
        <Field label="Descrição"><textarea value={pageForm.description} maxLength={2000} placeholder="Texto exibido na página pública" onChange={(e)=>setPageForm({...pageForm,description:e.target.value})}/></Field>
        <Field label="Slug opcional"><input value={pageForm.slug} maxLength={64} placeholder="consultoria" onChange={(e)=>setPageForm({...pageForm,slug:e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,"")})}/></Field>
        <label className="grid gap-2 rounded-lg border border-[var(--border)] p-3 text-xs font-bold text-[var(--text-secondary)]">
          Logo da página <span className="font-medium">PNG, JPEG ou WebP · máximo 2 MB</span>
          <input aria-label="Logo da página" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event)=>void selectPageLogo(event.target.files?.[0])} className="text-xs"/>
          {pageLogo.name && <span className="text-[var(--text)]">Selecionado: {pageLogo.name}</span>}
          {!pageLogo.name && currentLogoUrl && <span className="text-[var(--text)]">Logo atual mantido.</span>}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cor principal"><input type="color" value={pageForm.primary} onChange={(e)=>setPageForm({...pageForm,primary:e.target.value})}/></Field>
          <Field label="Cor secundária"><input type="color" value={pageForm.secondary} onChange={(e)=>setPageForm({...pageForm,secondary:e.target.value})}/></Field>
          <Field label="Cor de destaque"><input type="color" value={pageForm.accent} onChange={(e)=>setPageForm({...pageForm,accent:e.target.value})}/></Field>
          <Field label="Fundo"><input type="color" value={pageForm.background} onChange={(e)=>setPageForm({...pageForm,background:e.target.value})}/></Field>
          <Field label="Texto"><input type="color" value={pageForm.text} onChange={(e)=>setPageForm({...pageForm,text:e.target.value})}/></Field>
          <Field label="Modo"><select value={pageForm.mode} onChange={(e)=>setPageForm({...pageForm,mode:e.target.value})}><option value="auto">Automático</option><option value="light">Claro</option><option value="dark">Escuro</option></select></Field>
        </div>
        <div className="rounded-lg border border-[var(--border)] p-3"><p className="mb-2 text-xs font-black uppercase">Campo personalizado</p><div className="grid grid-cols-2 gap-2"><input aria-label="Rótulo do campo" value={customField.label} maxLength={120} onChange={(e)=>setCustomField({...customField,label:e.target.value})} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3"/><select aria-label="Tipo do campo" value={customField.type} onChange={(e)=>setCustomField({...customField,type:e.target.value})} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3"><option value="text">Texto</option><option value="textarea">Texto longo</option><option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="phone">Telefone / WhatsApp</option><option value="email">E-mail</option><option value="date">Data</option><option value="number">Número</option><option value="boolean">Sim/não</option></select></div><div className="mt-2 flex items-center justify-between"><label className="text-xs font-bold"><input type="checkbox" checked={customField.required} onChange={(e)=>setCustomField({...customField,required:e.target.checked})}/> Obrigatório</label><Button size="sm" onClick={()=>{if(!customField.label.trim())return;setPageFields([...pageFields,{...customField,label:customField.label.trim(),id:`field_${crypto.randomUUID().slice(0,8)}`,maxLength:customFieldMaxLength(customField.type)}]);}}>Adicionar</Button></div>{pageFields.map((field)=><div key={field.id} className="mt-2 flex items-center justify-between gap-2"><p className="text-xs font-semibold">{field.label} · {field.type}{field.required?" · obrigatório":""}</p><Button size="sm" onClick={()=>setPageFields(pageFields.filter((item)=>item.id!==field.id))}>Remover</Button></div>)}</div>
        <div className="flex gap-2"><Button variant="primary" disabled={!pageForm.serviceId||!pageForm.title} onClick={() => void savePage()}>{editingPageId ? "Atualizar página" : "Gerar link com esta identidade"}</Button>{editingPageId && <Button onClick={resetPageForm}>Cancelar</Button>}</div>
      </FormCard>
      <div className="grid content-start gap-3">
        <div className="lg:sticky lg:top-4"><PagePreview serviceName={previewService?.name || ""} title={pageForm.title} description={pageForm.description} identity={{ primary: pageForm.primary, secondary: pageForm.secondary, accent: pageForm.accent, background: pageForm.background, text: pageForm.text, mode: pageForm.mode }} logoSrc={pageLogo.preview || (currentLogoUrl ? `${apiBaseUrl()}${currentLogoUrl}` : "")} fields={previewFields} /></div>
        {pages.map((item)=>{const link=`${window.location.origin}/agendar/${item.slug||item.public_id}`;return <article key={item.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><h3 className="font-black">{item.title}</h3><p className="mt-1 break-all text-xs text-[var(--text-secondary)]">{link}</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" icon={<Copy size={14}/>} onClick={()=>void navigator.clipboard.writeText(link)}>Copiar</Button><Button size="sm" icon={<Link2 size={14}/>} onClick={()=>window.open(link,"_blank","noopener")}>Visualizar</Button><Button size="sm" icon={<Pencil size={14}/>} onClick={()=>startEditPage(item)}>Editar</Button><Button size="sm" icon={<Trash2 size={14}/>} onClick={()=>void archivePage(item.id)}>{pendingConfirm?.kind === "page" && pendingConfirm.id === item.id ? "Confirmar arquivamento" : "Arquivar"}</Button><label className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-[var(--border)] px-3 text-xs font-bold">Trocar logo<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event)=>void uploadLogo(item.id,event.target.files?.[0])}/></label></div></article>})}
      </div>
    </div>}
  </div>;
}

function FormCard({title,children}:{title:string;children:ReactNode}) { return <section className="grid content-start gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"><h2 className="text-lg font-black">{title}</h2>{children}</section>; }
function Field({label,children}:{label:string;children:ReactNode}) { return <label className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">{label}<div className="[&_input]:h-10 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-[var(--border)] [&_input]:bg-[var(--background)] [&_input]:px-3 [&_select]:h-10 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-[var(--border)] [&_select]:bg-[var(--background)] [&_select]:px-3 [&_textarea]:min-h-20 [&_textarea]:w-full [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-[var(--border)] [&_textarea]:bg-[var(--background)] [&_textarea]:p-3">{children}</div></label>; }
