import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  FileCheck2,
  FileSignature,
  Maximize2,
  Minus,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Save,
  Send,
  Share2,
  Sparkles,
  Plus,
  Trash2,
  UsersRound,
} from "lucide-react";
import { authToken, wsBaseUrl } from "../../core/api/config";
import type { AuthSession } from "../../types/auth";
import type {
  Branding,
  CommercialContract,
  CommercialDocument,
  CommercialProposal,
  Deliverable,
  DocumentRevision,
  Signer,
} from "../../features/commercial/types";
import { isProposal } from "../../features/commercial/types";
import type { DocumentUpdateInput } from "../../features/commercial/api";
import { exportCommercialDocumentPdf, shareCommercialDocument, writeWithNora } from "../../features/commercial/api";
import Button from "../shared/Button";
import { showAlert, showConfirm, showPrompt } from "../shared/AppDialogProvider";
import A4ContentPages from "./A4ContentPages";
import CommercialInspector from "./CommercialInspector";
import NoraReviewPanel from "./NoraReviewPanel";
import RichTextToolbar from "./RichTextToolbar";

type Focus = "scope" | "risk" | "tone" | "commercial" | "legal" | "grammar";
type SaveState = "saved" | "dirty" | "saving" | "error";

type CommercialEditorProps = {
  document: CommercialDocument;
  session: AuthSession;
  busy: boolean;
  onBack: () => void;
  onDocumentChange: (document: CommercialDocument) => void;
  onSave: (document: CommercialDocument, input: DocumentUpdateInput) => Promise<CommercialDocument>;
  onSubmitProposal: (proposal: CommercialProposal) => Promise<void>;
  onApproveProposal: (proposal: CommercialProposal) => Promise<void>;
  onRequestChanges: (proposal: CommercialProposal) => Promise<void>;
  onGenerateContract: (proposal: CommercialProposal) => Promise<void>;
  onAnalyze: (proposal: CommercialProposal, context: string, focus: Focus[]) => Promise<void>;
  onSuggestion: (proposal: CommercialProposal, suggestionId: string, decision: "accepted" | "rejected") => Promise<void>;
  onSendForSignature: (contract: CommercialContract) => Promise<void>;
  onSign: (contract: CommercialContract) => Promise<void>;
  onInstantiate: (contract: CommercialContract) => Promise<void>;
  onDeleteProposal: (proposal: CommercialProposal) => Promise<void>;
};

type Participant = { id: string; name: string; photoUrl: string };

