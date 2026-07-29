import { ArrowRight, CheckCircle2, FileText, Send, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import { apiRequest } from "../../core/api/client";
import BrandLogo from "../layout/BrandLogo";

type PublicRoute =
  | { kind: "portal"; token: string }
  | { kind: "form"; token: string };

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

export function publicRouteFromHash(hash = window.location.hash): PublicRoute | null {
  const match = hash.match(/^#\/(portal|formulario)\/([^/?#]+)/i);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() === "portal" ? "portal" : "form",
    token: decodeURIComponent(match[2]),
  };
}

export default function PublicAccess({ route }: { route: PublicRoute }) {
  const [payload, setPayload] = useState<PortalData | FormData | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const endpoint = route.kind === "portal"
    ? `/api/plataforma/portal/publico/${encodeURIComponent(route.token)}`
    : `/api/plataforma/formularios/publico/${encodeURIComponent(route.token)}`;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    apiRequest<PortalData | FormData>(endpoint, { token: null })
      .then((data) => {
        if (active) setPayload(data);
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
      } else {
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
              <p className="text-xs font-black uppercase text-cyan-400">Portal do cliente</p>
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
                      <span className="rounded-full border border-[var(--border)] px-2 py-1 text-[10px] font-black uppercase">
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
