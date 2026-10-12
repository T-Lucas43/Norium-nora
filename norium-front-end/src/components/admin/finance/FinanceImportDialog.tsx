import { useMemo, useState } from "react";
import { Upload } from "lucide-react";
import type { ImportPreview } from "../../../features/admin-finance/types";
import Button from "../../shared/Button";
import AdminOverlay from "../layout/AdminOverlay";

type ImportKind = "expenses" | "payments" | "jorro";

interface FinanceImportDialogProps {
  loading?: boolean;
  onClose: () => void;
  onPreview: (file: File) => Promise<ImportPreview>;
  onCommit: (payload: { kind: ImportKind; rows: Array<Record<string, string>>; mapping: Array<{ sourceColumn: string; targetField: string }> }) => Promise<void>;
}

const targetFields: Record<ImportKind, Array<[string, string]>> = {
  expenses: [
    ["title", "Título"], ["description", "Descrição"], ["amountCents", "Valor"], ["categoryId", "Categoria"],
    ["supplierId", "Fornecedor"], ["costCenterId", "Centro de custo"], ["providerId", "Provedor"], ["status", "Status"],
    ["expenseType", "Tipo"], ["dueAt", "Vencimento"], ["paidAt", "Pagamento"], ["paymentMethod", "Método"], ["notes", "Observações"],
  ],
  payments: [
    ["customerId", "ID do cliente"], ["customerName", "Cliente"], ["planId", "Plano"], ["grossCents", "Valor bruto"],
    ["discountCents", "Desconto"], ["refundCents", "Reembolso"], ["taxCents", "Impostos"], ["feeCents", "Taxas"],
    ["status", "Status"], ["dueAt", "Vencimento"], ["paidAt", "Recebimento"], ["provider", "Provedor"], ["paymentMethod", "Método"],
  ],
  jorro: [
    ["title", "Descrição do consumo"], ["amountCents", "Valor"], ["dueAt", "Data"], ["status", "Status"],
    ["paymentMethod", "Método"], ["notes", "Observações"],
  ],
};

export default function FinanceImportDialog({ loading, onClose, onPreview, onCommit }: FinanceImportDialogProps) {
  const [kind, setKind] = useState<ImportKind>("expenses");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const targets = useMemo(() => targetFields[kind], [kind]);

  async function selectFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      const result = await onPreview(file);
      setPreview(result);
      setMapping(Object.fromEntries(result.suggestedMapping.map((item) => [item.sourceColumn, item.targetField])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível ler o arquivo.");
    }
  }

  async function commit() {
    if (!preview) return;
    await onCommit({
      kind,
      rows: preview.rows,
      mapping: preview.headers.map((sourceColumn) => ({ sourceColumn, targetField: mapping[sourceColumn] || "" })),
    });
  }

  return (
    <AdminOverlay open title="Importar dados financeiros" subtitle="CSV ou Excel com prévia e mapeamento antes da gravação." width={880} closeLabel="Fechar" onClose={onClose}>
      <section className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm font-medium text-red-300">{error}</div>}
          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <label className="finance-label">Destino<select className="finance-field" value={kind} onChange={(event) => setKind(event.target.value as ImportKind)}><option value="expenses">Despesas</option><option value="payments">Receitas</option><option value="jorro">Consumo Jorro</option></select></label>
            <label className="grid cursor-pointer place-items-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)] p-5 text-center hover:bg-[var(--surface-hover)]">
              <Upload size={22} className="mb-2 text-blue-400" /><strong className="text-sm">Selecionar CSV ou Excel</strong><span className="mt-1 text-xs text-[var(--text-secondary)]">Até 10 MB e 5.000 linhas por importação</span>
              <input type="file" accept=".csv,.xlsx,.xlsm" className="sr-only" onChange={(event) => void selectFile(event.target.files?.[0])} />
            </label>
          </div>
          {preview && <>
            <div><h3 className="text-sm font-semibold">Mapeamento de colunas</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">{preview.fileName} · {preview.totalRows} linha(s)</p></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {preview.headers.map((header) => <label key={header} className="finance-label"><span className="truncate" title={header}>{header}</span><select className="finance-field" value={mapping[header] || ""} onChange={(event) => setMapping((current) => ({ ...current, [header]: event.target.value }))}><option value="">Ignorar coluna</option>{targets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>)}
            </div>
            <div className="overflow-x-auto rounded-lg border border-[var(--border)]"><table className="w-full min-w-[720px] text-left text-xs"><thead className="bg-[var(--background)]"><tr>{preview.headers.map((header) => <th key={header} className="px-3 py-2 font-semibold">{header}</th>)}</tr></thead><tbody>{preview.rows.slice(0, 5).map((row, index) => <tr key={index} className="border-t border-[var(--border)]">{preview.headers.map((header) => <td key={header} className="max-w-48 truncate px-3 py-2">{row[header]}</td>)}</tr>)}</tbody></table></div>
          </>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--border)] p-4"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={!preview || loading} onClick={() => void commit()}>{loading ? "Importando..." : "Importar registros"}</Button></footer>
      </section>
    </AdminOverlay>
  );
}