export default function CommercialEditor({
  document: sourceDocument,
  session,
  busy,
  onBack,
  onDocumentChange,
  onSave,
  onSubmitProposal,
  onApproveProposal,
  onRequestChanges,
  onGenerateContract,
  onAnalyze,
  onSuggestion,
  onSendForSignature,
  onSign,
  onInstantiate,
  onDeleteProposal,
}: CommercialEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const sourceDocumentIdRef = useRef(sourceDocument.id);
  const shareButtonRef = useRef<HTMLDivElement>(null);
  const savedSnapshotRef = useRef("");
  const [title, setTitle] = useState(sourceDocument.title);
  const [contentHtml, setContentHtml] = useState(sourceDocument.contentHtml);
  const [scopeSummary, setScopeSummary] = useState(sourceDocument.scopeSummary);
  const [amount, setAmount] = useState(sourceDocument.amount);
  const [currency, setCurrency] = useState(sourceDocument.currency);
  const [validUntil, setValidUntil] = useState(isProposal(sourceDocument) ? sourceDocument.validUntil : null);
  const [branding, setBranding] = useState<Branding>(sourceDocument.branding);
  const [signers, setSigners] = useState<Signer[]>(sourceDocument.signers);
  const [deliverables, setDeliverables] = useState<Deliverable[]>(sourceDocument.deliverables);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [noraOpen, setNoraOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [writingWithNora, setWritingWithNora] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareMenuPosition, setShareMenuPosition] = useState({ left: 12, top: 72 });
  const [noraUndoStack, setNoraUndoStack] = useState<string[]>([]);
  const [toolbarDock, setToolbarDock] = useState<"top" | "right">(() => (
    window.localStorage.getItem("norium-commercial-toolbar") === "right" ? "right" : "top"
  ));

  const readOnly = !isProposal(sourceDocument) && ["signed", "active", "completed", "cancelled"].includes(sourceDocument.status);
  const advancedPlan = ["equipe", "enterprise"].includes(session.user.plan);
  const proposal = isProposal(sourceDocument) ? sourceDocument : null;
  const contract = isProposal(sourceDocument) ? null : sourceDocument;

  const draftSnapshot = useMemo(
    () => JSON.stringify({ title, contentHtml, scopeSummary, amount, currency, validUntil, branding, signers, deliverables }),
    [amount, branding, contentHtml, currency, deliverables, scopeSummary, signers, title, validUntil],
  );

  useEffect(() => {
    const changedDocument = sourceDocumentIdRef.current !== sourceDocument.id;
    const editingDocument = Boolean(editorRef.current?.contains(document.activeElement));
    setTitle(sourceDocument.title);
    // Atualizacoes vindas de acoes explicitas nao devem substituir o DOM do
    // contentEditable enquanto o usuario ainda esta escrevendo.
    if (changedDocument || !editingDocument) {
      setContentHtml(sourceDocument.contentHtml);
    }
    setScopeSummary(sourceDocument.scopeSummary);
    setAmount(sourceDocument.amount);
    setCurrency(sourceDocument.currency);
    setValidUntil(isProposal(sourceDocument) ? sourceDocument.validUntil : null);
    setBranding(sourceDocument.branding);
    setSigners(sourceDocument.signers);
    setDeliverables(sourceDocument.deliverables);
    const snapshot = JSON.stringify({
      title: sourceDocument.title,
      contentHtml: sourceDocument.contentHtml,
      scopeSummary: sourceDocument.scopeSummary,
      amount: sourceDocument.amount,
      currency: sourceDocument.currency,
      validUntil: isProposal(sourceDocument) ? sourceDocument.validUntil : null,
      branding: sourceDocument.branding,
      signers: sourceDocument.signers,
      deliverables: sourceDocument.deliverables,
    });
    savedSnapshotRef.current = snapshot;
    sourceDocumentIdRef.current = sourceDocument.id;
    setSaveState("saved");
  }, [sourceDocument.id, sourceDocument.version]);

  useEffect(() => {
    setNoraUndoStack([]);
  }, [sourceDocument.id]);

  useEffect(() => {
    if (readOnly || !savedSnapshotRef.current) return;
    const nextState = draftSnapshot === savedSnapshotRef.current ? "saved" : "dirty";
    setSaveState((current) => current === "saving" ? current : nextState);
    if (nextState === "dirty") setSaveError("");
  }, [draftSnapshot, readOnly]);

  useEffect(() => {
    const token = authToken();
    if (!token) return;
    const socket = new WebSocket(`${wsBaseUrl()}/api/comercial/ws/${sourceDocument.id}?token=${encodeURIComponent(token)}`);
    const heartbeat = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "PING" }));
    }, 25_000);
    socket.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || !("type" in message)) return;
      const payload = message as { type: string; participant?: Participant; document?: CommercialDocument; actorId?: string };
      if (payload.type === "PRESENCE_JOIN" && payload.participant) {
        setParticipants((current) => current.some((item) => item.id === payload.participant?.id) ? current : [...current, payload.participant as Participant]);
      } else if (payload.type === "PRESENCE_LEAVE" && payload.participant) {
        setParticipants((current) => current.filter((item) => item.id !== payload.participant?.id));
      } else if (payload.type === "DOCUMENT_UPDATED" && payload.document && payload.actorId !== session.user.id) {
        onDocumentChange(payload.document);
      }
    };
    return () => {
      window.clearInterval(heartbeat);
      socket.close();
    };
  }, [onDocumentChange, session.user.id, sourceDocument.id]);

  function syncHtmlFromEditor() {
    setContentHtml(readPagedEditorHtml(editorRef.current));
  }

  function changeToolbarDock(value: "top" | "right") {
    setToolbarDock(value);
    window.localStorage.setItem("norium-commercial-toolbar", value);
  }

  function toggleShareMenu() {
    if (shareMenuOpen) {
      setShareMenuOpen(false);
      return;
    }
    const rect = shareButtonRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = 224;
      setShareMenuPosition({
        left: Math.max(12, Math.min(window.innerWidth - menuWidth - 12, rect.right - menuWidth)),
        top: Math.max(12, Math.min(window.innerHeight - 132, rect.bottom + 8)),
      });
    }
    setShareMenuOpen(true);
  }

  async function writeDocumentWithNora() {
    if (!editorRef.current || readOnly || writingWithNora) return;
    const selection = window.getSelection();
    const activeRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const selectionInsideEditor = Boolean(
      activeRange
      && editorRef.current.contains(activeRange.commonAncestorContainer),
    );
    const selectedText = selectionInsideEditor ? selection?.toString().trim() || "" : "";
    const instruction = await showPrompt({
      title: selectedText ? "Reescrever com a Nora" : "Escrever com a Nora",
      description: selectedText
        ? "Explique como deseja transformar o trecho selecionado. A Nora usará o documento e o cliente como contexto."
        : "Descreva a ideia, cláusula ou seção. A Nora vai detalhar o conteúdo sem inventar valores, prazos ou garantias.",
      placeholder: selectedText
        ? "Ex.: deixe mais objetivo e acrescente critérios de aceite"
        : "Ex.: detalhe uma seção de suporte após a entrega, com limites claros",
      confirmLabel: selectedText ? "Reescrever trecho" : "Inserir no documento",
      multiline: true,
      required: true,
    });
    if (!instruction) return;

    setWritingWithNora(true);
    try {
      const result = await writeWithNora(
        proposal ? "proposal" : "contract",
        sourceDocument.id,
        {
          instruction,
          selectedText,
          mode: selectedText ? "rewrite" : "insert",
        },
      );
      const selectedOwner = activeRange?.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? activeRange.commonAncestorContainer as Element
        : activeRange?.commonAncestorContainer.parentElement;
      const targetPage = selectedOwner?.closest<HTMLElement>('[data-commercial-page-content][contenteditable="true"]')
        || editorRef.current.querySelector<HTMLElement>('[data-commercial-page-content][contenteditable="true"]');
      targetPage?.focus({ preventScroll: true });
      if (selectionInsideEditor && activeRange) {
        const currentSelection = window.getSelection();
        currentSelection?.removeAllRanges();
        currentSelection?.addRange(activeRange);
      } else {
        const lastPage = editorRef.current.querySelector<HTMLElement>("[data-commercial-page-content]:last-of-type")
          || editorRef.current.querySelector<HTMLElement>("[data-commercial-page-content]")
          || editorRef.current;
        const endRange = document.createRange();
        endRange.selectNodeContents(lastPage);
        endRange.collapse(false);
        const currentSelection = window.getSelection();
        currentSelection?.removeAllRanges();
        currentSelection?.addRange(endRange);
      }
      document.execCommand("insertHTML", false, result.contentHtml);
      syncHtmlFromEditor();
    } catch (error) {
      await showAlert({
        title: "Não foi possível escrever com a Nora",
        description: error instanceof Error ? error.message : "Tente novamente em instantes.",
        tone: "warning",
      });
    } finally {
      setWritingWithNora(false);
    }
  }

  async function shareByEmail() {
    if (sharing) return;
    setShareMenuOpen(false);
    const defaultRecipient = sourceDocument.client?.email || "";
    const recipient = await showPrompt({
      title: proposal ? "Enviar proposta por e-mail" : "Enviar contrato por e-mail",
      description: "O envio usa o Gmail conectado a esta conta ou equipe. Nenhuma credencial é compartilhada com outro tenant.",
      defaultValue: defaultRecipient,
      placeholder: "cliente@empresa.com",
      confirmLabel: "Continuar",
      required: true,
    });
    if (!recipient) return;
    const subject = await showPrompt({
      title: "Assunto do e-mail",
      defaultValue: sourceDocument.title,
      confirmLabel: "Continuar",
      required: true,
    });
    if (!subject) return;
    const message = await showPrompt({
      title: "Mensagem de apresentação",
      description: "O conteúdo do documento será incluído após esta mensagem.",
      defaultValue: `Olá, segue ${proposal ? "a proposta comercial" : "o contrato"} "${sourceDocument.title}" para sua análise.`,
      confirmLabel: "Enviar agora",
      multiline: true,
      required: true,
    });
    if (!message) return;

    setSharing(true);
    try {
      await shareCommercialDocument(proposal ? "proposal" : "contract", sourceDocument.id, {
        channel: "email",
        recipient,
        subject,
        message,
      });
      await showAlert({
        title: "Documento enviado",
        description: `O Gmail confirmou o envio para ${recipient}. A ação também foi registrada na Central.`,
        tone: "success",
      });
    } catch (error) {
      await showAlert({
        title: "Não foi possível enviar",
        description: error instanceof Error ? error.message : "Verifique a conexão do Gmail e tente novamente.",
        tone: "warning",
      });
    } finally {
      setSharing(false);
    }
  }

  async function shareWithTeam() {
    if (sharing) return;
    setShareMenuOpen(false);
    const message = await showPrompt({
      title: "Compartilhar com a equipe",
      description: "A mensagem aparecerá no chat interno com o PDF anexado e um vínculo para abrir este documento no Norium.",
      defaultValue: `Compartilho ${proposal ? "a proposta" : "o contrato"} "${sourceDocument.title}" para acompanhamento da equipe.`,
      confirmLabel: "Enviar ao time",
      multiline: true,
      required: true,
    });
    if (!message) return;

    setSharing(true);
    try {
      await shareCommercialDocument(proposal ? "proposal" : "contract", sourceDocument.id, {
        channel: "team",
        message,
      });
      await showAlert({
        title: "Compartilhado com a equipe",
        description: "O documento foi publicado no chat interno e permanece vinculado ao tenant atual.",
        tone: "success",
      });
    } catch (error) {
      await showAlert({
        title: "Não foi possível compartilhar",
        description: error instanceof Error ? error.message : "Tente novamente em instantes.",
        tone: "warning",
      });
    } finally {
      setSharing(false);
    }
  }

  function currentUpdateInput(expectedVersion: number): DocumentUpdateInput {
    return {
      expectedVersion,
      title,
      contentHtml,
      scopeSummary,
      amount,
      currency,
      validUntil,
      branding,
      signers: signers.map(({ name, email, role, order, required }) => ({ name, email, role, order, required })),
      deliverables,
    };
  }

  async function saveDocument() {
    if (readOnly || saveState === "saving" || draftSnapshot === savedSnapshotRef.current) return;
    setSaveState("saving");
    setSaveError("");
    try {
      const saved = await onSave(sourceDocument, currentUpdateInput(sourceDocument.version));
      savedSnapshotRef.current = JSON.stringify({
        title: saved.title,
        contentHtml: saved.contentHtml,
        scopeSummary: saved.scopeSummary,
        amount: saved.amount,
        currency: saved.currency,
        validUntil: isProposal(saved) ? saved.validUntil : null,
        branding: saved.branding,
        signers: saved.signers,
        deliverables: saved.deliverables,
      });
      setSaveState("saved");
      onDocumentChange(saved);
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "Falha ao salvar o documento.");
    }
  }

  async function decideNoraSuggestion(suggestionId: string, decision: "accepted" | "rejected") {
    if (!proposal) return;

    let currentProposal = proposal;
    if (!readOnly && draftSnapshot !== savedSnapshotRef.current) {
      setSaveState("saving");
      setSaveError("");
      try {
        const saved = await onSave(proposal, currentUpdateInput(proposal.version));
        if (!isProposal(saved)) return;
        currentProposal = saved;
        savedSnapshotRef.current = JSON.stringify({
          title: saved.title,
          contentHtml: saved.contentHtml,
          scopeSummary: saved.scopeSummary,
          amount: saved.amount,
          currency: saved.currency,
          validUntil: saved.validUntil,
          branding: saved.branding,
          signers: saved.signers,
          deliverables: saved.deliverables,
        });
        setSaveState("saved");
        onDocumentChange(saved);
      } catch (error) {
        setSaveState("error");
        setSaveError(error instanceof Error ? error.message : "Falha ao salvar antes de aplicar a sugestao.");
        return;
      }
    }

    const previousContent = readPagedEditorHtml(editorRef.current, contentHtml);
    await onSuggestion(currentProposal, suggestionId, decision);
    if (decision === "accepted") {
      setNoraUndoStack((current) => [...current.slice(-9), previousContent]);
    }
  }

  async function undoLastNoraSuggestion() {
    const previousContent = noraUndoStack[noraUndoStack.length - 1];
    if (!proposal || readOnly || !previousContent) return;
    setSaveState("saving");
    setSaveError("");
    try {
      const saved = await onSave(sourceDocument, {
        ...currentUpdateInput(sourceDocument.version),
        contentHtml: previousContent,
      });
      setContentHtml(previousContent);
      savedSnapshotRef.current = JSON.stringify({
        title: saved.title,
        contentHtml: saved.contentHtml,
        scopeSummary: saved.scopeSummary,
        amount: saved.amount,
        currency: saved.currency,
        validUntil: isProposal(saved) ? saved.validUntil : null,
        branding: saved.branding,
        signers: saved.signers,
        deliverables: saved.deliverables,
      });
      setNoraUndoStack((current) => current.slice(0, -1));
      setSaveState("saved");
      onDocumentChange(saved);
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "Não foi possível desfazer a sugestão da Nora.");
    }
  }

  async function restoreRevision(revision: DocumentRevision) {
    const confirmed = await showConfirm({
      title: `Restaurar a versão ${revision.version}?`,
      description: "O estado atual permanecerá disponível no histórico do documento.",
      confirmLabel: "Restaurar versão",
    });
    if (!confirmed) return;
    setTitle(revision.title);
    setContentHtml(revision.contentHtml);
    setBranding(revision.branding);
  }

  async function exportPdf() {
    const previewWindow = window.open("", "_blank");
    if (previewWindow) {
      previewWindow.opener = null;
      previewWindow.document.write("<!doctype html><title>Gerando PDF...</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#080b0e;color:#e5edf7;font:600 15px Arial}span{padding:18px 22px;border:1px solid #263241;border-radius:10px;background:#0c1117}</style><span>Gerando PDF seguro no Norium...</span>");
      previewWindow.document.close();
    }
    try {
      const blob = await exportCommercialDocumentPdf(proposal ? "proposal" : "contract", sourceDocument.id);
      const url = URL.createObjectURL(blob);
      if (previewWindow) {
        previewWindow.location.replace(url);
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = `${safeFileName(title)}.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (error) {
      if (previewWindow) {
        printDocument(previewWindow);
      }
      await showAlert({
        title: previewWindow ? "Pre-visualizacao local aberta" : "Nao foi possivel exportar o PDF",
        description: previewWindow
          ? "O backend nao respondeu, entao o Norium abriu a versao local para imprimir ou salvar como PDF."
          : error instanceof Error ? error.message : "Tente novamente em instantes.",
        tone: "warning",
      });
    }
  }

  function printDocument(existingWindow?: Window | null) {
    const printWindow = existingWindow || window.open("", "_blank");
    if (!printWindow) {
      void showAlert({
        title: "Janela de impressão bloqueada",
        description: "Permita pop-ups para o Norium e tente exportar novamente.",
      });
      return;
    }
    const safeHeader = sanitizePreviewHtml(branding.headerHtml);
    const safeFooter = sanitizePreviewHtml(branding.footerHtml);
    const safeContent = sanitizePreviewHtml(contentHtml).replace(
      /<h([1-3])[^>]*>\s*Assinaturas\s*<\/h\1>/gi,
      "",
    );
    const documentKind = proposal ? "Proposta comercial" : "Contrato comercial";
    const clientName = sourceDocument.client.company || sourceDocument.client.name || "Cliente";
    const clientDetails = [sourceDocument.client.document, sourceDocument.client.email].filter(Boolean).map(escapeHtml).join(" · ");
    const logoMarkup = branding.logoUrl
      ? `<div class="logo"><img src="${escapeHtml(branding.logoUrl)}" alt="Logo da empresa"></div>`
      : "";
    const signerBlocks = signers.map((signer) => `<section class="signature"><div></div><strong>${escapeHtml(signer.name || "Assinante")}</strong><span>${escapeHtml(roleLabel(signer.role))}</span></section>`).join("");
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
      @page{size:A4;margin:18mm 18mm 20mm}@page cover{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}body{font-family:Arial,sans-serif;color:${branding.textColor};-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .page{position:relative;background:#fff}.cover{page:cover;width:210mm;height:297mm;margin:0;padding:18mm;break-after:page;page-break-after:always;display:flex;flex-direction:column;overflow:hidden}.cover:before{content:"";position:absolute;inset:0 0 auto 0;height:9mm;background:linear-gradient(90deg,${branding.primaryColor},${branding.secondaryColor})}
      .cover .logo{margin-top:18mm}.cover-type{margin-top:auto;color:${branding.secondaryColor};font-size:12px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase}
      .cover h1{max-width:155mm;margin:8mm 0 9mm;font-size:30px;line-height:1.18;color:${branding.primaryColor}}.cover-client{border-left:4px solid ${branding.secondaryColor};padding:4mm 0 4mm 6mm}
      .cover-client strong,.cover-client span{display:block}.cover-client strong{font-size:17px}.cover-client span{margin-top:2mm;color:#64748b;font-size:11px}
      .cover-meta{display:grid;grid-template-columns:repeat(2,1fr);gap:8mm;margin-top:auto;padding-top:12mm;border-top:1px solid #cbd5e1}.cover-meta small,.cover-meta strong{display:block}.cover-meta small{color:#64748b;font-size:9px;text-transform:uppercase;letter-spacing:1px}.cover-meta strong{margin-top:2mm;font-size:12px}
      .content{page:document;width:auto;min-height:auto;margin:0;padding:0;font-size:11pt;line-height:1.62;overflow-wrap:anywhere}.content header,.content footer{color:#475569;font-size:9pt}.content header{margin-bottom:8mm;padding-bottom:3mm;border-bottom:1px solid #cbd5e1}.content footer{margin-top:10mm;padding-top:3mm;border-top:1px solid #cbd5e1}
      .logo{text-align:${branding.logoAlignment};margin:0 0 7mm}.logo img{max-height:${Math.max(36, branding.logoScale * 0.62)}px;max-width:64mm}
      .content h1,.content h2,.content h3{color:${branding.primaryColor};break-after:avoid;page-break-after:avoid}.content p,.content li{orphans:3;widows:3}.content a{color:${branding.secondaryColor}}.content img{max-width:100%;height:auto}table{width:100%;border-collapse:collapse;break-inside:avoid}td,th{border:1px solid #cbd5e1;padding:8px}
      .signature-wrap{margin-top:10mm;break-inside:avoid;page-break-inside:avoid}.signature-wrap h2{margin:0 0 7mm;break-after:avoid;page-break-after:avoid}.signatures{display:grid;grid-template-columns:repeat(2,1fr);gap:36px;break-inside:avoid;page-break-inside:avoid}.signature{break-inside:avoid;page-break-inside:avoid}.signature div{border-top:1px solid #334155;margin-bottom:8px}.signature strong,.signature span{display:block;font-size:11px}
      @media print{button{display:none}}
    </style></head><body>
      <section class="page cover">
        ${logoMarkup}
        <div class="cover-type">${escapeHtml(documentKind)}</div>
        <h1>${escapeHtml(title)}</h1>
        <div class="cover-client"><strong>${escapeHtml(clientName)}</strong>${clientDetails ? `<span>${clientDetails}</span>` : ""}</div>
        <div class="cover-meta">
          <div><small>Emissão</small><strong>${escapeHtml(formatDocumentDate(sourceDocument.updatedAt))}</strong></div>
          <div><small>Investimento</small><strong>${escapeHtml(formatMoney(amount, currency))}</strong></div>
        </div>
      </section>
      <main class="page content"><header>${safeHeader}</header>${logoMarkup}<h1>${escapeHtml(title)}</h1>${safeContent}${signerBlocks ? `<section class="signature-wrap"><h2>Assinaturas</h2><div class="signatures">${signerBlocks}</div></section>` : ""}<footer>${safeFooter}</footer></main>
      <script>window.onload=()=>window.print()</script>
    </body></html>`);
    printWindow.document.close();
  }

  function renderEditorToolbar(orientation: "top" | "right") {
    return (
      <RichTextToolbar
        editorRef={editorRef}
        onChange={syncHtmlFromEditor}
        onWriteWithNora={() => void writeDocumentWithNora()}
        onUndoNora={() => void undoLastNoraSuggestion()}
        canUndoNora={noraUndoStack.length > 0}
        writingWithNora={writingWithNora}
        orientation={orientation}
        onOrientationChange={changeToolbarDock}
      />
    );
  }

  return (
    <main className={`${fullScreen ? "fixed inset-0 z-[110]" : "min-h-0 flex-1"} flex flex-col overflow-hidden bg-[var(--background)] text-[var(--text)]`}>
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="sm" iconOnly onClick={onBack} aria-label="Voltar para documentos"><ArrowLeft size={17} /></Button>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/12 text-blue-400">{proposal ? <FileSignature size={18} /> : <FileCheck2 size={18} />}</span>
          <div className="min-w-0">
            <input value={title} disabled={readOnly} onChange={(event) => setTitle(event.target.value)} className="block w-full min-w-0 bg-transparent text-base font-black outline-none" aria-label="Titulo do documento" />
            <div className="mt-0.5 flex items-center gap-2 text-xs font-bold text-[var(--text-secondary)]">
              <StatusPill status={sourceDocument.status} />
              <span>v{sourceDocument.version}</span>
              <SaveIndicator state={saveState} error={saveError} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {participants.length > 0 && <span className="hidden items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-2 text-xs font-bold sm:flex"><UsersRound size={13} className="text-emerald-400" /> {participants.length} online</span>}
          {proposal && <Button size="sm" variant={noraOpen ? "primary" : "secondary"} onClick={() => setNoraOpen((current) => !current)} icon={<Sparkles size={14} />}>Nora</Button>}
          <Button size="sm" variant="secondary" onClick={() => setInspectorOpen((current) => !current)} icon={inspectorOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}>Propriedades</Button>
          <div className="flex h-9 items-center rounded-lg border border-[var(--border)] bg-[var(--background)]">
            <button type="button" onClick={() => setZoom((current) => Math.max(50, current - 10))} className="grid h-full w-8 place-items-center hover:bg-[var(--surface-hover)]" aria-label="Diminuir zoom"><Minus size={14} /></button>
            <span className="w-12 text-center text-xs font-bold">{zoom}%</span>
            <button type="button" onClick={() => setZoom((current) => Math.min(150, current + 10))} className="grid h-full w-8 place-items-center hover:bg-[var(--surface-hover)]" aria-label="Aumentar zoom"><Plus size={14} /></button>
          </div>
          {!readOnly && (
            <Button
              size="sm"
              onClick={() => void saveDocument()}
              loading={saveState === "saving"}
              disabled={saveState !== "dirty" && saveState !== "error"}
              icon={<Save size={14} />}
            >
              Salvar
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => void exportPdf()} icon={<Download size={14} />}>Exportar PDF</Button>
          <div ref={shareButtonRef}>
            <Button
              size="sm"
              variant="secondary"
              loading={sharing}
              onClick={toggleShareMenu}
              icon={<Share2 size={14} />}
            >
              Compartilhar
            </Button>
          </div>
          {proposal && !proposal.contractId && <Button variant="danger" size="sm" iconOnly onClick={() => void onDeleteProposal(proposal)} className="border-rose-500/25 text-rose-400 hover:bg-rose-500/10" aria-label="Excluir proposta"><Trash2 size={15} /></Button>}
          <Button size="sm" iconOnly onClick={() => setFullScreen((current) => !current)} aria-label={fullScreen ? "Sair da tela cheia" : "Abrir em tela cheia"}>{fullScreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</Button>
        </div>
      </header>

      <WorkflowBar
        document={sourceDocument}
        busy={busy || saveState === "saving"}
        onSubmit={() => proposal && void onSubmitProposal(proposal)}
        onApprove={() => proposal && void onApproveProposal(proposal)}
        onRequestChanges={() => proposal && void onRequestChanges(proposal)}
        onGenerate={() => proposal && void onGenerateContract(proposal)}
        onSend={() => contract && void onSendForSignature(contract)}
        onSign={() => contract && void onSign(contract)}
        onInstantiate={() => contract && void onInstantiate(contract)}
      />

      <div
        className="commercial-editor-grid grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: `${inspectorOpen ? "minmax(230px, 280px)" : "0px"} minmax(0, 1fr) ${noraOpen && proposal ? "minmax(300px, 370px)" : "0px"}`,
        }}
      >
        <div className={`commercial-editor-inspector h-full min-h-0 overflow-hidden transition-all ${inspectorOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}>
          <CommercialInspector
            branding={branding}
            signers={signers}
            deliverables={deliverables}
            revisions={sourceDocument.revisions}
            advancedPlan={advancedPlan}
            readOnly={readOnly}
            onBrandingChange={setBranding}
            onSignersChange={setSigners}
            onDeliverablesChange={setDeliverables}
            onRestoreRevision={restoreRevision}
          />
        </div>

        <section className="flex min-w-0 flex-col overflow-hidden border-x border-[var(--border)]">
          {!readOnly && toolbarDock === "top" && renderEditorToolbar("top")}
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
            <span className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold text-[var(--text-secondary)]">
              <Eye size={12} /> {readOnly ? "Documento A4 (somente leitura)" : "Documento A4 editável"}
            </span>
            <label className="flex min-w-[170px] flex-1 items-center gap-2 text-xs font-bold uppercase text-[var(--text-secondary)]">Resumo <input value={scopeSummary} disabled={readOnly} onChange={(event) => setScopeSummary(event.target.value)} placeholder="Resumo executivo do escopo" className="commercial-field normal-case" /></label>
            <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--text-secondary)]">Valor <input value={amount} disabled={readOnly} onChange={(event) => setAmount(Number(event.target.value))} type="number" min="0" className="commercial-field w-32 normal-case" /></label>
            <select value={currency} disabled={readOnly} onChange={(event) => setCurrency(event.target.value)} className="commercial-field w-20"><option>BRL</option><option>USD</option><option>EUR</option></select>
            {proposal && <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--text-secondary)]">Validade <input value={validUntil || ""} disabled={readOnly} onChange={(event) => setValidUntil(event.target.value || null)} type="date" className="commercial-field normal-case" /></label>}
          </div>
          <div className={`grid min-h-0 flex-1 ${!readOnly && toolbarDock === "right" ? "commercial-editor-with-side-toolbar grid-cols-[minmax(0,1fr)_240px]" : "grid-cols-1"}`}>
          <div className="min-h-0 overflow-auto bg-[color-mix(in_srgb,var(--background)_88%,#64748b)] p-4 sm:p-8">
            <div
              className="commercial-document-stack mx-auto w-full max-w-[794px]"
              style={{
                zoom: zoom / 100,
              } as CSSProperties}
            >
              <section className="commercial-page-shell">
                <article
                  className="commercial-document-page commercial-document-cover relative flex min-h-[1123px] w-full flex-col overflow-hidden bg-white shadow-2xl"
                  style={{
                    color: branding.textColor,
                    "--document-primary": branding.primaryColor,
                    "--document-secondary": branding.secondaryColor,
                  } as CSSProperties}
                >
                  <div className="h-9 w-full" style={{ background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})` }} />
                  <div className="flex flex-1 flex-col px-14 pb-14 pt-12">
                    {branding.logoUrl && (
                      <div style={{ textAlign: branding.logoAlignment }}>
                        <img src={branding.logoUrl} alt="Logo da empresa" className="inline-block max-w-full object-contain" style={{ maxHeight: `${Math.max(48, branding.logoScale * 0.72)}px` }} />
                      </div>
                    )}
                    <div className="mt-auto max-w-2xl pb-12">
                      <p className="text-xs font-bold uppercase tracking-[0.22em]" style={{ color: branding.secondaryColor }}>{proposal ? "Proposta comercial" : "Contrato comercial"}</p>
                      <h1 className="mt-5 text-4xl font-bold leading-tight" style={{ color: branding.primaryColor }}>{title}</h1>
                      <div className="mt-10 border-l-4 py-3 pl-5" style={{ borderColor: branding.secondaryColor }}>
                        <p className="text-xl font-bold">{sourceDocument.client.company || sourceDocument.client.name || "Cliente"}</p>
                        {(sourceDocument.client.document || sourceDocument.client.email) && (
                          <p className="mt-2 text-sm text-slate-500">{[sourceDocument.client.document, sourceDocument.client.email].filter(Boolean).join(" · ")}</p>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-8 border-t border-slate-200 pt-8 text-sm">
                      <div><span className="block text-xs font-bold uppercase tracking-wider text-slate-500">Emissão</span><strong className="mt-2 block">{formatDocumentDate(sourceDocument.updatedAt)}</strong></div>
                      <div><span className="block text-xs font-bold uppercase tracking-wider text-slate-500">Investimento</span><strong className="mt-2 block">{formatMoney(amount, currency)}</strong></div>
                    </div>
                  </div>
                </article>
              </section>

              {readOnly ? (
                <A4ContentPages
                  title={title}
                  contentHtml={contentHtml}
                  branding={branding}
                  signers={signers}
                />
              ) : (
                <A4ContentPages
                  title={title}
                  contentHtml={contentHtml}
                  branding={branding}
                  signers={signers}
                  editable
                  editorRef={editorRef}
                  onChange={setContentHtml}
                  paginationKey={`${sourceDocument.id}:${sourceDocument.version}`}
                />
              )}
            </div>
          </div>
          {!readOnly && toolbarDock === "right" && (
            <aside className="commercial-editor-side-toolbar min-h-0 overflow-hidden">
              {renderEditorToolbar("right")}
            </aside>
          )}
          </div>
        </section>

        <div className={`commercial-editor-nora h-full min-h-0 overflow-hidden transition-all ${noraOpen && proposal ? "opacity-100" : "pointer-events-none opacity-0"}`}>
          {proposal && (
            <NoraReviewPanel
              proposal={proposal}
              busy={busy}
              onAnalyze={(context, focus) => onAnalyze(proposal, context, focus)}
              onDecision={decideNoraSuggestion}
            />
          )}
        </div>
      </div>
      {shareMenuOpen && createPortal(
        <>
          <button
            type="button"
            aria-label="Fechar menu de compartilhamento"
            className="fixed inset-0 z-[190] cursor-default"
            onClick={() => setShareMenuOpen(false)}
          />
          <div
            role="menu"
            aria-label="Compartilhar documento"
            className="norium-modern-shell fixed z-[200] w-56 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 text-[var(--text)] shadow-2xl"
            style={shareMenuPosition}
          >
            <button type="button" role="menuitem" onClick={() => void shareByEmail()} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-xs font-bold hover:bg-[var(--surface-hover)]"><Send size={14} className="text-blue-400" /> Enviar por e-mail</button>
            <button type="button" role="menuitem" onClick={() => void shareWithTeam()} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-xs font-bold hover:bg-[var(--surface-hover)]"><UsersRound size={14} className="text-cyan-400" /> Avisar equipe</button>
          </div>
        </>,
        document.body,
      )}
    </main>
  );
}

function WorkflowBar({
  document,
  busy,
  onSubmit,
  onApprove,
  onRequestChanges,
  onGenerate,
  onSend,
  onSign,
  onInstantiate,
}: {
  document: CommercialDocument;
  busy: boolean;
  onSubmit: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onGenerate: () => void;
  onSend: () => void;
  onSign: () => void;
  onInstantiate: () => void;
}) {
  const proposal = isProposal(document);
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--background)] px-4 py-2">
      <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-secondary)]"><Clock3 size={13} /> Atualizado em {formatDate(document.updatedAt)}</div>
      <div className="flex flex-wrap gap-2">
        {proposal && ["draft", "changes_requested", "rejected"].includes(document.status) && <Button size="sm" loading={busy} onClick={onSubmit} icon={<Send size={13} />}>Enviar para aprovacao</Button>}
        {proposal && document.status === "in_review" && <>
          <Button size="sm" loading={busy} onClick={onApprove} icon={<CheckCircle2 size={13} />} className="bg-emerald-500 text-white">Aprovar</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onRequestChanges}>Solicitar ajustes</Button>
        </>}
        {proposal && ["approved", "sent", "accepted"].includes(document.status) && <Button size="sm" loading={busy} onClick={onGenerate} icon={<FileSignature size={13} />}>Gerar contrato</Button>}
        {!proposal && document.status === "draft" && <Button size="sm" loading={busy} onClick={onSend} icon={<Send size={13} />}>Enviar para assinatura</Button>}
        {!proposal && document.status === "awaiting_signatures" && <Button size="sm" loading={busy} onClick={onSign} icon={<FileSignature size={13} />}>Registrar assinatura</Button>}
        {!proposal && document.status === "signed" && <Button size="sm" loading={busy} onClick={onInstantiate} icon={<CheckCircle2 size={13} />}>Criar tarefas e agenda</Button>}
      </div>
    </div>
  );
}

