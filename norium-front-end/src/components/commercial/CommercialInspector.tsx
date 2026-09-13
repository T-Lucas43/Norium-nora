import { useState, type ChangeEvent, type ReactNode } from "react";
import {
  CalendarDays,
  FileClock,
  ImagePlus,
  Palette,
  Plus,
  RotateCcw,
  Trash2,
  UsersRound,
} from "lucide-react";
import type {
  Branding,
  Deliverable,
  DocumentRevision,
  Signer,
  SignerRole,
} from "../../features/commercial/types";
import Button from "../shared/Button";
import { showAlert } from "../shared/AppDialogProvider";

type InspectorTab = "brand" | "signers" | "deliverables" | "history";

type CommercialInspectorProps = {
  branding: Branding;
  signers: Signer[];
  deliverables: Deliverable[];
  revisions: DocumentRevision[];
  advancedPlan: boolean;
  readOnly?: boolean;
  imageLabel?: string;
  onBrandingChange: (branding: Branding) => void;
  onSignersChange: (signers: Signer[]) => void;
  onDeliverablesChange: (deliverables: Deliverable[]) => void;
  onRestoreRevision: (revision: DocumentRevision) => void;
};

const tabs: Array<{ id: InspectorTab; label: string; icon: typeof Palette }> = [
  { id: "brand", label: "Marca", icon: Palette },
  { id: "signers", label: "Assinantes", icon: UsersRound },
  { id: "deliverables", label: "Entregaveis", icon: CalendarDays },
  { id: "history", label: "Historico", icon: FileClock },
];

const palettePresets = [
  { name: "Azul editorial", primaryColor: "#1F3A5F", secondaryColor: "#AFC6DC", textColor: "#172033" },
  { name: "Rosa queimado", primaryColor: "#7D3247", secondaryColor: "#C98F86", textColor: "#32242A" },
  { name: "Verde sálvia", primaryColor: "#214E45", secondaryColor: "#A9C8B8", textColor: "#18312C" },
  { name: "Lilás criativo", primaryColor: "#5B2A86", secondaryColor: "#C5A3DE", textColor: "#2F2337" },
  { name: "Bege moderno", primaryColor: "#795548", secondaryColor: "#E5D4BD", textColor: "#332A26" },
  { name: "Executivo", primaryColor: "#171A1F", secondaryColor: "#B9985A", textColor: "#171A1F" },
];

function emptySigner(index: number): Signer {
  return {
    id: `draft_signer_${crypto.randomUUID()}`,
    name: "",
    email: "",
    role: index === 0 ? "contractor" : "client",
    order: index + 1,
    required: true,
    status: "pending",
    signedAt: null,
    invitedAt: null,
    signatureDataUrl: "",
  };
}

function emptyDeliverable(): Deliverable {
  return {
    title: "",
    description: "",
    dueDate: null,
    responsibleId: "",
    responsibleName: "",
    createCalendarEvent: true,
  };
}

