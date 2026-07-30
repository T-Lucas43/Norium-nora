import { useState } from "react";
import { AlertTriangle, Check, Scale, Sparkles, X } from "lucide-react";
import type { CommercialProposal, NoraSuggestion } from "../../features/commercial/types";
import Button from "../shared/Button";

type Focus = "scope" | "risk" | "tone" | "commercial" | "legal";

type NoraReviewPanelProps = {
  proposal: CommercialProposal;
  busy: boolean;
  onAnalyze: (context: string, focus: Focus[]) => Promise<void>;
  onDecision: (suggestionId: string, decision: "accepted" | "rejected") => Promise<void>;
};

const focuses: Array<{ id: Focus; label: string }> = [
  { id: "scope", label: "Escopo" },
  { id: "risk", label: "Riscos" },
  { id: "tone", label: "Tom" },
  { id: "commercial", label: "Comercial" },
  { id: "legal", label: "Contratual" },
];

export default function NoraReviewPanel({ proposal, busy, onAnalyze, onDecision }: NoraReviewPanelProps) {
  const [context, setContext] = useState(proposal.noraAnalysis?.context || "");
  const [focus, setFocus] = useState<Focus[]>(proposal.noraAnalysis?.focus || ["scope", "risk", "tone"]);

  function toggleFocus(value: Focus) {
    setFocus((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  return (
    <aside className="flex min-h-0 flex-col border-l border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
      <header className="border-b border-[var(--border)] p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-[var(--primary)]"><Sparkles size={19} /></span>
          <div><h3 className="text-sm font-black">Revisao da Nora</h3><p className="text-[10px] font-semibold text-[var(--text-secondary)]">Analise contextual, sem alterar sem aprovacao.</p></div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <label className="block">
          <span className="mb-2 block text-[10px] font-black uppercase text-[var(--text-secondary)]">Contexto de analise</span>
          <textarea
            value={context}
            onChange={(event) => setContext(event.target.value)}
            placeholder="Ex.: cliente conservador, manter margem de 25%, evitar juridiquês."
            className="commercial-field min-h-24 resize-y leading-5"
          />
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          {focuses.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => toggleFocus(item.id)}
              className={`rounded-full border px-3 py-1.5 text-[10px] font-black ${focus.includes(item.id) ? "border-[color-mix(in_srgb,var(--primary)_55%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-[var(--primary)]" : "border-[var(--border)] text-[var(--text-secondary)]"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <Button
          variant="primary"
          loading={busy}
          disabled={!focus.length}
          onClick={() => void onAnalyze(context, focus)}
          icon={<Sparkles size={15} />}
          className="mt-4 w-full"
        >
          Analisar documento
        </Button>

        {proposal.noraAnalysis && (
          <section className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
            <div className="flex items-center justify-between gap-3">
              <strong className="text-xs">Diagnostico</strong>
              <RiskBadge level={proposal.noraAnalysis.riskLevel} />
            </div>
            <p className="mt-3 text-xs font-semibold leading-5 text-[var(--text)]">{proposal.noraAnalysis.summary}</p>
            {proposal.noraAnalysis.tone && <p className="mt-2 text-[10px] font-semibold leading-4 text-[var(--text-secondary)]">{proposal.noraAnalysis.tone}</p>}
          </section>
        )}

        <div className="mt-5 space-y-3">
          {proposal.suggestions.map((suggestion) => (
            <SuggestionCard key={suggestion.id} suggestion={suggestion} busy={busy} onDecision={onDecision} />
          ))}
          {proposal.noraAnalysis && !proposal.suggestions.length && (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/8 p-5 text-center">
              <Check size={20} className="mx-auto text-emerald-500" />
              <p className="mt-2 text-xs font-bold text-emerald-500">Nenhuma alteracao textual necessaria nesta analise.</p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function RiskBadge({ level }: { level: "low" | "medium" | "high" }) {
  const label = level === "high" ? "Risco alto" : level === "medium" ? "Risco medio" : "Risco baixo";
  const className = level === "high" ? "text-rose-300 bg-rose-400/10" : level === "medium" ? "text-amber-300 bg-amber-400/10" : "text-emerald-300 bg-emerald-400/10";
  return <span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${className}`}>{label}</span>;
}

function SuggestionCard({
  suggestion,
  busy,
  onDecision,
}: {
  suggestion: NoraSuggestion;
  busy: boolean;
  onDecision: (suggestionId: string, decision: "accepted" | "rejected") => Promise<void>;
}) {
  return (
    <article className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2 text-[10px] font-black uppercase text-[var(--text)]">
          {suggestion.severity === "critical" ? <AlertTriangle size={13} className="text-rose-400" /> : <Scale size={13} className="text-[var(--primary)]" />}
          {suggestion.severity === "critical" ? "Critico" : suggestion.severity === "warning" ? "Atencao" : "Melhoria"}
        </span>
        <span className="rounded-full border border-[var(--border)] px-2 py-1 text-[8px] font-black uppercase text-[var(--text-secondary)]">{suggestion.status}</span>
      </div>
      <p className="mt-3 text-xs font-semibold leading-5 text-[var(--text)]">{suggestion.reason}</p>
      {(suggestion.original || suggestion.replacement) && (
        <div className="mt-3 overflow-hidden rounded-md border border-[var(--border)] text-[10px] leading-4">
          {suggestion.original && <div className="bg-rose-500/8 p-3 text-rose-500"><span className="mr-2 font-black">-</span>{suggestion.original}</div>}
          {suggestion.replacement && <div className="bg-emerald-500/8 p-3 text-emerald-500"><span className="mr-2 font-black">+</span>{suggestion.replacement}</div>}
        </div>
      )}
      {suggestion.status === "pending" && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="sm" disabled={busy} onClick={() => void onDecision(suggestion.id, "accepted")} icon={<Check size={13} />} className="bg-emerald-500 text-white">Aceitar</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onDecision(suggestion.id, "rejected")} icon={<X size={13} />}>Rejeitar</Button>
        </div>
      )}
    </article>
  );
}