function SaveIndicator({ state, error }: { state: SaveState; error: string }) {
  const copy = state === "saving" ? "Salvando..." : state === "dirty" ? "Alterações não salvas" : state === "error" ? error : "Salvo";
  return <span className={state === "error" ? "max-w-64 truncate text-rose-400" : state === "saved" ? "text-emerald-400" : "text-amber-400"}>{copy}</span>;
}

function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = {
    draft: "Rascunho",
    in_review: "Em aprovacao",
    changes_requested: "Ajustes solicitados",
    approved: "Aprovada",
    rejected: "Rejeitada",
    sent: "Enviada",
    accepted: "Aceita",
    contracted: "Convertida",
    archived: "Arquivada",
    awaiting_signatures: "Aguardando assinaturas",
    signed: "Assinado",
    active: "Ativo",
    completed: "Concluido",
    cancelled: "Cancelado",
  };
  return <span className="rounded-full border border-[var(--border)] bg-[var(--surface-hover)] px-2 py-0.5 uppercase">{labels[status] || status}</span>;
}

function roleLabel(role: Signer["role"]) {
  return role === "client" ? "Contratante" : role === "contractor" ? "Contratado" : "Testemunha";
}

function formatDate(value?: string | null) {
  if (!value) return "agora";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatDocumentDate(value?: string | null) {
  if (!value) return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date());
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date(value));
}

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: currency || "BRL",
  }).format(value || 0);
}

function safeFileName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 100) || "documento-comercial";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] || character);
}

function readPagedEditorHtml(root: HTMLDivElement | null, fallback = "<p></p>") {
  if (!root) return fallback;
  const pages = Array.from(root.querySelectorAll<HTMLElement>("[data-commercial-page-content]"));
  if (!pages.length) return fallback;
  const html = pages.map((page) => {
    const clone = page.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[data-document-decoration]").forEach((node) => node.remove());
    return clone.innerHTML;
  }).join("");
  return html.trim() ? html : fallback;
}

function sanitizePreviewHtml(value: string) {
  const document = new DOMParser().parseFromString(value || "", "text/html");
  document.querySelectorAll("script,style,iframe,object,embed,form").forEach((node) => node.remove());
  document.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      if (attribute.name.startsWith("on")) node.removeAttribute(attribute.name);
    });
  });
  return document.body.innerHTML;
}
