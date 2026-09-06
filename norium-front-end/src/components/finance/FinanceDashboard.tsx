import WorkspaceHeader from "../shared/WorkspaceHeader";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutDashboard,
  ArrowDownUp,
  CalendarClock,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  FileSearch,
  FileUp,
  Paperclip,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Save,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { apiBaseUrl } from "../../utils/api";
import { downloadWithAuth, openWithAuth } from "../../utils/download";
import LoadingState from "../shared/LoadingState";
import { showConfirm } from "../shared/AppDialogProvider";
import Button from "../shared/Button";

const BACKEND_URL = apiBaseUrl();

type EntryType = "entrada" | "saida";
type EntryStatus = "pendente" | "pago" | "cancelado";
type Frequency = "unico" | "semanal" | "mensal" | "anual";
type FinanceView = "overview" | "entries" | "scheduled" | "boletos";
type FinanceCreatePanel = "entry" | "scheduled" | null;

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
  return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
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
  const [cpf, setCpf] = useState("");
  const [senhaBoleto, setSenhaBoleto] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncingBoletos, setSyncingBoletos] = useState(false);
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

  const loadFinance = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const response = await fetch(`${BACKEND_URL}/api/financeiro?user_id=${userId}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.detail || "Nao consegui carregar os dados financeiros.");
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
    if (!lancamentoForm.title.trim() || !amount) return;
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
      if (!response.ok) throw new Error(payload?.detail || "Nao consegui criar o lancamento.");
      setLancamentoForm(emptyLancamento);
      setSelectedId(payload.lancamento.id);
      setActiveView("entries");
      setCreatePanel(null);
      setNotice(`Lancamento "${payload.lancamento.title}" salvo com sucesso.`);
      await loadFinance();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Falha ao salvar o lancamento. Verifique se o backend esta rodando na porta 8000.",
      );
    } finally {
      setCreatingLancamento(false);
    }
  }

  async function createProgramado() {
    const amount = Number(String(programadoForm.amount).replace(",", "."));
    if (!programadoForm.title.trim() || !amount) return;
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
      if (!response.ok) throw new Error(payload?.detail || "Nao consegui criar a programacao.");
      setProgramadoForm(emptyProgramado);
      setActiveView("scheduled");
      setCreatePanel(null);
      setNotice(`Gasto programado "${payload.programado.title}" salvo com sucesso.`);
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar a programacao.");
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
      if (!response.ok) throw new Error(payload?.detail || "Nao consegui atualizar o lancamento.");
      setNotice(`Lancamento "${payload.lancamento.title}" atualizado.`);
      await loadFinance();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui atualizar o lancamento.");
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
        throw new Error(payload?.detail || "Nao consegui excluir o lancamento.");
      }
      setSelectedId(null);
      setEditingId(null);
      setDeleteConfirmId(null);
      setNotice("Lancamento excluido com sucesso.");
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui excluir o lancamento.");
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
    if (!editForm.title.trim() || !amount) {
      setError("Informe titulo e valor para salvar o lancamento.");
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
      setError(payload?.detail || "Nao consegui excluir a programacao.");
      return;
    }
    setNotice("Programacao excluida.");
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
      if (!response.ok) throw new Error(payload?.detail || "Nao consegui registrar o pagamento.");
      setSelectedId(payload?.lancamento?.id || null);
      setNotice(
        payload?.programado?.nextDueDate
          ? `Pagamento registrado. Proximo vencimento em ${dateLabel(payload.programado.nextDueDate)}.`
          : "Pagamento registrado e programacao concluida.",
      );
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui registrar o pagamento.");
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
        if (!response.ok) throw new Error(payload?.detail || `Nao consegui anexar ${file.name}.`);
      }
      setNotice(
        selectedFiles.length === 1
          ? "Arquivo anexado ao lancamento."
          : `${selectedFiles.length} arquivos anexados ao lancamento.`,
      );
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui anexar os arquivos.");
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
      if (!response.ok) throw new Error(payload?.detail || "Nao consegui remover o anexo.");
      setNotice(`Anexo "${attachment.name}" removido.`);
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui remover o anexo.");
    } finally {
      setRemovingAttachmentId(null);
    }
  }

  async function consultarBoletos() {
    if (cpf.replace(/\D/g, "").length !== 11) {
      setError("Informe um CPF com 11 digitos.");
      return;
    }
    try {
      setSyncingBoletos(true);
      setError("");
      setNotice("");
      const response = await fetch(`${BACKEND_URL}/api/financeiro/boletos/consultar`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, cpf, senha: senhaBoleto || undefined }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.detail || "Nao consegui consultar boletos.");
      setNotice(payload.message || "Consulta concluida.");
      await loadFinance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao consultar boletos.");
    } finally {
      setSyncingBoletos(false);
    }
  }

  const showEntries = activeView === "overview" || activeView === "entries";
  const showBoletos = activeView === "overview" || activeView === "boletos";
  const showScheduled = activeView === "overview" || activeView === "scheduled";
  const showAside = createPanel !== null || activeView === "overview" || activeView === "scheduled";
  const totalMovimentado = data.resumo.entradas + data.resumo.saidas;
  const percentualSaidas = totalMovimentado > 0 ? Math.round((data.resumo.saidas / totalMovimentado) * 100) : 0;
  const financeStatus = data.resumo.vencidos > 0 ? `${data.resumo.vencidos} vencimento(s) pedem atenção` : data.resumo.saldo >= 0 ? "Fluxo financeiro saudável" : "Saldo abaixo do esperado";

  return (
    <div className="clean-workspace finance-workspace norium-finance flex h-full min-h-0 w-full flex-col bg-[var(--background)] text-[var(--text)]">
      <WorkspaceHeader title="Financeiro" description="Acompanhe o caixa, os lançamentos e os próximos vencimentos." icon={Wallet}>
<Button iconOnly onClick={() => void loadFinance()} title="Atualizar financeiro" aria-label="Atualizar financeiro"><RefreshCw size={16} /></Button>
<Button onClick={() => onOpenNora?.("Analise meu financeiro atual, destaque riscos e próximos vencimentos.")}><Sparkles size={16} />Analisar com Nora</Button>
<Button onClick={() => { setCreatePanel("scheduled"); setActiveView("scheduled"); }}><CalendarClock size={16} />Programar gasto</Button>
<Button variant="primary" className="workspace-primary" onClick={() => { setCreatePanel("entry"); setActiveView("entries"); }}><Plus size={16} />Novo lançamento</Button>
</WorkspaceHeader>

      <main className="finance-content min-h-0 flex-1 overflow-y-auto">
            <div className="workspace-metrics grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Metric icon={TrendingUp} label="Entradas pagas" value={money(data.resumo.entradas)} tone="emerald" />
              <Metric icon={TrendingDown} label="Saídas pagas" value={money(data.resumo.saidas)} tone="rose" />
              <Metric icon={Wallet} label="Saldo" value={money(data.resumo.saldo)} tone="blue" />
              <Metric icon={AlertTriangle} label="Pendente" value={money(data.resumo.pendente)} tone="amber" />
            </div>
        <nav className="workspace-tabs finance-tabs" aria-label="Áreas do financeiro">
          {([
            ["overview", "Visão geral", data.lancamentos.length + data.programados.length],
            ["entries", "Lançamentos", data.lancamentos.length],
            ["scheduled", "Programados", data.programados.length],
            ["boletos", "Boletos", data.boletos.length],
          ] as Array<[FinanceView, string, number]>).map(([view, label, count]) => (
            <button
              key={view}
              aria-pressed={activeView === view}
              onClick={() => {
                setActiveView(view);
                setCreatePanel(null);
              }}
              className={`flex h-10 shrink-0 items-center gap-2 rounded-md px-4 text-xs font-bold transition ${
                activeView === view
                  ? "bg-[var(--primary)] text-white shadow-lg shadow-blue-950/20"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              }`}
            >
              {view === "overview" ? <LayoutDashboard size={16} /> : view === "entries" ? <ArrowDownUp size={16} /> : view === "scheduled" ? <CalendarClock size={16} /> : <Receipt size={16} />}
              {label}
              <span className={`rounded-full px-2 py-0.5 text-xs ${activeView === view ? "bg-white/15" : "bg-[var(--background)]"}`}>
                {count}
              </span>
            </button>
          ))}
        </nav>

        <div className={`grid gap-4 ${showAside ? "xl:grid-cols-[minmax(0,1fr)_380px]" : ""}`}>
          <section className="space-y-4">


            {activeView === "overview" && (
              <section className="grid gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm lg:grid-cols-[minmax(0,1fr)_minmax(280px,.55fr)]">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div><p className="text-[10px] font-black uppercase tracking-[.16em] text-blue-300">Leitura do período</p><h2 className="mt-1 text-lg font-black">{financeStatus}</h2></div>
                    <span className={`rounded-full px-3 py-1 text-xs font-black ${data.resumo.vencidos > 0 || data.resumo.saldo < 0 ? "bg-amber-500/12 text-amber-200" : "bg-emerald-500/12 text-emerald-200"}`}>{data.resumo.vencidos > 0 ? "Requer ação" : "Em dia"}</span>
                  </div>
                  <div className="mt-5 h-2 overflow-hidden rounded-full bg-[var(--background)]"><span className="block h-full rounded-full bg-slate-400" style={{ width: `${Math.min(100, percentualSaidas)}%` }} /></div>
                  <div className="mt-2 flex justify-between text-xs font-bold text-[var(--text-secondary)]"><span>Saídas no fluxo movimentado</span><strong className="text-[var(--text)]">{percentualSaidas}%</strong></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-[var(--background)] p-4"><span className="text-xs font-bold text-[var(--text-secondary)]">Vencidos</span><strong className="mt-2 block text-2xl font-black text-amber-200">{data.resumo.vencidos}</strong></div>
                  <div className="rounded-xl bg-[var(--background)] p-4"><span className="text-xs font-bold text-[var(--text-secondary)]">Recorrências</span><strong className="mt-2 block text-2xl font-black text-cyan-200">{data.resumo.programadosAtivos}</strong></div>
                </div>
              </section>
            )}

            {(error || notice) && (
              <div className={`rounded-lg border px-4 py-3 text-sm font-bold ${error ? "border-amber-400/25 bg-amber-500/10 text-amber-200" : "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"}`}>
                {error || notice}
              </div>
            )}

            {showBoletos && (
            <section className="workspace-panel">
              <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
                <div>
                  <h2 className="text-base font-black">Boletos no CPF</h2>
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">Consulte e organize os boletos vinculados ao CPF informado.</p>
                </div>
                <Receipt size={20} className="text-blue-300" />
              </header>
              <div className="grid gap-3 p-5 md:grid-cols-2 2xl:grid-cols-[minmax(0,1fr)_220px_auto]">
                <div className="flex h-11 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3">
                  <Search size={15} className="text-[var(--text-secondary)]" />
                  <input
                    value={cpf}
                    onChange={(event) => setCpf(event.target.value)}
                    placeholder="CPF para consulta de boletos"
                    className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
                  />
                </div>
                <div className="flex h-11 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3">
                  <input
                    value={senhaBoleto}
                    onChange={(event) => setSenhaBoleto(event.target.value)}
                    placeholder="Senha do boleto"
                    type="password"
                    className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none placeholder:text-[var(--text-secondary)]"
                  />
                </div>
                <Button variant="primary" size="lg"
                  onClick={() => void consultarBoletos()}
                  disabled={syncingBoletos}
                  className="hover:brightness-110disabled:opacity-50 md:col-span-2 2xl:col-span-1"
                >
                  <FileSearch size={16} />
                  {syncingBoletos ? "Consultando..." : "Buscar boletos"}
                </Button>
              </div>
              <div className="divide-y divide-[var(--border)]">
                {data.boletos.length === 0 ? (
                  <EmptyLine text="Nenhum boleto importado ainda." />
                ) : (
                  data.boletos.map((boleto) => (
                    <div key={boleto.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_auto]">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold">{boleto.title}</p>
                        <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                          {boleto.beneficiary || "Beneficiario nao informado"} · {dateLabel(boleto.dueDate)}
                        </p>
                        {(boleto.linhaDigitavel || boleto.barcode) && (
                          <p className="mt-1 truncate text-xs font-semibold text-[var(--text-secondary)]">
                            Linha: {boleto.linhaDigitavel || boleto.barcode}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <span className="text-sm font-bold text-blue-200">{money(boleto.amount)}</span>
                        {boleto.url && (
                          <a
                            href={boleto.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex h-8 items-center gap-2 rounded-lg border border-blue-400/30 px-3 text-xs font-bold text-blue-200 transition hover:bg-blue-500/10"
                          >
                            <ExternalLink size={14} />
                            Abrir boleto
                          </a>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
            )}

            {showEntries && (
            <section className="workspace-panel">
              <header className="border-b border-[var(--border)] px-5 py-4">
                <h2 className="text-base font-black">Lancamentos</h2>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">Entradas, saidas, comprovantes e status.</p>
              </header>
              <div className="divide-y divide-[var(--border)]">
                {loading ? (
                  <LoadingState label="Carregando financeiro..." />
                ) : data.lancamentos.length === 0 ? (
                  <EmptyLine text="Nenhum lancamento criado." />
                ) : (
                  data.lancamentos.map((item) => (
                    <div key={item.id}>
                    <button
                      onClick={() => {
                        setSelectedId(item.id);
                        setDeleteConfirmId(null);
                        if (editingId && editingId !== item.id) setEditingId(null);
                      }}
                      className={`grid w-full gap-3 px-5 py-4 text-left transition hover:bg-[var(--surface-hover)] md:grid-cols-[1fr_auto] ${
                        selectedId === item.id ? "bg-blue-500/10" : ""
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          {item.type === "entrada" ? <TrendingUp size={15} className="text-emerald-300" /> : <TrendingDown size={15} className="text-rose-300" />}
                          <strong className="truncate text-sm font-bold">{item.title}</strong>
                          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${item.status === "pago" ? "bg-emerald-500/10 text-emerald-200" : "bg-amber-500/10 text-amber-200"}`}>
                            {item.status}
                          </span>
                        </span>
                        <span className="mt-1 block truncate text-xs font-semibold text-[var(--text-secondary)]">
                          {item.category} · {dateLabel(item.dueDate)} · {item.attachments.length} anexo(s)
                        </span>
                      </span>
                      <span className={`text-sm font-bold ${item.type === "entrada" ? "text-emerald-200" : "text-rose-200"}`}>
                        {item.type === "entrada" ? "+" : "-"} {money(item.amount)}
                      </span>
                    </button>
                    <div className="flex flex-wrap items-center gap-2 bg-[var(--surface)] px-5 pb-4">
                      {item.status === "pendente" && (
                        <Button variant="primary" size="sm"
                          onClick={() => void payLancamento(item)}
                          disabled={payingLancamentoId === item.id}
                          className="bg-emerald-600 hover:bg-emerald-500"
                        >
                          <CheckCircle2 size={13} />
                          {payingLancamentoId === item.id ? "Registrando..." : "Marcar como pago"}
                        </Button>
                      )}
                      <button
                        onClick={() => selectLancamento(item)}
                        className="flex h-8 items-center gap-1 rounded-lg border border-blue-400/25 px-2 text-xs font-bold text-blue-100 hover:bg-blue-500/10"
                      >
                        <Eye size={13} />
                        Visualizar
                      </button>
                      <Button size="sm"
                        onClick={() => startEditLancamento(item)}
                        className="border-cyan-400/25 text-cyan-100 hover:bg-cyan-500/10"
                      >
                        <Edit3 size={13} />
                        Editar
                      </Button>
                      <button
                        onClick={() => openAttachmentPicker(item)}
                        disabled={uploadingAttachments}
                        className="flex h-8 items-center gap-1 rounded-lg border border-blue-400/25 px-2 text-xs font-bold text-blue-100 hover:bg-blue-500/10 disabled:opacity-50"
                      >
                        <Paperclip size={13} />
                        Anexar
                      </button>
                      <Button variant="danger" size="sm"
                        onClick={() => {
                          selectLancamento(item);
                          setDeleteConfirmId(item.id);
                        }}
                        className="border-rose-400/25 text-rose-100 hover:bg-rose-500/10"
                      >
                        <Trash2 size={13} />
                        Excluir
                      </Button>
                    </div>
                    </div>
                  ))
                )}
              </div>
            </section>
            )}

            {activeView === "scheduled" && data.programados.length > 0 && (
              <section className="workspace-panel">
                <header className="border-b border-[var(--border)] px-5 py-4">
                  <h2 className="text-base font-black">Agenda de pagamentos</h2>
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">
                    Controle recorrencias, proximos vencimentos e pagamentos realizados.
                  </p>
                </header>
                <div className="grid gap-3 p-4 md:grid-cols-2">
                  {data.programados.map((item) => (
                    <article key={item.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-bold">{item.title}</h3>
                          <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                            {item.category} · {item.frequency}
                          </p>
                        </div>
                        <strong className="shrink-0 text-sm text-blue-200">{money(item.amount)}</strong>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-md bg-[var(--surface)] p-3">
                          <span className="block text-[var(--text-secondary)]">Proximo vencimento</span>
                          <strong className="mt-1 block">{dateLabel(item.nextDueDate)}</strong>
                        </div>
                        <div className="rounded-md bg-[var(--surface)] p-3">
                          <span className="block text-[var(--text-secondary)]">Lembrete</span>
                          <strong className="mt-1 block">{item.remindDaysBefore} dia(s) antes</strong>
                        </div>
                      </div>
                      <div className="mt-4 flex gap-2">
                        <Button variant="primary" size="sm"
                          onClick={() => void payProgramado(item)}
                          disabled={!item.active || payingProgramadoId === item.id}
                          className="flex-1 bg-emerald-600 hover:bg-emerald-500"
                        >
                          <CheckCircle2 size={14} />
                          {payingProgramadoId === item.id ? "Registrando..." : "Marcar como pago"}
                        </Button>
                        <Button variant="danger" size="sm" iconOnly
                          onClick={() => void deleteProgramado(item.id)}
                          className="border-rose-400/25 text-rose-200 hover:bg-rose-500/10"
                          title="Excluir gasto programado"
                         aria-label="Excluir gasto programado">
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </section>

          {showAside && (
          <aside className="space-y-4">
            {createPanel === "entry" && (
            <section className="rounded-lg border border-blue-400/30 bg-[var(--surface)] p-5 shadow-xl shadow-black/10">
              <h2 className="flex items-center gap-2 text-base font-black">
                <Plus size={18} className="text-blue-300" />
                Novo lancamento
                <Button variant="ghost" size="sm" iconOnly onClick={() => setCreatePanel(null)} className="ml-auto" title="Fechar formulario" aria-label="Fechar formulario">
                  <X size={15} />
                </Button>
              </h2>
              <div className="mt-4 space-y-3">
                <input value={lancamentoForm.title} onChange={(event) => setLancamentoForm({ ...lancamentoForm, title: event.target.value })} placeholder="Titulo" className="field" />
                <div className="grid grid-cols-2 gap-2">
                  <Select value={lancamentoForm.type} onChange={(value) => setLancamentoForm({ ...lancamentoForm, type: value as EntryType })}>
                    <option value="saida">Saida</option>
                    <option value="entrada">Entrada</option>
                  </Select>
                  <input value={lancamentoForm.amount} onChange={(event) => setLancamentoForm({ ...lancamentoForm, amount: event.target.value })} placeholder="Valor" className="field" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input value={lancamentoForm.category} onChange={(event) => setLancamentoForm({ ...lancamentoForm, category: event.target.value })} placeholder="Categoria" className="field" />
                  <input type="date" value={lancamentoForm.dueDate} onChange={(event) => setLancamentoForm({ ...lancamentoForm, dueDate: event.target.value })} className="field" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input value={lancamentoForm.method} onChange={(event) => setLancamentoForm({ ...lancamentoForm, method: event.target.value })} placeholder="Metodo" className="field" />
                  <Select value={lancamentoForm.status} onChange={(value) => setLancamentoForm({ ...lancamentoForm, status: value as EntryStatus })}>
                    <option value="pendente">Pendente</option>
                    <option value="pago">Pago</option>
                    <option value="cancelado">Cancelado</option>
                  </Select>
                </div>
                <textarea value={lancamentoForm.description} onChange={(event) => setLancamentoForm({ ...lancamentoForm, description: event.target.value })} placeholder="Descricao" rows={3} className="field resize-none py-3" />
                <button
                  onClick={() => void createLancamento()}
                  disabled={creatingLancamento || !lancamentoForm.title.trim() || !lancamentoForm.amount}
                  className="h-11 w-full rounded-lg bg-[var(--primary)] text-sm font-bold text-white transition hover:brightness-110disabled:opacity-45"
                >
                  {creatingLancamento ? "Salvando..." : "Criar lancamento"}
                </button>
              </div>
            </section>
            )}

            {createPanel === "scheduled" && (
            <section className="rounded-lg border border-cyan-400/30 bg-[var(--surface)] p-5 shadow-xl shadow-black/10">
              <h2 className="flex items-center gap-2 text-base font-black">
                <BellRing size={18} className="text-cyan-300" />
                Programar gasto fixo
                <Button variant="ghost" size="sm" iconOnly onClick={() => setCreatePanel(null)} className="ml-auto" title="Fechar formulario" aria-label="Fechar formulario">
                  <X size={15} />
                </Button>
              </h2>
              <div className="mt-4 space-y-3">
                <input value={programadoForm.title} onChange={(event) => setProgramadoForm({ ...programadoForm, title: event.target.value })} placeholder="Nome do gasto" className="field" />
                <div className="grid grid-cols-2 gap-2">
                  <input value={programadoForm.amount} onChange={(event) => setProgramadoForm({ ...programadoForm, amount: event.target.value })} placeholder="Valor" className="field" />
                  <input type="date" value={programadoForm.nextDueDate} onChange={(event) => setProgramadoForm({ ...programadoForm, nextDueDate: event.target.value })} className="field" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Select value={programadoForm.frequency} onChange={(value) => setProgramadoForm({ ...programadoForm, frequency: value as Frequency })}>
                    <option value="unico">Unico</option>
                    <option value="semanal">Semanal</option>
                    <option value="mensal">Mensal</option>
                    <option value="anual">Anual</option>
                  </Select>
                  <input value={programadoForm.remindDaysBefore} onChange={(event) => setProgramadoForm({ ...programadoForm, remindDaysBefore: event.target.value })} placeholder="Avisar dias antes" className="field" />
                </div>
                <input value={programadoForm.category} onChange={(event) => setProgramadoForm({ ...programadoForm, category: event.target.value })} placeholder="Categoria" className="field" />
                <button
                  onClick={() => void createProgramado()}
                  disabled={creatingProgramado || !programadoForm.title.trim() || !programadoForm.amount}
                  className="h-11 w-full rounded-lg bg-cyan-600 text-sm font-bold text-white transition hover:bg-cyan-500 disabled:opacity-45"
                >
                  {creatingProgramado ? "Salvando..." : "Programar lembrete"}
                </button>
              </div>
            </section>
            )}

            {activeView === "overview" && (
            <section className="workspace-panel">
              <header className="border-b border-[var(--border)] px-5 py-4">
                <h2 className="text-base font-black">Lembretes</h2>
              </header>
              <div className="divide-y divide-[var(--border)]">
                {data.lembretes.length === 0 ? (
                  <EmptyLine text="Nenhum pagamento proximo." />
                ) : data.lembretes.map((item) => (
                  <div key={item.id} className="px-5 py-4">
                    <p className="text-sm font-bold">{item.title}</p>
                    <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                      {money(item.amount)} · {dateLabel(item.dueDate)} · {item.daysUntil < 0 ? "vencido" : `${item.daysUntil} dia(s)`}
                    </p>
                  </div>
                ))}
              </div>
            </section>
            )}

            {showScheduled && activeView !== "scheduled" && (
            <section className="workspace-panel">
              <header className="border-b border-[var(--border)] px-5 py-4">
                <h2 className="text-base font-black">Gastos programados</h2>
              </header>
              <div className="divide-y divide-[var(--border)]">
                {data.programados.length === 0 ? (
                  <EmptyLine text="Nenhum gasto programado." />
                ) : data.programados.map((item) => (
                  <div key={item.id} className="grid gap-3 px-5 py-4">
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-bold">{item.title}</p>
                        <span className="text-xs font-bold text-blue-200">{money(item.amount)}</span>
                      </div>
                      <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                        {item.frequency} · {dateLabel(item.nextDueDate)} · avisar {item.remindDaysBefore} dia(s) antes
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="primary" size="sm"
                        onClick={() => void payProgramado(item)}
                        disabled={!item.active || payingProgramadoId === item.id}
                        className="flex-1 border-emerald-400/25 text-emerald-200 hover:bg-emerald-500/10"
                      >
                        <CheckCircle2 size={14} />
                        {payingProgramadoId === item.id ? "Registrando..." : "Marcar como pago"}
                      </Button>
                      <Button variant="danger" size="sm" iconOnly
                        onClick={() => void deleteProgramado(item.id)}
                        className="border-rose-400/25 text-rose-200 hover:bg-rose-500/10"
                        title="Excluir gasto programado"
                       aria-label="Excluir gasto programado">
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
            )}
          </aside>
          )}
        </div>

        {selected && (
          <section className="fixed bottom-6 right-6 top-24 z-40 w-[620px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl shadow-black/35">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Lancamento selecionado</p>
                <h2 className="mt-1 text-lg font-black">{selected.title}</h2>
                <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">
                  {selected.category} · {selected.status} · {dateLabel(selected.dueDate)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => startEditLancamento(selected)}
                  className="border-cyan-400/25 text-cyan-100 hover:bg-cyan-500/10"
                >
                  <Edit3 size={15} />
                  Editar
                </Button>
                <Button variant="primary" onClick={() => void patchLancamento(selected.id, { status: "pago" })} className="border-emerald-400/25 text-emerald-200 hover:bg-emerald-500/10">
                  <CheckCircle2 size={15} />
                  Marcar pago
                </Button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingAttachments}
                  className="flex h-10 items-center gap-2 rounded-lg border border-blue-400/25 px-3 text-xs font-bold text-blue-200 hover:bg-blue-500/10 disabled:opacity-50"
                >
                  <FileUp size={15} />
                  {uploadingAttachments ? "Anexando..." : "Anexar documentos"}
                </button>
                <Button variant="danger" onClick={() => setDeleteConfirmId(selected.id)} className="border-rose-400/25 text-rose-200 hover:bg-rose-500/10">
                  <Trash2 size={15} />
                  Excluir
                </Button>
                <Button iconOnly
                  onClick={() => {
                    setSelectedId(null);
                    setEditingId(null);
                    setDeleteConfirmId(null);
                  }}
                  className="text-[var(--text-secondary)]"
                  title="Fechar visualizacao"
                 aria-label="Fechar visualizacao">
                  <X size={16} />
                </Button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf,application/xml,text/xml,.xml,.ofx,.csv,.xlsx,.xls,.doc,.docx"
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files;
                  if (files?.length) void uploadAttachments(files);
                  event.currentTarget.value = "";
                }}
              />
            </div>

            {deleteConfirmId === selected.id && (
              <div className="mt-4 rounded-lg border border-rose-400/25 bg-rose-500/10 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-rose-100">Excluir lancamento?</h3>
                    <p className="mt-1 text-xs font-semibold text-rose-100/70">
                      Esta acao remove o lancamento financeiro da base persistida.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm"
                      onClick={() => setDeleteConfirmId(null)}
                      className="text-[var(--text-secondary)]"
                    >
                      Cancelar
                    </Button>
                    <Button variant="danger" size="sm"
                      onClick={() => void deleteLancamento(selected.id)}
                      className="bg-rose-600 hover:bg-rose-500"
                    >
                      Confirmar exclusao
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {isEditingSelected ? (
              <div className="mt-5 rounded-lg border border-cyan-400/25 bg-cyan-500/5 p-4">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold">Editar lancamento</h3>
                    <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                      Atualize valor, categoria, vencimento, status e descricao.
                    </p>
                  </div>
                  <Button size="sm" iconOnly
                    onClick={cancelEditLancamento}
                    className="text-[var(--text-secondary)]"
                    title="Cancelar edicao"
                   aria-label="Cancelar edicao">
                    <X size={16} />
                  </Button>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <label className="md:col-span-2">
                    <span className="text-xs font-bold uppercase text-[var(--text-secondary)]">Titulo</span>
                    <input value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} className="field mt-1" />
                  </label>
                  <label>
                    <span className="text-xs font-bold uppercase text-[var(--text-secondary)]">Tipo</span>
                    <Select value={editForm.type} onChange={(value) => setEditForm({ ...editForm, type: value as EntryType })}>
                      <option value="saida">Saida</option>
                      <option value="entrada">Entrada</option>
                    </Select>
                  </label>
                  <label>
                    <span className="text-xs font-bold uppercase text-[var(--text-secondary)]">Valor</span>
                    <input value={editForm.amount} onChange={(event) => setEditForm({ ...editForm, amount: event.target.value })} className="field mt-1" />
                  </label>
                  <label>
                    <span className="text-xs font-bold uppercase text-[var(--text-secondary)]">Categoria</span>
                    <input value={editForm.category} onChange={(event) => setEditForm({ ...editForm, category: event.target.value })} className="field mt-1" />
                  </label>
                  <label>
                    <span className="text-xs font-bold uppercase text-[var(--text-secondary)]">Metodo</span>
                    <input value={editForm.method} onChange={(event) => setEditForm({ ...editForm, method: event.target.value })} className="field mt-1" />
                  </label>
                  <label>
                    <span className="text-xs font-bold uppercase text-[var(--text-secondary)]">Vencimento</span>
                    <input type="date" value={editForm.dueDate} onChange={(event) => setEditForm({ ...editForm, dueDate: event.target.value })} className="field mt-1" />
                  </label>
                  <label>
                    <span className="text-xs font-bold uppercase text-[var(--text-secondary)]">Status</span>
                    <Select value={editForm.status} onChange={(value) => setEditForm({ ...editForm, status: value as EntryStatus })}>
                      <option value="pendente">Pendente</option>
                      <option value="pago">Pago</option>
                      <option value="cancelado">Cancelado</option>
                    </Select>
                  </label>
                  <label className="md:col-span-2">
                    <span className="text-xs font-bold uppercase text-[var(--text-secondary)]">Descricao</span>
                    <textarea
                      value={editForm.description}
                      onChange={(event) => setEditForm({ ...editForm, description: event.target.value })}
                      rows={3}
                      className="field mt-1 resize-none py-3"
                    />
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="ghost"
                    onClick={() => void saveEditLancamento()}
                    disabled={savingEdit}
                    className="bg-cyan-600 hover:bg-cyan-500"
                  >
                    <Save size={15} />
                    {savingEdit ? "Salvando..." : "Salvar alteracoes"}
                  </Button>
                  <Button
                    onClick={cancelEditLancamento}
                    className="text-[var(--text-secondary)]"
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
                <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Descricao</p>
                <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">{selected.description || "Sem descricao."}</p>
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-4">
                  <div>
                    <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Valor</p>
                    <strong className={selected.type === "entrada" ? "text-emerald-200" : "text-rose-200"}>{money(selected.amount)}</strong>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Metodo</p>
                    <strong>{selected.method || "Nao informado"}</strong>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Pago em</p>
                    <strong>{dateLabel(selected.paidAt)}</strong>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Origem</p>
                    <strong>{selected.source || "manual"}</strong>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-5 rounded-lg border border-dashed border-blue-400/30 bg-blue-500/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-blue-500/12 text-blue-200">
                    <FileText size={18} />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold">Documentos do lancamento</h3>
                    <p className="text-xs font-semibold text-[var(--text-secondary)]">
                      Comprovantes, notas fiscais, boletos, recibos, XML, OFX, planilhas e imagens.
                    </p>
                  </div>
                </div>
                <Button variant="primary" size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingAttachments}
                  className="hover:brightness-110disabled:opacity-50"
                >
                  <Paperclip size={14} />
                  Adicionar arquivos
                </Button>
              </div>
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-3">
              {selected.attachments.length === 0 ? (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="col-span-full rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)] px-4 py-6 text-center text-sm font-bold text-[var(--text-secondary)] transition hover:border-blue-400/60 hover:text-blue-200"
                >
                  Nenhum arquivo anexado. Clique para adicionar comprovantes ou notas fiscais.
                </button>
              ) : selected.attachments.map((item) => (
                <article key={item.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-3 text-xs font-bold hover:border-blue-400">
                  <span className="flex min-w-0 items-center gap-2">
                    <Paperclip size={14} className="shrink-0 text-blue-300" />
                    <span className="min-w-0">
                      <span className="block truncate">{item.name}</span>
                      <span className="mt-0.5 block truncate text-xs font-semibold text-[var(--text-secondary)]">
                        {item.mimeType || "arquivo"} · {fileSizeLabel(item.size)}
                      </span>
                    </span>
                  </span>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => void openWithAuth(item.url)}
                      className="flex h-8 items-center justify-center rounded-lg border border-blue-400/25 text-xs font-bold text-blue-100 hover:bg-blue-500/10"
                    >
                      Abrir
                    </button>
                    <Button variant="primary" size="sm"
                     
                      onClick={() => void downloadWithAuth(item.url, item.name)}
                     
                    >
                      <Download size={13} />
                      Baixar
                    </Button>
                    <Button variant="danger" size="sm"
                      onClick={() => void removeAttachment(item)}
                      disabled={removingAttachmentId === item.id}
                      className="border-rose-400/25 text-rose-100 hover:bg-rose-500/10"
                    >
                      <Trash2 size={13} />
                      {removingAttachmentId === item.id ? "..." : "Remover"}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      <style>{`
        .field {
          height: 2.75rem;
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid var(--border);
          background: var(--background);
          padding: 0 0.75rem;
          font-size: 0.875rem;
          font-weight: 700;
          outline: none;
        }
        .field:focus {
          border-color: #38bdf8;
        }
      `}</style>
    </div>
  );
}

function Metric({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: "blue" | "emerald" | "rose" | "amber" }) {
  const tones = {
    blue: "bg-blue-500/10 text-blue-200",
    emerald: "bg-emerald-500/10 text-emerald-200",
    rose: "bg-rose-500/10 text-rose-200",
    amber: "bg-amber-500/10 text-amber-200",
  };
  return (
    <div className="workspace-metric finance-metric">
      <span className={`mb-5 grid h-10 w-10 place-items-center rounded-xl ${tones[tone]}`}>
        <Icon size={19} />
      </span>
      <p className={`text-xl font-black ${tones[tone].split(" ")[1]}`}>{value}</p>
      <p className="mt-1 text-xs font-bold text-[var(--text-secondary)]">{label}</p>
    </div>
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className="field">
      {children}
    </select>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="px-5 py-6 text-sm font-semibold text-[var(--text-secondary)]">{text}</div>;
}
