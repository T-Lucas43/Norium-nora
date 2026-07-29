import { apiRequest } from "../core/api/client";

export async function authJson<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  return apiRequest<T>(path, { ...init, token });
}
