import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarCheck, Clock3, Copy, ExternalLink, Link2, MapPin, Pencil, Plus, Trash2, Upload, Users, type LucideIcon } from "lucide-react";
import { apiBaseUrl } from "../../core/api/config";
import { schedulingApi, type AvailabilityPeriod, type Booking, type SchedulingPage, type SchedulingProfessional, type SchedulingService, type TeamSchedulingSettings } from "../../features/scheduling/api";
import { WEEKDAYS, defaultPeriods, periodsFromWeekly, weeklyFromPeriods, type DayPeriod } from "../../features/scheduling/availability";
import PagePreview from "./PagePreview";
import RescheduleDialog from "./RescheduleDialog";
import "./scheduling-v2.css";

const BUILTIN_FIELDS = [
  { id: "full_name", type: "full_name", label: "Nome completo", required: true, maxLength: 160 },
  { id: "email", type: "email", label: "E-mail", required: true, maxLength: 254 },
  { id: "phone", type: "phone", label: "WhatsApp", required: false, maxLength: 32 },
];
const EMPTY_SERVICE_FORM = { name: "", description: "", durations: "30", capacity: 1, bufferBefore: 0, bufferAfter: 0, professionalIds: [] as string[] };
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
  const [teamCalendar, setTeamCalendar] = useState<Booking[]>([]);
  const [teamSettings, setTeamSettings] = useState<TeamSchedulingSettings>({ enabled: false, professionals: [] });
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
  const [availabilityResponsible, setAvailabilityResponsible] = useState("");
  const [periods, setPeriods] = useState<Record<string, DayPeriod>>(defaultPeriods);
  const [lunch, setLunch] = useState({ enabled: true, start: "12:00", end: "14:00" });
  const [availLoading, setAvailLoading] = useState(false);
  const [availTimezone, setAvailTimezone] = useState("");
  const [availNotice, setAvailNotice] = useState("");
  const [advanced, setAdvanced] = useState<{exceptions: Record<string, AvailabilityPeriod[]>; blocked: Array<{start:string;end:string}>}>({ exceptions: {}, blocked: [] });
  const [rescheduling, setRescheduling] = useState<Booking | null>(null);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [teamSaving, setTeamSaving] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{kind: string; id: string} | null>(null);

  const reload = async () => {
    setLoading(true); setError("");
    try { const data = await schedulingApi.dashboard(); setServices(data.services); setPages(data.pages); setBookings(data.bookings); if (data.teamSettings) setTeamSettings(data.teamSettings); setTeamCalendar(data.teamCalendar || data.bookings); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao carregar."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);
  useEffect(() => { if (!pageForm.serviceId && services[0]) setPageForm((v) => ({ ...v, serviceId: services[0].id })); if (!availabilityService && services[0]) setAvailabilityService(services[0].id); }, [services, pageForm.serviceId, availabilityService]);
  useEffect(() => { if (teamSettings.enabled && !availabilityResponsible) setAvailabilityResponsible(teamSettings.professionals.find((item) => item.active)?.userId || ""); }, [availabilityResponsible, teamSettings]);

  useEffect(() => {
    if (!availabilityService) return;
    let cancelled = false;
    setAvailLoading(true); setAvailNotice(""); setError("");
    (teamSettings.enabled ? schedulingApi.getAvailability(availabilityService, availabilityResponsible) : schedulingApi.getAvailability(availabilityService)).then((data) => {
      if (cancelled) return;
      setPeriods(periodsFromWeekly(data.weekly));
      setLunch((current) => ({ ...current, enabled: false }));
      setAvailTimezone(data.timezone || "");
      setAdvanced({ exceptions: data.exceptions || {}, blocked: data.blocked || [] });
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Falha ao carregar disponibilidade."); })
      .finally(() => { if (!cancelled) setAvailLoading(false); });
    return () => { cancelled = true; };
  }, [availabilityResponsible, availabilityService, teamSettings.enabled]);

  const today = new Date().toISOString().slice(0, 10);
  const counters = useMemo(() => ({ today: bookings.filter((item) => item.start_at.startsWith(today)).length, confirmed: bookings.filter((item) => item.status === "CONFIRMED").length, pending: bookings.filter((item) => item.status === "PENDING").length, cancelled: bookings.filter((item) => item.status === "CANCELLED").length }), [bookings, today]);
  const cards: Array<{ label: string; value: number; Icon: LucideIcon }> = [{label:"Hoje",value:counters.today,Icon:CalendarCheck},{label:"Confirmados",value:counters.confirmed,Icon:Clock3},{label:"Pendentes",value:counters.pending,Icon:Users},{label:"Cancelados",value:counters.cancelled,Icon:CalendarCheck}];

  function parseDurations(value: string) {
    return value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item >= 5 && item <= 1440);
  }

  async function saveService() {
    if (teamSaving) { setError("Aguarde a confirmação do modo equipe antes de salvar o serviço."); return; }
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
          professionalIds: serviceForm.professionalIds,
        });
        setNotice("Serviço atualizado.");
      } else {
        await schedulingApi.createService({ ...serviceForm, name: serviceForm.name.trim(), description: serviceForm.description.trim(), durations, color: "#6d5dfc", locationType: "online", location: "", instructions: "", minimumNoticeMinutes: 60, maximumDays: 60, slotInterval: 15, active: true, professionalIds: serviceForm.professionalIds });
        setNotice("Serviço criado.");
      }
      setServiceForm(EMPTY_SERVICE_FORM); setEditingServiceId(""); setError(""); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao salvar serviço."); }
  }

  function startEditService(item: SchedulingService) {
    setEditingServiceId(item.id);
    setServiceForm({ name: item.name, description: item.description || "", durations: item.durations.join(", "), capacity: item.capacity, bufferBefore: item.buffer_before, bufferAfter: item.buffer_after, professionalIds: item.professionalIds || [] });
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
        responsibleId: teamSettings.enabled ? availabilityResponsible || null : null,
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

  function teamPayload(settings: TeamSchedulingSettings) {
    return { enabled: settings.enabled, professionals: settings.professionals.map(({userId,active,profession,position,color}) => ({userId,active,profession,position,color})) };
  }

  async function persistTeamSettings(next: TeamSchedulingSettings, message: string) {
    const previous = teamSettings;
    setTeamSettings(next); setTeamSaving(true); setError("");
    try {
      const saved = await schedulingApi.saveTeamSettings(teamPayload(next));
      setTeamSettings(saved);
      setAvailabilityResponsible(saved.professionals.find((item) => item.active)?.userId || "");
      setNotice(message);
    } catch (reason) {
      setTeamSettings(previous);
      setError(reason instanceof Error ? reason.message : "Falha ao salvar modo equipe.");
    } finally { setTeamSaving(false); }
  }

  async function saveTeamMode() {
    await persistTeamSettings(teamSettings, "Dados dos profissionais salvos no modo equipe.");
  }

  function updateProfessional(userId: string, patch: Partial<SchedulingProfessional>) {
    setTeamSettings((current) => ({ ...current, professionals: current.professionals.map((item) => item.userId === userId ? { ...item, ...patch } : item) }));
  }

  const previewService = services.find((item) => item.id === pageForm.serviceId);
  const previewFields = [...BUILTIN_FIELDS.map((field) => ({ id: field.id, type: field.type, label: field.label, required: field.required })), ...pageFields];
  const pageLink = (item: SchedulingPage) => `${window.location.origin}/agendar/${item.slug || item.public_id}`;
  const headerPage = (section === "Páginas" && editingPageId ? pages.find((item) => item.id === editingPageId) : undefined) || pages.find((item) => item.active !== false) || pages[0];
  const headerLink = headerPage ? pageLink(headerPage) : "";
  const serviceName = (item: Booking) => item.service_name || services.find((service) => service.id === item.service_id)?.name || "—";

  async function copyHeaderLink() {
    if (!headerLink) return;
    try { await navigator.clipboard.writeText(headerLink); setNotice("Link copiado."); }
    catch { setError("Não consegui copiar o link. Copie pelo cartão da página."); }
  }

  return <div className="nx-page nx-sc">
    <header className="nx-ph">
      <div><h1>Agendamentos</h1><p>{SECTION_SUBTITLES[section] || "Serviços, disponibilidade, páginas públicas e reservas."}</p></div>
      <div className="nx-ph-actions">
        {(section === "Agendamentos" || section === "Páginas") && <button type="button" className="nx-btn" disabled={!headerLink} title={headerLink || "Crie uma página para gerar o link"} onClick={() => void copyHeaderLink()}>{section === "Páginas" ? <Copy size={16}/> : <Link2 size={16}/>}Copiar link</button>}
        {section === "Páginas" && <button type="button" className="nx-btn" disabled={!headerLink} onClick={() => window.open(headerLink, "_blank", "noopener")}><ExternalLink size={16}/>Abrir página</button>}
        <button type="button" className="nx-btn is-primary" onClick={() => setSection("Serviços")}><Plus size={16}/>Novo serviço</button>
      </div>
    </header>
    <nav className="nx-tabs" aria-label="Seções de agendamentos">{SECTIONS.map((item) => <button key={item} type="button" aria-current={section === item ? "page" : undefined} onClick={() => setSection(item)} className={`nx-tab ${section === item ? "is-active" : ""}`}>{item}</button>)}</nav>
    {error && <div role="alert" className="nx-sc-alert"><span>{error}</span><button type="button" className="nx-btn is-sm" onClick={() => void reload()}>Tentar novamente</button></div>}
    {notice && !error && <div role="status" className="nx-sc-ok">{notice}</div>}
    {loading ? <p className="nx-sc-loading">Carregando agendamentos...</p> : section === "Agendamentos" ? <>
      <div className="nx-kpis">{cards.map(({label,value,Icon}) => <article key={label} className="nx-card nx-kpi"><div className="nx-kpi-l"><Icon size={16}/>{label}</div><div className="nx-kpi-v">{value}</div></article>)}</div>
      <div className="nx-card nx-sc-tablewrap"><table className="nx-table"><thead><tr><th>Cliente</th><th>Serviço</th><th>Profissional</th><th>Data</th><th>Status</th><th>E-mail</th><th>Telefone</th><th>Ações</th></tr></thead><tbody>{bookings.map((item) => { const status = bookingStatus(item.status); return <tr key={item.id}><td className="nx-sc-strong">{item.attendee_name}</td><td className="nx-muted">{serviceName(item)}</td><td className="nx-muted"><span className="nx-sc-who"><i className="nx-sc-dot" style={{background:item.professional_color||"var(--nx-primary)"}}/>{item.professional_name||"Responsável"}</span></td><td className="nx-muted" style={{whiteSpace:"nowrap"}}>{formatDateTime(item.start_at)}</td><td><span className={`nx-badge ${status.tone}`} title={item.status}>{status.label}</span></td><td className="nx-muted">{item.attendee_email}</td><td className="nx-muted" style={{whiteSpace:"nowrap"}}>{item.attendee_phone || "—"}</td><td><div className="nx-sc-acts">{item.status !== "CANCELLED" && <><button type="button" className="nx-btn is-sm" onClick={() => setRescheduling(item)}><Pencil size={14}/>Reagendar</button><button type="button" className="nx-btn is-sm is-ghost" onClick={() => void cancelBooking(item.id)}><Trash2 size={14}/>{pendingConfirm?.kind === "booking" && pendingConfirm.id === item.id ? "Confirmar cancelamento" : "Cancelar"}</button></>}</div></td></tr>; })}{!bookings.length && <tr><td colSpan={8} className="nx-sc-empty">Nenhum agendamento ainda.</td></tr>}</tbody></table></div>
    </> : section === "Calendário da equipe" ? <TeamCalendar events={teamCalendar} professionals={teamSettings.professionals} onSelect={setSelectedBooking}/>
    : section === "Serviços" ? <div className="nx-sc-split"><FormCard title={editingServiceId ? "Editar serviço" : "Novo serviço"}><Field label="Nome"><input value={serviceForm.name} maxLength={120} onChange={(e)=>setServiceForm({...serviceForm,name:e.target.value})}/></Field><Field label="Descrição"><textarea value={serviceForm.description} maxLength={2000} onChange={(e)=>setServiceForm({...serviceForm,description:e.target.value})}/></Field><Field label="Durações em minutos, separadas por vírgula"><input value={serviceForm.durations} onChange={(e)=>setServiceForm({...serviceForm,durations:e.target.value})}/></Field><div className="nx-sc-3"><Field label="Capacidade"><input type="number" min={1} max={500} value={serviceForm.capacity} onChange={(e)=>setServiceForm({...serviceForm,capacity:Number(e.target.value)})}/></Field><Field label="Buffer antes"><input type="number" min={0} value={serviceForm.bufferBefore} onChange={(e)=>setServiceForm({...serviceForm,bufferBefore:Number(e.target.value)})}/></Field><Field label="Buffer depois"><input type="number" min={0} value={serviceForm.bufferAfter} onChange={(e)=>setServiceForm({...serviceForm,bufferAfter:Number(e.target.value)})}/></Field></div>{teamSettings.enabled&&<div className="nx-sc-box"><p className="nx-sc-lbl" style={{margin:0}}>Profissionais que prestam este serviço</p><div style={{display:"grid",gap:8}}>{teamSettings.professionals.filter(item=>item.active).map(item=><label key={item.userId} className="nx-sc-check"><input type="checkbox" checked={serviceForm.professionalIds.includes(item.userId)} onChange={(event)=>setServiceForm({...serviceForm,professionalIds:event.target.checked?[...serviceForm.professionalIds,item.userId]:serviceForm.professionalIds.filter(id=>id!==item.userId)})}/><i className="nx-sc-dot" style={{background:item.color}}/>{item.name} · {item.profession||item.position}</label>)}</div>{!teamSettings.professionals.some(item=>item.active)&&<p className="nx-small" style={{margin:0,color:"var(--nx-warning)"}}>Ative ao menos um profissional em Modo equipe para criar vínculos.</p>}<p className="nx-small" style={{margin:0,color:"var(--nx-primary-text)"}}>{serviceForm.professionalIds.length} profissional(is) selecionado(s). O vínculo será gravado ao salvar o serviço.</p></div>}<div className="nx-sc-btns"><button type="button" className="nx-btn is-primary" disabled={!serviceForm.name||teamSaving} onClick={() => void saveService()}>{editingServiceId ? "Atualizar serviço" : "Criar serviço"}</button>{editingServiceId && <button type="button" className="nx-btn" onClick={() => { setEditingServiceId(""); setServiceForm(EMPTY_SERVICE_FORM); }}>Cancelar</button>}</div></FormCard><div className="nx-sc-services">{services.map((item)=><article key={item.id} className="nx-card nx-sc-svc" style={{borderLeftColor:item.color||"var(--nx-primary)"}}><h3>{item.name}</h3><p className="nx-muted nx-small" style={{margin:"4px 0 0"}}>{item.description || "Sem descrição"}</p><div className="nx-sc-meta"><span><Clock3 size={13}/>{item.durations.join(" / ")} min</span>{(item.location_type || item.location) && <span><MapPin size={13}/>{locationLabel(item)}</span>}<span><Users size={13}/>{item.capacity} vaga(s)</span></div><p className="nx-faint nx-small" style={{margin:"6px 0 0"}}>Buffers {item.buffer_before}/{item.buffer_after} min</p>{teamSettings.enabled&&<p className="nx-faint nx-small" style={{margin:"4px 0 0"}}>{item.professionalIds?.length||0} profissional(is) vinculado(s)</p>}<div className="nx-sc-svc-f"><span className={`nx-badge ${item.active === false ? "" : "is-green"}`}>{item.active === false ? "Fora do link" : "Visível no link"}</span><button type="button" className="nx-btn is-sm is-ghost" onClick={() => startEditService(item)}><Pencil size={14}/>Editar</button><button type="button" className="nx-btn is-sm is-ghost" onClick={() => void archiveService(item.id)}><Trash2 size={14}/>{pendingConfirm?.kind === "service" && pendingConfirm.id === item.id ? "Confirmar arquivamento" : "Arquivar"}</button></div></article>)}{!services.length && <div className="nx-card nx-sc-loading">Nenhum serviço ainda. Crie o primeiro ao lado.</div>}</div></div>
    : section === "Disponibilidade" ? <FormCard title="Disponibilidade semanal">
      <div className={teamSettings.enabled ? "nx-sc-2" : ""}><Field label="Serviço"><select value={availabilityService} onChange={(e)=>setAvailabilityService(e.target.value)}>{services.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      {teamSettings.enabled&&<Field label="Profissional"><select value={availabilityResponsible} onChange={(e)=>setAvailabilityResponsible(e.target.value)}><option value="">Selecione</option>{teamSettings.professionals.filter(item=>item.active&&services.find(service=>service.id===availabilityService)?.professionalIds?.includes(item.userId)).map(item=><option key={item.userId} value={item.userId}>{item.name} · {item.profession||item.position}</option>)}</select></Field>}</div>
      {availLoading
        ? <p className="nx-sc-box nx-sc-loading" style={{margin:0}}>Carregando disponibilidade salva…</p>
        : <><div className="nx-sc-days">{WEEKDAYS.map((label,index)=>{const key=String(index);const item=periods[key];return <div key={label} className="nx-sc-day"><label className="nx-sc-check"><input type="checkbox" checked={item.enabled} onChange={(e)=>setPeriods({...periods,[key]:{...item,enabled:e.target.checked}})}/>{label}</label>{item.enabled ? <div className="nx-sc-slots">{item.slots.map((slot, position) => <div key={position} className="nx-sc-slot"><input aria-label={`${label} início ${position + 1}`} type="time" value={slot.start} onChange={(e)=>updateSlot(key,position,{start:e.target.value})}/><input aria-label={`${label} fim ${position + 1}`} type="time" value={slot.end} onChange={(e)=>updateSlot(key,position,{end:e.target.value})}/>{item.slots.length > 1 ? <button type="button" className="nx-btn is-sm is-ghost" onClick={() => removeSlot(key, position)}>Remover</button> : <span />}</div>)}<div><button type="button" className="nx-btn is-sm" disabled={item.slots.length >= 8} onClick={() => addSlot(key)}><Plus size={14}/>Adicionar período</button></div></div> : <span className="nx-sc-off">Indisponível</span>}</div>})}</div>
      <label className="nx-sc-check"><input type="checkbox" checked={lunch.enabled} onChange={(e)=>setLunch({...lunch,enabled:e.target.checked})}/> Intervalo aplicado ao salvar</label>{lunch.enabled && <div className="nx-sc-2"><input aria-label="Início do intervalo" type="time" value={lunch.start} onChange={(e)=>setLunch({...lunch,start:e.target.value})}/><input aria-label="Fim do intervalo" type="time" value={lunch.end} onChange={(e)=>setLunch({...lunch,end:e.target.value})}/></div>}
      <p className="nx-faint nx-small" style={{margin:0}}>Fuso horário: {availTimezone || "carregando…"}</p>
      <div><button type="button" className="nx-btn is-primary" disabled={!availabilityService||(teamSettings.enabled&&!availabilityResponsible)} onClick={() => void saveAvailability()}>Salvar disponibilidade</button></div>
      {availNotice && <p role="status" className="nx-sc-ok" style={{margin:0}}>{availNotice}</p>}</>}
    </FormCard>
    : section === "Modo equipe" ? <FormCard title="Modo equipe nos agendamentos">
      <label className="nx-sc-switchrow"><span><strong>Ativar agenda compartilhada</strong><small>A alteração é salva imediatamente e permanece após recarregar a página.</small></span><input aria-label="Ativar agenda compartilhada" type="checkbox" disabled={teamSaving} checked={teamSettings.enabled} onChange={(event)=>void persistTeamSettings({...teamSettings,enabled:event.target.checked},event.target.checked?"Modo equipe ativado e salvo.":"Modo equipe desativado e salvo.")} style={{width:18,height:18}}/></label>
      {teamSaving && <p role="status" className="nx-small" style={{margin:0,color:"var(--nx-primary-text)",fontWeight:500}}>Salvando no banco de dados…</p>}
      <div className="nx-sc-pros">{teamSettings.professionals.map((item)=><article key={item.userId} className={`nx-card nx-sc-pro ${item.active?"is-active":""}`}><div className="nx-sc-pro-h">{item.avatarUrl?<img src={item.avatarUrl} alt=""/>:<span className="nx-av">{item.name.slice(0,2).toUpperCase()}</span>}<div className="nx-grow"><strong>{item.name}</strong><small>{item.email}</small></div><input aria-label={`Ativar ${item.name} como profissional`} type="checkbox" disabled={teamSaving||!teamSettings.enabled} checked={item.active} onChange={(event)=>{const next={...teamSettings,professionals:teamSettings.professionals.map((professional)=>professional.userId===item.userId?{...professional,active:event.target.checked}:professional)};void persistTeamSettings(next,event.target.checked?`${item.name} disponível para vincular aos serviços.`:`${item.name} removido dos serviços da agenda.`);}}/></div><div className="nx-sc-pro-f"><input aria-label={`Profissão de ${item.name}`} value={item.profession} placeholder="Profissão" maxLength={120} onChange={(event)=>updateProfessional(item.userId,{profession:event.target.value})}/><input aria-label={`Posição de ${item.name}`} value={item.position} placeholder={item.jobTitle||"Posição"} maxLength={120} onChange={(event)=>updateProfessional(item.userId,{position:event.target.value})}/><input aria-label={`Cor de ${item.name}`} type="color" value={item.color} onChange={(event)=>updateProfessional(item.userId,{color:event.target.value})}/></div></article>)}</div>
      {!teamSettings.professionals.length && <p className="nx-faint nx-small" style={{margin:0}}>Nenhum profissional disponível na equipe.</p>}
      <div><button type="button" className="nx-btn is-primary" disabled={teamSaving} onClick={() => void saveTeamMode()}>{teamSaving?"Salvando…":"Salvar profissão, posição e cores"}</button></div>
    </FormCard>
    : <div className="nx-sc-split is-pages">
      <FormCard title={editingPageId ? "Editar página" : "Nova página"}>
        <Field label="Serviço"><select value={pageForm.serviceId} onChange={(e)=>setPageForm({...pageForm,serviceId:e.target.value})}>{services.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="Título"><input value={pageForm.title} maxLength={120} onChange={(e)=>setPageForm({...pageForm,title:e.target.value})}/></Field>
        <Field label="Descrição"><textarea value={pageForm.description} maxLength={2000} placeholder="Texto exibido na página pública" onChange={(e)=>setPageForm({...pageForm,description:e.target.value})}/></Field>
        <Field label="Slug opcional"><input value={pageForm.slug} maxLength={64} placeholder="consultoria" onChange={(e)=>setPageForm({...pageForm,slug:e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,"")})}/></Field>
        <p className="nx-sc-link" style={{marginTop:-8}}><Link2 size={13}/>{window.location.origin}/agendar/{pageForm.slug || "…"}</p>
        <label className="nx-sc-box">
          <span className="nx-sc-lbl">Logo da página <span className="nx-faint" style={{fontWeight:400}}>PNG, JPEG ou WebP · máximo 2 MB</span></span>
          <input aria-label="Logo da página" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event)=>void selectPageLogo(event.target.files?.[0])}/>
          {pageLogo.name && <span className="nx-small">Selecionado: {pageLogo.name}</span>}
          {!pageLogo.name && currentLogoUrl && <span className="nx-small">Logo atual mantido.</span>}
        </label>
        <div>
          <p className="nx-sc-lbl" style={{margin:"0 0 8px"}}>Cores e tema</p>
          <div className="nx-sc-colors">
            <Field label="Principal"><input aria-label="Cor principal" type="color" value={pageForm.primary} onChange={(e)=>setPageForm({...pageForm,primary:e.target.value})}/></Field>
            <Field label="Secundária"><input aria-label="Cor secundária" type="color" value={pageForm.secondary} onChange={(e)=>setPageForm({...pageForm,secondary:e.target.value})}/></Field>
            <Field label="Destaque"><input aria-label="Cor de destaque" type="color" value={pageForm.accent} onChange={(e)=>setPageForm({...pageForm,accent:e.target.value})}/></Field>
            <Field label="Fundo"><input type="color" value={pageForm.background} onChange={(e)=>setPageForm({...pageForm,background:e.target.value})}/></Field>
            <Field label="Texto"><input type="color" value={pageForm.text} onChange={(e)=>setPageForm({...pageForm,text:e.target.value})}/></Field>
          </div>
          <div className="nx-seg" role="group" aria-label="Modo" style={{marginTop:10}}>{PAGE_MODES.map(([value,label]) => <button key={value} type="button" aria-pressed={pageForm.mode === value} className={pageForm.mode === value ? "is-active" : ""} onClick={()=>setPageForm({...pageForm,mode:value})}>{label}</button>)}</div>
        </div>
        <div>
          <p className="nx-sc-lbl" style={{margin:"0 0 4px"}}>Campos pedidos ao cliente</p>
          {BUILTIN_FIELDS.map((field)=><div key={field.id} className="nx-sc-fieldrow"><span className="nx-grow">{field.label}</span><span className={`nx-badge ${field.required ? "is-blue" : ""}`}>{field.required ? "Obrigatório" : "Opcional"}</span></div>)}
          {pageFields.map((field)=><div key={field.id} className="nx-sc-fieldrow"><span className="nx-grow">{field.label} · {field.type}{field.required?" · obrigatório":""}</span><span className={`nx-badge ${field.required ? "is-blue" : ""}`}>{field.required ? "Obrigatório" : "Opcional"}</span><button type="button" className="nx-btn is-sm is-ghost" onClick={()=>setPageFields(pageFields.filter((item)=>item.id!==field.id))}>Remover</button></div>)}
        </div>
        <div className="nx-sc-box"><p className="nx-sc-lbl" style={{margin:0}}>Campo personalizado</p><div className="nx-sc-2"><input aria-label="Rótulo do campo" value={customField.label} maxLength={120} onChange={(e)=>setCustomField({...customField,label:e.target.value})}/><select aria-label="Tipo do campo" value={customField.type} onChange={(e)=>setCustomField({...customField,type:e.target.value})}><option value="text">Texto</option><option value="textarea">Texto longo</option><option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="phone">Telefone / WhatsApp</option><option value="email">E-mail</option><option value="date">Data</option><option value="number">Número</option><option value="boolean">Sim/não</option></select></div><div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}><label className="nx-sc-check"><input type="checkbox" checked={customField.required} onChange={(e)=>setCustomField({...customField,required:e.target.checked})}/> Obrigatório</label><button type="button" className="nx-btn is-sm" onClick={()=>{if(!customField.label.trim())return;setPageFields([...pageFields,{...customField,label:customField.label.trim(),id:`field_${crypto.randomUUID().slice(0,8)}`,maxLength:customFieldMaxLength(customField.type)}]);}}><Plus size={14}/>Adicionar</button></div></div>
        <div className="nx-sc-btns"><button type="button" className="nx-btn is-primary" disabled={!pageForm.serviceId||!pageForm.title} onClick={() => void savePage()}>{editingPageId ? "Atualizar página" : "Gerar link com esta identidade"}</button>{editingPageId && <button type="button" className="nx-btn" onClick={resetPageForm}>Cancelar</button>}</div>
      </FormCard>
      <div className="nx-sc-side">
        <div className="nx-sc-sticky"><PagePreview serviceName={previewService?.name || ""} title={pageForm.title} description={pageForm.description} identity={{ primary: pageForm.primary, secondary: pageForm.secondary, accent: pageForm.accent, background: pageForm.background, text: pageForm.text, mode: pageForm.mode }} logoSrc={pageLogo.preview || (currentLogoUrl ? `${apiBaseUrl()}${currentLogoUrl}` : "")} fields={previewFields} /></div>
        {pages.map((item)=>{const link=pageLink(item);return <article key={item.id} className="nx-card nx-sc-page"><div style={{display:"flex",alignItems:"center",gap:8}}><h3 className="nx-grow">{item.title}</h3><span className={`nx-badge ${item.active === false ? "" : "is-green"}`}>{item.active === false ? "Arquivada" : "No ar"}</span></div><p className="nx-sc-link"><Link2 size={13}/>{link}</p><div className="nx-sc-btns" style={{marginTop:12}}><button type="button" className="nx-btn is-sm" onClick={()=>void navigator.clipboard.writeText(link)}><Copy size={14}/>Copiar</button><button type="button" className="nx-btn is-sm" onClick={()=>window.open(link,"_blank","noopener")}><ExternalLink size={14}/>Visualizar</button><button type="button" className="nx-btn is-sm" onClick={()=>startEditPage(item)}><Pencil size={14}/>Editar</button><button type="button" className="nx-btn is-sm is-ghost" onClick={()=>void archivePage(item.id)}><Trash2 size={14}/>{pendingConfirm?.kind === "page" && pendingConfirm.id === item.id ? "Confirmar arquivamento" : "Arquivar"}</button><label className="nx-btn is-sm is-ghost nx-sc-upload"><Upload size={14}/>Trocar logo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event)=>void uploadLogo(item.id,event.target.files?.[0])}/></label></div></article>})}
      </div>
    </div>}
    {selectedBooking && (
      <BookingDetailsDialog booking={selectedBooking} onClose={() => setSelectedBooking(null)} onReschedule={() => { setRescheduling(selectedBooking); setSelectedBooking(null); }}/>
    )}
    {rescheduling && <RescheduleDialog key={rescheduling.id} booking={rescheduling} services={services} professionals={teamSettings.professionals} onClose={() => setRescheduling(null)} onSaved={() => void reload()} />}
  </div>;
}

