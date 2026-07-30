import { ArrowRight, CheckCircle2, FileSignature, FileText, Send, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import { apiRequest } from "../../core/api/client";
import BrandLogo from "../layout/BrandLogo";

type PublicRoute =
  | { kind: "portal"; token: string }
  | { kind: "form"; token: string }
  | { kind: "signature"; token: string };

type PortalData = {
  portal: {
    clientName?: string;
    email?: string;
    companyName?: string;
  };
  requests: Array<{
    id: string;
    title?: string;
    description?: string;
    status?: string;
    createdAt?: string;
  }>;
};

type PublicField = {
  id?: string;
  name?: string;
  label?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
};

type FormData = {
  form: {
    title?: string;
    description?: string;
    fields?: PublicField[];
    successMessage?: string;
  };
};

type SignatureData = {
  contract: {
    id: string;
    title: string;
    contentHtml: string;
    status: string;
    branding?: {
      logoUrl?: string;
      primaryColor?: string;
      secondaryColor?: string;
      textColor?: string;
    };
    client?: { name?: string; company?: string };
    signers: Array<{
      id: string;
      name: string;
      role: string;
      order: number;
      status: string;
      signedAt?: string | null;
    }>;
  };
  signer: {
    id: string;
    name: string;
    email: string;
    role: string;
    order: number;
    status: string;
  };
  expiresAt: string;
};

export function publicRouteFromHash(hash = window.location.hash): PublicRoute | null {
  const match = hash.match(/^#\/(portal|formulario|assinatura)\/([^/?#]+)/i);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  return {
    kind: kind === "portal" ? "portal" : kind === "assinatura" ? "signature" : "form",
    token: decodeURIComponent(match[2]),
  };
}

export default function PublicAccess({ route }: { route: PublicRoute }) {
  const [payload, setPayload] = useState<PortalData | FormData | SignatureData | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [signatureName, setSignatureName] = useState("");
  const [signatureEmail, setSignatureEmail] = useState("");
  const [signatureConsent, setSignatureConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const endpoint = route.kind === "portal"
    ? `/api/plataforma/portal/publico/${encodeURIComponent(route.token)}`
    : route.kind === "signature"
      ? `/api/comercial/public/signature/${encodeURIComponent(route.token)}`
      : `/api/plataforma/formularios/publico/${encodeURIComponent(route.token)}`;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    apiRequest<PortalData | FormData | SignatureData>(endpoint, { token: null })
      .then((data) => {
        if (!active) return;
        setPayload(data);
        if ("signer" in data) {
          setSignatureName(data.signer.name || "");
          setSignatureEmail(data.signer.email || "");
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : "Este acesso nao esta disponivel.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);

  const fields = useMemo(() => {
    if (!payload || !("form" in payload)) return [];
    const configured = Array.isArray(payload.form.fields) ? payload.form.fields : [];
    return configured.length > 0
      ? configured
      : [
          { name: "nome", label: "Nome", type: "text", required: true },
          { name: "email", label: "E-mail", type: "email", required: true },
          { name: "mensagem", label: "Como podemos ajudar?", type: "textarea", required: true },
        ];
  }, [payload]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      if (route.kind === "portal") {
        await apiRequest(`/api/plataforma/portal/publico/${encodeURIComponent(route.token)}/solicitacoes`, {
          method: "POST",
          token: null,
          body: JSON.stringify({ title, description, attachments: [] }),
        });
        setTitle("");
        setDescription("");
        setMessage("Solicitacao enviada com seguranca.");
        const refreshed = await apiRequest<PortalData>(endpoint, { token: null });
        setPayload(refreshed);
      } else if (route.kind === "form") {
        const result = await apiRequest<{ message?: string }>(
          `/api/plataforma/formularios/publico/${encodeURIComponent(route.token)}/respostas`,
          {
            method: "POST",
            token: null,
            body: JSON.stringify({ values, attachments: [] }),
          },
        );
        setValues({});
        setMessage(result.message || "Recebemos suas informacoes.");
      } else {
        await apiRequest(`/api/comercial/public/signature/${encodeURIComponent(route.token)}`, {
          method: "POST",
          token: null,
          body: JSON.stringify({
            name: signatureName,
            email: signatureEmail,
            consent: signatureConsent,
            signatureDataUrl: "",
          }),
        });
        setMessage("Assinatura registrada. Uma copia da trilha de auditoria permanece vinculada ao contrato.");
        const refreshed = await apiRequest<SignatureData>(endpoint, { token: null });
        setPayload(refreshed);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Nao foi possivel enviar.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh bg-[var(--background)] p-4 text-[var(--text)] sm:p-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex items-center justify-between border-b border-[var(--border)] pb-5">
          <BrandLogo className="h-11 w-[116px]" />
          <span className="inline-flex items-center gap-2 text-xs font-bold text-[var(--text-secondary)]">
            <ShieldCheck size={16} className="text-cyan-400" /> Acesso seguro
          </span>
        </header>

        {loading && <PublicState title="Carregando acesso..." />}
        {!loading && error && <PublicState title="Acesso indisponivel" description={error} />}

        {!loading && payload && "portal" in payload && (
          <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
            <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--glass-shadow)]">
              <p className="text-xs font-bold uppercase text-cyan-400">Portal do cliente</p>
              <h1 className="mt-3 text-3xl font-black">{payload.portal.clientName || "Bem-vindo ao Norium"}</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                Acompanhe solicitacoes, envie documentos e registre uma nova demanda em um unico lugar.
              </p>
              <div className="mt-7 space-y-3">
                {payload.requests.length === 0 && (
                  <p className="rounded-lg border border-dashed border-[var(--border)] p-5 text-sm text-[var(--text-secondary)]">
                    Nenhuma solicitacao registrada.
                  </p>
                )}
                {payload.requests.map((request) => (
                  <article key={request.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface-soft)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-black">{request.title}</h2>
                      <span className="rounded-full border border-[var(--border)] px-2 py-1 text-xs font-bold uppercase">
                        {request.status || "aberta"}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--text-secondary)]">{request.description}</p>
                  </article>
                ))}
              </div>
            </section>
            <PublicRequestForm
              title={title}
              description={description}
              message={message}
              error={error}
              submitting={submitting}
              onTitle={setTitle}
              onDescription={setDescription}
              onSubmit={submit}
            />
          </div>
        )}

        {!loading && payload && "form" in payload && (
          <section className="mx-auto max-w-2xl rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--glass-shadow)] sm:p-8">
            <FileText className="text-cyan-400" size={28} />
            <h1 className="mt-4 text-3xl font-black">{payload.form.title || "Formulario Norium"}</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{payload.form.description}</p>
            <form className="mt-7 space-y-4" onSubmit={submit}>
              {fields.map((field, index) => {
                const name = field.name || field.id || `campo_${index + 1}`;
                const common = {
                  value: values[name] || "",
                  required: Boolean(field.required),
                  placeholder: field.placeholder || "",
                  onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                    setValues((current) => ({ ...current, [name]: event.target.value })),
                  className: "norium-platform-input",
                };
                return (
                  <label key={name} className="norium-platform-label">
                    {field.label || name}
                    {field.type === "textarea"
                      ? <textarea {...common} rows={5} />
                      : <input {...common} type={field.type || "text"} />}
                  </label>
                );
              })}
              {message && <SuccessMessage text={message} />}
              {error && <ErrorMessage text={error} />}
              <button className="norium-platform-button w-full justify-center" disabled={submitting}>
                {submitting ? "Enviando..." : "Enviar formulario"} <ArrowRight size={16} />
              </button>
            </form>
          </section>
        )}

        {!loading && payload && "signer" in payload && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
            <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-[var(--glass-shadow)]">
              <header
                className="border-b border-[var(--border)] p-6"
                style={{ borderTop: `4px solid ${payload.contract.branding?.secondaryColor || "#3B82F6"}` }}
              >
                {payload.contract.branding?.logoUrl && (
                  <img src={payload.contract.branding.logoUrl} alt="Logo da empresa" className="mb-4 max-h-14 max-w-48 object-contain" />
                )}
                <p className="text-xs font-bold uppercase text-cyan-400">Documento para assinatura</p>
                <h1 className="mt-2 text-2xl font-black">{payload.contract.title}</h1>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  Cliente: {payload.contract.client?.company || payload.contract.client?.name || "Nao informado"}
                </p>
              </header>
              <article className="commercial-document p-6 sm:p-10" dangerouslySetInnerHTML={{ __html: payload.contract.contentHtml }} />
            </section>

            <aside className="h-fit rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--glass-shadow)] lg:sticky lg:top-6">
              <FileSignature size={28} className="text-cyan-400" />
              <h2 className="mt-4 text-xl font-black">Assinatura eletronica</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                Revise o documento, confirme sua identidade e registre o aceite.
              </p>
              {payload.signer.status === "signed" ? (
                <SuccessMessage text="Este assinante ja concluiu o aceite." />
              ) : (
                <form className="mt-6 space-y-4" onSubmit={submit}>
                  <label className="norium-platform-label">
                    Nome completo
                    <input className="norium-platform-input" required value={signatureName} onChange={(event) => setSignatureName(event.target.value)} />
                  </label>
                  <label className="norium-platform-label">
                    E-mail
                    <input className="norium-platform-input" type="email" required value={signatureEmail} onChange={(event) => setSignatureEmail(event.target.value)} />
                  </label>
                  <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-soft)] p-4 text-sm leading-6">
                    <input className="mt-1" type="checkbox" required checked={signatureConsent} onChange={(event) => setSignatureConsent(event.target.checked)} />
                    Li o documento e concordo em registrar eletronicamente meu aceite.
                  </label>
                  {message && <SuccessMessage text={message} />}
                  {error && <ErrorMessage text={error} />}
                  <button className="norium-platform-button w-full justify-center" disabled={submitting || !signatureConsent}>
                    {submitting ? "Registrando..." : "Assinar documento"} <ArrowRight size={16} />
                  </button>
                </form>
              )}
              <p className="mt-5 text-xs leading-5 text-[var(--text-secondary)]">
                Link valido ate {new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(new Date(payload.expiresAt))}.
              </p>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}

function PublicRequestForm(props: {
  title: string;
  description: string;
  message: string;
  error: string;
  submitting: boolean;
  onTitle: (value: string) => void;
  onDescription: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--glass-shadow)]" onSubmit={props.onSubmit}>
      <Send size={25} className="text-cyan-400" />
      <h2 className="mt-4 text-xl font-black">Nova solicitacao</h2>
      <label className="norium-platform-label mt-5">
        Assunto
        <input className="norium-platform-input" required value={props.title} onChange={(event) => props.onTitle(event.target.value)} />
      </label>
      <label className="norium-platform-label mt-4">
        Detalhes
        <textarea className="norium-platform-input" required rows={7} value={props.description} onChange={(event) => props.onDescription(event.target.value)} />
      </label>
      {props.message && <SuccessMessage text={props.message} />}
      {props.error && <ErrorMessage text={props.error} />}
      <button className="norium-platform-button mt-5 w-full justify-center" disabled={props.submitting}>
        {props.submitting ? "Enviando..." : "Enviar solicitacao"} <ArrowRight size={16} />
      </button>
    </form>
  );
}

function PublicState({ title, description = "" }: { title: string; description?: string }) {
  return (
    <section className="mx-auto mt-24 max-w-lg rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
      <h1 className="text-xl font-black">{title}</h1>
      {description && <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{description}</p>}
    </section>
  );
}

function SuccessMessage({ text }: { text: string }) {
  return (
    <p className="mt-4 inline-flex w-full items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm font-bold text-emerald-300">
      <CheckCircle2 size={17} /> {text}
    </p>
  );
}

function ErrorMessage({ text }: { text: string }) {
  return <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm font-bold text-red-300">{text}</p>;
}
