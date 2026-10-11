export type PreviewField = { id: string; label: string; type: string; required?: boolean };
export type PreviewIdentity = { primary: string; secondary: string; accent: string; background: string; text: string; mode: string };

const TYPE_LABELS: Record<string, string> = {
  full_name: "Nome", first_name: "Nome", last_name: "Sobrenome", email: "E-mail", phone: "Telefone",
  text: "Texto", textarea: "Texto longo", cpf: "CPF", cnpj: "CNPJ", date: "Data", datetime: "Data e hora",
  time: "Hora", address: "Endereço", number: "Número", select: "Seleção", multiselect: "Múltipla escolha",
  checkbox: "Múltipla escolha", radio: "Opção única", boolean: "Sim/não",
};

export default function PagePreview({
  serviceName, title, description, identity, logoSrc, fields,
}: {
  serviceName: string; title: string; description: string; identity: PreviewIdentity; logoSrc: string; fields: PreviewField[];
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] p-5 shadow-sm" style={{ background: identity.background, color: identity.text }}>
      <div className="flex items-center gap-3">
        {logoSrc ? (
          <img src={logoSrc} alt="Pré-visualização do logo" className="h-12 w-12 rounded-xl object-contain" />
        ) : (
          <div className="grid h-12 w-12 place-items-center rounded-xl font-semibold text-white" style={{ background: identity.secondary }}>
            {(title || serviceName || "N").slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: identity.primary }}>Prévia ao vivo · antes de publicar</p>
          <h3 className="truncate text-xl font-semibold">{title || "Título da página"}</h3>
          {serviceName && (
            <p className="mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: identity.accent }}>{serviceName}</p>
          )}
        </div>
      </div>
      {description && <p className="mt-3 text-sm opacity-80">{description}</p>}
      <div className="mt-4 grid max-h-72 gap-2 overflow-y-auto">
        {fields.map((field) => (
          <div key={field.id}>
            <p className="mb-1 text-[11px] font-semibold">
              {field.label}
              {field.required && <span style={{ color: identity.primary }}> *</span>}
              <span className="ml-2 font-semibold opacity-60">{TYPE_LABELS[field.type] || field.type}{field.required ? " · obrigatório" : " · opcional"}</span>
            </p>
            {field.type === "textarea" ? (
              <div className="min-h-16 rounded-lg border border-black/10 px-3 py-2 text-xs opacity-60">Resposta longa…</div>
            ) : field.type === "boolean" ? (
              <div className="flex gap-2 text-xs font-semibold"><span className="rounded-lg border border-black/10 px-3 py-2">Sim</span><span className="rounded-lg border border-black/10 px-3 py-2">Não</span></div>
            ) : (
              <div className="h-10 truncate rounded-lg border border-black/10 px-3 py-2 text-xs opacity-60">{field.label}</div>
            )}
          </div>
        ))}
        {!fields.length && <p className="rounded-lg bg-black/5 p-3 text-center text-xs opacity-60">Nenhum campo ainda.</p>}
        <button type="button" tabIndex={-1} className="h-10 rounded-lg text-sm font-semibold text-white" style={{ background: identity.primary }}>Continuar</button>
      </div>
    </div>
  );
}
