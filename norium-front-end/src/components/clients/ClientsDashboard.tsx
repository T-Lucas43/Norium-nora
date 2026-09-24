import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Building2,
  Bot,
  CalendarClock,
  Camera,
  CheckCheck,
  ChevronRight,
  Download,
  FileSignature,
  FileText,
  History,
  Mail,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  UserRound,
  UserRoundCheck,
  UsersRound,
  X,
} from "lucide-react";
import { apiRequest } from "../../core/api/client";
import WorkspaceHeader from "../shared/WorkspaceHeader";
import Button from "../shared/Button";
import { showConfirm } from "../shared/AppDialogProvider";
import ClientAvatar from "./ClientAvatar";
import ClientAccessDialog from "./ClientAccessDialog";
import ClientEditor from "./ClientEditor";
import { ClientContracts, ClientDocuments } from "./ClientAssets";
import {
  dateLabel,
  gmailUrl,
  saveBlob,
  stageLabels,
  statusLabels,
  uploadPayload,
  whatsappUrl,
  type Client,
  type Client360,
  type ClientStatus,
} from "./clientModel";
import "./clients.css";

type DetailTab = "overview" | "contracts" | "documents" | "history";
export default function ClientsDashboard({ onOpenNora }: { onOpenNora?: (prompt?: string) => void }) {
  const [clients, setClients] = useState<Client[]>([]),
    [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState<"all" | ClientStatus>("all"),
    [sort, setSort] = useState("recent"),
    [visible, setVisible] = useState(25);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [editor, setEditor] = useState<{ client: Client | null } | null>(null),
    [accessClient, setAccessClient] = useState<Client | null>(null),
    [photoBusy, setPhotoBusy] = useState(false);
  const [tab, setTab] = useState<DetailTab>("overview");
  const photoRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiRequest<{ items: Client[] }>("/api/clientes");
      setClients(
        data.items.map((item) => ({
          ...item,
          tags: item.tags || [],
          status: item.status || "lead",
          stage: item.stage || "new",
        })),
      );
      setSelectedId((current) =>
        data.items.some((item) => item.id === current) ? current : null,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível carregar os clientes.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (loading) return;
    const consume = () => {
      try {
        const link = JSON.parse(
          localStorage.getItem("norium-deep-link") || "null",
        );
        if (link?.tab !== "Clientes" || link.entityType !== "client") return;
        const client = clients.find((item) => item.id === link.entityId);
        localStorage.removeItem("norium-deep-link");
        if (client) {
          setSelectedId(client.id);
          setTab(
            link.metadata?.section === "documents" ? "documents" : "overview",
          );
        }
      } catch {
        /* Ignore unrelated or invalid navigation state. */
      }
    };
    consume();
    window.addEventListener("norium:deep-link", consume);
    return () => window.removeEventListener("norium:deep-link", consume);
  }, [clients, loading]);
  const selected = clients.find((item) => item.id === selectedId) || null;
  const canEditSelected = selected?.accessRole !== "view";
  const canShareSelected = selected?.accessRole === "owner";
  const filtered = useMemo(() => {
    const simplify = (value: string) =>
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("pt-BR");
    return clients
      .filter(
        (item) =>
          (filter === "all" || item.status === filter) &&
          simplify(
            `${item.name} ${item.company} ${item.email} ${item.phone} ${item.document || ""} ${item.segment} ${item.tags.join(" ")}`,
          ).includes(simplify(query)),
      )
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name, "pt-BR")
          : sort === "next"
            ? (a.nextActionAt || "9999").localeCompare(b.nextActionAt || "9999")
            : b.updatedAt.localeCompare(a.updatedAt),
      );
  }, [clients, query, filter, sort]);
  const nextContacts = clients.filter(
    (item) =>
      item.nextActionAt &&
      new Date(item.nextActionAt).getTime() <= Date.now() + 7 * 86400000 &&
      item.status !== "inactive",
  ).length;
  function select(id: string | null) {
    setSelectedId(id);
    setTab("overview");
    setError("");
  }
  function askNoraAboutClient(instruction = "Faça um resumo 360° e recomende os próximos passos") {
    if (!selected || !onOpenNora) return;
    onOpenNora([
      `${instruction} para este cliente usando apenas os dados registrados abaixo.`,
      `Cliente: ${selected.name}`,
      `Empresa: ${selected.company || "cliente individual"}`,
      `Status: ${statusLabels[selected.status]}`,
      `Etapa: ${stageLabels[selected.stage]}`,
      `Segmento: ${selected.segment || "não informado"}`,
      `Responsável: ${selected.ownerName || "não informado"}`,
      `Próximo contato: ${selected.nextActionAt || "não agendado"}`,
      `Marcadores: ${selected.tags.join(", ") || "nenhum"}`,
      `Observações: ${selected.notes || "nenhuma"}`,
      "Não invente histórico, valores, decisões ou conversas que não estejam nesses dados.",
    ].join("\n"));
  }
  function updateClient(client: Client) {
    setClients((current) =>
      current.some((item) => item.id === client.id)
        ? current.map((item) =>
            item.id === client.id ? { ...item, ...client } : item,
          )
        : [client, ...current],
    );
    setSelectedId(client.id);
    setEditor(null);
  }
  async function remove(client: Client) {
    if (
      !(await showConfirm({
        title: "Excluir cliente?",
        description: `A ficha de “${client.name}”, sua foto e seus anexos serão excluídos. Contratos e registros históricos continuarão disponíveis em suas respectivas telas.`,
        confirmLabel: "Excluir cliente",
        tone: "danger",
      }))
    )
      return;
    setError("");
    try {
      await apiRequest(`/api/clientes/${client.id}`, { method: "DELETE" });
      setClients((current) => current.filter((item) => item.id !== client.id));
      select(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível excluir o cliente.",
      );
    }
  }
  async function photo(file?: File) {
    if (!selected || !file) return;
    const clientId = selected.id;
    setPhotoBusy(true);
    setError("");
    try {
      const result = await apiRequest<{ item: Client }>(
        `/api/clientes/${clientId}/avatar`,
        {
          method: "PUT",
          body: JSON.stringify(await uploadPayload(file)),
          timeoutMs: 90000,
        },
      );
      setClients((current) =>
        current.map((item) =>
          item.id === clientId ? { ...item, ...result.item } : item,
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível salvar a foto.",
      );
    } finally {
      setPhotoBusy(false);
      if (photoRef.current) photoRef.current.value = "";
    }
  }
  async function removePhoto() {
    if (!selected) return;
    const clientId = selected.id;
    setPhotoBusy(true);
    setError("");
    try {
      await apiRequest(`/api/clientes/${clientId}/avatar`, {
        method: "DELETE",
      });
      setClients((current) =>
        current.map((item) =>
          item.id === clientId ? { ...item, avatarId: undefined } : item,
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível remover a foto.",
      );
    } finally {
      setPhotoBusy(false);
    }
  }
  function exportClients() {
    const escape = (value: unknown) => {
      const text = String(value ?? "");
      return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
    };
    const rows = [
      [
        "Nome",
        "Empresa",
        "E-mail",
        "WhatsApp",
        "Segmento",
        "Status",
        "Etapa",
        "Responsável",
        "Próximo contato",
      ],
      ...filtered.map((item) => [
        item.name,
        item.company,
        item.email,
        item.phone,
        item.segment,
        statusLabels[item.status],
        stageLabels[item.stage],
        item.ownerName,
        item.nextActionAt || "",
      ]),
    ];
    saveBlob(
      new Blob(
        ["\ufeff", rows.map((row) => row.map(escape).join(";")).join("\r\n")],
        { type: "text/csv;charset=utf-8" },
      ),
      `clientes-norium-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  }
  return (
    <main className="clients-workspace clean-workspace">
      <WorkspaceHeader
        title="Clientes"
        description="Pessoas, conversas e documentos. Tudo no mesmo lugar."
        icon={UsersRound}
      >
        {onOpenNora && (
          <Button size="sm" onClick={() => onOpenNora("Ajude-me a analisar minha carteira de clientes e definir prioridades.")}>
            <Sparkles size={15} />
            Perguntar à Nora
          </Button>
        )}
        <Button
          size="sm"
          iconOnly
          title="Atualizar clientes"
          aria-label="Atualizar clientes"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={16} />
        </Button>
        <Button size="sm" disabled={!filtered.length} onClick={exportClients}>
          <Download size={15} />
          Exportar
        </Button>
        <Button
          className="client-main-action"
          onClick={() => setEditor({ client: null })}
        >
          <Plus size={16} />
          Novo cliente
        </Button>
      </WorkspaceHeader>
      <div className="client-metrics">
        <Metric
          icon={UsersRound}
          tone="violet"
          value={clients.length}
          label="Total de clientes"
        />
        <Metric
          icon={UserRoundCheck}
          tone="green"
          value={clients.filter((item) => item.status === "active").length}
          label="Clientes ativos"
        />
        <Metric
          icon={MessageCircle}
          tone="sky"
          value={clients.filter((item) => item.status === "lead").length}
          label="Em prospecção"
        />
        <Metric
          icon={CalendarClock}
          tone="amber"
          value={nextContacts}
          label="Contatos até os próximos 7 dias"
        />
      </div>
      {error && (
        <div role="alert" className="client-error">
          {error}
        </div>
      )}
      <div
        className={`client-workbench ${selected ? "client-has-selection" : ""}`}
      >
        <aside className="client-sidebar" aria-label="Lista de clientes">
          <div className="client-sidebar-tools">
            <label className="client-search">
              <Search size={17} />
              <input
                aria-label="Buscar clientes"
                placeholder="Buscar nome, empresa ou contato"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisible(25);
                }}
              />
              {query && (
                <button aria-label="Limpar busca" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </label>
            <div className="client-filters">
              {(["all", "active", "lead", "inactive"] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => {
                    setFilter(value);
                    setVisible(25);
                  }}
                >
                  {value === "all"
                    ? "Todos"
                    : value === "active"
                      ? "Ativos"
                      : value === "lead"
                        ? "Leads"
                        : "Inativos"}
                </button>
              ))}
            </div>
            <div className="client-list-caption">
              <span>
                {filtered.length}{" "}
                {filtered.length === 1 ? "cliente" : "clientes"}
              </span>
              <select
                aria-label="Ordenar clientes"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="recent">Recentes</option>
                <option value="name">Nome A–Z</option>
                <option value="next">Próximo contato</option>
              </select>
            </div>
          </div>
          <div className="client-list">
            {loading ? (
              <p className="client-empty" role="status">
                Carregando clientes…
              </p>
            ) : (
              filtered.slice(0, visible).map((client) => (
                <button
                  className={`client-list-item ${selectedId === client.id ? "is-selected" : ""}`}
                  key={client.id}
                  aria-pressed={selectedId === client.id}
                  onClick={() => select(client.id)}
                >
                  <ClientAvatar client={client} />
                  <span className="client-list-person">
                    <strong>{client.name}</strong>
                    <small>
                      {client.company || client.email || "Cliente individual"}
                    </small>
                    <span
                      className={`client-status-dot client-status-${client.status}`}
                    >
                      {statusLabels[client.status]}
                    </span>
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))
            )}
            {!loading && !filtered.length && (
              <div className="client-empty">
                <Search size={24} />
                <h4>
                  {query || filter !== "all"
                    ? "Nenhum resultado"
                    : "Sua carteira começa aqui"}
                </h4>
                <p>
                  {query || filter !== "all"
                    ? "Ajuste a busca ou os filtros."
                    : "Cadastre um cliente para organizar os contatos."}
                </p>
              </div>
            )}
            {visible < filtered.length && (
              <Button
                className="client-load-more"
                variant="ghost"
                onClick={() => setVisible((value) => value + 25)}
              >
                Carregar mais clientes
              </Button>
            )}
          </div>
        </aside>
        <section className="client-detail" aria-label="Ficha do cliente">
          {selected ? (
            <>
              <div className="client-detail-top">
                <Button size="sm" variant="ghost" onClick={() => select(null)}>
                  <ArrowLeft size={15} />
                  <span>Clientes</span>
                </Button>
                <div>
                  {canShareSelected && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setAccessClient(selected)}
                    >
                      <UsersRound size={14} />
                      Compartilhar
                    </Button>
                  )}
                  {canEditSelected && (
                    <Button
                      size="sm"
                      disabled={photoBusy}
                      onClick={() => setEditor({ client: selected })}
                    >
                      <Pencil size={14} />
                      Editar
                    </Button>
                  )}
                  {canShareSelected && (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      disabled={photoBusy}
                      aria-label="Excluir cliente"
                      title="Excluir cliente"
                      onClick={() => void remove(selected)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  )}
                </div>
              </div>
              <header className="client-profile">
                <div className="client-photo-control">
                  <button
                    disabled={photoBusy || !canEditSelected}
                    className="client-photo-button"
                    aria-label={
                      selected.avatarId
                        ? "Alterar foto do cliente"
                        : "Adicionar foto do cliente"
                    }
                    title="Alterar foto"
                    onClick={() => photoRef.current?.click()}
                  >
                    <ClientAvatar client={selected} large />
                    <span>
                      <Camera size={14} />
                    </span>
                  </button>
                  {selected.avatarId && canEditSelected && (
                    <button
                      className="client-remove-photo"
                      disabled={photoBusy}
                      onClick={() => void removePhoto()}
                    >
                      Remover foto
                    </button>
                  )}
                  <input
                    hidden
                    ref={photoRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label="Foto de perfil do cliente"
                    onChange={(event) => void photo(event.target.files?.[0])}
                  />
                </div>
                <div className="client-profile-info">
                  <div className="client-profile-status">
                    <span
                      className={`client-badge client-tone-${selected.status === "active" ? "green" : selected.status === "lead" ? "sky" : "neutral"}`}
                    >
                      {statusLabels[selected.status]}
                    </span>
                    <span>{stageLabels[selected.stage]}</span>
                    {selected.accessRole && selected.accessRole !== "owner" && (
                      <span>Compartilhado por {selected.createdByName || "membro da equipe"}</span>
                    )}
                  </div>
                  <h2>{selected.name}</h2>
                  <p>
                    <Building2 size={14} />
                    {selected.company || "Cliente individual"}
                    {selected.segment && <span> · {selected.segment}</span>}
                  </p>
                </div>
              </header>
              {photoBusy && (
                <p role="status" className="client-hint">
                  Atualizando foto…
                </p>
              )}
              <div className="client-contact-actions">
                <ContactAction
                  icon={Mail}
                  label="Gmail"
                  value={selected.email}
                  href={gmailUrl(selected.email)}
                  tone="red"
                  onEdit={() => setEditor({ client: selected })}
                />
                <ContactAction
                  icon={MessageCircle}
                  label="WhatsApp"
                  value={selected.phone}
                  href={whatsappUrl(selected.phone)}
                  tone="green"
                  onEdit={() => setEditor({ client: selected })}
                />
              </div>
              <nav
                className="client-detail-tabs"
                aria-label="Seções da ficha"
                role="tablist"
              >
                {(
                  [
                    { id: "overview", label: "Informações", icon: UserRound },
                    {
                      id: "contracts",
                      label: "Contratos",
                      icon: FileSignature,
                    },
                    { id: "documents", label: "Documentos", icon: FileText },
                    { id: "history", label: "Histórico", icon: History },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    id={`client-tab-${id}`}
                    aria-controls="client-detail-panel"
                    onClick={() => setTab(id)}
                  >
                    <Icon size={15} />
                    {label}
                    {id === "documents" && !!selected.attachmentCount && (
                      <span>{selected.attachmentCount}</span>
                    )}
                  </button>
                ))}
              </nav>
              <div
                role="tabpanel"
                aria-labelledby={`client-tab-${tab}`}
                id="client-detail-panel"
                key={`${selected.id}-${tab}`}
              >
                {tab === "overview" && (
                  <div className="client-overview">
                    {onOpenNora && (
                      <section className="client-nora-card">
                        <span><Bot size={22} /></span>
                        <div>
                          <p>Nora para este cliente</p>
                          <h3>Transforme a ficha em próximos passos</h3>
                          <small>Resumo, riscos e documentos usando somente o contexto registrado.</small>
                          <div>
                            <button type="button" onClick={() => askNoraAboutClient()}>Resumo 360°</button>
                            <button type="button" onClick={() => askNoraAboutClient("Identifique riscos, pendências e o próximo contato mais útil")}>Próxima ação</button>
                            <button type="button" onClick={() => askNoraAboutClient("Sugira o documento mais adequado para este momento do relacionamento")}>Sugerir documento</button>
                          </div>
                        </div>
                      </section>
                    )}
                    <dl className="client-details-grid">
                      <Info label="Responsável" value={selected.ownerName} />
                      <Info label="CPF / CNPJ" value={selected.document} />
                      <Info label="Segmento" value={selected.segment} />
                      <Info
                        label="Última atualização"
                        value={dateLabel(selected.updatedAt)}
                      />
                    </dl>
                    <div className="client-next-contact">
                      <span className="client-tone-amber">
                        <CalendarClock size={20} />
                      </span>
                      <div>
                        <h3>Próximo contato</h3>
                        <p>
                          {selected.nextActionAt
                            ? dateLabel(selected.nextActionAt, true)
                            : "Nenhum acompanhamento agendado"}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canEditSelected}
                        onClick={() => setEditor({ client: selected })}
                      >
                        {selected.nextActionAt ? "Alterar" : "Agendar"}
                        <ArrowUpRight size={14} />
                      </Button>
                    </div>
                    <section className="client-notes">
                      <h3>Sobre o cliente</h3>
                      <p>
                        {selected.notes ||
                          "Adicione observações para manter o contexto das próximas conversas."}
                      </p>
                    </section>
                    <section className="client-tags">
                      <h3>
                        <Tag size={14} />
                        Marcadores
                      </h3>
                      {selected.tags.length ? (
                        <div>
                          {selected.tags.map((value) => (
                            <span key={value}>{value}</span>
                          ))}
                        </div>
                      ) : (
                        <p className="client-hint">Sem marcadores</p>
                      )}
                    </section>
                  </div>
                )}
                {tab === "documents" && (
                  <ClientDocuments
                    clientId={selected.id}
                    canEdit={canEditSelected}
                    onCountChange={(count) =>
                      setClients((current) =>
                        current.map((item) =>
                          item.id === selected.id
                            ? { ...item, attachmentCount: count }
                            : item,
                        ),
                      )
                    }
                  />
                )}
                {tab === "contracts" && (
                  <ClientContracts clientId={selected.id} canEdit={canEditSelected} />
                )}
                {tab === "history" && <ClientHistory clientId={selected.id} />}
              </div>
            </>
          ) : (
            <div className="client-welcome">
              <span className="client-welcome-icon">
                <UsersRound size={34} strokeWidth={1.3} />
              </span>
              <h2>Um lugar para cada relacionamento</h2>
              <p>
                Selecione um cliente para ver seus contatos, acompanhar
                contratos e organizar documentos.
              </p>
              <div>
                <span>
                  <MessageCircle size={16} />
                  Contato direto
                </span>
                <span>
                  <FileSignature size={16} />
                  Contratos
                </span>
                <span>
                  <FileText size={16} />
                  Documentos
                </span>
              </div>
              {!clients.length && !loading && (
                <Button
                  className="client-main-action"
                  onClick={() => setEditor({ client: null })}
                >
                  <Plus size={16} />
                  Cadastrar primeiro cliente
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
      {editor && (
        <ClientEditor
          client={editor.client}
          onSave={updateClient}
          onClose={() => setEditor(null)}
        />
      )}
      {accessClient && (
        <ClientAccessDialog
          client={accessClient}
          onClose={() => setAccessClient(null)}
          onSaved={updateClient}
        />
      )}
    </main>
  );
}
function Metric({
  icon: Icon,
  tone,
  value,
  label,
}: {
  icon: typeof UsersRound;
  tone: string;
  value: number;
  label: string;
}) {
  return (
    <article className="client-metric">
      <span className={`client-metric-icon client-tone-${tone}`}>
        <Icon size={18} />
      </span>
      <div>
        <strong>{value}</strong>
        <p>{label}</p>
      </div>
    </article>
  );
}
function Info({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "Não informado"}</dd>
    </div>
  );
}
function ContactAction({
  icon: Icon,
  label,
  value,
  href,
  tone,
  onEdit,
}: {
  icon: typeof Mail;
  label: string;
  value: string;
  href: string | null;
  tone: string;
  onEdit: () => void;
}) {
  const content = (
    <>
      <span className={`client-contact-icon client-tone-${tone}`}>
        <Icon size={18} />
      </span>
      <span>
        <small>{label}</small>
        <strong>
          {value || `Adicionar ${label === "Gmail" ? "e-mail" : "telefone"}`}
        </strong>
      </span>
      <ArrowUpRight size={16} />
    </>
  );
  return href ? (
    <a
      className="client-contact-action"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Abrir ${label} para ${value}`}
    >
      {content}
    </a>
  ) : (
    <button className="client-contact-action" onClick={onEdit}>
      {content}
    </button>
  );
}
function ClientHistory({ clientId }: { clientId: string }) {
  const [data, setData] = useState<Client360 | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void apiRequest<Client360>(`/api/clientes/${clientId}/360`)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [clientId]);
  if (error)
    return (
      <p className="client-error" role="alert">
        {error}
      </p>
    );
  if (!data)
    return (
      <p className="client-empty" role="status">
        Carregando histórico…
      </p>
    );
  return (
    <section className="client-section">
      <header className="client-section-heading">
        <div>
          <h3>Histórico do relacionamento</h3>
          <p>Conversas, entregas e atividades relacionadas ao cliente.</p>
        </div>
      </header>
      <div className="client-history-totals">
        {[
          ["E-mails", data.summary.emails],
          ["Conversas", data.summary.messages],
          ["Tarefas", data.summary.tasks],
          ["Financeiro", data.summary.finance],
          ["Agenda", data.summary.calendar],
          ["Anexos", data.summary.attachments],
          ["Acompanhamentos", data.summary.followUps],
        ].map(([label, value], index) => (
          <span key={String(label)}>
            <strong
              className={`client-tone-${["red", "green", "violet", "sky", "amber", "violet", "green"][index]}`}
            >
              {value}
            </strong>
            {label}
          </span>
        ))}
      </div>
      <div className="client-history-list">
        {data.timeline.map((item) => (
          <button
            key={`${item.type}-${item.id}`}
            disabled={!item.deepLink}
            onClick={() => {
              if (item.deepLink) {
                localStorage.setItem(
                  "norium-deep-link",
                  JSON.stringify(item.deepLink),
                );
                window.dispatchEvent(
                  new CustomEvent("norium:deep-link", {
                    detail: item.deepLink,
                  }),
                );
              }
            }}
          >
            <span className="client-history-mark">
              <CheckCheck size={14} />
            </span>
            <span>
              <strong>{item.title || "Atividade registrada"}</strong>
              <p>{item.description}</p>
              <time>{dateLabel(item.timestamp, true)}</time>
            </span>
            {item.deepLink && <ArrowUpRight size={15} />}
          </button>
        ))}
        {!data.timeline.length && (
          <div className="client-empty">
            <History size={26} />
            <h4>O histórico começa nas próximas interações</h4>
            <p>As atividades vinculadas ao cliente aparecerão aqui.</p>
          </div>
        )}
      </div>
    </section>
  );
}
