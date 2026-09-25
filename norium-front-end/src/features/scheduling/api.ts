import { apiRequest } from "../../core/api/client";

export type SchedulingService = {
  id: string; name: string; description: string; durations: number[]; color: string;
  buffer_before: number; buffer_after: number; capacity: number; slot_interval: number; active: boolean;
  location_type?: string; location?: string; instructions?: string;
  minimum_notice_minutes?: number; maximum_days?: number;
  professionalIds?: string[];
};
export type SchedulingPage = { id: string; public_id: string; service_id: string; slug?: string; title: string; description: string; fields: BookingField[]; theme: Record<string,string>; logo_url?: string; active: boolean };
export type BookingField = { id: string; type: string; label: string; required?: boolean; maxLength?: number };
export type Booking = { id: string; service_id: string; responsible_id?: string; attendee_name: string; attendee_email: string; attendee_phone?: string | null; start_at: string; end_at: string; timezone?: string; status: string; service_name?: string; professional_name?: string; professional_color?: string };
export type SchedulingProfessional = { userId: string; name: string; email: string; avatarUrl?: string; jobTitle?: string; active: boolean; profession: string; position: string; color: string };
export type TeamSchedulingSettings = { enabled: boolean; professionals: SchedulingProfessional[] };
export type AvailabilityPeriod = { start: string; end: string };
export type Availability = { service_id?: string | null; timezone: string; weekly: Record<string, AvailabilityPeriod[]>; exceptions?: Record<string, AvailabilityPeriod[]>; blocked?: Array<{start:string;end:string}> };
export type Slot = { startAt: string; endAt: string; remaining: number };
export type SlotsResponse = { slots: Slot[]; date?: string; timezone?: string; calendarVerified?: boolean };
export type ChannelReceipt = { sent: boolean; replay?: boolean; uncertain?: boolean; queued?: boolean; receipt?: Record<string,string>; error?: string; needsConnection?: boolean } | null;
export type NotifyPreview = {
  bookingId: string; serviceName: string; timezone: string;
  oldStartAt: string; oldEndAt: string; newStartAt: string; newEndAt: string;
  attendeeName: string; attendeeEmail: string; attendeePhone?: string | null; phoneValid: boolean;
  gmailConnected: boolean; whatsappConnected: boolean;
  gmailSubject: string; gmailBody: string; whatsappMessage: string;
  professionalChanged?: boolean; previousProfessionalName?: string; newProfessionalName?: string; signature?: string;
};
export type RescheduleResult = { booking: Booking; replay: boolean; calendarSync?: { synced: boolean; queued?: boolean; verifiedBeforeSave?: boolean; error?: string }; receipts: { gmail: ChannelReceipt; whatsapp: ChannelReceipt } };

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
  return apiRequest<T>(path, { ...init, timeoutMs: init?.timeoutMs ?? 15_000 });
}

// Cache curto de horários públicos: evita chamadas repetidas ao alternar dia/duração.
const slotsCache = new Map<string, { at: number; data: SlotsResponse }>();
const SLOTS_CACHE_TTL_MS = 30_000;

export function slotsCacheKey(pageId: string, day: string, duration: number, responsibleId = "", serviceId = "") {
  return `${pageId}::${day}::${duration}::${responsibleId}::${serviceId}`;
}

export function clearSlotsCache(pageId?: string) {
  if (!pageId) { slotsCache.clear(); return; }
  for (const key of slotsCache.keys()) {
    if (key.startsWith(`${pageId}::`)) slotsCache.delete(key);
  }
}

