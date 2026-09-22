import { apiRequest } from "../../core/api/client";

export type SchedulingService = {
  id: string; name: string; description: string; durations: number[]; color: string;
  buffer_before: number; buffer_after: number; capacity: number; slot_interval: number; active: boolean;
  location_type?: string; location?: string; instructions?: string;
  minimum_notice_minutes?: number; maximum_days?: number;
};
export type SchedulingPage = { id: string; public_id: string; service_id: string; slug?: string; title: string; description: string; fields: BookingField[]; theme: Record<string,string>; logo_url?: string; active: boolean };
export type BookingField = { id: string; type: string; label: string; required?: boolean; maxLength?: number };
export type Booking = { id: string; service_id: string; attendee_name: string; attendee_email: string; attendee_phone?: string | null; start_at: string; end_at: string; timezone?: string; status: string };
export type AvailabilityPeriod = { start: string; end: string };
export type Availability = { service_id?: string | null; timezone: string; weekly: Record<string, AvailabilityPeriod[]>; exceptions?: Record<string, AvailabilityPeriod[]>; blocked?: Array<{start:string;end:string}> };
export type Slot = { startAt: string; endAt: string; remaining: number };
export type SlotsResponse = { slots: Slot[]; date?: string; timezone?: string; calendarVerified?: boolean };
export type ChannelReceipt = { sent: boolean; replay?: boolean; uncertain?: boolean; receipt?: Record<string,string>; error?: string; needsConnection?: boolean } | null;
export type NotifyPreview = {
  bookingId: string; serviceName: string; timezone: string;
  oldStartAt: string; oldEndAt: string; newStartAt: string; newEndAt: string;
  attendeeName: string; attendeeEmail: string; attendeePhone?: string | null; phoneValid: boolean;
  gmailConnected: boolean; whatsappConnected: boolean;
  gmailSubject: string; gmailBody: string; whatsappMessage: string;
};
export type RescheduleResult = { booking: Booking; replay: boolean; calendarSync?: { synced: boolean; error?: string }; receipts: { gmail: ChannelReceipt; whatsapp: ChannelReceipt } };

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
  return apiRequest<T>(path, { ...init, timeoutMs: init?.timeoutMs ?? 15_000 });
}

// Cache curto de horários públicos: evita chamadas repetidas ao alternar dia/duração.
const slotsCache = new Map<string, { at: number; data: SlotsResponse }>();
const SLOTS_CACHE_TTL_MS = 30_000;

export function slotsCacheKey(pageId: string, day: string, duration: number) {
  return `${pageId}::${day}::${duration}`;
}

export function clearSlotsCache(pageId?: string) {
  if (!pageId) { slotsCache.clear(); return; }
  for (const key of slotsCache.keys()) {
    if (key.startsWith(`${pageId}::`)) slotsCache.delete(key);
  }
}

export const schedulingApi = {
  dashboard: async () => {
    const [services, pages, bookings] = await Promise.all([
      request<{services: SchedulingService[]}>("/api/scheduling/services"),
      request<{pages: SchedulingPage[]}>("/api/scheduling/pages"),
      request<{bookings: Booking[]}>("/api/scheduling/bookings"),
    ]);
    return { services: services.services, pages: pages.pages, bookings: bookings.bookings };
  },
  createService: (body: unknown) => request<SchedulingService>("/api/scheduling/services", { method: "POST", body: JSON.stringify(body) }),
  updateService: (id: string, body: unknown) => request<SchedulingService>(`/api/scheduling/services/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  archiveService: (id: string) => request<{service: SchedulingService; activePages: number; activeBookings: number}>(`/api/scheduling/services/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getAvailability: (serviceId: string | null) => request<Availability>(serviceId ? `/api/scheduling/availability?serviceId=${encodeURIComponent(serviceId)}` : "/api/scheduling/availability"),
  setAvailability: (body: unknown) => request<Availability>("/api/scheduling/availability", { method: "PUT", body: JSON.stringify(body) }),
  createPage: (body: unknown) => request<SchedulingPage>("/api/scheduling/pages", { method: "POST", body: JSON.stringify(body) }),
  updatePage: (id: string, body: unknown) => request<SchedulingPage>(`/api/scheduling/pages/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  archivePage: (id: string) => request<void>(`/api/scheduling/pages/${encodeURIComponent(id)}`, { method: "DELETE" }),
  uploadLogo: (pageId: string, dataBase64: string) => request<{logoUrl:string}>(`/api/scheduling/pages/${encodeURIComponent(pageId)}/logo`, { method: "POST", body: JSON.stringify({dataBase64}) }),
  updateBookingStatus: (id: string, status: string) => request<Booking>(`/api/scheduling/bookings/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({status}) }),
  notifyPreview: (id: string, startAt: string, duration: number) => request<NotifyPreview>(`/api/scheduling/bookings/${encodeURIComponent(id)}/notify-preview?startAt=${encodeURIComponent(startAt)}&duration=${duration}`),
  adminReschedule: (id: string, body: {startAt:string;duration:number;notifyGmail:boolean;notifyWhatsapp:boolean;gmailSubject:string;gmailBody:string;whatsappMessage:string;operationKey:string}) => request<RescheduleResult>(`/api/scheduling/bookings/${encodeURIComponent(id)}/reschedule`, { method: "POST", body: JSON.stringify(body) }),
  publicPage: (id: string) => request<{page: SchedulingPage; service: SchedulingService}>(`/api/public/scheduling/pages/${encodeURIComponent(id)}`),
  slots: (id: string, day: string, duration: number, signal?: AbortSignal) => request<SlotsResponse>(`/api/public/scheduling/pages/${encodeURIComponent(id)}/slots?day=${day}&duration=${duration}`, { signal }),
  slotsCached: async (id: string, day: string, duration: number, signal?: AbortSignal): Promise<SlotsResponse> => {
    const key = slotsCacheKey(id, day, duration);
    const cached = slotsCache.get(key);
    if (cached && Date.now() - cached.at < SLOTS_CACHE_TTL_MS) return cached.data;
    const data = await request<SlotsResponse>(`/api/public/scheduling/pages/${encodeURIComponent(id)}/slots?day=${day}&duration=${duration}`, { signal });
    if (!signal?.aborted) slotsCache.set(key, { at: Date.now(), data });
    return data;
  },
  book: (id: string, body: unknown) => request<{booking:{public_id:string;status:string};cancelToken:string;rescheduleToken:string}>(`/api/public/scheduling/pages/${encodeURIComponent(id)}/bookings`, { method: "POST", body: JSON.stringify(body) }),
};
