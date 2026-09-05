// Cliente HTTP unico: autenticacao, timeout e erros nao se repetem nas telas.
import { apiBaseUrl, authToken } from "./config";
import { requestScope } from "./sessionScope";

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

const UNAUTHORIZED_REQUEST_ORIGIN = "Origem da requisicao autenticada nao autorizada.";

function requestUrl(path: string) {
  let parsed: URL;
  try {
    parsed = new URL(path, window.location.origin);
  } catch {
    throw new ApiError(UNAUTHORIZED_REQUEST_ORIGIN, 400);
  }

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(path.trimStart());
  const isNetworkPath = /^[\\/]{2}/.test(path);
  if (hasScheme || isNetworkPath) {
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== window.location.origin) {
      throw new ApiError(UNAUTHORIZED_REQUEST_ORIGIN, 400);
    }
    return parsed.href;
  }

  // Evita que formas relativas ambiguas (por exemplo, barras invertidas)
  // escapem para outra origem durante a normalizacao feita pelo navegador.
  if (parsed.origin !== window.location.origin) {
    throw new ApiError(UNAUTHORIZED_REQUEST_ORIGIN, 400);
  }
  return `${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Converte erros FastAPI/Pydantic em uma mensagem útil para a tela.
 *
 * FastAPI envia falhas de validação no formato `{ detail: [{ msg, loc }] }`.
 * Antes elas eram descartadas e o cadastro mostrava apenas a mensagem genérica
 * "Falha na API do Norium", mesmo quando a API explicava exatamente o campo
 * inválido.
 */
export function apiErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const detail = "detail" in payload ? payload.detail : null;
  if (typeof detail === "string" && detail.trim()) return detail;

  if (Array.isArray(detail)) {
    const firstMessage = detail.find((item): item is { msg: unknown } => (
      Boolean(item) && typeof item === "object" && "msg" in item
    ));
    if (typeof firstMessage?.msg === "string" && firstMessage.msg.trim()) {
      return firstMessage.msg.replace(/^Value error,\s*/i, "").trim();
    }
  }

  return fallback;
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
  const scope = requestScope();
  const url = requestUrl(path);
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

      const response = await fetch(url, {
        ...init,
        headers,
        signal: timeoutController.signal,
      });
      const payload = await response.json().catch(() => null);
      if (scope !== requestScope()) throw new ApiError("A sessão ou o ambiente mudou. Atualize a página.", 499);
      if (!response.ok) {
        const apiError = new ApiError(apiErrorMessage(payload, "Falha na API do Norium."), response.status, payload);
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

export async function authenticatedWebSocketUrl(url: string, token?: string | null) {
  const response = await apiRequest<{ ticket: string }>("/api/auth/websocket-ticket", {
    method: "POST",
    token,
  });
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}ticket=${encodeURIComponent(response.ticket)}`;
}

/** Usa a mesma autenticacao e identificacao de workspace para respostas binarias. */
export async function apiBlobRequest(path: string, options: ApiRequestOptions = {}): Promise<Blob> {
  const scope = requestScope();
  const url = requestUrl(path);
  const { token = authToken(), timeoutMs = 60_000, headers: customHeaders, signal, ...init } = options;
  const headers = new Headers(customHeaders);
  if (!headers.has("Accept")) headers.set("Accept", "application/pdf");
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  const workspaceId = window.localStorage.getItem("norium-workspace-id");
  if (workspaceId && workspaceId !== "primary" && !headers.has("X-Norium-Workspace")) {
    headers.set("X-Norium-Workspace", workspaceId);
  }

  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => timeoutController.abort(), timeoutMs);
  const abortFromCaller = () => timeoutController.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch(url, { ...init, headers, signal: timeoutController.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new ApiError(apiErrorMessage(payload, "Falha ao gerar o arquivo no Norium."), response.status, payload);
    }
    const blob = await response.blob();
    if (scope !== requestScope()) throw new ApiError("A sessão ou o ambiente mudou. Atualize a página.", 499);
    return blob;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw new ApiError("Operacao cancelada.", 499);
    if (timeoutController.signal.aborted) throw new ApiError("A geracao do arquivo demorou mais que o esperado.", 408);
    throw new ApiError(
      `Nao foi possivel conectar ao backend do Norium em ${apiBaseUrl()}.`,
      0,
      error instanceof Error ? { cause: error.message } : null,
    );
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
