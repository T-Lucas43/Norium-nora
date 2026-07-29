// Adaptador Gmail com timeout proprio, preservando os endpoints existentes.
import { ApiError, apiRequest } from "../../core/api/client";

const GMAIL_REQUEST_TIMEOUT_MS = 45_000;

export async function mailApiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await apiRequest<T>(path, {
      ...init,
      cache: "no-store",
      timeoutMs: GMAIL_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 408) {
      throw new Error(
        "Tempo esgotado ao sincronizar o Gmail. A conexao esta ativa, mas o Google demorou para retornar. Tente atualizar em alguns segundos.",
      );
    }
    throw error;
  }
}