const SECTIONS = ["Agendamentos","Calendário da equipe","Serviços","Disponibilidade","Páginas","Modo equipe"];
const SECTION_SUBTITLES: Record<string, string> = {
  "Agendamentos": "Clientes marcam horário sozinhos pelo seu link",
  "Calendário da equipe": "Agenda da semana com os horários de cada profissional",
  "Serviços": "Serviços que o cliente pode marcar pelo link",
  "Disponibilidade": "Dias e horários em que o cliente pode marcar",
  "Páginas": "Página com link para o cliente marcar horário sozinho",
  "Modo equipe": "Profissionais que atendem pelos agendamentos",
};
const PAGE_MODES: Array<[string, string]> = [["auto", "Automático"], ["light", "Claro"], ["dark", "Escuro"]];
const BOOKING_STATUS: Record<string, { label: string; tone: string }> = {
  CONFIRMED: { label: "Confirmado", tone: "is-green" },
  PENDING: { label: "Pendente", tone: "is-amber" },
  CANCELLED: { label: "Cancelado", tone: "is-red" },
  COMPLETED: { label: "Concluído", tone: "is-blue" },
  RESCHEDULED: { label: "Reagendado", tone: "is-violet" },
  NO_SHOW: { label: "Não compareceu", tone: "is-red" },
};

