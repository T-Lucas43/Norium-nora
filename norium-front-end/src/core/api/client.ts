// Cliente HTTP unico: autenticacao, timeout e erros nao se repetem nas telas.
import { apiBaseUrl, authToken } from "./config";

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

type ApiRequestOptions = RequestInit & {
  token?: string | null;
  timeoutMs?: number;
};

function requestUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const detail = "detail" in payload ? payload.detail : null;
  return typeof detail === "string" && detail.trim() ? detail : fallback;
}

function waitForRetry(delayMs: number, signal?: AbortSignal | null) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Operacao cancelada.", "AbortError"));
  }

  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Operacao cancelada.", "AbortError"));
    };
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { token = authToken(), timeoutMs = 20_000, headers: customHeaders, signal, ...init } = options;
  const headers = new Headers(customHeaders);

  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const workspaceId = window.localStorage.getItem("norium-workspace-id");
  if (workspaceId && workspaceId !== "primary" && !headers.has("X-Norium-Workspace")) {
    headers.set("X-Norium-Workspace", workspaceId);
  }
  const method = (init.method || "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("Idempotency-Key")) {
    headers.set("Idempotency-Key", crypto.randomUUID());
  }

  const maxAttempts = ["GET", "HEAD"].includes(method) ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const timeoutController = new AbortController();
    const timeoutId = window.setTimeout(() => timeoutController.abort(), timeoutMs);
    const abortFromCaller = () => timeoutController.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      if (signal?.aborted) {
        throw new ApiError("Operacao cancelada.", 499);
      }

      const response = await fetch(requestUrl(path), {
        ...init,
        headers,
        signal: timeoutController.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const apiError = new ApiError(errorMessage(payload, "Falha na API do Norium."), response.status, payload);
        if (attempt + 1 < maxAttempts && [502, 503, 504].includes(response.status)) {
          await waitForRetry(300, signal);
          continue;
        }
        throw apiError;
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal?.aborted) {
        throw new ApiError("Operacao cancelada.", 499);
      }
      if (timeoutController.signal.aborted) {
        throw new ApiError("A operacao demorou mais que o esperado.", 408);
      }
      if (attempt + 1 < maxAttempts) {
        await waitForRetry(300, signal);
        continue;
      }
      throw new ApiError(
        `Nao foi possivel conectar ao backend do Norium em ${apiBaseUrl()}. Verifique se o servidor local esta ativo.`,
        0,
        error instanceof Error ? { cause: error.message } : null,
      );
    } finally {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  throw new ApiError("Nao foi possivel concluir a requisicao.", 0);
}
