import "../../styles/screens/trabalho-comum.css";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Eye, FileSignature, History, Pencil, Save, Upload, X } from "lucide-react";
import { changeProposalStatus, downloadImportedDocument, exportCommercialDocumentPdf, updateProposal } from "../../features/commercial/api";
import type { ClientOption, CommercialProposal, ProposalFileVersion } from "../../features/commercial/types";
import Button from "../shared/Button";
import PdfDocumentPreview from "./PdfDocumentPreview";
import PdfVisualEditor from "./PdfVisualEditor";
import type { PdfEdits } from "./pdfEditorModel";
import { proposalStatuses, statusLabels } from "./proposalWorkflow";
import "../shared/workspace.css";
import "./proposalFiles.css";

export default function ProposalPdfWorkspace({ proposal, clients, editImmediately = false, onBack, onUpload, onChange }: {
  proposal: CommercialProposal; clients: ClientOption[]; editImmediately?: boolean;
  onBack: () => void; onUpload: (proposal: CommercialProposal, signed?: boolean) => void; onChange: (proposal: CommercialProposal) => void;
}) {
  const [editor, setEditor] = useState<{ blob: Blob; source: CommercialProposal } | null>(null);
  const [preview, setPreview] = useState("");
  const [previewBlob, setPreviewBlob] = useState<Blob | undefined>();
  const [previewTitle, setPreviewTitle] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState(proposal.title);
  const [clientId, setClientId] = useState(proposal.clientId);
  const [amount, setAmount] = useState(proposal.amount);
  const [validUntil, setValidUntil] = useState(proposal.validUntil || "");
  const signed = Boolean(proposal.signedDocumentId);
  const [previewVersion, setPreviewVersion] = useState(0);
  const proposalRef = useRef(proposal); proposalRef.current = proposal;
  const openEditorInitially = useRef(editImmediately);
  useEffect(() => {
    let active = true;
    setError("");
    const source = proposalRef.current;
    const openingEditor = openEditorInitially.current && !source.signedDocumentId;
    void exportCommercialDocumentPdf("proposal", source.id, !openingEditor).then(blob => {
      if (!active) return;
      openEditorInitially.current = false;
      if (openingEditor) setEditor({ blob, source });
      else { setPreview(URL.createObjectURL(blob)); setPreviewBlob(blob); setPreviewTitle(source.title); }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Não foi possível abrir o PDF."); });
    return () => { active = false; };
  }, [proposal.id, proposal.sourceDocumentId, previewVersion]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  async function action(run: () => Promise<void>) {
    setBusy(true); setError("");
    try { await run(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível concluir a ação."); }
    finally { setBusy(false); }
  }
  async function saveDetails() {
    if (title === proposal.title && clientId === proposal.clientId && amount === proposal.amount && validUntil === (proposal.validUntil || "")) return proposal;
    const response = await updateProposal(proposal.id, { expectedVersion: proposal.version, title: title.trim(), clientId, amount, validUntil: validUntil || null });
    onChange(response.proposal);
    return response.proposal;
  }
  async function edit() {
    const source = await saveDetails();
    const blob = await exportCommercialDocumentPdf("proposal", source.id, false);
    setEditor({ blob, source });
  }
  async function savePdf(edits: PdfEdits) {
    if (!editor) throw new Error("Reabra o editor da proposta.");
    const response = await updateProposal(proposal.id, { expectedVersion: editor.source.version, pdfEdits: edits });
    setEditor(current => current ? { ...current, source: response.proposal } : current);
    onChange(response.proposal);
    return exportCommercialDocumentPdf("proposal", proposal.id);
  }
  async function viewFile(file: ProposalFileVersion) {
    const blob = await downloadImportedDocument(file.editedDocumentId || file.documentId);
    setPreview(URL.createObjectURL(blob)); setPreviewBlob(blob); setPreviewTitle(file.fileName);
  }
  async function closeEditor() {
    setEditor(null);
    await action(async () => { const blob = await exportCommercialDocumentPdf("proposal", proposal.id); setPreview(URL.createObjectURL(blob)); setPreviewBlob(blob); setPreviewTitle(proposal.title); });
  }
  if (editor) return <PdfVisualEditor blob={editor.blob} title={proposal.title} initialEdits={editor.source.pdfEdits} onSave={savePdf} onClose={() => void closeEditor()}/>;
  return <main className="clean-workspace nxw-remap documents-workspace min-h-[calc(100dvh-74px)] bg-[var(--background)] text-[var(--text)]">
    <div className="proposal-files-bar"><div><Button variant="ghost" onClick={onBack} icon={<ArrowLeft size={16}/>}>Propostas</Button><span className={signed ? "text-emerald-400 text-xs font-semibold" : "text-amber-400 text-xs font-semibold"}>{statusLabels[proposal.status]}</span><select aria-label="Alterar status da proposta" value="" disabled={busy} onChange={event => { const status = event.target.value as CommercialProposal["status"]; if (status === "signed") onUpload(proposal, true); else if (status) void action(async () => { const response = await changeProposalStatus(proposal.id, status, "", proposal.version); onChange(response.proposal); }); }}><option value="">Alterar status</option>{proposalStatuses.filter(status => status !== proposal.status).map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></div><div><Button variant="secondary" onClick={() => setHistoryOpen(!historyOpen)} icon={<History size={15}/>}>Arquivos ({proposal.fileVersions?.length || 0})</Button><Button variant="secondary" disabled={busy || Boolean(proposal.contractId)} onClick={() => void action(async () => { const current = signed ? proposal : await saveDetails(); onUpload(current); })} icon={<Upload size={15}/>}>Enviar nova versão</Button></div></div>
    {historyOpen && <section className="proposal-file-history" aria-label="Histórico de arquivos">{proposal.fileVersions?.map(file => <article key={file.documentId}><div><strong>{file.fileName}</strong><small>{file.signed ? "Assinado pelo cliente • " : "Versão enviada • "}{new Date(file.uploadedAt).toLocaleString("pt-BR")} • {file.uploadedBy}{file.documentId === proposal.sourceDocumentId ? " • Atual" : ""}</small>{file.note && <small>{file.note}</small>}</div><div className="file-actions"><Button variant="secondary" disabled={busy} onClick={() => void action(() => viewFile(file))} icon={<Eye size={14}/>}>Visualizar</Button></div></article>)}</section>}
    <section className="proposal-pdf-overview"><header><div><h1>{proposal.title}</h1><p>{signed ? "Arquivo assinado preservado. Para editar, envie uma nova versão." : "Edite, assine e acompanhe esta proposta no mesmo lugar."}</p></div><div className="flex gap-2">{!signed && <Button disabled={busy} onClick={() => void action(edit)} icon={<Pencil size={15}/>}>Editar / assinar PDF</Button>}{preview && <a className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" href={preview} download={`${previewTitle.replace(/\.pdf$/i, "")}.pdf`}><Download size={15}/>Baixar PDF</a>}</div></header>
      {!signed && <div className="proposal-pdf-fields"><label>Título<input value={title} maxLength={220} disabled={busy} onChange={event => setTitle(event.target.value)} className="commercial-field"/></label><label>Valor ({proposal.currency})<input type="number" min={0} max={999999999} value={amount} disabled={busy} onChange={event => setAmount(Number(event.target.value))} className="commercial-field"/></label><label>Validade<input type="date" value={validUntil} disabled={busy} onChange={event => setValidUntil(event.target.value)} className="commercial-field"/></label><Button variant="secondary" disabled={busy || title.trim().length < 2} onClick={() => void action(async () => { await saveDetails(); })} icon={<Save size={15}/>}>Salvar dados</Button><label>Cliente<select value={clientId} disabled={busy} onChange={event => setClientId(event.target.value)} className="commercial-field"><option value="">Sem cliente vinculado</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name || client.company}</option>)}</select></label></div>}
      {error && <div role="alert" className="flex items-center justify-between gap-3 text-sm text-rose-400">{error}<Button variant="ghost" onClick={() => setPreviewVersion(value => value + 1)}>Tentar novamente</Button></div>}
      {preview && <div><div className="flex items-center justify-between pb-2 text-xs text-[var(--text-secondary)]"><span className="flex gap-2"><FileSignature size={14}/>{previewTitle}</span>{previewTitle !== proposal.title && <Button variant="ghost" size="sm" onClick={() => setPreviewVersion(value => value + 1)} icon={<X size={13}/>}>Voltar ao PDF atual</Button>}</div><PdfDocumentPreview blob={previewBlob} title={previewTitle}/></div>}
    </section>
  </main>;
}
