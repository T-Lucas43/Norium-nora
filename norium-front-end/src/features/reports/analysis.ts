import { requestScope } from "../../core/api/sessionScope";
import { analyzeReport } from "./api";
import { reportFingerprint, type NoraReportAnalysis, type ReportDocument } from "./reportDocument";

export const defaultAnalysisFocus = "Explique os resultados, riscos e oportunidades com evidências e ações práticas. Volume de atividade não prova produtividade ou qualidade. Não avalie pessoas além dos dados de tarefas disponíveis.";
const pending = new Map<string, Promise<NoraReportAnalysis>>();
const cached = new Map<string, { value: NoraReportAnalysis; expires: number }>();
let queue: Promise<unknown> = Promise.resolve();
let scope = "";

export function clearReportAnalysisCache() { cached.clear(); pending.clear(); }

export function getReportAnalysis(report: ReportDocument, focus = defaultAnalysisFocus, force = false): Promise<NoraReportAnalysis> {
  const currentScope = requestScope();
  if (currentScope !== scope) { cached.clear(); pending.clear(); scope = currentScope; }
  const key = JSON.stringify([currentScope, reportFingerprint(report), focus]);
  const hit = cached.get(key);
  if (!force && hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  if (pending.has(key)) return pending.get(key)!;
  const job = queue.catch(() => undefined).then(async () => {
    if (requestScope() !== currentScope) throw new Error("A sessão ou o espaço mudou. Atualize o relatório.");
    const value = report.recordCount ? await analyzeReport(report, focus) : {
      summary: "Não há registros neste recorte. Não é possível avaliar resultados, produtividade ou tendências sem evidências disponíveis.",
      insights: [], limitations: ["Nota automática de disponibilidade; não houve análise por IA."], generatedAt: new Date().toISOString(),
    };
    if (requestScope() !== currentScope) throw new Error("A sessão mudou durante a análise. Atualize o relatório.");
    if (cached.size > 24) cached.clear();
    cached.set(key, { value, expires: Date.now() + 300_000 });
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, job); queue = job;
  return job;
}
