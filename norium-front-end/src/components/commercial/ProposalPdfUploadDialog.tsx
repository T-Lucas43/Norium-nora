import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileCheck2, Upload, X } from "lucide-react";
import { uploadProposalPdf } from "../../features/commercial/api";
import type { ClientOption, CommercialProposal } from "../../features/commercial/types";
import Button from "../shared/Button";
import "./proposalFiles.css";

export default function ProposalPdfUploadDialog({ proposal, clients = [], initialSigned = false, onClose, onUploaded }: {
  proposal?: CommercialProposal; clients?: ClientOption[]; initialSigned?: boolean;
  onClose: () => void; onUploaded: (proposal: CommercialProposal) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState("");
  const [signed, setSigned] = useState(initialSigned);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);
  function selectFile(next: File | null) {
    setError("");
    if (next && (!/\.pdf$/i.test(next.name) || (next.type && next.type !== "application/pdf"))) { setError("Selecione uma proposta em PDF."); setFile(null); return; }
    if (next && next.size > 25 * 1024 * 1024) { setError("O PDF pode ter até 25 MB."); setFile(null); return; }
    setFile(next);
    if (next && !title) setTitle(next.name.replace(/\.pdf$/i, "").slice(0, 220));
  }
  async function upload() {
    if (!file || busy) return;
    setBusy(true); setError("");
    try {
      const response = await uploadProposalPdf(file, { title: title.trim(), clientId, signed, note, expectedVersion: proposal?.version }, proposal?.id);
      onUploaded(response.proposal);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível enviar o PDF."); }
    finally { setBusy(false); }
  }
  return createPortal(<div className="proposal-upload-backdrop"><div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="proposal-upload-title" className="clean-workspace proposal-upload-dialog" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape" && !busy) onClose();
    if (event.key === "Tab") {
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') || []);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><div><h2 id="proposal-upload-title">{proposal ? "Enviar nova versão" : "Importar proposta em PDF"}</h2><p>{proposal ? proposal.title : "Envie o arquivo e continue a edição no Norium."}</p></div><Button iconOnly variant="ghost" disabled={busy} onClick={onClose} aria-label="Fechar upload"><X size={18}/></Button></header>
    <div className="proposal-upload-body">
      <label className="proposal-upload-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) selectFile(event.dataTransfer.files[0] || null); }}>
        <Upload size={26}/><strong>{file?.name || "Selecione ou arraste o PDF"}</strong><span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "PDF • até 25 MB"}</span>
        <input type="file" accept="application/pdf,.pdf" aria-label="Arquivo PDF da proposta" disabled={busy} onChange={event => selectFile(event.target.files?.[0] || null)}/>
      </label>
      {!proposal && <><label>Título da proposta<input className="commercial-field" maxLength={220} value={title} disabled={busy} onChange={event => setTitle(event.target.value)}/></label><label>Cliente (opcional)<select className="commercial-field" value={clientId} disabled={busy} onChange={event => setClientId(event.target.value)}><option value="">Vincular depois</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name || client.company}</option>)}</select></label></>}
      <label className="proposal-signed-choice"><input type="checkbox" checked={signed} disabled={busy} onChange={event => setSigned(event.target.checked)}/><span><strong><FileCheck2 size={16}/> Este arquivo já foi assinado pelo cliente</strong><small>Registrar como Assinado e atualizar os indicadores. O PDF recebido será preservado.</small></span></label>
      {proposal && !signed && <p className="proposal-upload-note">A nova versão será aberta como rascunho para edição. Os arquivos anteriores continuarão no histórico.</p>}
      <label>Observação (opcional)<textarea className="commercial-field" maxLength={1200} rows={2} value={note} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="Ex.: versão assinada recebida por e-mail"/></label>
      {error && <p role="alert" className="text-rose-400">{error}</p>}
    </div>
    <footer><Button variant="ghost" disabled={busy} onClick={onClose}>Cancelar</Button><Button icon={<Upload size={15}/>} loading={busy} disabled={!file || (!proposal && !title.trim())} onClick={() => void upload()}>{signed ? "Enviar e registrar assinatura" : "Enviar e editar"}</Button></footer>
  </div></div>, document.body);
}
