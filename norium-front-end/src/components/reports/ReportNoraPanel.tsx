import { useEffect, useState } from "react";
import { Sparkles, ArrowUpRight, CircleCheck, CircleAlert, Lightbulb } from "lucide-react";
import type { NoraReportAnalysis, ReportDocument } from "../../features/reports/reportDocument";
import { analysisEvidence, reportFingerprint } from "../../features/reports/reportDocument";
import { defaultAnalysisFocus, getReportAnalysis } from "../../features/reports/analysis";
import { insightLabels } from "../../features/reports/pdfBuilder";
import Button from "../shared/Button";
export type SavedReportAnalysis = { fingerprint: string; analysis: NoraReportAnalysis };

export default function ReportNoraPanel({ report, saved, onAnalyzed, onOpenNora, disabled }: { report: ReportDocument; saved: SavedReportAnalysis | null; onAnalyzed: (value: SavedReportAnalysis) => void; onOpenNora?: (prompt: string) => void; disabled: boolean }) {
  const [focus, setFocus] = useState(defaultAnalysisFocus), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const fingerprint = reportFingerprint(report), current = saved?.fingerprint === fingerprint ? saved.analysis : null;
  useEffect(() => {
    setBusy(false);
    if (disabled || current) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setBusy(true); setError("");
      void getReportAnalysis(report).then(analysis => { if (active) onAnalyzed({ fingerprint, analysis }); })
        .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Não foi possível concluir a análise."); })
        .finally(() => { if (active) setBusy(false); });
    }, 600);
    return () => { active = false; window.clearTimeout(timer); };
    // The fingerprint contains every evidence field; generatedAt is deliberately excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, disabled]);
  const evidence = analysisEvidence(report);
  const references = new Map([...evidence.metrics.map(item => [item.id, `${item.label}: ${item.value}`] as const), ...evidence.tables.flatMap(table => table.rows.map((row, index) => [row.id, `${table.title}, linha ${index + 1}`] as const))]);
  async function analyze() { setBusy(true); setError(""); try { onAnalyzed({ fingerprint, analysis: await getReportAnalysis(report, focus, true) }); } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível concluir a análise."); } finally { setBusy(false); } }
  return <section className="report-nora" aria-label="Análise da Nora"><header><div className="report-nora-heading"><span><Sparkles size={17}/></span><div><h3>Análise da Nora</h3><p>Contexto, evidências e próximos passos para este recorte.</p></div></div><Button size="sm" loading={busy} disabled={disabled || !report.recordCount || focus.trim().length < 4} onClick={() => void analyze()}><Sparkles size={14}/>{busy ? "Analisando…" : current ? "Analisar novamente" : "Analisar relatório"}</Button></header><details className="report-nora-focus"><summary>Personalizar a análise</summary><label>O que a Nora deve observar?<textarea value={focus} maxLength={1500} rows={3} disabled={busy} onChange={event => setFocus(event.target.value)}/></label><div>{["Destaque riscos e pontos de atenção, com evidências e ações prioritárias.", "Destaque resultados positivos e oportunidades de melhoria, sem inventar comparações."].map((value, index) => <button key={value} disabled={busy} onClick={() => setFocus(value)}>{index ? "Resultados e oportunidades" : "Riscos e prioridades"}</button>)}</div></details>{busy && <p className="report-feedback" role="status">A Nora está avaliando os indicadores e as tabelas. A análise pode levar até dois minutos.</p>}{error && <p className="report-feedback is-error" role="alert">{error}</p>}{saved && !current && <p className="report-feedback">Os dados ou filtros mudaram. Gere uma análise deste recorte para incluí-la no PDF.</p>}{!current && !busy && !saved && <p className="report-nora-empty">A Nora explica o que os números indicam, com pontos positivos ou de atenção conforme os dados. A análise é gerada automaticamente e acompanha o PDF por padrão.</p>}{current && <div className="report-nora-result"><p>{current.summary}</p><div className="report-insights">{current.insights.map((item, index) => { const Icon = item.kind === "positive" ? CircleCheck : item.kind === "attention" ? CircleAlert : Lightbulb; return <article key={index} className={`insight-${item.kind}`}><span className="insight-kind"><Icon size={14}/>{insightLabels[item.kind]}</span><h4>{item.title}</h4><p>{item.explanation}</p><div className="insight-evidence">{item.evidenceIds.map(id => <span key={id}>{references.get(id) || "Dado do relatório"}</span>)}</div><p className="insight-action"><strong>Próxima ação</strong>{item.recommendation}</p></article>; })}</div><details><summary>Limites da análise</summary><ul>{current.limitations.map(item => <li key={item}>{item}</li>)}</ul></details><footer><span>Gerada em {new Date(current.generatedAt).toLocaleString("pt-BR")}</span>{onOpenNora && <Button size="sm" variant="ghost" onClick={() => onOpenNora(`Quero aprofundar esta análise do relatório ${report.title}, período ${report.period}. Analise apenas estas evidências e comentários, sem presumir novos dados: ${JSON.stringify({ evidence, analysis: current })}`)}>Conversar sobre a análise<ArrowUpRight size={13}/></Button>}</footer></div>}</section>;
}
