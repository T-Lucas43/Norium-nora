import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  FileUp,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { apiBaseUrl } from "../../utils/api";
import { downloadWithAuth, openWithAuth } from "../../utils/download";
import LoadingState from "../shared/LoadingState";
import { showConfirm } from "../shared/AppDialogProvider";
import "./finance.css";

const BACKEND_URL = apiBaseUrl();

type EntryType = "entrada" | "saida";
type EntryStatus = "pendente" | "pago" | "cancelado";
type Frequency = "unico" | "semanal" | "mensal" | "anual";
type FinanceView = "overview" | "entries" | "scheduled" | "boletos";
type FinanceCreatePanel = "entry" | "scheduled" | null;
type PeriodPreset = "this-month" | "last-month" | "last-3-months" | "this-year" | "custom";
type BoletoFilter = "open" | "paid" | "all";

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
};

type Lancamento = {
  id: string;
  title: string;
  description: string;
  type: EntryType;
  amount: number;
  category: string;
  method: string;
  status: EntryStatus;
  dueDate: string | null;
  paidAt: string | null;
  attachments: Attachment[];
  source: string;
  createdAt: string;
  updatedAt: string;
};

type Programado = {
  id: string;
  title: string;
  description: string;
  type: EntryType;
  amount: number;
  category: string;
  frequency: Frequency;
  nextDueDate: string | null;
  remindDaysBefore: number;
  active: boolean;
};

type Boleto = {
  id: string;
  title: string;
  beneficiary: string;
  amount: number;
  dueDate: string | null;
  status: string;
  barcode: string;
  linhaDigitavel?: string;
  url?: string;
  source: string;
};

type FinanceData = {
  lancamentos: Lancamento[];
  programados: Programado[];
  boletos: Boleto[];
  lembretes: Array<{ id: string; kind: string; title: string; amount: number; dueDate: string | null; daysUntil: number }>;
  resumo: {
    entradas: number;
    saidas: number;
    saldo: number;
    pendente: number;
    vencidos: number;
    programadosAtivos: number;
    boletosEncontrados: number;
  };
};

type LancamentoForm = {
  title: string;
  description: string;
  type: EntryType;
  amount: string;
  category: string;
  method: string;
  status: EntryStatus;
  dueDate: string;
};

type ProgramadoForm = {
  title: string;
  description: string;
  type: EntryType;
  amount: string;
  category: string;
  frequency: Frequency;
  nextDueDate: string;
  remindDaysBefore: string;
};

const emptyLancamento: LancamentoForm = {
  title: "",
  description: "",
  type: "saida",
  amount: "",
  category: "geral",
  method: "",
  status: "pendente",
  dueDate: "",
};

const emptyProgramado: ProgramadoForm = {
  title: "",
  description: "",
  type: "saida",
  amount: "",
  category: "fixo",
  frequency: "mensal",
  nextDueDate: "",
  remindDaysBefore: "3",
};

const fallbackData: FinanceData = {
  lancamentos: [],
  programados: [],
  boletos: [],
  lembretes: [],
  resumo: {
    entradas: 0,
    saidas: 0,
    saldo: 0,
    pendente: 0,
    vencidos: 0,
    programadosAtivos: 0,
    boletosEncontrados: 0,
  },
};

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
}

