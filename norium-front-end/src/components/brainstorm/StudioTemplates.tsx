import { ArrowLeft, ArrowRight, Check, FileText, LayoutTemplate, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NoriumUser } from "../../types/auth";
import Button from "../shared/Button";
import "./studio.css";

import { STUDIO_TEMPLATES, studioTemplateTitle } from "./studioTemplateCatalog";

function TemplatePreview({ layout }: { layout: string }) {
  return <div className={`studio-template-preview preview-${layout}`} aria-hidden="true">
    <div className="preview-document"><div className="preview-heading"><i /><span>•••</span></div>
      <div className="preview-rule" /><div className="preview-rule short" />
      <div className="preview-columns">{[0, 1, 2].map((column) => <div key={column} className={`preview-column column-${column}`}><div className="preview-band" />{[0, 1].map((row) => <div key={row} className="preview-note"><i /><i /></div>)}</div>)}</div>
    </div>
  </div>;
}

export type StudioSessionForm = { title: string; objective: string; responsibleId: string; template: string; durationMinutes: number };

export default function StudioTemplates({ members, userId, onClose, onCreate }: {
  members: NoriumUser[]; userId: string; onClose: () => void; onCreate: (form: StudioSessionForm) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<StudioSessionForm>({ title: "", objective: "", responsibleId: userId, template: "plano-projeto", durationMinutes: 15 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const selected = STUDIO_TEMPLATES.find((template) => template.id === form.template);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError("");
    try { await onCreate(form); } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível criar a sessão."); } finally { setSaving(false); }
  }
  return <dialog ref={dialogRef} className="studio-template-dialog" aria-labelledby="studio-create-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <header className="studio-dialog-top"><span><LayoutTemplate size={17} /> ESTÚDIO <span className="studio-step">{step + 1} / 2</span></span><Button iconOnly variant="ghost" onClick={onClose} disabled={saving} aria-label="Fechar criação de sessão"><X size={18} /></Button></header>
    <form onSubmit={submit}>
      <div className="studio-dialog-body"><div className="studio-dialog-heading"><span className="studio-eyebrow">{step === 0 ? "UM PONTO DE PARTIDA PARA CADA IDEIA" : "PRONTO PARA COLABORAR"}</span><h2 id="studio-create-title">{step === 0 ? "Escolha um template para começar" : "Dê forma à sua sessão"}</h2><p>{step === 0 ? "Planeje, crie e avance com a equipe. O primeiro passo já está organizado." : "Personalize os detalhes. Todos os itens do quadro podem ser editados depois."}</p></div>
      {step === 0 ? <><div className="studio-template-grid" role="group" aria-label="Templates da sessão">{STUDIO_TEMPLATES.map((template) => <button type="button" key={template.id} aria-pressed={form.template === template.id} className={`studio-template-card ${form.template === template.id ? "is-selected" : ""}`} onClick={() => setForm((current) => ({ ...current, template: template.id }))}>
        <TemplatePreview layout={template.layout} /><span className="studio-template-copy"><strong>{template.title}{form.template === template.id && <Check size={16} />}</strong><span>{template.description}</span><small><FileText size={12} /> Quadro colaborativo</small></span>
      </button>)}</div><button type="button" className={`studio-blank-option ${form.template === "livre" ? "is-selected" : ""}`} aria-pressed={form.template === "livre"} onClick={() => setForm((current) => ({ ...current, template: "livre" }))}>Prefere começar do zero? <strong>Usar quadro livre {form.template === "livre" && <Check size={14} />}</strong></button></> : <div className="studio-session-details"><aside><TemplatePreview layout={selected?.layout || "ideas"} /><h3>{studioTemplateTitle(form.template)}</h3><p>Seu quadro começa com:</p><ul>{(selected?.sections || ["Um espaço livre para suas ideias"]).map((section) => <li key={section}><Check size={15} /> {section}</li>)}</ul></aside><div className="studio-session-fields"><label className="brainstorm-field"><span>Título da sessão</span><input autoFocus required minLength={2} maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Ex.: Planejamento do lançamento" /></label><label className="brainstorm-field"><span>Objetivo <small>(opcional)</small></span><textarea rows={3} maxLength={1200} value={form.objective} onChange={(event) => setForm({ ...form, objective: event.target.value })} placeholder="O que queremos alcançar juntos?" /></label><label className="brainstorm-field"><span>Responsável</span><select value={form.responsibleId} onChange={(event) => setForm({ ...form, responsibleId: event.target.value })}>{members.map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}</select></label><label className="brainstorm-field"><span>Timer da sessão (minutos)</span><input type="number" required min={1} max={240} value={form.durationMinutes} onChange={(event) => setForm({ ...form, durationMinutes: Number(event.target.value) })} /><small>O timer só começa quando você o iniciar no quadro.</small></label></div></div>}
      {error && <p className="studio-create-error" role="alert">{error}</p>}</div>
      <footer className="studio-dialog-footer"><span>{step === 0 ? `${studioTemplateTitle(form.template)} selecionado` : "Salvo no espaço de trabalho da equipe"}</span><div>{step === 1 && <Button type="button" onClick={() => setStep(0)} disabled={saving}><ArrowLeft size={16} /> Voltar</Button>}{step === 0 ? <Button type="button" variant="primary" onClick={() => setStep(1)}>Continuar <ArrowRight size={16} /></Button> : <Button type="submit" variant="primary" disabled={saving || form.title.trim().length < 2}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Criar sessão</Button>}</div></footer>
    </form>
  </dialog>;
}
