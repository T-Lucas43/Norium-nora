// Adaptador dos dados de relatorio, separado da renderizacao e exportacao.
import { ApiError, apiRequest } from "../../core/api/client";
import type { FinanceData } from "./types";
import { analysisEvidence, type NoraReportAnalysis, type ReportDocument } from "./reportDocument";

export async function analyzeReport(document: ReportDocument, focus: string) {
  const response = await apiRequest<{ item: NoraReportAnalysis }>("/api/relatorios/analisar", { method: "POST", body: JSON.stringify({ report: analysisEvidence(document), focus }), timeoutMs: 145_000 });
  return response.item;
}

function wait(delayMs: number) {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export async function loadFinanceReportData(userId: string) {
  const path = `/api/financeiro?user_id=${encodeURIComponent(userId)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await apiRequest<FinanceData>(path, {
        cache: "no-store",
        timeoutMs: 10_000,
      });
    } catch (error) {
      const canRetry = error instanceof ApiError && (error.status === 0 || error.status === 408);
      if (!canRetry || attempt === 2) throw error;
      await wait(1_000 * (attempt + 1));
    }
  }
  throw new ApiError("Falha ao carregar o financeiro.", 0);
}

export function registerReportEvent(title: string, description: string, metadata: Record<string, unknown>) {
  void apiRequest("/api/omnichannel/registrar-evento", {
    method: "POST",
    body: JSON.stringify({
      id: `report_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      source: "relatorios",
      title,
      description,
      timestamp: new Date().toISOString(),
      metadata,
    }),
  }).catch(() => undefined);
}