function dateLabel(value?: string | null) {
  if (!value) return "Sem data";
  return new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function periodBounds(preset: PeriodPreset, customStart: string, customEnd: string) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (preset === "custom") return { start: customStart, end: customEnd };
  if (preset === "last-month") {
    return {
      start: dateKey(new Date(year, month - 1, 1)),
      end: dateKey(new Date(year, month, 0)),
    };
  }
  if (preset === "last-3-months") {
    return {
      start: dateKey(new Date(year, month - 2, 1)),
      end: dateKey(new Date(year, month + 1, 0)),
    };
  }
  if (preset === "this-year") {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  return {
    start: dateKey(new Date(year, month, 1)),
    end: dateKey(new Date(year, month + 1, 0)),
  };
}

function withinPeriod(value: string | null | undefined, start: string, end: string) {
  if (!value || !start || !end) return false;
  const key = value.slice(0, 10);
  return key >= start && key <= end;
}

function boletoIsPaid(status: string) {
  return /pago|paid|quitado/i.test(status);
}

function fileSizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formFromLancamento(item: Lancamento): LancamentoForm {
  return {
    title: item.title,
    description: item.description,
    type: item.type,
    amount: String(item.amount).replace(".", ","),
    category: item.category,
    method: item.method,
    status: item.status,
    dueDate: item.dueDate || "",
  };
}

export default function FinanceDashboard({ userId = "primary", onOpenNora }: { userId?: string; onOpenNora?: (prompt?: string) => void }) {
  const [data, setData] = useState<FinanceData>(fallbackData);
  const [lancamentoForm, setLancamentoForm] = useState<LancamentoForm>(emptyLancamento);
  const [editForm, setEditForm] = useState<LancamentoForm>(emptyLancamento);
  const [programadoForm, setProgramadoForm] = useState<ProgramadoForm>(emptyProgramado);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("this-month");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [boletoFilter, setBoletoFilter] = useState<BoletoFilter>("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [creatingLancamento, setCreatingLancamento] = useState(false);
  const [creatingProgramado, setCreatingProgramado] = useState(false);
  const [payingLancamentoId, setPayingLancamentoId] = useState<string | null>(null);
  const [payingProgramadoId, setPayingProgramadoId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<FinanceView>("overview");
  const [createPanel, setCreatePanel] = useState<FinanceCreatePanel>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [removingAttachmentId, setRemovingAttachmentId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => data.lancamentos.find((item) => item.id === selectedId) || null, [data.lancamentos, selectedId]);
  const isEditingSelected = Boolean(selected && editingId === selected.id);
  const period = useMemo(() => periodBounds(periodPreset, customStart, customEnd), [customEnd, customStart, periodPreset]);
  const filteredLancamentos = useMemo(
    () => data.lancamentos.filter((item) => withinPeriod(item.paidAt || item.dueDate || item.createdAt, period.start, period.end)),
    [data.lancamentos, period.end, period.start],
  );
  const filteredProgramados = useMemo(
    () => data.programados.filter((item) => withinPeriod(item.nextDueDate, period.start, period.end)),
    [data.programados, period.end, period.start],
  );
  const filteredBoletos = useMemo(
    () => data.boletos.filter((item) => {
      if (!withinPeriod(item.dueDate, period.start, period.end)) return false;
      if (boletoFilter === "paid") return boletoIsPaid(item.status);
      if (boletoFilter === "open") return !boletoIsPaid(item.status) && !/cancelado|cancelled/i.test(item.status);
      return true;
    }),
    [boletoFilter, data.boletos, period.end, period.start],
  );
  const filteredSummary = useMemo(() => {
    const paid = filteredLancamentos.filter((item) => item.status === "pago");
    const pending = filteredLancamentos.filter((item) => item.status === "pendente");
    const entradas = paid.filter((item) => item.type === "entrada").reduce((total, item) => total + item.amount, 0);
    const saidas = paid.filter((item) => item.type === "saida").reduce((total, item) => total + item.amount, 0);
    const today = dateKey(new Date());
    return {
      entradas,
      saidas,
      saldo: entradas - saidas,
      pendente: pending.reduce((total, item) => total + item.amount, 0),
      vencidos: pending.filter((item) => item.dueDate && item.dueDate < today).length,
      programadosAtivos: filteredProgramados.filter((item) => item.active).length,
    };
  }, [filteredLancamentos, filteredProgramados]);

  const loadFinance = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const response = await fetch(`${BACKEND_URL}/api/financeiro?user_id=${userId}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.detail || "Não consegui carregar os dados financeiros.");
      setData(payload);
      setSelectedId((current) => {
        if (current && payload.lancamentos?.some((item: Lancamento) => item.id === current)) return current;
        setEditingId(null);
        setDeleteConfirmId(null);
        return null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar financeiro.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadFinance();
  }, [loadFinance]);

  useEffect(() => {
    const handler = () => void loadFinance();
    window.addEventListener("finance:changed", handler);
    return () => window.removeEventListener("finance:changed", handler);
  }, [loadFinance]);

  async function createLancamento() {
    const amount = Number(String(lancamentoForm.amount).replace(",", "."));
    if (!lancamentoForm.title.trim() || !Number.isFinite(amount) || amount <= 0) {
      setError("Informe um título e um valor maior que zero para salvar o lançamento.");
      return;
    }
    try {
      setCreatingLancamento(true);
      setError("");
      setNotice("");
      const response = await fetch(`${BACKEND_URL}/api/financeiro/lancamentos`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          title: lancamentoForm.title,
          description: lancamentoForm.description,
          type: lancamentoForm.type,
          amount,
          category: lancamentoForm.category,
          method: lancamentoForm.method,
          status: lancamentoForm.status,
          dueDate: lancamentoForm.dueDate || null,
          paidAt: lancamentoForm.status === "pago" ? new Date().toISOString().slice(0, 10) : null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.detail || "Não consegui criar o lançamento.");
      setLancamentoForm(emptyLancamento);
      setSelectedId(payload.lancamento.id);
      setActiveView("entries");
      setCreatePanel(null);
      setNotice(`Lançamento "${payload.lancamento.title}" salvo com sucesso.`);
      await loadFinance();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Falha ao salvar o lançamento. Verifique se o backend esta rodando na porta 8000.",
      );
    } finally {
      setCreatingLancamento(false);
    }
  }

  async function createProgramado() {
    const amount = Number(String(programadoForm.amount).replace(",", "."));
    if (!programadoForm.title.trim() || !Number.isFinite(amount) || amount <= 0) {
      setError("Informe um título e um valor maior que zero para programar o gasto.");
      return;
    }
    try {
      setCreatingProgramado(true);
      setError("");
      setNotice("");
      const response = await fetch(`${BACKEND_URL}/api/financeiro/programados`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          title: programadoForm.title,
          description: programadoForm.description,
          type: programadoForm.type,
          amount,
          category: programadoForm.category,
          frequency: programadoForm.frequency,
          nextDueDate: programadoForm.nextDueDate || null,
          remindDaysBefore: Number(programadoForm.remindDaysBefore || 0),
          active: true,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.detail || "Não consegui criar a programação.");
      setProgramadoForm(emptyProgramado);
      setActiveView("scheduled");
      setCreatePanel(null);
      setNotice(`Gasto programado "${payload.programado.title}" salvo com sucesso.`);
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar a programação.");
    } finally {
      setCreatingProgramado(false);
    }
  }

  async function patchLancamento(id: string, updates: Partial<Lancamento>) {
    try {
      setError("");
      setNotice("");
      const response = await fetch(`${BACKEND_URL}/api/financeiro/lancamentos/${id}`, {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, ...updates }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.detail || "Não consegui atualizar o lançamento.");
      setNotice(`Lançamento "${payload.lancamento.title}" atualizado.`);
      await loadFinance();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui atualizar o lançamento.");
      return false;
    }
  }

  async function deleteLancamento(id: string) {
    try {
      setError("");
      setNotice("");
      const response = await fetch(`${BACKEND_URL}/api/financeiro/lancamentos/${id}?user_id=${userId}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.detail || "Não consegui excluir o lançamento.");
      }
      setSelectedId(null);
      setEditingId(null);
      setDeleteConfirmId(null);
      setNotice("Lançamento excluído com sucesso.");
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui excluir o lançamento.");
    }
  }

  function startEditLancamento(item: Lancamento) {
    setSelectedId(item.id);
    setEditingId(item.id);
    setEditForm(formFromLancamento(item));
    setError("");
    setNotice("");
  }

  function selectLancamento(item: Lancamento) {
    setSelectedId(item.id);
    setDeleteConfirmId(null);
    if (editingId && editingId !== item.id) setEditingId(null);
  }

  function openAttachmentPicker(item: Lancamento) {
    setSelectedId(item.id);
    setDeleteConfirmId(null);
    window.setTimeout(() => fileInputRef.current?.click(), 0);
  }

  function cancelEditLancamento() {
    setEditingId(null);
    setEditForm(emptyLancamento);
  }

  async function saveEditLancamento() {
    if (!selected) return;
    const amount = Number(String(editForm.amount).replace(",", "."));
    if (!editForm.title.trim() || !Number.isFinite(amount) || amount <= 0) {
      setError("Informe um título e um valor maior que zero para salvar o lançamento.");
      return;
    }

    try {
      setSavingEdit(true);
      const saved = await patchLancamento(selected.id, {
        title: editForm.title,
        description: editForm.description,
        type: editForm.type,
        amount,
        category: editForm.category,
        method: editForm.method,
        status: editForm.status,
        dueDate: editForm.dueDate || null,
        paidAt: editForm.status === "pago" ? selected.paidAt || new Date().toISOString().slice(0, 10) : null,
      });
      if (saved) setEditingId(null);
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteProgramado(id: string) {
    const response = await fetch(`${BACKEND_URL}/api/financeiro/programados/${id}?user_id=${userId}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json();
      setError(payload?.detail || "Não consegui excluir a programação.");
      return;
    }
    setNotice("Programação excluída.");
    await loadFinance();
  }

  async function payProgramado(item: Programado) {
    const confirmed = await showConfirm({
      title: "Confirmar pagamento programado",
      description: `"${item.title}" será marcado como pago no valor de ${money(item.amount)}.`,
      confirmLabel: "Marcar como pago",
    });
    if (!confirmed) return;

    try {
      setPayingProgramadoId(item.id);
      setError("");
      setNotice("");
      const response = await fetch(`${BACKEND_URL}/api/financeiro/programados/${item.id}/pagar`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.detail || "Não consegui registrar o pagamento.");
      setSelectedId(payload?.lancamento?.id || null);
      setNotice(
        payload?.programado?.nextDueDate
          ? `Pagamento registrado. Próximo vencimento em ${dateLabel(payload.programado.nextDueDate)}.`
          : "Pagamento registrado e programação concluída.",
      );
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui registrar o pagamento.");
    } finally {
      setPayingProgramadoId(null);
    }
  }

  async function payLancamento(item: Lancamento) {
    const confirmed = await showConfirm({
      title: "Confirmar pagamento",
      description: `"${item.title}" será marcado como pago no valor de ${money(item.amount)}.`,
      confirmLabel: "Marcar como pago",
    });
    if (!confirmed) return;

    try {
      setPayingLancamentoId(item.id);
      const paid = await patchLancamento(item.id, {
        status: "pago",
        paidAt: new Date().toISOString().slice(0, 10),
      });
      if (paid) setNotice(`Pagamento de "${item.title}" registrado com sucesso.`);
    } finally {
      setPayingLancamentoId(null);
    }
  }

  async function uploadAttachments(files: FileList | File[]) {
    if (!selected) return;
    const selectedFiles = Array.from(files);
    if (selectedFiles.length === 0) return;

    try {
      setUploadingAttachments(true);
      setError("");
      for (const file of selectedFiles) {
        const dataUrl = await readFileAsDataUrl(file);
        const response = await fetch(`${BACKEND_URL}/api/financeiro/lancamentos/${selected.id}/anexos`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            file_name: file.name,
            mime_type: file.type || "application/octet-stream",
            data_url: dataUrl,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.detail || `Não consegui anexar ${file.name}.`);
      }
      setNotice(
        selectedFiles.length === 1
          ? "Arquivo anexado ao lançamento."
          : `${selectedFiles.length} arquivos anexados ao lançamento.`,
      );
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui anexar os arquivos.");
    } finally {
      setUploadingAttachments(false);
    }
  }

  async function removeAttachment(attachment: Attachment) {
    if (!selected) return;
    const confirmed = await showConfirm({
      title: "Remover anexo?",
      description: `"${attachment.name}" será desvinculado deste lançamento.`,
      confirmLabel: "Remover anexo",
      tone: "danger",
    });
    if (!confirmed) return;

    try {
      setRemovingAttachmentId(attachment.id);
      setError("");
      setNotice("");
      const response = await fetch(
        `${BACKEND_URL}/api/financeiro/lancamentos/${selected.id}/anexos/${attachment.id}?user_id=${userId}`,
        { method: "DELETE" },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.detail || "Não consegui remover o anexo.");
      setNotice(`Anexo "${attachment.name}" removido.`);
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui remover o anexo.");
    } finally {
      setRemovingAttachmentId(null);
    }
  }

  const showEntries = activeView === "overview" || activeView === "entries";
  const showBoletos = activeView === "boletos";
  const totalMovimentado = filteredSummary.entradas + filteredSummary.saidas;
  const percentualSaidas = totalMovimentado > 0 ? Math.round((filteredSummary.saidas / totalMovimentado) * 100) : 0;
  const financeStatus = filteredSummary.vencidos > 0 ? `${filteredSummary.vencidos} vencimento(s) pedem atenção` : filteredSummary.saldo >= 0 ? "Fluxo financeiro saudável" : "Saldo abaixo do esperado";
  const paidEntries = filteredLancamentos.filter((item) => item.status === "pago");
  const paidIn = paidEntries.filter((item) => item.type === "entrada").length;
  const paidOut = paidEntries.filter((item) => item.type === "saida").length;
  const pendingCount = filteredLancamentos.filter((item) => item.status === "pendente").length;
  const margin = filteredSummary.entradas > 0 ? (filteredSummary.saldo / filteredSummary.entradas) * 100 : null;
  const monthly = useMemo(() => monthlyRevenue(data.lancamentos), [data.lancamentos]);
  const monthlyMax = Math.max(0, ...monthly.map((item) => item.total));
  const feedback = (error || notice) ? (
    <div role={error ? "alert" : "status"} className={`fin-alert ${error ? "is-error" : "is-ok"}`}>{error || notice}</div>
  ) : null;

  function closeSelected() {
    setSelectedId(null);
    setEditingId(null);
    setDeleteConfirmId(null);
  }

  const entriesCard = (
    <section className="nx-card" aria-label="Lançamentos">
      <div className="nx-card-h">
        <h2>Lançamentos</h2>
        <span className="nx-faint nx-small" style={{ marginLeft: "auto" }}>Entradas, saídas, comprovantes e status</span>
      </div>
      {loading ? (
        <LoadingState label="Carregando financeiro..." />
      ) : filteredLancamentos.length === 0 ? (
        <EmptyLine text="Nenhum lançamento no período selecionado." />
      ) : (
        <div className="fin-table-wrap">
          <table className="nx-table">
            <thead>
              <tr>
                <th>Vencimento</th>
                <th>Descrição</th>
                <th>Categoria</th>
                <th>Método</th>
                <th>Status</th>
                <th className="fin-num">Valor</th>
                <th className="fin-num">Ações</th>
              </tr>
            </thead>
            <tbody>
              {filteredLancamentos.map((item) => (
                <tr key={item.id} className={selectedId === item.id ? "is-selected" : ""} onClick={() => selectLancamento(item)}>
                  <td className="nx-muted">{dateLabel(item.dueDate)}</td>
                  <td>
                    <button type="button" className="fin-title-btn" title={item.title} onClick={(event) => { event.stopPropagation(); selectLancamento(item); }}>{item.title}</button>
                    <span className="nx-faint nx-small">{item.attachments.length} anexo(s)</span>
                  </td>
                  <td className="nx-muted">{item.category || "—"}</td>
                  <td className="nx-muted">{item.method || "—"}</td>
                  <td><StatusBadge status={item.status} /></td>
                  <td className={`fin-num ${item.type === "entrada" ? "nx-up" : "nx-down"}`}>{item.type === "entrada" ? "+" : "−"} {money(item.amount)}</td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <div className="fin-row-actions">
                      {item.status === "pendente" && (
                        <button type="button" className="nx-btn is-sm fin-btn-success" onClick={() => void payLancamento(item)} disabled={payingLancamentoId === item.id}>
                          <CheckCircle2 size={14} />
                          {payingLancamentoId === item.id ? "Registrando..." : "Marcar como pago"}
                        </button>
                      )}
                      <button type="button" className="fin-icon-btn" onClick={() => selectLancamento(item)} title="Visualizar" aria-label={`Visualizar ${item.title}`}><Eye size={16} /></button>
                      <button type="button" className="fin-icon-btn" onClick={() => startEditLancamento(item)} title="Editar" aria-label={`Editar ${item.title}`}><Edit3 size={16} /></button>
                      <button type="button" className="fin-icon-btn" onClick={() => openAttachmentPicker(item)} disabled={uploadingAttachments} title="Anexar" aria-label={`Anexar arquivo em ${item.title}`}><Paperclip size={16} /></button>
                      <button type="button" className="fin-icon-btn is-danger" onClick={() => { selectLancamento(item); setDeleteConfirmId(item.id); }} title="Excluir" aria-label={`Excluir ${item.title}`}><Trash2 size={16} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  const programadoActions = (item: Programado) => (
    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
      <button type="button" className="nx-btn is-sm fin-btn-success" style={{ flex: 1 }} onClick={() => void payProgramado(item)} disabled={!item.active || payingProgramadoId === item.id}>
        <CheckCircle2 size={14} />
        {payingProgramadoId === item.id ? "Registrando..." : "Marcar como pago"}
      </button>
      <button type="button" className="fin-icon-btn is-danger" onClick={() => void deleteProgramado(item.id)} title="Excluir gasto programado" aria-label="Excluir gasto programado">
        <Trash2 size={16} />
      </button>
    </div>
  );

  return (
    <div className="nx-page fin-page norium-finance">
      <div className="nx-ph">
        <div>
          <h1>Financeiro</h1>
          <p>{periodTitle(periodPreset, period.start, period.end)}</p>
        </div>
        <div className="nx-ph-actions">
          <div className="fin-head-period">
            <select aria-label="Período financeiro" className="fin-field is-auto" value={periodPreset} onChange={(event) => setPeriodPreset(event.target.value as PeriodPreset)}>
              <option value="this-month">Este mês</option>
              <option value="last-month">Mês anterior</option>
              <option value="last-3-months">Últimos 3 meses</option>
              <option value="this-year">Este ano</option>
              <option value="custom">Período personalizado</option>
            </select>
            <button type="button" className="nx-btn" style={{ width: 36, padding: 0 }} onClick={() => void loadFinance()} title="Atualizar financeiro" aria-label="Atualizar financeiro"><RefreshCw size={16} /></button>
          </div>
          <button type="button" className="nx-btn" onClick={() => onOpenNora?.("Analise meu financeiro atual, destaque riscos e próximos vencimentos.")}><Sparkles size={16} />Analisar com a Nora</button>
          <button type="button" className="nx-btn" onClick={() => { setCreatePanel("scheduled"); setActiveView("scheduled"); }}><CalendarClock size={16} />Programar gasto</button>
          <button type="button" className="nx-btn is-primary" aria-label="Novo lançamento" onClick={() => { setCreatePanel("entry"); setActiveView("entries"); }}><Plus size={16} />Lançamento</button>
        </div>
      </div>

      {periodPreset === "custom" && (
        <section className="fin-custom-period" aria-label="Filtro do período financeiro">
          <span>Período analisado</span>
          <input type="date" className="fin-field is-auto" aria-label="Início do período" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
          <span>até</span>
          <input type="date" className="fin-field is-auto" aria-label="Fim do período" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
        </section>
      )}

      <div className="nx-kpis">
        <div className="nx-card nx-kpi">
          <div className="nx-kpi-l"><TrendingUp size={16} />Entradas pagas</div>
          <div className="nx-kpi-v">{money(filteredSummary.entradas)}</div>
          <div className="nx-kpi-s">{paidIn} recebimento(s) no período</div>
        </div>
        <div className="nx-card nx-kpi">
          <div className="nx-kpi-l"><TrendingDown size={16} />Saídas pagas</div>
          <div className="nx-kpi-v">{money(filteredSummary.saidas)}</div>
          <div className="nx-kpi-s">{paidOut} pagamento(s) no período</div>
        </div>
        <div className="nx-card nx-kpi">
          <div className="nx-kpi-l"><Wallet size={16} />Saldo</div>
          <div className={`nx-kpi-v ${filteredSummary.saldo < 0 ? "fin-kpi-v-down" : ""}`}>{money(filteredSummary.saldo)}</div>
          <div className="nx-kpi-s">{margin === null ? "sem entradas pagas no período" : `margem de ${margin.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`}</div>
        </div>
        <div className="nx-card nx-kpi">
          <div className="nx-kpi-l"><AlertTriangle size={16} />Pendente</div>
          <div className="nx-kpi-v">{money(filteredSummary.pendente)}</div>
          <div className="nx-kpi-s">{pendingCount} em aberto{filteredSummary.vencidos > 0 ? <> · <span className="nx-down">{filteredSummary.vencidos} vencido(s)</span></> : ""}</div>
        </div>
      </div>

      <nav className="nx-tabs" aria-label="Áreas do financeiro">
        {([
          ["overview", "Visão geral", filteredLancamentos.length + filteredProgramados.length],
          ["entries", "Lançamentos", filteredLancamentos.length],
          ["scheduled", "Programados", filteredProgramados.length],
          ["boletos", "Boletos", filteredBoletos.length],
        ] as Array<[FinanceView, string, number]>).map(([view, label, count]) => (
          <button
            key={view}
            type="button"
            aria-pressed={activeView === view}
            onClick={() => {
              setActiveView(view);
              setCreatePanel(null);
            }}
            className={`nx-tab ${activeView === view ? "is-active" : ""}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            {label}
            <span className="nx-badge" style={{ height: 20, padding: "0 7px", fontSize: 11.5 }}>{count}</span>
          </button>
        ))}
      </nav>

      {createPanel === null && !selected && feedback}

      {activeView === "overview" && (
        <>
          <div className="fin-grid-main">
            <section className="nx-card" aria-label="Receita mensal">
              <div className="nx-card-h">
                <h2>Receita mensal</h2>
                <span className="nx-faint nx-small" style={{ marginLeft: "auto" }}>entradas pagas, em milhares de R$</span>
              </div>
              <div className="nx-card-b">
                <div className="fin-chart">
                  {monthly.map((item, index) => (
                    <div key={item.key} className="fin-chart-col" title={`${item.label}: ${money(item.total)}`}>
                      <span>{(item.total / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</span>
                      <div className="fin-chart-track">
                        <div className={`fin-chart-bar ${index === monthly.length - 1 ? "is-current" : ""}`} style={{ height: monthlyMax > 0 ? `${Math.max(1, (item.total / monthlyMax) * 100)}%` : "2px" }} />
                      </div>
                      <span>{item.short}</span>
                    </div>
                  ))}
                </div>
                {monthlyMax === 0 && !loading && <p className="fin-chart-empty">Nenhuma entrada paga nos últimos meses.</p>}
              </div>
            </section>

            <section className="nx-card" aria-label="Próximos vencimentos">
              <div className="nx-card-h">
                <h2>Próximos vencimentos</h2>
                <button type="button" className="nx-more" onClick={() => setActiveView("entries")}>Ver todos</button>
              </div>
              <div className="nx-card-b">
                {data.lembretes.length === 0 ? (
                  <EmptyLine text="Nenhum pagamento próximo." />
                ) : data.lembretes.map((item) => (
                  <div key={item.id} className="nx-row">
                    <div className="nx-grow">
                      <div className="nx-row-t nx-ell">{item.title}</div>
                      <div className="nx-row-sub">{dateLabel(item.dueDate)} · {item.daysUntil < 0 ? <span className="nx-down">vencido</span> : `${item.daysUntil} dia(s)`}</div>
                    </div>
                    <span style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap" }}>{money(item.amount)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="nx-grid-2">
            <section className="nx-card" aria-label="Leitura do período">
              <div className="nx-card-h">
                <div>
                  <div className="nx-faint nx-small">Leitura do período</div>
                  <h2 style={{ marginTop: 2 }}>{financeStatus}</h2>
                </div>
                <span className={`nx-badge ${filteredSummary.vencidos > 0 || filteredSummary.saldo < 0 ? "is-amber" : "is-green"}`} style={{ marginLeft: "auto" }}>{filteredSummary.vencidos > 0 ? "Requer ação" : "Em dia"}</span>
              </div>
              <div className="nx-card-b">
                <div className="nx-bar"><i style={{ width: `${Math.min(100, percentualSaidas)}%` }} /></div>
                <div className="nx-small nx-muted" style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}><span>Saídas no fluxo movimentado</span><b style={{ color: "var(--nx-text)" }}>{percentualSaidas}%</b></div>
                <div className="fin-read-boxes">
                  <div><span className="nx-small nx-muted">Vencidos</span><strong className={filteredSummary.vencidos > 0 ? "nx-down" : ""}>{filteredSummary.vencidos}</strong></div>
                  <div><span className="nx-small nx-muted">Recorrências</span><strong>{filteredSummary.programadosAtivos}</strong></div>
                </div>
              </div>
            </section>

            <section className="nx-card" aria-label="Gastos programados">
              <div className="nx-card-h">
                <h2>Gastos programados</h2>
                <button type="button" className="nx-more" onClick={() => setActiveView("scheduled")}>Ver programados</button>
              </div>
              <div className="nx-card-b">
                {data.programados.length === 0 ? (
                  <EmptyLine text="Nenhum gasto programado." />
                ) : data.programados.map((item) => (
                  <div key={item.id} className="nx-row" style={{ display: "block" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div className="nx-row-t nx-ell nx-grow">{item.title}</div>
                      <span style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap" }}>{money(item.amount)}</span>
                    </div>
                    <div className="nx-row-sub">{frequencyLabel(item.frequency)} · {dateLabel(item.nextDueDate)} · avisar {item.remindDaysBefore} dia(s) antes</div>
                    {programadoActions(item)}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}

      {showBoletos && (
        <section className="nx-card" aria-label="Boletos">
          <div className="nx-card-h" style={{ flexWrap: "wrap" }}>
            <div>
              <h2>Boletos</h2>
              <div className="nx-faint nx-small" style={{ marginTop: 2 }}>Documentos importados dentro do período selecionado.</div>
            </div>
            <div className="nx-seg" aria-label="Situação dos boletos" style={{ marginLeft: "auto" }}>
              {([['open', 'Em aberto'], ['paid', 'Pagos'], ['all', 'Todos']] as Array<[BoletoFilter, string]>).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={boletoFilter === value} className={boletoFilter === value ? "is-active" : ""} onClick={() => setBoletoFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {filteredBoletos.length === 0 ? (
            <EmptyLine text={boletoFilter === "paid" ? "Nenhum boleto pago neste período." : boletoFilter === "open" ? "Nenhum boleto em aberto neste período." : "Nenhum boleto neste período."} />
          ) : (
            <div className="fin-table-wrap">
              <table className="nx-table">
                <thead>
                  <tr><th>Vencimento</th><th>Boleto</th><th>Beneficiário</th><th>Status</th><th className="fin-num">Valor</th><th className="fin-num">Documento</th></tr>
                </thead>
                <tbody>
                  {filteredBoletos.map((boleto) => (
                    <tr key={boleto.id} style={{ cursor: "default" }}>
                      <td className="nx-muted">{dateLabel(boleto.dueDate)}</td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{boleto.title}</div>
                        {(boleto.linhaDigitavel || boleto.barcode) && <div className="nx-faint nx-small nx-ell" style={{ maxWidth: 280 }}>Linha: {boleto.linhaDigitavel || boleto.barcode}</div>}
                      </td>
                      <td className="nx-muted">{boleto.beneficiary || "Beneficiário não informado"}</td>
                      <td><span className={`nx-badge ${boletoIsPaid(boleto.status) ? "is-green" : "is-amber"}`}>{boletoIsPaid(boleto.status) ? "Pago" : "Em aberto"}</span></td>
                      <td className="fin-num">{money(boleto.amount)}</td>
                      <td className="fin-num">
                        {boleto.url ? (
                          <a href={boleto.url} target="_blank" rel="noreferrer" className="nx-btn is-sm" style={{ textDecoration: "none" }}>
                            <ExternalLink size={14} />
                            Abrir boleto
                          </a>
                        ) : <span className="nx-faint">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {showEntries && entriesCard}

      {activeView === "scheduled" && (
        <section className="nx-card" aria-label="Agenda de pagamentos">
          <div className="nx-card-h">
            <div>
              <h2>Agenda de pagamentos</h2>
              <div className="nx-faint nx-small" style={{ marginTop: 2 }}>Controle recorrências, próximos vencimentos e pagamentos realizados.</div>
            </div>
          </div>
          {filteredProgramados.length === 0 ? (
            <EmptyLine text="Nenhum gasto programado no período selecionado." />
          ) : (
            <div className="fin-sched-grid">
              {filteredProgramados.map((item) => (
                <article key={item.id} className="fin-sched-card">
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div className="nx-grow">
                      <h3 className="nx-ell" style={{ margin: 0, fontSize: 14 }}>{item.title}</h3>
                      <div className="nx-faint nx-small" style={{ marginTop: 2 }}>{item.category} · {frequencyLabel(item.frequency)}</div>
                    </div>
                    <strong style={{ fontSize: 14, whiteSpace: "nowrap" }}>{money(item.amount)}</strong>
                  </div>
                  <div className="fin-sched-meta">
                    <div><span>Próximo vencimento</span><b>{dateLabel(item.nextDueDate)}</b></div>
                    <div><span>Lembrete</span><b>{item.remindDaysBefore} dia(s) antes</b></div>
                  </div>
                  {programadoActions(item)}
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {createPanel === "entry" && (
        <div className="fin-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreatePanel(null); }}>
          <section className="fin-modal" role="dialog" aria-modal="true" aria-labelledby="fin-new-entry-title">
            <div className="fin-modal-h">
              <div className="nx-grow">
                <h2 id="fin-new-entry-title">Novo lançamento</h2>
                <p>Registre uma entrada ou saída do caixa.</p>
              </div>
              <button type="button" className="fin-icon-btn" onClick={() => setCreatePanel(null)} title="Fechar formulário" aria-label="Fechar formulário"><X size={16} /></button>
            </div>
            <div className="fin-modal-b">
              <TypeSeg value={lancamentoForm.type} onChange={(type) => setLancamentoForm({ ...lancamentoForm, type })} />
              <div className="fin-form-grid">
                <label className="fin-label">Título *<input value={lancamentoForm.title} onChange={(event) => setLancamentoForm({ ...lancamentoForm, title: event.target.value })} placeholder="Título" className="fin-field" /></label>
                <label className="fin-label">Valor (R$) *<input value={lancamentoForm.amount} inputMode="decimal" onChange={(event) => setLancamentoForm({ ...lancamentoForm, amount: event.target.value })} placeholder="Valor" className="fin-field" /></label>
                <label className="fin-label">Categoria<input value={lancamentoForm.category} onChange={(event) => setLancamentoForm({ ...lancamentoForm, category: event.target.value })} placeholder="Categoria" className="fin-field" /></label>
                <label className="fin-label">Método<input value={lancamentoForm.method} onChange={(event) => setLancamentoForm({ ...lancamentoForm, method: event.target.value })} placeholder="Método" className="fin-field" /></label>
                <label className="fin-label">Vencimento<input type="date" value={lancamentoForm.dueDate} onChange={(event) => setLancamentoForm({ ...lancamentoForm, dueDate: event.target.value })} className="fin-field" /></label>
                <label className="fin-label">Status
                  <Select value={lancamentoForm.status} onChange={(value) => setLancamentoForm({ ...lancamentoForm, status: value as EntryStatus })}>
                    <option value="pendente">Pendente</option>
                    <option value="pago">Pago</option>
                    <option value="cancelado">Cancelado</option>
                  </Select>
                </label>
                <label className="fin-label is-full">Descrição<textarea value={lancamentoForm.description} onChange={(event) => setLancamentoForm({ ...lancamentoForm, description: event.target.value })} placeholder="Descrição" rows={3} className="fin-field" /></label>
              </div>
              {feedback}
            </div>
            <div className="fin-modal-f">
              <button type="button" className="nx-btn" onClick={() => setCreatePanel(null)}>Cancelar</button>
              <button type="button" className="nx-btn is-primary" onClick={() => void createLancamento()} disabled={creatingLancamento || !lancamentoForm.title.trim() || !lancamentoForm.amount}>
                {creatingLancamento ? "Salvando..." : "Salvar lançamento"}
              </button>
            </div>
          </section>
        </div>
      )}

      {createPanel === "scheduled" && (
        <div className="fin-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreatePanel(null); }}>
          <section className="fin-modal" role="dialog" aria-modal="true" aria-labelledby="fin-new-scheduled-title">
            <div className="fin-modal-h">
              <BellRing size={18} style={{ marginTop: 3, color: "var(--nx-primary)" }} />
              <div className="nx-grow">
                <h2 id="fin-new-scheduled-title">Programar gasto fixo</h2>
                <p>Receba um lembrete antes de cada vencimento.</p>
              </div>
              <button type="button" className="fin-icon-btn" onClick={() => setCreatePanel(null)} title="Fechar formulário" aria-label="Fechar formulário"><X size={16} /></button>
            </div>
            <div className="fin-modal-b">
              <div className="fin-form-grid">
                <label className="fin-label is-full">Nome do gasto *<input value={programadoForm.title} onChange={(event) => setProgramadoForm({ ...programadoForm, title: event.target.value })} placeholder="Nome do gasto" className="fin-field" /></label>
                <label className="fin-label">Valor (R$) *<input value={programadoForm.amount} inputMode="decimal" onChange={(event) => setProgramadoForm({ ...programadoForm, amount: event.target.value })} placeholder="Valor" className="fin-field" /></label>
                <label className="fin-label">Próximo vencimento<input type="date" value={programadoForm.nextDueDate} onChange={(event) => setProgramadoForm({ ...programadoForm, nextDueDate: event.target.value })} className="fin-field" /></label>
                <label className="fin-label">Frequência
                  <Select value={programadoForm.frequency} onChange={(value) => setProgramadoForm({ ...programadoForm, frequency: value as Frequency })}>
                    <option value="unico">Único</option>
                    <option value="semanal">Semanal</option>
                    <option value="mensal">Mensal</option>
                    <option value="anual">Anual</option>
                  </Select>
                </label>
                <label className="fin-label">Avisar dias antes<input value={programadoForm.remindDaysBefore} inputMode="numeric" onChange={(event) => setProgramadoForm({ ...programadoForm, remindDaysBefore: event.target.value })} placeholder="Avisar dias antes" className="fin-field" /></label>
                <label className="fin-label is-full">Categoria<input value={programadoForm.category} onChange={(event) => setProgramadoForm({ ...programadoForm, category: event.target.value })} placeholder="Categoria" className="fin-field" /></label>
              </div>
              {feedback}
            </div>
            <div className="fin-modal-f">
              <button type="button" className="nx-btn" onClick={() => setCreatePanel(null)}>Cancelar</button>
              <button type="button" className="nx-btn is-primary" onClick={() => void createProgramado()} disabled={creatingProgramado || !programadoForm.title.trim() || !programadoForm.amount}>
                {creatingProgramado ? "Salvando..." : "Programar lembrete"}
              </button>
            </div>
          </section>
        </div>
      )}

      {selected && (
        <section className="fin-drawer" aria-label="Lançamento selecionado">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div className="nx-grow">
              <div className="nx-faint nx-small">Lançamento selecionado</div>
              <h2>{selected.title}</h2>
              <div className="nx-muted nx-small" style={{ marginTop: 4, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                {selected.category} · <StatusBadge status={selected.status} /> · {dateLabel(selected.dueDate)}
              </div>
            </div>
            <button type="button" className="fin-icon-btn" onClick={closeSelected} title="Fechar visualização" aria-label="Fechar visualização"><X size={16} /></button>
          </div>
          <div className="fin-drawer-actions">
            <button type="button" className="nx-btn is-sm" onClick={() => startEditLancamento(selected)}><Edit3 size={14} />Editar</button>
            <button type="button" className="nx-btn is-sm fin-btn-success" onClick={() => void patchLancamento(selected.id, { status: "pago" })}><CheckCircle2 size={14} />Marcar pago</button>
            <button type="button" className="nx-btn is-sm" onClick={() => fileInputRef.current?.click()} disabled={uploadingAttachments}><FileUp size={14} />{uploadingAttachments ? "Anexando..." : "Anexar documentos"}</button>
            <button type="button" className="nx-btn is-sm fin-btn-danger" onClick={() => setDeleteConfirmId(selected.id)}><Trash2 size={14} />Excluir</button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf,application/xml,text/xml,.xml,.ofx,.csv,.xlsx,.xls,.doc,.docx"
            className="hidden"
            style={{ display: "none" }}
            onChange={(event) => {
              const files = event.target.files;
              if (files?.length) void uploadAttachments(files);
              event.currentTarget.value = "";
            }}
          />

          {createPanel === null && feedback}

          {deleteConfirmId === selected.id && (
            <div className="fin-box is-danger">
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                <div className="nx-grow">
                  <h3 style={{ margin: 0, fontSize: 14, color: "var(--nx-danger)" }}>Excluir lançamento?</h3>
                  <p className="nx-small nx-muted" style={{ margin: "3px 0 0" }}>Esta ação remove o lançamento financeiro da base persistida.</p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="nx-btn is-sm" onClick={() => setDeleteConfirmId(null)}>Cancelar</button>
                  <button type="button" className="nx-btn is-sm fin-btn-danger-solid" onClick={() => void deleteLancamento(selected.id)}>Confirmar exclusão</button>
                </div>
              </div>
            </div>
          )}

          {isEditingSelected ? (
            <div className="fin-box">
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
                <div className="nx-grow">
                  <h3 style={{ margin: 0, fontSize: 14 }}>Editar lançamento</h3>
                  <p className="nx-small nx-muted" style={{ margin: "3px 0 0" }}>Atualize valor, categoria, vencimento, status e descrição.</p>
                </div>
                <button type="button" className="fin-icon-btn" onClick={cancelEditLancamento} title="Cancelar edição" aria-label="Cancelar edição"><X size={16} /></button>
              </div>
              <div className="fin-form-grid">
                <label className="fin-label is-full">Título<input value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} className="fin-field" /></label>
                <div className="fin-label">Tipo<TypeSeg value={editForm.type} onChange={(type) => setEditForm({ ...editForm, type })} /></div>
                <label className="fin-label">Valor (R$)<input value={editForm.amount} inputMode="decimal" onChange={(event) => setEditForm({ ...editForm, amount: event.target.value })} className="fin-field" /></label>
                <label className="fin-label">Categoria<input value={editForm.category} onChange={(event) => setEditForm({ ...editForm, category: event.target.value })} className="fin-field" /></label>
                <label className="fin-label">Método<input value={editForm.method} onChange={(event) => setEditForm({ ...editForm, method: event.target.value })} className="fin-field" /></label>
                <label className="fin-label">Vencimento<input type="date" value={editForm.dueDate} onChange={(event) => setEditForm({ ...editForm, dueDate: event.target.value })} className="fin-field" /></label>
                <label className="fin-label">Status
                  <Select value={editForm.status} onChange={(value) => setEditForm({ ...editForm, status: value as EntryStatus })}>
                    <option value="pendente">Pendente</option>
                    <option value="pago">Pago</option>
                    <option value="cancelado">Cancelado</option>
                  </Select>
                </label>
                <label className="fin-label is-full">Descrição<textarea value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} rows={3} className="fin-field" /></label>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                <button type="button" className="nx-btn is-primary" onClick={() => void saveEditLancamento()} disabled={savingEdit}><Save size={15} />{savingEdit ? "Salvando..." : "Salvar alterações"}</button>
                <button type="button" className="nx-btn" onClick={cancelEditLancamento}>Cancelar</button>
              </div>
            </div>
          ) : (
            <div className="fin-box">
              <div className="nx-faint nx-small">Descrição</div>
              <p className="nx-muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>{selected.description || "Sem descrição."}</p>
              <div className="fin-facts">
                <div><span>Valor</span><b className={selected.type === "entrada" ? "nx-up" : "nx-down"}>{money(selected.amount)}</b></div>
                <div><span>Método</span><b>{selected.method || "Não informado"}</b></div>
                <div><span>Pago em</span><b>{dateLabel(selected.paidAt)}</b></div>
                <div><span>Origem</span><b>{selected.source || "manual"}</b></div>
              </div>
            </div>
          )}

          <div className="fin-box is-dashed">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
              <span style={{ display: "grid", width: 36, height: 36, placeItems: "center", borderRadius: 8, background: "var(--nx-primary-soft)", color: "var(--nx-primary-text)" }}><FileText size={16} /></span>
              <div className="nx-grow">
                <h3 style={{ margin: 0, fontSize: 14 }}>Documentos do lançamento</h3>
                <p className="nx-small nx-muted" style={{ margin: "2px 0 0" }}>Comprovantes, notas fiscais, boletos, recibos, XML, OFX, planilhas e imagens.</p>
              </div>
              <button type="button" className="nx-btn is-sm is-primary" onClick={() => fileInputRef.current?.click()} disabled={uploadingAttachments}><Paperclip size={14} />Adicionar arquivos</button>
            </div>
          </div>
          <div className="fin-attach-grid">
            {selected.attachments.length === 0 ? (
              <button type="button" className="fin-attach-empty" style={{ gridColumn: "1 / -1" }} onClick={() => fileInputRef.current?.click()}>
                Nenhum arquivo anexado. Clique para adicionar comprovantes ou notas fiscais.
              </button>
            ) : selected.attachments.map((item) => (
              <article key={item.id} className="fin-attach">
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <Paperclip size={14} style={{ flex: "none", color: "var(--nx-primary)" }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="nx-ell" style={{ fontWeight: 500 }}>{item.name}</div>
                    <div className="nx-ell nx-faint" style={{ fontSize: 12 }}>{item.mimeType || "arquivo"} · {fileSizeLabel(item.size)}</div>
                  </div>
                </div>
                <div className="fin-attach-actions">
                  <button type="button" className="nx-btn is-sm" onClick={() => void openWithAuth(item.url)}>Abrir</button>
                  <button type="button" className="nx-btn is-sm" onClick={() => void downloadWithAuth(item.url, item.name)}><Download size={13} />Baixar</button>
                  <button type="button" className="nx-btn is-sm fin-btn-danger" onClick={() => void removeAttachment(item)} disabled={removingAttachmentId === item.id}><Trash2 size={13} />{removingAttachmentId === item.id ? "..." : "Remover"}</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const MONTH_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function monthlyRevenue(items: Lancamento[]) {
  const now = new Date();
  const months = Array.from({ length: 10 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - 9 + index, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    return { key, short: MONTH_SHORT[date.getMonth()], label: `${MONTH_SHORT[date.getMonth()]}/${date.getFullYear()}`, total: 0 };
  });
  const byKey = new Map(months.map((item) => [item.key, item]));
  items.forEach((item) => {
    if (item.type !== "entrada" || item.status !== "pago") return;
    const month = byKey.get((item.paidAt || item.dueDate || item.createdAt || "").slice(0, 7));
    if (month) month.total += Number(item.amount || 0);
  });
  return months;
}

function periodTitle(preset: PeriodPreset, start: string, end: string) {
  if (!start || !end) return "Defina as datas do período";
  if (preset === "this-month" || preset === "last-month") {
    const label = new Date(`${start}T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  return `${dateLabel(start)} a ${dateLabel(end)}`;
}

function frequencyLabel(value: Frequency) {
  return { unico: "Único", semanal: "Semanal", mensal: "Mensal", anual: "Anual" }[value] || value;
}

function StatusBadge({ status }: { status: EntryStatus }) {
  const tone = status === "pago" ? "is-green" : status === "pendente" ? "is-amber" : "";
  const label = status === "pago" ? "Pago" : status === "pendente" ? "Pendente" : "Cancelado";
  return <span className={`nx-badge ${tone}`}>{label}</span>;
}

function TypeSeg({ value, onChange }: { value: EntryType; onChange: (value: EntryType) => void }) {
  return (
    <div className="nx-seg" role="group" aria-label="Tipo do lançamento" style={{ alignSelf: "flex-start" }}>
      <button type="button" aria-pressed={value === "saida"} className={`fin-seg-out ${value === "saida" ? "is-active" : ""}`} onClick={() => onChange("saida")}>Saída</button>
      <button type="button" aria-pressed={value === "entrada"} className={`fin-seg-in ${value === "entrada" ? "is-active" : ""}`} onClick={() => onChange("entrada")}>Entrada</button>
    </div>
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className="fin-field">
      {children}
    </select>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="fin-empty">{text}</div>;
}