export default function CommercialInspector({
  branding,
  signers,
  deliverables,
  revisions,
  advancedPlan,
  readOnly = false,
  imageLabel = "Logo",
  onBrandingChange,
  onSignersChange,
  onDeliverablesChange,
  onRestoreRevision,
}: CommercialInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("brand");

  function updateSigner(index: number, changes: Partial<Signer>) {
    onSignersChange(signers.map((signer, position) => position === index ? { ...signer, ...changes } : signer));
  }

  function updateDeliverable(index: number, changes: Partial<Deliverable>) {
    onDeliverablesChange(deliverables.map((item, position) => position === index ? { ...item, ...changes } : item));
  }

  function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 1_500_000) {
      void showAlert({
        title: "Imagem nao suportada",
        description: "Escolha uma imagem JPG, PNG ou WebP de ate 1,5 MB.",
        tone: "warning",
      });
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onBrandingChange({ ...branding, logoUrl: String(reader.result || "") });
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--surface)]">
      <div className="grid grid-cols-4 border-b border-[var(--border)]">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            title={label}
            className={`flex h-14 flex-col items-center justify-center gap-1 text-xs font-bold ${tab === id ? "bg-blue-500/10 text-blue-400" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"}`}
           aria-label={label}>
            <Icon size={15} />
            <span className="hidden 2xl:block">{label}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable]">
        {tab === "brand" && (
          <div className="space-y-5">
            <InspectorHeading title="Identidade visual" description={advancedPlan ? "Perfis de marca da empresa." : "Perfil de marca pessoal."} />
            <div>
              <p className="mb-2 text-xs font-bold uppercase text-[var(--text-secondary)]">Paletas editoriais</p>
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Paletas de cores">
                {palettePresets.map((palette) => {
                  const active = branding.primaryColor.toUpperCase() === palette.primaryColor && branding.secondaryColor.toUpperCase() === palette.secondaryColor;
                  return <button key={palette.name} type="button" disabled={readOnly} aria-pressed={active} onClick={() => onBrandingChange({ ...branding, primaryColor: palette.primaryColor, secondaryColor: palette.secondaryColor, textColor: palette.textColor })} className={`rounded-lg border p-2 text-left transition ${active ? "border-cyan-400 bg-cyan-500/10" : "border-[var(--border)] bg-[var(--background)] hover:border-cyan-400/60"}`}>
                    <span className="mb-1.5 flex overflow-hidden rounded-full"><span className="h-3 flex-1" style={{ backgroundColor: palette.primaryColor }} /><span className="h-3 flex-1" style={{ backgroundColor: palette.secondaryColor }} /><span className="h-3 flex-1" style={{ backgroundColor: palette.textColor }} /></span>
                    <span className="block truncate text-[11px] font-bold">{palette.name}</span>
                  </button>;
                })}
              </div>
              <p className="mt-2 text-[11px] font-semibold leading-4 text-[var(--text-secondary)]">Escolha uma base e ajuste cada cor abaixo.</p>
            </div>
            <label className={`flex min-h-24 items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)] p-3 text-center ${readOnly ? "opacity-60" : "cursor-pointer hover:border-blue-500"}`}>
              {branding.logoUrl ? <img src={branding.logoUrl} alt={imageLabel} className={`max-h-16 max-w-full ${imageLabel.startsWith("Foto") ? "aspect-square rounded-full object-cover" : "object-contain"}`} /> : <><ImagePlus size={20} /><span className="text-xs font-bold">Enviar {imageLabel.toLocaleLowerCase("pt-BR")}</span></>}
              <input type="file" accept="image/*" className="sr-only" disabled={readOnly} onChange={uploadLogo} />
            </label>
            {branding.logoUrl && !readOnly && (
              <Button size="sm" variant="ghost" onClick={() => onBrandingChange({ ...branding, logoUrl: "" })} icon={<Trash2 size={13} />}>Remover {imageLabel.toLocaleLowerCase("pt-BR")}</Button>
            )}
            <Field label={`Alinhamento da ${imageLabel.toLocaleLowerCase("pt-BR")}`}>
              <select value={branding.logoAlignment} disabled={readOnly} onChange={(event) => onBrandingChange({ ...branding, logoAlignment: event.target.value as Branding["logoAlignment"] })} className="commercial-field">
                <option value="left">Esquerda</option>
                <option value="center">Centro</option>
                <option value="right">Direita</option>
              </select>
            </Field>
            <Field label={`Escala da ${imageLabel.toLocaleLowerCase("pt-BR")} (${branding.logoScale}%)`}>
              <input type="range" min="30" max="180" value={branding.logoScale} disabled={readOnly} onChange={(event) => onBrandingChange({ ...branding, logoScale: Number(event.target.value) })} className="w-full accent-blue-500" />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <ColorField label="Primaria" value={branding.primaryColor} disabled={readOnly} onChange={(primaryColor) => onBrandingChange({ ...branding, primaryColor })} />
              <ColorField label="Secundaria" value={branding.secondaryColor} disabled={readOnly} onChange={(secondaryColor) => onBrandingChange({ ...branding, secondaryColor })} />
              <ColorField label="Texto" value={branding.textColor} disabled={readOnly} onChange={(textColor) => onBrandingChange({ ...branding, textColor })} />
            </div>
            <Field label="Cabecalho">
              <textarea value={branding.headerHtml} disabled={readOnly} onChange={(event) => onBrandingChange({ ...branding, headerHtml: event.target.value })} placeholder="Texto ou HTML simples do cabecalho" className="commercial-field min-h-20 resize-y" />
            </Field>
            <Field label="Rodape">
              <textarea value={branding.footerHtml} disabled={readOnly} onChange={(event) => onBrandingChange({ ...branding, footerHtml: event.target.value })} placeholder="Contato, endereco e informacoes legais" className="commercial-field min-h-20 resize-y" />
            </Field>
          </div>
        )}

        {tab === "signers" && (
          <div className="space-y-4">
            <InspectorHeading title="Assinantes" description={advancedPlan ? "Defina papeis e ordem de assinatura." : "No Solo: profissional e cliente."} />
            {signers.map((signer, index) => (
              <section key={signer.id || `${signer.email}-${index}`} className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-xs">Assinante {index + 1}</strong>
                  <span className={`rounded-full px-2 py-1 text-xs font-bold uppercase ${signer.status === "signed" ? "bg-emerald-500/15 text-emerald-400" : "bg-blue-500/10 text-blue-400"}`}>{signer.status}</span>
                </div>
                <input value={signer.name} disabled={readOnly || signer.status === "signed"} onChange={(event) => updateSigner(index, { name: event.target.value })} placeholder="Nome completo" className="commercial-field" />
                <input value={signer.email} disabled={readOnly || signer.status === "signed"} onChange={(event) => updateSigner(index, { email: event.target.value })} placeholder="E-mail" type="email" className="commercial-field" />
                <div className="grid grid-cols-[minmax(0,1fr)_84px] gap-2">
                  <select value={signer.role} disabled={readOnly || signer.status === "signed"} onChange={(event) => updateSigner(index, { role: event.target.value as SignerRole })} className="commercial-field">
                    <option value="contractor">Contratado</option>
                    <option value="client">Contratante</option>
                    {advancedPlan && <option value="witness">Testemunha</option>}
                  </select>
                  <input value={signer.order} disabled={readOnly || signer.status === "signed"} onChange={(event) => updateSigner(index, { order: Number(event.target.value) })} min={1} type="number" className="commercial-field" title="Ordem" />
                </div>
                {!readOnly && signer.status !== "signed" && (
                  <Button size="sm" variant="ghost" onClick={() => onSignersChange(signers.filter((_, position) => position !== index))} icon={<Trash2 size={13} />}>Remover</Button>
                )}
              </section>
            ))}
            {!readOnly && (
              <Button
                size="sm"
                onClick={() => onSignersChange([...signers, emptySigner(signers.length)])}
                disabled={!advancedPlan && signers.length >= 2}
                icon={<Plus size={14} />}
                className="w-full"
              >
                Adicionar assinante
              </Button>
            )}
          </div>
        )}

        {tab === "deliverables" && (
          <div className="space-y-4">
            <InspectorHeading title="Entregaveis e obrigacoes" description="Depois da assinatura, cada item pode virar tarefa e compromisso." />
            {deliverables.map((item, index) => (
              <section key={`${index}-${item.title}`} className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                <input value={item.title} disabled={readOnly} onChange={(event) => updateDeliverable(index, { title: event.target.value })} placeholder="Nome do entregavel" className="commercial-field" />
                <textarea value={item.description} disabled={readOnly} onChange={(event) => updateDeliverable(index, { description: event.target.value })} placeholder="Criterio de aceite e detalhes" className="commercial-field min-h-20 resize-y" />
                <input value={item.dueDate || ""} disabled={readOnly} onChange={(event) => updateDeliverable(index, { dueDate: event.target.value || null })} type="date" className="commercial-field" />
                <input value={item.responsibleName} disabled={readOnly} onChange={(event) => updateDeliverable(index, { responsibleName: event.target.value })} placeholder="Responsavel" className="commercial-field" />
                <label className="flex items-center gap-2 text-xs font-bold text-[var(--text-secondary)]">
                  <input type="checkbox" checked={item.createCalendarEvent} disabled={readOnly} onChange={(event) => updateDeliverable(index, { createCalendarEvent: event.target.checked })} />
                  Adicionar prazo ao Google Agenda
                </label>
                {!readOnly && <Button size="sm" variant="ghost" onClick={() => onDeliverablesChange(deliverables.filter((_, position) => position !== index))} icon={<Trash2 size={13} />}>Remover</Button>}
              </section>
            ))}
            {!readOnly && <Button size="sm" onClick={() => onDeliverablesChange([...deliverables, emptyDeliverable()])} icon={<Plus size={14} />} className="w-full">Adicionar entregavel</Button>}
          </div>
        )}

        {tab === "history" && (
          <div className="space-y-4">
            <InspectorHeading title="Historico de versoes" description="Cada salvamento preserva a versao anterior." />
            {revisions.map((revision) => (
              <section key={revision.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <span><strong className="block text-xs">Versao {revision.version}</strong><small className="text-xs font-semibold text-[var(--text-secondary)]">{revision.savedBy}</small></span>
                  <time className="text-xs font-bold text-[var(--text-secondary)]">{new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(revision.savedAt))}</time>
                </div>
                {!readOnly && <Button size="sm" variant="ghost" className="mt-3" onClick={() => onRestoreRevision(revision)} icon={<RotateCcw size={13} />}>Restaurar esta versao</Button>}
              </section>
            ))}
            {!revisions.length && <p className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-xs font-semibold text-[var(--text-secondary)]">O historico aparecera depois do primeiro salvamento.</p>}
          </div>
        )}
      </div>
    </aside>
  );
}

function InspectorHeading({ title, description }: { title: string; description: string }) {
  return <div><h3 className="text-sm font-bold">{title}</h3><p className="mt-1 text-xs font-semibold leading-5 text-[var(--text-secondary)]">{description}</p></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-bold uppercase text-[var(--text-secondary)]">{label}</span>{children}</label>;
}

function ColorField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <label className="min-w-0">
      <span className="mb-1.5 block truncate text-xs font-bold uppercase text-[var(--text-secondary)]">{label}</span>
      <span className="flex h-9 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-2">
        <input type="color" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="h-5 w-6 border-0 bg-transparent p-0" />
        <span className="truncate text-xs font-bold">{value}</span>
      </span>
    </label>
  );
}
