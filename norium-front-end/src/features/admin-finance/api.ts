import { apiBlobRequest, apiRequest } from "../../core/api/client";
import type {
  AdminFinanceDashboardData,
  AuditLog,
  Expense,
  FinanceBudget,
  FinanceGoal,
  FinancePlan,
  FinanceReference,
  FinanceSettings,
  ImportPreview,
  PagedResult,
  Payment,
  Subscription,
} from "./types";

const ROOT = "/api/admin/finance";

function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") search.set(key, String(value));
  });
  const suffix = search.toString();
  return suffix ? `?${suffix}` : "";
}

export const adminFinanceApi = {
  dashboard: (token: string, params: Record<string, string | undefined>) =>
    apiRequest<AdminFinanceDashboardData>(`${ROOT}/dashboard${query(params)}`, { token }),
  cashFlow: (token: string, days = 90) =>
    apiRequest<{ items: Array<{ date: string; inflowCents: number; outflowCents: number; balanceCents: number }> }>(`${ROOT}/cash-flow?days=${days}`, { token }),
  plans: (token: string) => apiRequest<{ items: FinancePlan[] }>(`${ROOT}/plans`, { token }),
  subscriptions: (token: string, params: Record<string, string | number | undefined> = {}) =>
    apiRequest<PagedResult<Subscription>>(`${ROOT}/subscriptions${query(params)}`, { token }),
  payments: (token: string, params: Record<string, string | number | undefined> = {}) =>
    apiRequest<PagedResult<Payment>>(`${ROOT}/payments${query(params)}`, { token }),
  expenses: (token: string, params: Record<string, string | number | undefined> = {}) =>
    apiRequest<PagedResult<Expense>>(`${ROOT}/expenses${query(params)}`, { token }),
  references: (token: string, kind: string) => apiRequest<{ items: FinanceReference[] }>(`${ROOT}/references/${kind}`, { token }),
  goals: (token: string) => apiRequest<{ items: FinanceGoal[] }>(`${ROOT}/goals`, { token }),
  budgets: (token: string) => apiRequest<{ items: FinanceBudget[] }>(`${ROOT}/budgets`, { token }),
  settings: (token: string) => apiRequest<{ settings: FinanceSettings }>(`${ROOT}/settings`, { token }),
  audit: (token: string, params: Record<string, string | number | undefined> = {}) =>
    apiRequest<PagedResult<AuditLog>>(`${ROOT}/audit${query(params)}`, { token }),
  jorro: (token: string) => apiRequest<Record<string, unknown>>(`${ROOT}/jorro/status`, { token }),
  syncJorro: (token: string) => apiRequest<Record<string, unknown>>(`${ROOT}/jorro/sync`, { token, method: "POST" }),
  create: <T>(token: string, collection: string, payload: Record<string, unknown>) =>
    apiRequest<{ item: T }>(`${ROOT}/${collection}`, { token, method: "POST", body: JSON.stringify(payload) }),
  update: <T>(token: string, collection: string, id: string, payload: Record<string, unknown>) =>
    apiRequest<{ item: T }>(`${ROOT}/${collection}/${id}`, { token, method: "PATCH", body: JSON.stringify(payload) }),
  remove: (token: string, collection: string, id: string) =>
    apiRequest<{ deleted: boolean }>(`${ROOT}/${collection}/${id}`, { token, method: "DELETE" }),
  duplicate: <T>(token: string, collection: "plans" | "expenses", id: string) =>
    apiRequest<{ item: T }>(`${ROOT}/${collection}/${id}/duplicate`, { token, method: "POST" }),
  createReference: (token: string, kind: string, payload: Record<string, unknown>) =>
    apiRequest<{ item: FinanceReference }>(`${ROOT}/references/${kind}`, { token, method: "POST", body: JSON.stringify(payload) }),
  updateReference: (token: string, kind: string, id: string, payload: Record<string, unknown>) =>
    apiRequest<{ item: FinanceReference }>(`${ROOT}/references/${kind}/${id}`, { token, method: "PATCH", body: JSON.stringify(payload) }),
  removeReference: (token: string, kind: string, id: string) =>
    apiRequest<{ deleted: boolean }>(`${ROOT}/references/${kind}/${id}`, { token, method: "DELETE" }),
  saveSettings: (token: string, payload: FinanceSettings) =>
    apiRequest<{ settings: FinanceSettings }>(`${ROOT}/settings`, { token, method: "PUT", body: JSON.stringify(payload) }),
  bulkExpenseStatus: (token: string, ids: string[], status: string) =>
    apiRequest<{ updated: number }>(`${ROOT}/expenses/bulk-status`, { token, method: "POST", body: JSON.stringify({ ids, status }) }),
  previewImport: (token: string, file: File) => apiRequest<ImportPreview>(`${ROOT}/import/preview?fileName=${encodeURIComponent(file.name)}`, {
    token,
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
    timeoutMs: 60_000,
  }),
  commitImport: (token: string, payload: Record<string, unknown>) =>
    apiRequest<{ created: number; errors: Array<Record<string, unknown>> }>(`${ROOT}/import/commit`, { token, method: "POST", body: JSON.stringify(payload), timeoutMs: 60_000 }),
  exportFile: (token: string, format: "csv" | "xlsx" | "pdf") => apiBlobRequest(`${ROOT}/export/${format}`, { token }),
};
