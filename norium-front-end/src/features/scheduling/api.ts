import { apiBaseUrl } from "../../core/api/config";

export type SchedulingService = {
  id: string; name: string; description: string; durations: number[]; color: string;
  buffer_before: number; buffer_after: number; capacity: number; slot_interval: number; active: boolean;
};
export type SchedulingPage = { id: string; public_id: string; service_id: string; slug?: string; title: string; description: string; fields: BookingField[]; theme: Record<string,string>; logo_url?: string; active: boolean };
export type BookingField = { id: string; type: string; label: string; required?: boolean; maxLength?: number };
export type Booking = { id: string; service_id: string; attendee_name: string; attendee_email: string; start_at: string; end_at: string; status: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Não foi possível concluir a operação.");
  return data as T;
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
  setAvailability: (body: unknown) => request("/api/scheduling/availability", { method: "PUT", body: JSON.stringify(body) }),
  createPage: (body: unknown) => request<SchedulingPage>("/api/scheduling/pages", { method: "POST", body: JSON.stringify(body) }),
  uploadLogo: (pageId: string, dataBase64: string) => request<{logoUrl:string}>(`/api/scheduling/pages/${encodeURIComponent(pageId)}/logo`, { method: "POST", body: JSON.stringify({dataBase64}) }),
  publicPage: (id: string) => request<{page: SchedulingPage; service: SchedulingService}>(`/api/public/scheduling/pages/${encodeURIComponent(id)}`),
  slots: (id: string, day: string, duration: number) => request<{slots: {startAt:string;endAt:string;remaining:number}[]}>(`/api/public/scheduling/pages/${encodeURIComponent(id)}/slots?day=${day}&duration=${duration}`),
  book: (id: string, body: unknown) => request<{booking:{public_id:string;status:string};cancelToken:string;rescheduleToken:string}>(`/api/public/scheduling/pages/${encodeURIComponent(id)}/bookings`, { method: "POST", body: JSON.stringify(body) }),
};
