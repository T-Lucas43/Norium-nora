import { useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { apiRequest } from "../../core/api/client";

export type NoraApprovalSnapshot = {
  id: string;
  action?: string | null;
  source?: string | null;
  title: string;
  status: string;
  digest?: string | null;
  expiresAt?: string | null;
  workspace?: string | null;
  version?: string | null;
  summary: string;
  recipients: string[];
  decidedAt?: string | null;
  outcome?: string | null;
  uncertain?: boolean;
};

type ApprovalItem = Record<string, unknown>;

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 25);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Normalize a backend approval into the small snapshot the chat card persists. */
export function normalizeApprovalCard(raw: unknown): NoraApprovalSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as ApprovalItem;
  if (typeof item.id !== "string" || !item.id) return null;
  const payload = (item.payload ?? {}) as ApprovalItem;
  const exact = (payload.emailExact ?? {}) as ApprovalItem;
  const metadata = (item.metadata ?? {}) as ApprovalItem;
  const execution = (item.execution ?? {}) as ApprovalItem;
  const recipients = [...asStringList(exact.to), ...asStringList(exact.cc), ...asStringList(exact.bcc)].slice(0, 25);
  return {
    id: item.id,
    action: typeof item.action === "string" ? item.action : null,
    source: typeof item.source === "string" ? item.source : null,
    title: asString(item.title).slice(0, 300),
    status: asString(item.status, "pending").slice(0, 30),
    digest: typeof item.digest === "string" && item.digest ? item.digest.slice(0, 128) : null,
    expiresAt: typeof item.expiresAt === "string" && item.expiresAt ? item.expiresAt.slice(0, 64) : null,
    workspace: typeof metadata.workspace === "string" && metadata.workspace ? metadata.workspace.slice(0, 80) : null,
    version: typeof metadata.version === "string" && metadata.version ? metadata.version.slice(0, 40) : null,
    summary: asString(item.description).slice(0, 2000),
    recipients,
    decidedAt: typeof item.decidedAt === "string" && item.decidedAt ? item.decidedAt.slice(0, 64) : null,
    outcome: (asString(execution.response) || asString(item.decisionNote) || asString(item.executionError)).slice(0, 2000) || null,
    uncertain: item.executionUncertain === true,
  };
}

function statusLabel(status: string, uncertain: boolean): string {
  if (status === "pending") return "Aguardando decisão";
  if (status === "approved") return "Aprovada";
  if (status === "rejected") return "Negada";
  if (status === "cancelled") return "Cancelada";
  if (status === "executed") return "Executada";
  if (status === "expired") return "Expirada";
  if (status === "failed") return uncertain ? "Resultado incerto" : "Falha na execução";
  return status;
}

