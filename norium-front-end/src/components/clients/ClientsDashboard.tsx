import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ClientTagsPanel from "../business/ClientTagsPanel";
import ClientRelationsPanel from "../business/ClientRelationsPanel";
import BusinessDialog from "../business/BusinessDialog";
import ImportPanel from "../business/ImportPanel";
import ClientArchiveDialog from "../business/ClientArchiveDialog";
import ClientViewsPanel, { ClientBulkTags, type ClientFilters } from "../business/ClientViewsPanel";
import { requestScope } from "../../core/api/sessionScope";
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  CalendarClock,
  Camera,
  CheckCheck,
  ChevronRight,
  Download,
  FileSignature,
  FileText,
  History,
  Lock,
  Mail,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  UserRoundCheck,
  UsersRound,
  Wallet,
  X,
} from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { showConfirm } from "../shared/AppDialogProvider";
import NoraAvatar from "../layout/NoraAvatar";
import ClientAvatar from "./ClientAvatar";
import ClientAccessDialog from "./ClientAccessDialog";
import ClientEditor from "./ClientEditor";
import { ClientContracts, ClientDocuments } from "./ClientAssets";
import {
  dateLabel,
  documentLabel,
  gmailUrl,
  phoneLabel,
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

const statusBadge: Record<ClientStatus, string> = {
  active: "is-green",
  lead: "is-blue",
  inactive: "",
};

type DetailTab = "overview" | "contracts" | "documents" | "history";
export default function ClientsDashboard({ onOpenNora }: { onOpenNora?: (prompt?: string) => void }) {
  const scope = requestScope();
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
  const [importOpen, setImportOpen] = useState(false);
  const [archiveMode, setArchiveMode] = useState<ClientFilters["archive"]>("exclude");
  const [archiveClient, setArchiveClient] = useState<{ client: Client; archived: boolean } | null>(null);
  const [advanced, setAdvanced] = useState<Pick<ClientFilters, "stage" | "ownerId" | "tagIds">>({ stage: "all", ownerId: "", tagIds: [] });
  const [taggedIds, setTaggedIds] = useState<Set<string> | null>(null);
  const [tagFilterLoading, setTagFilterLoading] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [tagRevision, setTagRevision] = useState(0);
  useEffect(() => { const refreshTags = () => setTagRevision(value => value+1); window.addEventListener("norium:client-tags-changed", refreshTags); return () => window.removeEventListener("norium:client-tags-changed", refreshTags); }, []);
  const tagSignature = advanced.tagIds.join(",");
  useEffect(() => { setClients([]); setSelectedId(null); setCheckedIds([]); setAdvanced({ stage: "all", ownerId: "", tagIds: [] }); setQuery(""); setFilter("all"); setArchiveMode("exclude"); setArchiveClient(null); setEditor(null); setAccessClient(null); setImportOpen(false); }, [scope]);
  useEffect(() => setCheckedIds([]), [query, filter, archiveMode, advanced.stage, advanced.ownerId, tagSignature]);
  useEffect(() => {
    if (!tagSignature) { setTaggedIds(null); setTagFilterLoading(false); return; }
    const controller = new AbortController(); setTaggedIds(null); setTagFilterLoading(true);
    void apiRequest<{ ids: string[] }>(`/api/business/tagged-clients?tagIds=${encodeURIComponent(tagSignature)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && requestScope() === scope) setTaggedIds(new Set(result.ids)); })
      .catch(reason => { if (!controller.signal.aborted && requestScope() === scope) setError(reason instanceof Error ? reason.message : "Falha ao filtrar etiquetas."); })
      .finally(() => { if (!controller.signal.aborted && requestScope() === scope) setTagFilterLoading(false); });
    return () => controller.abort();
  }, [tagSignature, scope, tagRevision]);
  useEffect(() => { window.dispatchEvent(new CustomEvent("norium:presence-context", { detail: selectedId ? { type: "client", id: selectedId } : null })); return () => { window.dispatchEvent(new CustomEvent("norium:presence-context", { detail: null })); }; }, [selectedId]);
  const photoRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const requestedScope = requestScope();
    setLoading(true);
    setError("");
    try {
      const data = await apiRequest<{ items: Client[] }>("/api/clientes?archived=all");
      if (requestScope() !== requestedScope) return;
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
      if (requestScope() !== requestedScope) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível carregar os clientes.",
      );
    } finally {
      if (requestScope() === requestedScope) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, scope]);
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
  const liveClients = clients.filter(item => !item.archivedAt);
  const filtered = useMemo(() => {
    const simplify = (value: string) =>
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("pt-BR");
    return clients
      .filter(
        (item) =>
          (archiveMode === "all" || !!item.archivedAt === (archiveMode === "only")) &&
          (filter === "all" || item.status === filter) &&
          (advanced.stage === "all" || item.stage === advanced.stage) &&
          (!advanced.ownerId || item.ownerId === advanced.ownerId) &&
          (!tagSignature || !!taggedIds?.has(item.id)) &&
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
  }, [clients, query, filter, sort, archiveMode, advanced.stage, advanced.ownerId, tagSignature, taggedIds]);
  const nextContacts = liveClients.filter(
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
  function exportClients(exportItems: Client[] = filtered) {
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
      ...exportItems.map((item) => [
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
  const shown = Math.min(visible, filtered.length);
  const accessSummary = (client: Client) => {
    if (client.accessRole && client.accessRole !== "owner")
      return `Compartilhado por ${client.createdByName || "membro da equipe"} · você pode ${client.accessRole === "edit" ? "editar" : "visualizar"}`;
    const team = client.access?.teamPermission || "none";
    const people = client.access?.people?.length || 0;
    return [
      team === "none" ? "Só você e as pessoas convidadas" : `Equipe inteira pode ${team === "edit" ? "editar" : "visualizar"}`,
      people ? `${people} ${people === 1 ? "pessoa com acesso individual" : "pessoas com acesso individual"}` : "",
    ].filter(Boolean).join(" · ");
  };
  return (
    <main className="clients-workspace nx-page">
      {!selected && (
        <>
          <div className="nx-ph">
            <div>
              <h1>Clientes</h1>
              <p>
                {liveClients.length} em uso · {clients.length-liveClients.length} arquivados ·{" "}
                {liveClients.filter((item) => item.status === "active").length} ativos
              </p>
            </div>
            <div className="nx-ph-actions">
              {onOpenNora && (
                <button type="button" className="nx-btn" onClick={() => onOpenNora("Ajude-me a analisar minha carteira de clientes e definir prioridades.")}>
                  <Sparkles size={16} />
                  Perguntar à Nora
                </button>
              )}
              <button
                type="button"
                className="nx-btn client-icon-btn"
                title="Atualizar clientes"
                aria-label="Atualizar clientes"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw size={16} />
              </button>
              <button type="button" className="nx-btn" disabled={!filtered.length} onClick={() => exportClients()}>
                <Download size={16} />
                Exportar
              </button>
              <button type="button" className="nx-btn" onClick={() => setImportOpen(true)}>Importar</button>
              <button
                type="button"
                className="nx-btn is-primary"
                onClick={() => setEditor({ client: null })}
              >
                <Plus size={16} />
                Novo cliente
              </button>
            </div>
          </div>
          <div className="nx-kpis">
            <Metric icon={UsersRound} value={liveClients.length} label="Clientes em uso" />
            <Metric
              icon={UserRoundCheck}
              value={liveClients.filter((item) => item.status === "active").length}
              label="Clientes ativos"
            />
            <Metric
              icon={MessageCircle}
              value={liveClients.filter((item) => item.status === "lead").length}
              label="Em prospecção"
            />
            <Metric icon={CalendarClock} value={nextContacts} label="Contatos até os próximos 7 dias" />
          </div>
        </>
      )}
      {error && (
        <div role="alert" className="client-error">
          {error}
        </div>
      )}
      {!selected ? (
        <section className="client-list-section" aria-label="Lista de clientes">
          <div className="client-toolbar">
            <label className="nx-input client-search">
              <Search size={16} />
              <input
                aria-label="Buscar clientes"
                placeholder="Buscar por nome, empresa, CPF/CNPJ ou telefone"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisible(25);
                }}
              />
              {query && (
                <button type="button" aria-label="Limpar busca" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </label>
            <div className="nx-seg" role="group" aria-label="Filtrar por status">
              {(["all", "active", "lead", "inactive"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={filter === value}
                  className={filter === value ? "is-active" : ""}
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
            <label className="nx-input client-sort">
              <span className="nx-faint">Ordenar</span>
              <select
                aria-label="Ordenar clientes"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="recent">Recentes</option>
                <option value="name">Nome A–Z</option>
                <option value="next">Próximo contato</option>
              </select>
            </label>
            <span className="client-count">
              {filtered.length} {filtered.length === 1 ? "cliente" : "clientes"}
            </span>
          </div>
          <ClientViewsPanel clients={clients} value={{ query, status: filter, archive: archiveMode, ...advanced }} onChange={next => { setQuery(next.query); setFilter(next.status); setArchiveMode(next.archive); setAdvanced({ stage: next.stage, ownerId: next.ownerId, tagIds: next.tagIds }); setVisible(25); }} />
          <div className="nx-card client-table-card">
            {loading || tagFilterLoading ? (
              <p className="client-empty" role="status">
                Carregando clientes…
              </p>
            ) : filtered.length ? (
              <table className="nx-table client-table" aria-label="Clientes">
                <thead>
                  <tr>
                    <th><input type="checkbox" aria-label="Selecionar até 100 clientes visíveis" checked={!!filtered.length && filtered.slice(0, Math.min(visible, 100)).every(client => checkedIds.includes(client.id))} onChange={event => setCheckedIds(event.target.checked ? filtered.slice(0, Math.min(visible, 100)).map(client => client.id) : [])} /></th>
                    <th>Cliente</th>
                    <th className="client-col-md">CPF / CNPJ</th>
                    <th className="client-col-sm">Telefone</th>
                    <th>Status</th>
                    <th className="client-col-md">Responsável</th>
                    <th className="client-col-sm">Próximo contato</th>
                    <th aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, visible).map((client) => (
                    <tr key={client.id} onClick={() => select(client.id)}>
                      <td onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar ${client.name}`} checked={checkedIds.includes(client.id)} disabled={!checkedIds.includes(client.id) && checkedIds.length >= 100} onChange={event => setCheckedIds(current => event.target.checked ? [...current, client.id] : current.filter(id => id !== client.id))} /></td>
                      <td>
                        <button
                          type="button"
                          className="client-row-open"
                          aria-pressed={selectedId === client.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            select(client.id);
                          }}
                        >
                          <ClientAvatar client={client} />
                          <span>
                            <strong>{client.name}</strong>
                            {client.archivedAt && <span className="nx-badge">Arquivado</span>}
                            <small>{client.company || client.email || "Cliente individual"}</small>
                          </span>
                        </button>
                      </td>
                      <td className="client-col-md nx-muted">{documentLabel(client.document) || "—"}</td>
                      <td className="client-col-sm nx-muted">{phoneLabel(client.phone) || "—"}</td>
                      <td>
                        <span className={`nx-badge ${statusBadge[client.status]}`}>{statusLabels[client.status]}</span>
                      </td>
                      <td className="client-col-md nx-muted">{client.ownerName || "—"}</td>
                      <td className="client-col-sm nx-muted">{client.nextActionAt ? dateLabel(client.nextActionAt) : "—"}</td>
                      <td className="nx-faint client-col-arrow"><ChevronRight size={16} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="client-empty">
                <Search size={24} />
                <h4>
                  {archiveMode === "only" && !query && filter === "all" ? "Nenhum cliente arquivado" : query || filter !== "all" || archiveMode !== "exclude"
                    ? "Nenhum resultado"
                    : "Sua carteira começa aqui"}
                </h4>
                <p>
                  {archiveMode === "only" && !query && filter === "all" ? "Os cadastros arquivados aparecerão aqui para consulta e restauração." : query || filter !== "all" || archiveMode !== "exclude"
                    ? "Ajuste a busca ou os filtros."
                    : "Cadastre um cliente para organizar os contatos, contratos e documentos."}
                </p>
                {!clients.length && (
                  <button type="button" className="nx-btn is-primary" onClick={() => setEditor({ client: null })}>
                    <Plus size={16} />
                    Cadastrar primeiro cliente
                  </button>
                )}
              </div>
            )}
          </div>
          {!loading && filtered.length > 0 && (
            <div className="client-pager">
              <span>Mostrando 1–{shown} de {filtered.length}</span>
              {visible < filtered.length && (
                <button type="button" className="nx-btn is-sm" onClick={() => setVisible((value) => value + 25)}>
                  Carregar mais clientes
                </button>
              )}
            </div>
          )}
          {checkedIds.some(id => clients.some(client => client.id === id)) && <ClientBulkTags ids={checkedIds.filter(id => clients.some(client => client.id === id))} clients={clients} onUpdated={() => void load()} onExport={() => exportClients(clients.filter(client => checkedIds.includes(client.id)))} onClear={() => setCheckedIds([])} canEdit={clients.filter(client => checkedIds.includes(client.id)).every(client => client.accessRole !== "view")} />}
        </section>
      ) : (
        <section className="client-detail" aria-label="Ficha do cliente">
          <div className="client-detail-top">
            <button type="button" className="nx-btn is-ghost is-sm" onClick={() => select(null)}>
              <ArrowLeft size={15} />
              <span>Clientes</span>
            </button>
            <div>
              {canEditSelected && (
                <button
                  type="button"
                  className="nx-btn is-sm"
                  disabled={photoBusy}
                  onClick={() => setEditor({ client: selected })}
                >
                  <Pencil size={14} />
                  Editar
                </button>
              )}
              {canEditSelected && (
                <button type="button" className="nx-btn is-sm" disabled={photoBusy} onClick={() => setArchiveClient({ client: selected, archived: !selected.archivedAt })}>
                  {selected.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}{selected.archivedAt ? "Restaurar" : "Arquivar"}
                </button>
              )}
              {canShareSelected && (
                <button
                  type="button"
                  className="nx-btn is-sm is-ghost client-danger"
                  disabled={photoBusy}
                  aria-label="Excluir cliente"
                  title="Excluir cliente"
                  onClick={() => void remove(selected)}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          </div>
          <div className="client-ficha">
            <div className="nx-card client-profile">
              <div className="client-profile-id">
                <div className="client-photo-control">
                  <button
                    type="button"
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
                      <Camera size={12} />
                    </span>
                  </button>
                  {selected.avatarId && canEditSelected && (
                    <button
                      type="button"
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
                <div className="nx-grow">
                  <h2>{selected.name}</h2>
                  <p className="nx-faint nx-small">
                    {selected.company || "Cliente individual"}
                    {selected.segment && ` · ${selected.segment}`}
                  </p>
                </div>
              </div>
              {photoBusy && (
                <p role="status" className="client-hint">
                  Atualizando foto…
                </p>
              )}
              <div className="client-badges">
                <span className={`nx-badge ${statusBadge[selected.status]}`}>{statusLabels[selected.status]}</span>
                {selected.archivedAt && <span className="nx-badge">Arquivado em {dateLabel(selected.archivedAt)}</span>}
                <span className="nx-badge">{stageLabels[selected.stage]}</span>
                {selected.accessRole && selected.accessRole !== "owner" && (
                  <span className="nx-badge is-violet">Compartilhado por {selected.createdByName || "membro da equipe"}</span>
                )}
              </div>
              <div className="client-contact-actions">
                <ContactAction
                  icon={MessageCircle}
                  label="WhatsApp"
                  value={selected.phone}
                  href={whatsappUrl(selected.phone)}
                  onEdit={() => setEditor({ client: selected })}
                />
                <ContactAction
                  icon={Mail}
                  label="Gmail"
                  value={selected.email}
                  href={gmailUrl(selected.email)}
                  onEdit={() => setEditor({ client: selected })}
                />
              </div>
              <dl className="client-info">
                <Info label="CPF / CNPJ" value={documentLabel(selected.document)} />
                <Info label="Telefone" value={phoneLabel(selected.phone)} />
                <Info label="E-mail" value={selected.email} />
                <Info label="Responsável" value={selected.ownerName} />
                <Info
                  label="Próximo contato"
                  value={selected.nextActionAt ? dateLabel(selected.nextActionAt, true) : ""}
                />
                <Info label="Segmento" value={selected.segment} />
              </dl>
              <ClientTagsPanel key={selected.id} clientId={selected.id} canEdit={canEditSelected} />
              <ClientRelationsPanel key={`relations-${selected.id}`} clientId={selected.id} canEdit={canEditSelected} />
              <section className="client-block">
                <h3>Sobre</h3>
                <p className="client-notes">
                  {selected.notes ||
                    "Adicione observações para manter o contexto das próximas conversas."}
                </p>
              </section>
              <section className="client-block">
                <h3>
                  <Tag size={14} />
                  Marcadores
                </h3>
                {selected.tags.length ? (
                  <div className="client-badges">
                    {selected.tags.map((value) => (
                      <span className="nx-badge" key={value}>{value}</span>
                    ))}
                  </div>
                ) : (
                  <p className="client-hint">Sem marcadores</p>
                )}
              </section>
            </div>

            <div className="nx-card client-center">
              <nav
                className="nx-tabs client-detail-tabs"
                aria-label="Seções da ficha"
                role="tablist"
              >
                {(
                  [
                    { id: "overview", label: "Visão geral" },
                    { id: "history", label: "Linha do tempo" },
                    { id: "contracts", label: "Contratos" },
                    { id: "documents", label: "Documentos" },
                  ] as const
                ).map(({ id, label }) => (
                  <button
                    type="button"
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    className={`nx-tab${tab === id ? " is-active" : ""}`}
                    id={`client-tab-${id}`}
                    aria-controls="client-detail-panel"
                    onClick={() => setTab(id)}
                  >
                    {label}
                    {id === "documents" && !!selected.attachmentCount && (
                      <span className="nx-badge">{selected.attachmentCount}</span>
                    )}
                  </button>
                ))}
              </nav>
              <div
                role="tabpanel"
                aria-labelledby={`client-tab-${tab}`}
                id="client-detail-panel"
                className="client-panel"
                key={`${selected.id}-${tab}`}
              >
                {tab === "overview" && (
                  <div className="client-overview">
                    <div className="nx-row">
                      <span className="client-row-icon is-amber"><CalendarClock size={16} /></span>
                      <div className="nx-grow">
                        <div className="nx-row-t">Próximo contato</div>
                        <div className="nx-row-sub">
                          {selected.nextActionAt
                            ? dateLabel(selected.nextActionAt, true)
                            : "Nenhum acompanhamento agendado"}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="nx-btn is-sm"
                        disabled={!canEditSelected}
                        onClick={() => setEditor({ client: selected })}
                      >
                        {selected.nextActionAt ? "Alterar" : "Agendar"}
                        <ArrowUpRight size={14} />
                      </button>
                    </div>
                    <div className="nx-row">
                      <span className="client-row-icon is-blue"><History size={16} /></span>
                      <div className="nx-grow">
                        <div className="nx-row-t">Linha do tempo</div>
                        <div className="nx-row-sub">Conversas, e-mails, tarefas e pagamentos ligados ao cliente</div>
                      </div>
                      <button type="button" className="nx-btn is-sm is-ghost" onClick={() => setTab("history")}>
                        Ver histórico
                      </button>
                    </div>
                    <div className="nx-row">
                      <span className="client-row-icon is-violet"><FileSignature size={16} /></span>
                      <div className="nx-grow">
                        <div className="nx-row-t">Contratos</div>
                        <div className="nx-row-sub">Contratos vinculados a este cliente</div>
                      </div>
                      <button type="button" className="nx-btn is-sm is-ghost" onClick={() => setTab("contracts")}>
                        Ver contratos
                      </button>
                    </div>
                    <div className="nx-row">
                      <span className="client-row-icon is-green"><FileText size={16} /></span>
                      <div className="nx-grow">
                        <div className="nx-row-t">Documentos</div>
                        <div className="nx-row-sub">
                          {selected.attachmentCount
                            ? `${selected.attachmentCount} ${selected.attachmentCount === 1 ? "documento anexado" : "documentos anexados"}`
                            : "Nenhum documento anexado"}
                        </div>
                      </div>
                      <button type="button" className="nx-btn is-sm is-ghost" onClick={() => setTab("documents")}>
                        Ver documentos
                      </button>
                    </div>
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
            </div>

            <div className="client-aside">
              {onOpenNora && (
                <section className="nx-card client-side-card">
                  <div className="client-side-h">
                    <NoraAvatar className="rounded-full" />
                    <b>Nora · visão 360°</b>
                  </div>
                  <p className="nx-muted nx-small">
                    Resumo, riscos, próximo passo e documento sugerido usando somente o que está registrado nesta ficha.
                  </p>
                  <div className="client-side-actions">
                    <button type="button" className="nx-btn is-sm is-primary" onClick={() => askNoraAboutClient()}>Resumo 360°</button>
                    <button type="button" className="nx-btn is-sm" onClick={() => askNoraAboutClient("Identifique riscos, pendências e o próximo contato mais útil")}>Próxima ação</button>
                    <button type="button" className="nx-btn is-sm" onClick={() => askNoraAboutClient("Sugira o documento mais adequado para este momento do relacionamento")}>Sugerir documento</button>
                  </div>
                </section>
              )}
              <section className="nx-card client-side-card">
                <b className="client-side-title">Números</b>
                <div className="client-num"><span className="nx-muted">Status</span><b>{statusLabels[selected.status]}</b></div>
                <div className="client-num"><span className="nx-muted">Etapa</span><b>{stageLabels[selected.stage]}</b></div>
                <div className="client-num"><span className="nx-muted">Documentos</span><b>{selected.attachmentCount || 0}</b></div>
                <div className="client-num"><span className="nx-muted">Última atualização</span><b>{dateLabel(selected.updatedAt)}</b></div>
              </section>
              <section className="nx-card client-side-card">
                <b className="client-side-title">Acesso</b>
                <p className="nx-muted nx-small">{accessSummary(selected)}</p>
                {canShareSelected && (
                  <button
                    type="button"
                    className="nx-btn is-sm client-side-btn"
                    onClick={() => setAccessClient(selected)}
                  >
                    <Lock size={14} />
                    Compartilhar
                  </button>
                )}
              </section>
            </div>
          </div>
        </section>
      )}
      {editor && (
        <ClientEditor
          client={editor.client}
          onSave={updateClient}
          onClose={() => setEditor(null)}
        />
      )}
      {importOpen && <BusinessDialog title="Importar clientes" onClose={() => setImportOpen(false)}><ImportPanel target="clients" onComplete={() => void load()} /></BusinessDialog>}
      {archiveClient && <ClientArchiveDialog clients={[archiveClient.client]} archived={archiveClient.archived} onComplete={() => void load()} onClose={() => setArchiveClient(null)} />}
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
  value,
  label,
}: {
  icon: typeof UsersRound;
  value: number;
  label: string;
}) {
  return (
    <article className="nx-card nx-kpi">
      <div className="nx-kpi-l">
        <Icon size={16} />
        {label}
      </div>
      <div className="nx-kpi-v">{value}</div>
    </article>
  );
}
function Info({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || "Não informado"}</dd>
    </>
  );
}
function ContactAction({
  icon: Icon,
  label,
  value,
  href,
  onEdit,
}: {
  icon: typeof Mail;
  label: string;
  value: string;
  href: string | null;
  onEdit: () => void;
}) {
  const text = label === "Gmail" ? "E-mail" : label;
  return href ? (
    <a
      className="nx-btn is-sm"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Abrir ${label} para ${value}`}
      title={value}
    >
      <Icon size={14} />
      {text}
    </a>
  ) : (
    <button type="button" className="nx-btn is-sm" onClick={onEdit} title={`Adicionar ${label === "Gmail" ? "e-mail" : "telefone"}`}>
      <Icon size={14} />
      {`Adicionar ${label === "Gmail" ? "e-mail" : "telefone"}`}
    </button>
  );
}
const historyIcon = (type: string) =>
  /mail|email/i.test(type) ? Mail
    : /message|whats|chat|conversa/i.test(type) ? MessageCircle
      : /finan|pag|wallet/i.test(type) ? Wallet
        : /calend|agenda|event/i.test(type) ? CalendarClock
          : /attach|file|doc/i.test(type) ? FileText
            : CheckCheck;
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
      <div className="client-history-totals">
        {[
          ["E-mails", data.summary.emails],
          ["Conversas", data.summary.messages],
          ["Tarefas", data.summary.tasks],
          ["Financeiro", data.summary.finance],
          ["Agenda", data.summary.calendar],
          ["Anexos", data.summary.attachments],
          ["Acompanhamentos", data.summary.followUps],
        ].map(([label, value]) => (
          <span className="nx-badge" key={String(label)}>
            {label} <b>{value}</b>
          </span>
        ))}
      </div>
      <div className="client-history-list">
        {data.timeline.map((item) => {
          const Icon = historyIcon(item.type);
          return (
            <button
              type="button"
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
                <Icon size={15} />
              </span>
              <span className="nx-grow">
                <strong>{item.title || "Atividade registrada"}</strong>
                <p>{item.description}</p>
              </span>
              <time>{dateLabel(item.timestamp, true)}</time>
              {item.deepLink && <ArrowUpRight size={15} className="nx-faint" />}
            </button>
          );
        })}
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
