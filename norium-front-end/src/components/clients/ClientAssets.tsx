import { useEffect, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  Eye,
  FileSignature,
  FileText,
  Link2,
  Paperclip,
  Plus,
  Search,
  Trash2,
  Unlink,
  Upload,
  X,
} from "lucide-react";
import { apiBlobRequest, apiRequest } from "../../core/api/client";
import PdfDocumentPreview from "../commercial/PdfDocumentPreview";
import useClientDialog from "./useClientDialog";
import Button from "../shared/Button";
import { showConfirm } from "../shared/AppDialogProvider";
import {
  dateLabel,
  openContract,
  saveBlob,
  uploadPayload,
} from "./clientModel";
type Attachment = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  url: string;
};
type Contract = {
  id: string;
  title: string;
  status: string;
  amount: number;
  currency: string;
  updatedAt: string;
  linked: boolean;
  primary: boolean;
  client?: { name: string };
};
const contractLabels: Record<string, string> = {
  draft: "Rascunho",
  awaiting_signatures: "Aguardando assinatura",
  signed: "Assinado",
  active: "Ativo",
  completed: "Concluído",
  cancelled: "Cancelado",
  archived: "Arquivado",
  expired: "Expirado",
};

export function ClientDocuments({
  clientId,
  onCountChange,
}: {
  clientId: string;
  onCountChange: (count: number) => void;
}) {
  const [items, setItems] = useState<Attachment[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [preview, setPreview] = useState<{
      blob: Blob;
      item: Attachment;
    } | null>(null),
    [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void apiRequest<{ items: Attachment[] }>(`/api/clientes/${clientId}/files`)
      .then((data) => {
        if (active) setItems(data.items);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clientId]);
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<{ item: Attachment }>(
        `/api/clientes/${clientId}/files`,
        {
          method: "POST",
          body: JSON.stringify(await uploadPayload(file)),
          timeoutMs: 90000,
        },
      );
      const next = [result.item, ...items];
      setItems(next);
      onCountChange(next.length);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível anexar o documento.",
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  async function read(item: Attachment, view = false) {
    setBusy(true);
    setError("");
    try {
      const blob = await apiBlobRequest(item.url);
      if (view) setPreview({ blob, item });
      else saveBlob(blob, item.fileName);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível abrir o documento.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove(item: Attachment) {
    if (
      !(await showConfirm({
        title: "Remover documento?",
        description: `O arquivo “${item.fileName}” será removido desta ficha.`,
        confirmLabel: "Remover documento",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/clientes/${clientId}/files/${item.id}`, {
        method: "DELETE",
      });
      const next = items.filter((file) => file.id !== item.id);
      setItems(next);
      onCountChange(next.length);
      if (preview?.item.id === item.id) setPreview(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível remover o documento.",
      );
    } finally {
      setBusy(false);
    }
  }
  const filtered = items.filter((item) =>
    item.fileName
      .toLocaleLowerCase("pt-BR")
      .includes(query.toLocaleLowerCase("pt-BR")),
  );
  return (
    <section className="client-section">
      <header className="client-section-heading">
        <div>
          <h3>Documentos do cliente</h3>
          <p>Arquivos organizados e disponíveis nesta ficha.</p>
        </div>
        <Button loading={busy} onClick={() => fileRef.current?.click()}>
          <Upload size={15} />
          Anexar documento
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.txt,.csv,.png,.jpg,.jpeg,.webp"
          hidden
          aria-label="Anexar documento do cliente"
          onChange={(event) => void upload(event.target.files?.[0])}
        />
      </header>
      <p className="client-hint">
        PDF, Word, Excel, texto e imagens · até 15 MB por arquivo
      </p>
      {error && (
        <p role="alert" className="client-error">
          {error}
        </p>
      )}
      {!!items.length && (
        <label className="client-search">
          <Search size={16} />
          <input
            aria-label="Buscar documento"
            placeholder="Buscar documento"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {loading ? (
        <p role="status" className="client-empty">
          Carregando documentos…
        </p>
      ) : filtered.length ? (
        <div className="client-file-list">
          {filtered.map((item) => (
            <article key={item.id} className="client-file-row">
              <span className="client-file-icon">
                <FileText size={20} />
              </span>
              <div className="client-file-info">
                <strong title={item.fileName}>{item.fileName}</strong>
                <p>
                  {item.size < 1024 * 1024
                    ? `${Math.max(1, Math.round(item.size / 1024))} KB`
                    : `${(item.size / (1024 * 1024)).toFixed(1)} MB`}{" "}
                  · {dateLabel(item.createdAt)}
                </p>
              </div>
              <div className="client-row-actions">
                {(item.mimeType === "application/pdf" ||
                  item.mimeType.startsWith("image/")) && (
                  <Button
                    size="sm"
                    iconOnly
                    disabled={busy}
                    aria-label={`Visualizar ${item.fileName}`}
                    title="Visualizar"
                    onClick={() => void read(item, true)}
                  >
                    <Eye size={16} />
                  </Button>
                )}
                <Button
                  size="sm"
                  iconOnly
                  disabled={busy}
                  aria-label={`Baixar ${item.fileName}`}
                  title="Baixar"
                  onClick={() => void read(item)}
                >
                  <Download size={16} />
                </Button>
                <Button
                  size="sm"
                  iconOnly
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Remover ${item.fileName}`}
                  title="Remover"
                  onClick={() => void remove(item)}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="client-empty">
          <Paperclip size={26} />
          <h4>
            {query ? "Nenhum arquivo encontrado" : "Os documentos ficam aqui"}
          </h4>
          <p>
            {query
              ? "Tente outro nome de arquivo."
              : "Anexe propostas assinadas, comprovantes e outros documentos deste cliente."}
          </p>
        </div>
      )}
      {preview && (
        <ClientFilePreview
          title={preview.item.fileName}
          blob={preview.blob}
          isPdf={preview.item.mimeType === "application/pdf"}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}

export function ClientContracts({ clientId }: { clientId: string }) {
  const [items, setItems] = useState<Contract[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [picker, setPicker] = useState(false),
    [query, setQuery] = useState(""),
    [preview, setPreview] = useState<{ blob: Blob; title: string } | null>(
      null,
    );
  useEffect(() => {
    let active = true;
    void apiRequest<{ items: Contract[] }>(
      `/api/clientes/${clientId}/contracts`,
    )
      .then((data) => {
        if (active) setItems(data.items);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clientId]);
  async function link(item: Contract, linked: boolean) {
    if (
      !linked &&
      !(await showConfirm({
        title: "Desvincular contrato?",
        description:
          "O contrato continuará disponível em Documentos. Apenas o vínculo adicional com esta ficha será removido.",
        confirmLabel: "Desvincular",
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/clientes/${clientId}/contracts/${item.id}`, {
        method: linked ? "PUT" : "DELETE",
      });
      setItems((current) =>
        current.map((contract) =>
          contract.id === item.id ? { ...contract, linked } : contract,
        ),
      );
      if (linked) {
        setPicker(false);
        setQuery("");
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível atualizar o vínculo.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function view(item: Contract) {
    setBusy(true);
    setError("");
    try {
      setPreview({
        blob: await apiBlobRequest(`/api/comercial/contracts/${item.id}/pdf`),
        title: item.title,
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível abrir o contrato.",
      );
    } finally {
      setBusy(false);
    }
  }
  const linked = items.filter((item) => item.linked),
    available = items.filter(
      (item) =>
        !item.linked &&
        `${item.title} ${item.client?.name || ""}`
          .toLocaleLowerCase("pt-BR")
          .includes(query.toLocaleLowerCase("pt-BR")),
    );
  return (
    <section className="client-section">
      <header className="client-section-heading">
        <div>
          <h3>Contratos vinculados</h3>
          <p>Consulte os documentos e acompanhe cada situação.</p>
        </div>
        <Button disabled={loading || busy} onClick={() => setPicker(!picker)}>
          <Link2 size={15} />
          Vincular contrato
        </Button>
      </header>
      {error && (
        <p role="alert" className="client-error">
          {error}
        </p>
      )}
      {picker && (
        <div className="client-contract-picker">
          <div className="client-section-heading">
            <h4>Escolha um contrato existente</h4>
            <Button
              size="sm"
              iconOnly
              variant="ghost"
              aria-label="Fechar seleção de contratos"
              onClick={() => setPicker(false)}
            >
              <X size={16} />
            </Button>
          </div>
          <label className="client-search">
            <Search size={16} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar contrato ou cliente"
              aria-label="Buscar contrato"
            />
          </label>
          <div className="client-contract-options">
            {available.map((item) => (
              <button
                key={item.id}
                disabled={busy}
                onClick={() => void link(item, true)}
              >
                <FileSignature size={17} />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.client?.name || "Sem cliente informado"} ·{" "}
                    {contractLabels[item.status] || item.status}
                  </small>
                </span>
                <Plus size={16} />
              </button>
            ))}
            {!available.length && (
              <p className="client-hint">
                Nenhum contrato disponível para este filtro. Crie contratos na
                tela de Documentos.
              </p>
            )}
          </div>
        </div>
      )}
      {loading ? (
        <p role="status" className="client-empty">
          Carregando contratos…
        </p>
      ) : linked.length ? (
        <div className="client-file-list">
          {linked.map((item) => (
            <article className="client-contract-row" key={item.id}>
              <span className="client-file-icon">
                <FileSignature size={21} />
              </span>
              <div className="client-file-info">
                <strong>{item.title}</strong>
                <p>
                  {item.primary ? "Cliente do contrato" : "Vinculado à ficha"} ·{" "}
                  {dateLabel(item.updatedAt)}
                </p>
                <span
                  className={`client-badge ${["signed", "active", "completed"].includes(item.status) ? "client-tone-green" : ["cancelled", "expired"].includes(item.status) ? "client-tone-red" : "client-tone-amber"}`}
                >
                  {contractLabels[item.status] || item.status}
                </span>
              </div>
              <div className="client-contract-actions">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void view(item)}
                >
                  <Eye size={15} />
                  Visualizar
                </Button>
                <Button size="sm" onClick={() => openContract(item.id)}>
                  <ExternalLink size={15} />
                  Abrir
                </Button>
                {!item.primary && (
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    disabled={busy}
                    aria-label={`Desvincular ${item.title}`}
                    onClick={() => void link(item, false)}
                  >
                    <Unlink size={15} />
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="client-empty">
          <FileSignature size={28} />
          <h4>Nenhum contrato vinculado</h4>
          <p>
            Vincule um contrato existente para encontrá-lo diretamente nesta
            ficha.
          </p>
        </div>
      )}
      {preview && (
        <ClientFilePreview
          {...preview}
          isPdf
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}

function ClientFilePreview({
  blob,
  title,
  isPdf,
  onClose,
}: {
  blob: Blob;
  title: string;
  isPdf: boolean;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const dialog = useClientDialog<HTMLElement>(onClose);
  useEffect(() => {
    if (isPdf) return;
    const value = URL.createObjectURL(blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob, isPdf]);
  return (
    <div
      className="client-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Visualizar ${title}`}
        className="client-modal client-preview-modal"
      >
        <header>
          <h2>{title}</h2>
          <div>
            <Button
              size="sm"
              onClick={() =>
                saveBlob(
                  blob,
                  title.toLowerCase().endsWith(".pdf") || !isPdf
                    ? title
                    : `${title}.pdf`,
                )
              }
            >
              <Download size={16} />
              Baixar
            </Button>
            <Button
              autoFocus
              size="sm"
              iconOnly
              variant="ghost"
              aria-label="Fechar visualização"
              onClick={onClose}
            >
              <X size={18} />
            </Button>
          </div>
        </header>
        {isPdf ? (
          <PdfDocumentPreview blob={blob} title={title} />
        ) : (
          <img className="client-image-preview" src={url} alt={title} />
        )}
      </section>
    </div>
  );
}