function formatExpiry(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function NoraApprovalCard({
  approval,
  onDecision,
}: {
  approval: NoraApprovalSnapshot;
  onDecision: (next: NoraApprovalSnapshot) => void;
}) {
  const [pending, setPending] = useState<null | "approved" | "rejected" | "reconcile">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const decided = approval.status !== "pending";
  const busy = pending !== null;

  async function decide(kind: "approved" | "rejected") {
    if (busy || decided) return;
    setPending(kind);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiRequest<{ item: ApprovalItem }>(`/api/operacao/aprovacoes/${approval.id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision: kind, expectedDigest: approval.digest ?? undefined }),
      });
      const next = normalizeApprovalCard(updated.item) ?? approval;
      setNotice(kind === "approved" ? "Ação permitida." : "Ação negada. Nada foi executado.");
      onDecision(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui registrar a decisão.");
    } finally {
      setPending(null);
    }
  }

  async function reconcile() {
    if (busy || !approval.uncertain) return;
    setPending("reconcile");
    setError(null);
    setNotice(null);
    try {
      const outcome = await apiRequest<{ reconciled: boolean; item?: ApprovalItem; guidance?: string }>(
        `/api/operacao/aprovacoes/${approval.id}/reconciliar`,
        { method: "POST" },
      );
      if (outcome.reconciled && outcome.item) {
        setNotice("Envio confirmado na caixa de enviados.");
        onDecision(normalizeApprovalCard(outcome.item) ?? approval);
      } else {
        setNotice(outcome.guidance || "Nenhum e-mail correspondente encontrado. Nada foi repetido.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui verificar o envio.");
    } finally {
      setPending(null);
    }
  }

  const digestShort = approval.digest ? `${approval.digest.slice(0, 12)}…` : null;
  const expiry = formatExpiry(approval.expiresAt);

  return (
    <article
      aria-label={`Aprovação: ${approval.title || "ação sensível"}`}
      className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm"
    >
      <div className="flex items-center gap-2 font-semibold text-[var(--text)]">
        {decided ? (
          approval.status === "rejected" || approval.status === "cancelled" ? (
            <ShieldX size={17} className="text-red-400" aria-hidden="true" />
          ) : (
            <ShieldCheck size={17} className="text-emerald-400" aria-hidden="true" />
          )
        ) : (
          <ShieldAlert size={17} className="text-amber-400" aria-hidden="true" />
        )}
        <span>{decided ? "Permissão decidida" : "Permissão necessária"}</span>
        <span className="ml-auto rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]">
          {statusLabel(approval.status, approval.uncertain === true)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[var(--text-secondary)]">
        <dt className="font-medium text-[var(--text)]">Ação</dt>
        <dd className="break-words">{approval.title || approval.action || "Ação sensível"}</dd>
        {approval.recipients.length > 0 && (
          <>
            <dt className="font-medium text-[var(--text)]">Destinatários</dt>
            <dd className="break-words">{approval.recipients.join(", ")}</dd>
          </>
        )}
        {approval.summary && (
          <>
            <dt className="font-medium text-[var(--text)]">Detalhes</dt>
            <dd className="whitespace-pre-wrap break-words">{approval.summary}</dd>
          </>
        )}
        {approval.workspace && (
          <>
            <dt className="font-medium text-[var(--text)]">Workspace</dt>
            <dd className="break-words">{approval.workspace}</dd>
          </>
        )}
        <dt className="font-medium text-[var(--text)]">Versão</dt>
        <dd className="break-words">{approval.version || "—"}</dd>
        {digestShort && (
          <>
            <dt className="font-medium text-[var(--text)]">Conteúdo</dt>
            <dd className="break-all font-mono text-xs" title={approval.digest || undefined}>
              {digestShort}
            </dd>
          </>
        )}
        {expiry && (
          <>
            <dt className="font-medium text-[var(--text)]">Expira em</dt>
            <dd>{expiry}</dd>
          </>
        )}
      </dl>

      <p className="mt-3 text-xs text-[var(--text-secondary)]">
        A permissão vale somente para este conteúdo exato. Qualquer edição gera uma nova aprovação.
      </p>

      {!decided && (
        <div className="mt-3 flex flex-wrap gap-2" aria-busy={busy}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("approved")}
            className="rounded-lg bg-cyan-500 px-4 py-2 font-semibold text-white transition hover:bg-cyan-400 disabled:opacity-50"
          >
            {pending === "approved" ? "Permitindo…" : "Permitir esta ação"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("rejected")}
            className="rounded-lg border border-red-400/60 px-4 py-2 font-semibold text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
          >
            {pending === "rejected" ? "Negando…" : "Negar"}
          </button>
        </div>
      )}

      {approval.uncertain && approval.status === "failed" && (
        <div className="mt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void reconcile()}
            className="rounded-lg border border-[var(--border)] px-4 py-2 font-semibold text-[var(--text)] transition hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            {pending === "reconcile" ? "Verificando…" : "Verificar envio"}
          </button>
        </div>
      )}

      {approval.outcome && (
        <p role="status" className="mt-3 whitespace-pre-wrap break-words text-[var(--text)]">
          {approval.outcome}
        </p>
      )}
      {notice && !approval.outcome && (
        <p role="status" className="mt-2 text-[var(--text-secondary)]">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-red-300">
          {error}
        </p>
      )}
    </article>
  );
}
