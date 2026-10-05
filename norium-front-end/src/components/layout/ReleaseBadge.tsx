import { useEffect, useState } from "react";
import { apiBaseUrl } from "../../core/api/config";
import "./ReleaseBadge.css";

const environmentLabels = {
  local: "Local",
  homologacao: "Homologação",
  producao: "Produção",
} as const;

type Release = {
  environment: keyof typeof environmentLabels;
  version: string;
  revision: string;
};

function parseRelease(value: unknown): Release | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const { environment, version, revision } = candidate;
  if (typeof environment !== "string" || !Object.hasOwn(environmentLabels, environment)) return null;
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) return null;
  if (typeof version !== "string" || !/^20\d{2}\.\d{2}\.\d{2}$/.test(version)) return null;
  const [year, month, day] = version.split(".").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { environment: environment as Release["environment"], version, revision };
}

export default function ReleaseBadge() {
  const [release, setRelease] = useState<Release | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unknown" | "unavailable">("loading");

  useEffect(() => {
    let disposed = false;
    let requestId = 0;
    let controller: AbortController | undefined;
    let activeTimeout: number | undefined;

    async function refresh() {
      if (document.visibilityState === "hidden") return;
      const currentRequest = ++requestId;
      controller?.abort();
      window.clearTimeout(activeTimeout);
      const currentController = new AbortController();
      controller = currentController;
      const timeout = window.setTimeout(() => currentController.abort(), 5_000);
      activeTimeout = timeout;
      try {
        const response = await fetch(`${apiBaseUrl()}/api/system/release`, {
          cache: "no-store",
          credentials: "omit",
          headers: { Accept: "application/json" },
          signal: currentController.signal,
        });
        if (!response.ok) throw new Error("Release unavailable");
        const actual = parseRelease(await response.json());
        if (!disposed && currentRequest === requestId) {
          setRelease(actual);
          setState(actual ? "ready" : "unknown");
        }
      } catch {
        if (!disposed && currentRequest === requestId) {
          setRelease(null);
          setState("unavailable");
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearTimeout(activeTimeout);
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const label = release
    ? `${environmentLabels[release.environment]} · ${release.version} · ${release.revision.slice(0, 7)}`
    : state === "loading"
      ? "Consultando versão…"
      : state === "unknown"
        ? "Versão não informada"
        : "Versão indisponível";
  const description = release
    ? `Release em execução: ${label}. Commit: ${release.revision}. Versão pela data da revisão em UTC.`
    : "Não foi possível identificar a versão da imagem em execução.";

  return (
    <div
      className={`norium-release-badge ${release ? `is-${release.environment}` : "is-unknown"}`}
      role="status"
      aria-label="Versão em execução"
      aria-live="polite"
      title={description}
    >
      <span className="norium-release-dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