function bookingStatus(status: string) {
  return BOOKING_STATUS[status] || { label: status, tone: "" };
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString("pt-BR")} ${date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}

function locationLabel(item: SchedulingService) {
  const type = (item.location_type || "").toLowerCase();
  const label = type === "online" ? "Online" : type === "presencial" || type === "in_person" ? "Presencial" : type === "phone" || type === "telefone" ? "Chamada" : item.location_type || "";
  return [label, item.location].filter(Boolean).join(" · ");
}

function FormCard({title,children}:{title:string;children:ReactNode}) { return <section className="nx-card nx-sc-form"><h2>{title}</h2>{children}</section>; }
function Field({label,children}:{label:string;children:ReactNode}) { return <label className="nx-sc-field"><span>{label}</span><div>{children}</div></label>; }

const CALENDAR_START_HOUR = 7;
const CALENDAR_END_HOUR = 22;
const CALENDAR_HOUR_HEIGHT = 84;

function localDateKey(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}

function TeamCalendar({events,professionals,onSelect}:{events:Booking[];professionals:SchedulingProfessional[];onSelect:(booking:Booking)=>void}) {
  const start = new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate()-((start.getDay()+6)%7));
  const days = Array.from({length:7},(_,index)=>{const value=new Date(start);value.setDate(start.getDate()+index);return value;});
  const hours = Array.from({length:CALENDAR_END_HOUR-CALENDAR_START_HOUR+1},(_,index)=>CALENDAR_START_HOUR+index);
  const bodyHeight=(CALENDAR_END_HOUR-CALENDAR_START_HOUR)*CALENDAR_HOUR_HEIGHT;
  const todayKey = localDateKey(new Date());
  return <section className="nx-card" style={{overflow:"hidden"}}><header className="nx-sc-cal-h"><div><h2>Calendário da equipe</h2><p>Semana de {start.toLocaleDateString("pt-BR")} · clique em um agendamento para ver os detalhes</p></div><div className="nx-sc-cal-legend">{professionals.filter(item=>item.active).map(item=><span key={item.userId} className="nx-badge"><i className="nx-sc-dot" style={{background:item.color,width:8,height:8}}/>{item.name}</span>)}</div></header><div className="nx-sc-cal-scroll"><div style={{minWidth:1260}}><div className="nx-sc-cal-grid" style={{borderBottom:"1px solid var(--nx-border)"}}><div className="nx-sc-cal-day" style={{borderLeft:0,alignSelf:"center"}}><strong>Horário</strong></div>{days.map(day=><div key={localDateKey(day)} className={`nx-sc-cal-day ${localDateKey(day)===todayKey?"is-today":""}`}><strong>{day.toLocaleDateString("pt-BR",{weekday:"short"})}</strong><span>{day.getDate()}</span></div>)}</div><div className="nx-sc-cal-grid"><div className="nx-sc-cal-hours" style={{height:bodyHeight}}>{hours.map(hour=><span key={hour} style={{top:Math.max(8,(hour-CALENDAR_START_HOUR)*CALENDAR_HOUR_HEIGHT)}}>{String(hour).padStart(2,"0")}:00</span>)}</div>{days.map(day=>{const key=localDateKey(day);const dayEvents=events.filter(item=>localDateKey(item.start_at)===key&&item.status!=="CANCELLED");return <div key={key} className="nx-sc-cal-col" style={{height:bodyHeight,backgroundImage:`repeating-linear-gradient(to bottom, transparent 0, transparent ${CALENDAR_HOUR_HEIGHT-1}px, var(--nx-border) ${CALENDAR_HOUR_HEIGHT-1}px, var(--nx-border) ${CALENDAR_HOUR_HEIGHT}px)`}}>{dayEvents.map(item=>{const itemStart=new Date(item.start_at);const itemEnd=new Date(item.end_at);const startMinutes=itemStart.getHours()*60+itemStart.getMinutes();const endMinutes=itemEnd.getHours()*60+itemEnd.getMinutes();const top=Math.max(0,((startMinutes-CALENDAR_START_HOUR*60)/60)*CALENDAR_HOUR_HEIGHT);const height=Math.max(76,((endMinutes-startMinutes)/60)*CALENDAR_HOUR_HEIGHT);return <button type="button" aria-label={`Abrir agendamento de ${item.attendee_name}`} key={item.id} onClick={()=>onSelect(item)} className="nx-sc-cal-ev" style={{top,height,borderLeftColor:item.professional_color||"var(--nx-primary)"}}><strong>{itemStart.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}–{itemEnd.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})} · {item.attendee_name}</strong><small>{item.service_name||"Serviço"}</small><small style={{color:item.professional_color||"var(--nx-primary-text)",fontWeight:500}}>{item.professional_name||"Responsável"}</small></button>})}</div>})}</div></div></div></section>;
}