export const schedulingApi = {
  dashboard: async (): Promise<{services:SchedulingService[];pages:SchedulingPage[];bookings:Booking[];teamSettings?:TeamSchedulingSettings;teamCalendar?:Booking[]}> => {
    const [services, pages, bookings, teamSettings, teamCalendar] = await Promise.all([
      request<{services: SchedulingService[]}>("/api/scheduling/services"),
      request<{pages: SchedulingPage[]}>("/api/scheduling/pages"),
      request<{bookings: Booking[]}>("/api/scheduling/bookings"),
      request<TeamSchedulingSettings>("/api/scheduling/team-settings"),
      request<{events: Booking[]}>("/api/scheduling/team-calendar"),
    ]);
    return { services: services.services, pages: pages.pages, bookings: bookings.bookings, teamSettings, teamCalendar: teamCalendar.events };
  },
  createService: (body: unknown) => request<SchedulingService>("/api/scheduling/services", { method: "POST", body: JSON.stringify(body) }),
  updateService: (id: string, body: unknown) => request<SchedulingService>(`/api/scheduling/services/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  archiveService: (id: string) => request<{service: SchedulingService; activePages: number; activeBookings: number}>(`/api/scheduling/services/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getAvailability: (serviceId: string | null, responsibleId?: string) => request<Availability>(`/api/scheduling/availability?${new URLSearchParams({ ...(serviceId ? {serviceId} : {}), ...(responsibleId ? {responsibleId} : {}) })}`),
  setAvailability: (body: unknown) => request<Availability>("/api/scheduling/availability", { method: "PUT", body: JSON.stringify(body) }),
  createPage: (body: unknown) => request<SchedulingPage>("/api/scheduling/pages", { method: "POST", body: JSON.stringify(body) }),
  updatePage: (id: string, body: unknown) => request<SchedulingPage>(`/api/scheduling/pages/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  archivePage: (id: string) => request<void>(`/api/scheduling/pages/${encodeURIComponent(id)}`, { method: "DELETE" }),
  uploadLogo: (pageId: string, dataBase64: string) => request<{logoUrl:string}>(`/api/scheduling/pages/${encodeURIComponent(pageId)}/logo`, { method: "POST", body: JSON.stringify({dataBase64}) }),
  updateBookingStatus: (id: string, status: string) => request<Booking>(`/api/scheduling/bookings/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({status}) }),
  notifyPreview: (id: string, startAt: string, duration: number, responsibleId = "", signoff: "team" | "professional" = "team") => request<NotifyPreview>(`/api/scheduling/bookings/${encodeURIComponent(id)}/notify-preview?${new URLSearchParams({startAt,duration:String(duration),...(responsibleId?{responsibleId}:{}),signoff})}`, { timeoutMs: 6_000 }),
  adminReschedule: (id: string, body: {startAt:string;duration:number;responsibleId?:string|null;notifyGmail:boolean;notifyWhatsapp:boolean;gmailSubject:string;gmailBody:string;whatsappMessage:string;operationKey:string;signoff:"team"|"professional"}) => request<RescheduleResult>(`/api/scheduling/bookings/${encodeURIComponent(id)}/reschedule`, { method: "POST", body: JSON.stringify(body), timeoutMs: 8_000 }),
  teamSettings: () => request<TeamSchedulingSettings>("/api/scheduling/team-settings"),
  saveTeamSettings: (body: {enabled:boolean;professionals:Array<{userId:string;active:boolean;profession:string;position:string;color:string}>}) => request<TeamSchedulingSettings>("/api/scheduling/team-settings", {method:"PUT",body:JSON.stringify(body)}),
  teamCalendar: (startAt?: string, endAt?: string) => request<{events:Booking[]}>(`/api/scheduling/team-calendar?${new URLSearchParams({...(startAt?{startAt}:{}),...(endAt?{endAt}:{})})}`),
  publicPage: (id: string) => request<{page: SchedulingPage; service: SchedulingService; services?: SchedulingService[]; professionals?: Array<{id:string;name:string;avatarUrl?:string;profession:string;position:string;color:string}>; teamMode?:boolean}>(`/api/public/scheduling/pages/${encodeURIComponent(id)}`, { timeoutMs: 6_000 }),
  slots: (id: string, day: string, duration: number, signal?: AbortSignal, responsibleId = "", serviceId = "") => request<SlotsResponse>(`/api/public/scheduling/pages/${encodeURIComponent(id)}/slots?${new URLSearchParams({day,duration:String(duration),...(responsibleId?{responsibleId}:{}),...(serviceId?{serviceId}:{})})}`, { signal }),
  slotsCached: async (id: string, day: string, duration: number, signal?: AbortSignal, responsibleId = "", serviceId = ""): Promise<SlotsResponse> => {
    const key = slotsCacheKey(id, day, duration, responsibleId, serviceId);
    const cached = slotsCache.get(key);
    if (cached && Date.now() - cached.at < SLOTS_CACHE_TTL_MS) return cached.data;
    const data = await request<SlotsResponse>(`/api/public/scheduling/pages/${encodeURIComponent(id)}/slots?${new URLSearchParams({day,duration:String(duration),...(responsibleId?{responsibleId}:{}),...(serviceId?{serviceId}:{})})}`, { signal, timeoutMs: 6_000 });
    if (!signal?.aborted) slotsCache.set(key, { at: Date.now(), data });
    return data;
  },
  book: (id: string, body: unknown) => request<{booking:{public_id:string;status:string};cancelToken:string;rescheduleToken:string}>(`/api/public/scheduling/pages/${encodeURIComponent(id)}/bookings`, { method: "POST", body: JSON.stringify(body), timeoutMs: 8_000 }),
};
