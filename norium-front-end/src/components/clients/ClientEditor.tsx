import { useState } from "react";
import useClientDialog from "./useClientDialog";
import { X } from "lucide-react";
import Button from "../shared/Button";
import { apiRequest } from "../../core/api/client";
import {
  stageLabels,
  statusLabels,
  type Client,
  type ClientStage,
  type ClientStatus,
} from "./clientModel";
export default function ClientEditor({
  client,
  onSave,
  onClose,
}: {
  client: Client | null;
  onSave: (client: Client) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: client?.name || "",
    company: client?.company || "",
    document: client?.document || "",
    email: client?.email || "",
    phone: client?.phone || "",
    segment: client?.segment || "",
    status: client?.status || ("lead" as ClientStatus),
    stage: client?.stage || ("new" as ClientStage),
    ownerName: client?.ownerName || "",
    nextActionAt: client?.nextActionAt?.slice(0, 16) || "",
    tags: client?.tags.join(", ") || "",
    notes: client?.notes || "",
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useClientDialog<HTMLFormElement>(onClose, busy);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await apiRequest<{ item: Client }>(
        client ? `/api/clientes/${client.id}` : "/api/clientes",
        {
          method: client ? "PATCH" : "POST",
          body: JSON.stringify({
            ...form,
            name: form.name.trim(),
            tags: [
              ...new Set(
                form.tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              ),
            ].slice(0, 20),
            nextActionAt: form.nextActionAt || null,
          }),
        },
      );
      onSave(response.item);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível salvar o cliente.",
      );
    } finally {
      setBusy(false);
    }
  }
  function field(
    key:
      | "name"
      | "company"
      | "document"
      | "email"
      | "phone"
      | "segment"
      | "ownerName"
      | "nextActionAt"
      | "tags",
    label: string,
    type = "text",
    maxLength = 160,
  ) {
    return (
      <label>
        {label}
        <input
          type={type}
          autoFocus={key === "name"}
          required={key === "name"}
          minLength={key === "name" ? 2 : undefined}
          maxLength={maxLength}
          value={form[key]}
          onChange={(event) => setForm({ ...form, [key]: event.target.value })}
        />
      </label>
    );
  }
  return (
    <div className="client-modal-backdrop">
      <form
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-editor-title"
        className="client-modal"
        onSubmit={(event) => void submit(event)}
      >
        <header>
          <div>
            <h2 id="client-editor-title">
              {client ? "Editar cliente" : "Novo cliente"}
            </h2>
            <p>Informações para manter o relacionamento em dia.</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Fechar cadastro"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </header>
        <fieldset disabled={busy} className="client-form-grid">
          {field("name", "Nome *")}
          {field("company", "Empresa")}
          {field("email", "E-mail", "email", 220)}
          {field("phone", "WhatsApp / telefone", "tel", 40)}
          {field("document", "CPF / CNPJ", "text", 40)}
          {field("segment", "Segmento", "text", 100)}
          {field("ownerName", "Responsável")}
          <label>
            Status
            <select
              value={form.status}
              onChange={(event) =>
                setForm({ ...form, status: event.target.value as ClientStatus })
              }
            >
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Etapa comercial
            <select
              value={form.stage}
              onChange={(event) =>
                setForm({ ...form, stage: event.target.value as ClientStage })
              }
            >
              {Object.entries(stageLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {field("nextActionAt", "Próximo contato", "datetime-local")}
          {field("tags", "Marcadores, separados por vírgula", "text", 600)}
          <label className="client-form-wide">
            Observações
            <textarea
              rows={4}
              maxLength={2000}
              value={form.notes}
              onChange={(event) =>
                setForm({ ...form, notes: event.target.value })
              }
            />
          </label>
          <p className="client-hint client-form-wide">
            Telefones brasileiros podem usar DDD + número. Para outros países,
            inclua + e o código do país.
          </p>
        </fieldset>
        {error && (
          <p role="alert" className="client-error">
            {error}
          </p>
        )}
        <footer>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            className="client-main-action"
            type="submit"
            loading={busy}
            disabled={form.name.trim().length < 2}
          >
            Salvar cliente
          </Button>
        </footer>
      </form>
    </div>
  );
}