function BookingDetailsDialog({booking,onClose,onReschedule}:{booking:Booking;onClose:()=>void;onReschedule:()=>void}) {
  const status = bookingStatus(booking.status);
  return <div className="nx-sc-overlay" role="dialog" aria-modal="true" aria-label={`Detalhes do agendamento de ${booking.attendee_name}`}><div className="nx-card nx-sc-modal" style={{maxWidth:520}}><div className="nx-sc-modal-h"><div className="nx-grow"><p style={{margin:0}}>Agendamento</p><h2>{booking.attendee_name}</h2></div><button type="button" className="nx-btn is-sm" onClick={onClose}>Fechar</button></div><div className="nx-sc-modal-b"><dl className="nx-sc-dl"><dt>Serviço</dt><dd>{booking.service_name||"Serviço"}</dd><dt>Profissional</dt><dd>{booking.professional_name||"Responsável"}</dd><dt>Início</dt><dd>{formatDateTime(booking.start_at)}</dd><dt>Fim</dt><dd>{formatDateTime(booking.end_at)}</dd><dt>Status</dt><dd><span className={`nx-badge ${status.tone}`} title={booking.status}>{status.label}</span></dd><dt>E-mail</dt><dd>{booking.attendee_email}</dd><dt>Telefone</dt><dd>{booking.attendee_phone||"Não informado"}</dd></dl>{booking.status!=="CANCELLED"&&<div><button type="button" className="nx-btn is-primary" onClick={onReschedule}><Pencil size={14}/>Reagendar ou trocar profissional</button></div>}</div></div></div>;
}
