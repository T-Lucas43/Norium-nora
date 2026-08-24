import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import SidebarEsquerda from "./SidebarEsquerda";
import AreaCentralChat from "./AreaCentralChat";
import PainelDireito from "./PainelDireito";
import WhatsAppDirectory from "./WhatsAppDirectory";
import WhatsAppProfileView from "./WhatsAppProfileView";
import WhatsAppRail, { type WhatsAppSection } from "./WhatsAppRail";
import WhatsAppStatusView from "./WhatsAppStatusView";
import { Menu, X, Search, User, Send } from "lucide-react";
import type { AnexoPendente, ChatConversa, MsgConteudo, ParticipanteGrupo } from "./types";
import { apiBaseUrl } from "../../utils/api";
import StatusBanner from "../shared/StatusBanner";
import ConfirmDialog from "../shared/ConfirmDialog";
import Button from "../shared/Button";
import {
  whatsappApi,
  type Contact,
  type ConsentInfo,
  type WhatsAppConnection,
  type WhatsAppProfile,
  type WhatsAppStatusItem,
  type WhatsAppSyncProgress,
} from "./whatsappApi";
import { apiBlobRequest } from "../../core/api/client";
import {
  contactConversationId,
  contactDisplayName,
  contactGroupPhone,
  contactMatchesSearch,
  contactToConversation,
  enrichConversationsWithContacts,
  mergeContactCatalog,
  mergeConversationCatalog,
  mergeConversationDetails,
  mergeMessages,
  whatsappIdentifierKeys,
} from "./contactPicker";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";

const BACKEND_URL = apiBaseUrl();

interface ChatCentralProps {
  userId?: string;
  onConversaAtivaChange?: (conversaId: string | null) => void;
  onOpenNora?: (prompt?: string) => void;
}

function ContactAvatar({ contact }: { contact: Contact }) {
  const [failed, setFailed] = useState(false);
  const photoUrl = useAuthenticatedMedia(contact.photoUrl);
  const initials = contactDisplayName(contact)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--background)] flex items-center justify-center text-[var(--text-secondary)]">
      {photoUrl && !failed
        ? <img src={photoUrl} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
        : initials ? <span className="text-[10px] font-extrabold">{initials}</span> : <User size={14} />}
    </div>
  );
}

function normalizarProgressoSincronizacao(value?: Partial<WhatsAppSyncProgress> | null): WhatsAppSyncProgress {
  const raw = (value || {}) as Partial<WhatsAppSyncProgress> & Record<string, any>;
  const rawStatus = String(raw.status || raw.situacao || "syncing").toLowerCase();
  const status: WhatsAppSyncProgress["status"] = ["complete", "completed", "concluido", "concluído", "completo"].includes(rawStatus)
    ? "complete"
    : ["partial", "parcial", "completed_with_warnings", "concluido_com_avisos"].includes(rawStatus)
      ? "partial"
    : ["error", "erro", "failed", "falha"].includes(rawStatus)
      ? "error"
      : ["idle", "ocioso"].includes(rawStatus) ? "idle" : "syncing";
  return {
    status,
    phase: raw.phase || raw.etapa,
    progress: Math.max(0, Math.min(100, Number(raw.progress ?? raw.progresso ?? raw.percentual ?? (status === "complete" ? 100 : 0)))),
    current: raw.current ?? raw.atual,
    total: raw.total,
    message: raw.message || raw.mensagem,
    contactsSynced: raw.contactsSynced ?? raw.contatosSincronizados,
    photosSynced: raw.photosSynced ?? raw.fotosSincronizadas,
    requiresPro: normalizarBooleanWhatsApp(raw.requiresPro ?? raw.requires_pro ?? raw.exigePro),
    reconnectRequired: normalizarBooleanWhatsApp(raw.reconnectRequired ?? raw.reconnect_required ?? raw.requerReconexao),
    catalogWarnings: Array.isArray(raw.catalogWarnings ?? raw.catalog_warnings ?? raw.warnings ?? raw.avisosCatalogo)
      ? (raw.catalogWarnings ?? raw.catalog_warnings ?? raw.warnings ?? raw.avisosCatalogo).map((warning: unknown) => String(warning)).filter(Boolean)
      : [],
  };
}

function normalizarBooleanWhatsApp(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["1", "true", "yes", "sim"].includes(value.trim().toLowerCase());
  return false;
}

function normalizarStatusWhatsApp(value: unknown): WhatsAppStatusItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, any>;
  const id = String(raw.id || raw.statusId || raw.messageId || "").trim();
  if (!id) return null;
  const rawType = String(raw.type || raw.kind || raw.mediaType || "text").toLowerCase();
  const type: WhatsAppStatusItem["type"] = rawType.includes("video") ? "video" : rawType.includes("image") || rawType.includes("photo") ? "image" : "text";
  const fallbackName = raw.contactId || raw.chatId ? "Contato do WhatsApp" : "Status do WhatsApp";
  const rawTimestamp = raw.timestamp || raw.createdAt || Date.now();
  const numericTimestamp = Number(rawTimestamp);
  const timestamp = Number.isFinite(numericTimestamp) ? numericTimestamp : new Date(rawTimestamp).getTime();
  return {
    id,
    contactId: raw.contactId || raw.chatId,
    name: String(raw.name || raw.contactName || raw.notify || raw.verifiedName || fallbackName),
    photoUrl: raw.photoUrl || raw.profilePictureUrl,
    type,
    text: raw.text || raw.caption || raw.body,
    mediaUrl: raw.mediaUrl || raw.fileUrl || raw.url,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    viewed: normalizarBooleanWhatsApp(raw.viewed ?? raw.visualizado),
    mine: normalizarBooleanWhatsApp(raw.mine ?? raw.fromMe),
    color: raw.color || raw.backgroundColor,
  };
}

function normalizarGrupoWhatsApp(value: unknown): ChatConversa | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, any>;
  const metadata = raw.metadados && typeof raw.metadados === "object" ? raw.metadados : {};
  const id = String(raw.id || raw.groupId || raw.jid || "").trim();
  if (!id) return null;
  const participantSource = Array.isArray(metadata.participantes)
    ? metadata.participantes
    : Array.isArray(raw.participants) ? raw.participants : [];
  const participants = participantSource.map((participant: Record<string, any>) => ({
    id: String(participant.id || participant.phone || participant.jid || ""),
    phone: String(participant.phone || participant.id || participant.jid || ""),
    name: participant.name || participant.savedName || participant.contactName || participant.notify || participant.pushname || participant.displayName || participant.verifiedName,
    isAdmin: normalizarBooleanWhatsApp(participant.isAdmin ?? participant.admin) || ["admin", "superadmin"].includes(String(participant.admin || participant.role || "").toLowerCase()),
    isSuperAdmin: normalizarBooleanWhatsApp(participant.isSuperAdmin ?? participant.superAdmin) || String(participant.admin || participant.role || "").toLowerCase() === "superadmin",
    photoUrl: participant.photoUrl || participant.profilePictureUrl,
  })).filter((participant: { id: string }) => Boolean(participant.id));
  const name = String(raw.contato || raw.name || raw.subject || metadata.verifiedName || "Grupo do WhatsApp");
  return {
    id,
    contato: name,
    canal: "whatsapp",
    channel: "whatsapp",
    ultimoTexto: String(raw.ultimoTexto || raw.lastMessage?.text || raw.lastMessage?.body || ""),
    horario: String(raw.horario || ""),
    timestampUltimaMsg: Number(raw.timestampUltimaMsg || raw.timestamp || raw.lastMessage?.timestamp || 0),
    lida: raw.lida !== false,
    naoLidasCount: Number(raw.naoLidasCount || raw.unreadCount || 0),
    fixada: normalizarBooleanWhatsApp(raw.fixada),
    favorita: normalizarBooleanWhatsApp(raw.favorita),
    silenciada: normalizarBooleanWhatsApp(raw.silenciada),
    arquivada: normalizarBooleanWhatsApp(raw.arquivada),
    esGrupo: true,
    mensagens: Array.isArray(raw.mensagens) ? raw.mensagens : [],
    photoUrl: raw.photoUrl || raw.profilePictureUrl || metadata.photoUrl,
    metadados: {
      ...metadata,
      numeroCompleto: String(metadata.numeroCompleto || id),
      statusOnline: false,
      photoUrl: metadata.photoUrl || raw.photoUrl || raw.profilePictureUrl,
      participantes: participants,
      descricaoGrupo: metadata.descricaoGrupo || raw.description || raw.desc,
      criadoPor: metadata.criadoPor || raw.owner || raw.createdBy,
      criadoEm: metadata.criadoEm || raw.createdAt || raw.creation,
    },
  };
}

export default function ChatCentral({ userId = "primary", onConversaAtivaChange, onOpenNora }: ChatCentralProps) {
  const [loadingStatus, setLoadingStatus] = useState<boolean>(true);
  const [canaisStatus, setCanaisStatus] = useState<{ whatsapp?: WhatsAppConnection }>({});
  const [canalSelecionadoLogin, setCanalSelecionadoLogin] = useState<"whatsapp" | null>(null);
  const [qrCodeString, setQrCodeString] = useState<string | null>(null);
  const [erroLogin, setErroLogin] = useState<string | null>(null);
  const [mensagemLogin, setMensagemLogin] = useState<string | null>(null);
  const [consentInfo, setConsentInfo] = useState<ConsentInfo | null>(null);
  const [consentChecked, setConsentChecked] = useState<boolean>(false);
  const [aceitandoConsent, setAceitandoConsent] = useState<boolean>(false);

  const [conversas, setConversas] = useState<ChatConversa[]>([]);
  const [secaoWhatsApp, setSecaoWhatsApp] = useState<WhatsAppSection>("conversations");
  const [conversaSelecionada, setConversaSelecionada] = useState<string | null>(null);
  const [painelPerfilAberto, setPainelPerfilAberto] = useState<boolean>(false);
  const [abaDireitaModo, setAbaDireitaModo] = useState<"nora" | "perfil" | "config-propria">("nora");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const [modalContatosAberto, setModalContatosAberto] = useState<boolean>(false);
  const [modalGrupoAberto, setModalGrupoAberto] = useState<boolean>(false);
  const [modalConfigAberto, setModalConfigAberto] = useState<boolean>(false);
  const [listaContatos, setListaContatos] = useState<Contact[]>([]);
  const [filtroContatoNome, setFiltroContatoNome] = useState<string>("");
  const [carregandoContatos, setCarregandoContatos] = useState(false);
  const [contatosCarregados, setContatosCarregados] = useState(false);
  const [erroContatos, setErroContatos] = useState<string | null>(null);
  const [grupos, setGrupos] = useState<ChatConversa[]>([]);
  const [carregandoGrupos, setCarregandoGrupos] = useState(false);
  const [gruposCarregados, setGruposCarregados] = useState(false);
  const [erroGrupos, setErroGrupos] = useState<string | null>(null);
  const [perfilWhatsApp, setPerfilWhatsApp] = useState<WhatsAppProfile | null>(null);
  const [progressoSincronizacao, setProgressoSincronizacao] = useState<WhatsAppSyncProgress | null>(null);
  const [statusWhatsApp, setStatusWhatsApp] = useState<WhatsAppStatusItem[]>([]);
  const [statusSelecionado, setStatusSelecionado] = useState<string | null>(null);
  const [carregandoStatusWhatsApp, setCarregandoStatusWhatsApp] = useState(false);
  const [statusWhatsAppCarregados, setStatusWhatsAppCarregados] = useState(false);
  const [erroStatusWhatsApp, setErroStatusWhatsApp] = useState<string | null>(null);

  const [nomeNovoGrupo, setNomeNovoGrupo] = useState("");
  const [contatosSelecionadosGrupo, setContatosSelecionadosGrupo] = useState<string[]>([]);
  const [criandoGrupo, setCriandoGrupo] = useState(false);

  const [gravando, setGravando] = useState<boolean>(false);
  const [tempoGravacao, setTempoGravacao] = useState<number>(0);
  const [anexosPendentes, setAnexosPendentes] = useState<AnexoPendente[]>([]);
  const [enviandoAnexos, setEnviandoAnexos] = useState<boolean>(false);
  const [statusMicrofone, setStatusMicrofone] = useState<"idle" | "solicitando" | "liberado" | "negado">("idle");
  const [aviso, setAviso] = useState<{ tone: "error" | "info" | "success"; texto: string } | null>(null);
  const [conversaParaExcluir, setConversaParaExcluir] = useState<string | null>(null);
  const [excluindoConversa, setExcluindoConversa] = useState(false);
  const [modalEncaminharAberto, setModalEncaminharAberto] = useState(false);
  const [mensagensParaEncaminhar, setMensagensParaEncaminhar] = useState<string[]>([]);
  const [destinoEncaminhar, setDestinoEncaminhar] = useState<string | null>(null);
  const [encaminhando, setEncaminhando] = useState(false);
  const [historicoCarregandoId, setHistoricoCarregandoId] = useState<string | null>(null);
  const [sincronizandoCatalogo, setSincronizandoCatalogo] = useState(false);
  const [syncPollVersion, setSyncPollVersion] = useState(0);
  const [confirmarDesconexaoAberta, setConfirmarDesconexaoAberta] = useState(false);
  const [desconectando, setDesconectando] = useState(false);
  const avisoTimeoutRef = useRef<number | null>(null);
  const arquivoInputRef = useRef<HTMLInputElement>(null);
  const figurinhaInputRef = useRef<HTMLInputElement>(null);
  const anexosPendentesRef = useRef<AnexoPendente[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const audioMimeRef = useRef<string>("audio/webm");
  const cancelarEnvioAudioRef = useRef<boolean>(false);
  const carregandoConversasRef = useRef(false);
  const carregandoStatusRef = useRef(false);
  const cursorConversasRef = useRef(0);
  const whatsappConectadoRef = useRef(false);
  const conversasRef = useRef<ChatConversa[]>([]);
  const contatosRef = useRef<Contact[]>([]);
  const syncStatusRef = useRef<WhatsAppSyncProgress["status"]>("idle");
  const syncCompletionHandledRef = useRef(false);
  const syncShowSuccessRef = useRef(false);
  const catalogoInicialTentadoRef = useRef(false);
  const historicoRef = useRef(new Map<string, { cursor: number | null; hasMore: boolean }>());

  const mostrarAviso = useCallback((tone: "error" | "info" | "success", texto: string) => {
    if (avisoTimeoutRef.current) window.clearTimeout(avisoTimeoutRef.current);
    setAviso({ tone, texto });
    avisoTimeoutRef.current = window.setTimeout(() => setAviso(null), 5000);
  }, []);

  const formatarTempo = (segundos: number): string => {
    const mins = Math.floor(segundos / 60);
    const secs = segundos % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const carregarConversasDoBackend = useCallback(async (
    incremental = false,
    refresh = false,
    mostrarErro = true,
  ) => {
    if (carregandoConversasRef.current) return null;
    carregandoConversasRef.current = true;
    try {
      // Inclui novamente o ultimo segundo para nao perder duas mensagens que
      // tenham chegado com o mesmo timestamp. O merge por ID remove repeticoes.
      const since = incremental && cursorConversasRef.current > 0
        ? Math.max(0, cursorConversasRef.current - 1)
        : undefined;
      const payload = await whatsappApi.conversations(since, refresh);
      const data = Array.isArray(payload) ? payload : payload.items;
      const nextCursor = Array.isArray(payload)
        ? Math.max(0, ...data.map((item) => Number(item.timestampUltimaMsg || 0)))
        : Number(payload.cursor || cursorConversasRef.current);
      cursorConversasRef.current = Math.max(cursorConversasRef.current, nextCursor);
      setConversas((current) => {
        return mergeConversationCatalog(current, data, contatosRef.current).sort(
          (left, right) => Number(right.timestampUltimaMsg || 0) - Number(left.timestampUltimaMsg || 0),
        );
      });
      return data;
    } catch (err) {
      if (mostrarErro) {
        mostrarAviso("error", err instanceof Error ? err.message : "Falha ao carregar conversas.");
      }
      return null;
    } finally {
      carregandoConversasRef.current = false;
    }
  }, [mostrarAviso]);

  const carregarContatosDoBackend = useCallback(async (mostrarErro = true) => {
    setCarregandoContatos(true);
    setErroContatos(null);
    try {
      const contacts = await whatsappApi.contacts();
      const mergedContacts = mergeContactCatalog(contatosRef.current, contacts, conversasRef.current);
      contatosRef.current = mergedContacts;
      setListaContatos(mergedContacts);
      setConversas((current) => enrichConversationsWithContacts(current, mergedContacts));
      return mergedContacts;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao carregar contatos.";
      setErroContatos(message);
      if (mostrarErro) mostrarAviso("error", message);
      return null;
    } finally {
      setContatosCarregados(true);
      setCarregandoContatos(false);
    }
  }, [mostrarAviso]);

  const carregarGruposDoBackend = useCallback(async (mostrarErro = true) => {
    setCarregandoGrupos(true);
    setErroGrupos(null);
    try {
      const payload = await whatsappApi.groups();
      const rawItems = Array.isArray(payload) ? payload : payload.items;
      const items = (rawItems || []).map(normalizarGrupoWhatsApp).filter((item): item is ChatConversa => Boolean(item));
      setGrupos(items);
      return items;
    } catch (error) {
      const cachedGroups = conversasRef.current.filter((conversation) => conversation.esGrupo);
      setGrupos(cachedGroups);
      if (cachedGroups.length === 0) {
        const message = error instanceof Error ? error.message : "Falha ao carregar grupos.";
        setErroGrupos(message);
        if (mostrarErro) mostrarAviso("error", message);
      }
      return cachedGroups;
    } finally {
      setGruposCarregados(true);
      setCarregandoGrupos(false);
    }
  }, [mostrarAviso]);

  const carregarPerfilWhatsApp = useCallback(async () => {
    try {
      const payload = await whatsappApi.profile();
      const profile = "profile" in payload ? payload.profile : payload;
      setPerfilWhatsApp(profile);
      return profile;
    } catch {
      const phone = canaisStatus.whatsapp?.numero || undefined;
      const fallback = { name: phone || "Meu WhatsApp", phone };
      setPerfilWhatsApp((current) => current || fallback);
      return fallback;
    }
  }, [canaisStatus.whatsapp?.numero]);

  const carregarStatusDoBackend = useCallback(async (mostrarErro = true, background = false) => {
    if (carregandoStatusRef.current) return null;
    carregandoStatusRef.current = true;
    if (!background) setCarregandoStatusWhatsApp(true);
    if (!background) setErroStatusWhatsApp(null);
    try {
      const payload = await whatsappApi.statuses();
      const rawItems = Array.isArray(payload) ? payload : payload.items;
      const items = (rawItems || []).map(normalizarStatusWhatsApp).filter((item): item is WhatsAppStatusItem => Boolean(item));
      setStatusWhatsApp(items);
      return items;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao carregar os status do WhatsApp.";
      if (!background) setErroStatusWhatsApp(message);
      if (mostrarErro) mostrarAviso("error", message);
      return null;
    } finally {
      setStatusWhatsAppCarregados(true);
      if (!background) setCarregandoStatusWhatsApp(false);
      carregandoStatusRef.current = false;
    }
  }, [mostrarAviso]);

  const recarregarCatalogosAposSync = useCallback(async (refreshConversations = true) => {
    const [loadedConversations, contacts, loadedGroups] = await Promise.all([
      carregarConversasDoBackend(false, refreshConversations),
      carregarContatosDoBackend(false),
      carregarGruposDoBackend(false),
      carregarPerfilWhatsApp(),
      carregarStatusDoBackend(false, true),
    ]);
    const currentConversations = loadedConversations?.length ? loadedConversations : conversasRef.current;
    const mergedContacts = mergeContactCatalog(contatosRef.current, contacts || [], currentConversations);
    contatosRef.current = mergedContacts;
    setListaContatos(mergedContacts);
    setConversas((current) => enrichConversationsWithContacts(current, mergedContacts));
    return { contacts: contacts || [], groups: loadedGroups || [] };
  }, [carregarContatosDoBackend, carregarConversasDoBackend, carregarGruposDoBackend, carregarPerfilWhatsApp, carregarStatusDoBackend]);

  const forcarSincronizacaoCatalogo = useCallback(async (mostrarSucesso = false) => {
    setSincronizandoCatalogo(true);
    setSyncPollVersion((current) => current + 1);
    syncShowSuccessRef.current = mostrarSucesso;
    syncCompletionHandledRef.current = false;
    setProgressoSincronizacao({ status: "syncing", phase: "Preparando", progress: 1, message: "Preparando a sincronização do WhatsApp" });
    try {
      if (typeof whatsappApi.startSync !== "function") {
        const loaded = await recarregarCatalogosAposSync();
        const complete: WhatsAppSyncProgress = {
          status: "complete",
          phase: "Concluído",
          progress: 100,
          message: "Contatos, fotos e conversas sincronizados",
          contactsSynced: loaded.contacts.length,
          photosSynced: loaded.contacts.filter((contact) => Boolean(contact.photoUrl)).length,
        };
        syncStatusRef.current = "complete";
        syncCompletionHandledRef.current = true;
        setProgressoSincronizacao(complete);
        setSincronizandoCatalogo(false);
        if (mostrarSucesso) mostrarAviso("success", `${loaded.contacts.length} contatos e ${loaded.groups.length} grupos atualizados.`);
        return true;
      }

      const started = normalizarProgressoSincronizacao(await whatsappApi.startSync());
      syncStatusRef.current = started.status;
      setProgressoSincronizacao(started);
      if (started.status === "complete" || started.status === "partial") {
        const loaded = await recarregarCatalogosAposSync(started.status === "complete");
        syncCompletionHandledRef.current = true;
        setSincronizandoCatalogo(false);
        if (mostrarSucesso) {
          mostrarAviso(
            started.status === "partial" ? "info" : "success",
            started.status === "partial"
              ? started.message || "O cache disponível foi carregado, mas parte do catálogo precisa ser atualizada novamente."
              : `${loaded.contacts.length} contatos e ${loaded.groups.length} grupos atualizados.`,
          );
        }
      } else if (started.status === "error") {
        setSincronizandoCatalogo(false);
      }
      return started.status !== "error";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao sincronizar o WhatsApp.";
      syncStatusRef.current = "error";
      setProgressoSincronizacao((current) => ({ ...normalizarProgressoSincronizacao(current), status: "error", message }));
      setSincronizandoCatalogo(false);
      mostrarAviso("error", message);
      return false;
    }
  }, [mostrarAviso, recarregarCatalogosAposSync]);

  const carregarHistorico = useCallback(async (
    conversationId: string,
    older = false,
    mostrarErro = true,
  ) => {
    if (historicoCarregandoId === conversationId) return;
    const currentPage = historicoRef.current.get(conversationId);
    if (older && currentPage?.hasMore === false) return;
    setHistoricoCarregandoId(conversationId);
    try {
      const page = await whatsappApi.history(conversationId, older ? currentPage?.cursor : undefined);
      setConversas((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        return {
          ...conversation,
          mensagens: mergeMessages(conversation.mensagens, page.items),
        };
      }));
      historicoRef.current.set(conversationId, { cursor: page.cursor, hasMore: page.hasMore });
    } catch (error) {
      if (mostrarErro) {
        mostrarAviso("error", error instanceof Error ? error.message : "Falha ao carregar o historico do WhatsApp.");
      }
    } finally {
      setHistoricoCarregandoId((current) => current === conversationId ? null : current);
    }
  }, [historicoCarregandoId, mostrarAviso]);

  useEffect(() => {
    let intervalo: any;
    if (gravando) {
      setTempoGravacao(0);
      intervalo = setInterval(() => setTempoGravacao((prev) => prev + 1), 1000);
    }
    return () => clearInterval(intervalo);
  }, [gravando]);

  useEffect(() => {
    anexosPendentesRef.current = anexosPendentes;
  }, [anexosPendentes]);

  useEffect(() => {
    conversasRef.current = conversas;
  }, [conversas]);

  useEffect(() => {
    contatosRef.current = listaContatos;
  }, [listaContatos]);

  useEffect(() => {
    return () => {
      cancelarEnvioAudioRef.current = true;
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      audioStreamRef.current?.getTracks().forEach((track) => track.stop());
      anexosPendentesRef.current.forEach((anexo) => URL.revokeObjectURL(anexo.urlPreview));
    };
  }, []);

  useEffect(() => {
    onConversaAtivaChange?.(conversaSelecionada);
  }, [conversaSelecionada, onConversaAtivaChange]);

  useEffect(() => {
    whatsappConectadoRef.current = false;
    catalogoInicialTentadoRef.current = false;
    syncStatusRef.current = "idle";
    syncCompletionHandledRef.current = false;
    syncShowSuccessRef.current = false;
    cursorConversasRef.current = 0;
    historicoRef.current.clear();
    setConversas([]);
    setGrupos([]);
    setListaContatos([]);
    contatosRef.current = [];
    setContatosCarregados(false);
    setGruposCarregados(false);
    setStatusWhatsAppCarregados(false);
    setStatusWhatsApp([]);
    setStatusSelecionado(null);
    setPerfilWhatsApp(null);
    setProgressoSincronizacao(null);
    setSecaoWhatsApp("conversations");
    setConversaSelecionada(null);
    setQrCodeString(null);
    setCanalSelecionadoLogin(null);
  }, [userId]);

  useEffect(() => {
    const escutarEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConversaSelecionada(null);
        setPainelPerfilAberto(false);
      }
    };
    window.addEventListener("keydown", escutarEsc);
    return () => window.removeEventListener("keydown", escutarEsc);
  }, []);

  useEffect(() => {
    let active = true;
    let inFlight = false;

    async function checarAutenticacao() {
      if (inFlight) return;
      inFlight = true;
      try {
        const whatsapp = await whatsappApi.status();
        if (!active) return;
        const conectado = whatsapp.conectado === true;
        const estavaConectado = whatsappConectadoRef.current;
        whatsappConectadoRef.current = conectado;
        setCanaisStatus({ whatsapp });
        if (conectado) {
          setQrCodeString(null);
          setErroLogin(null);
          if (!estavaConectado) {
            // Abre todos os catalogos em paralelo: a interface pode usar o
            // cache imediatamente enquanto o backend atualiza a agenda.
            void recarregarCatalogosAposSync(false);
            catalogoInicialTentadoRef.current = true;
          }
        } else {
          if (whatsapp.qrcode) {
            setQrCodeString(whatsapp.qrcode);
            setErroLogin(null);
            setMensagemLogin("Escaneie este QR Code para liberar conversas, imagens, audios e figurinhas.");
            setCanalSelecionadoLogin("whatsapp");
          }
          if (!catalogoInicialTentadoRef.current) catalogoInicialTentadoRef.current = true;
        }
      } catch (err) {
        console.error(err);
        if (active) {
          setCanaisStatus((current) => ({
            whatsapp: {
              ...(current.whatsapp || { conectado: whatsappConectadoRef.current }),
              detail: err instanceof Error ? err.message : "Falha temporaria ao consultar a sessao.",
            },
          }));
        }
      } finally {
        inFlight = false;
        if (active) setLoadingStatus(false);
      }
    }

    void checarAutenticacao();
    const intervalo = window.setInterval(() => void checarAutenticacao(), 12_000);
    return () => {
      active = false;
      window.clearInterval(intervalo);
    };
  }, [recarregarCatalogosAposSync, userId]);

  useEffect(() => {
    if (canalSelecionadoLogin !== "whatsapp") return;
    let active = true;
    let inFlight = false;

    const atualizarQrCode = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const whatsapp = await whatsappApi.status();
        if (!active) return;
        setErroLogin(null);
        setCanaisStatus({ whatsapp });
        if (whatsapp.conectado) {
          whatsappConectadoRef.current = true;
          setQrCodeString(null);
          setErroLogin(null);
          setMensagemLogin("WhatsApp conectado com sucesso.");
          void recarregarCatalogosAposSync(false);
          if (active) setCanalSelecionadoLogin(null);
          return;
        }
        whatsappConectadoRef.current = false;
        if (whatsapp.qrcode) {
          setQrCodeString(whatsapp.qrcode);
          setErroLogin(null);
          setMensagemLogin("Abra o WhatsApp no celular, acesse Aparelhos conectados e escaneie este QR Code.");
        } else {
          setMensagemLogin("Preparando uma conexao segura e gerando o QR Code...");
        }
      } catch (error) {
        if (active) {
          setErroLogin(error instanceof Error ? error.message : "API do WhatsApp indisponivel.");
          setMensagemLogin("Nao foi possivel consultar a sessao. Tente novamente.");
        }
      } finally {
        inFlight = false;
      }
    };

    void atualizarQrCode();
    const interval = window.setInterval(() => void atualizarQrCode(), 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [canalSelecionadoLogin, recarregarCatalogosAposSync, userId]);

  useEffect(() => {
    const atualizarSeVisivel = () => {
      if (!document.hidden && !canalSelecionadoLogin && canaisStatus.whatsapp?.conectado) {
        void carregarConversasDoBackend(true, false, false);
      }
    };
    const intervaloChats = window.setInterval(atualizarSeVisivel, 3_000);
    document.addEventListener("visibilitychange", atualizarSeVisivel);
    return () => {
      window.clearInterval(intervaloChats);
      document.removeEventListener("visibilitychange", atualizarSeVisivel);
    };
  }, [canalSelecionadoLogin, canaisStatus.whatsapp?.conectado, carregarConversasDoBackend]);

  useEffect(() => {
    const atualizarEmTempoReal = () => {
      if (!whatsappConectadoRef.current) return;
      void carregarConversasDoBackend(true, false, false);
      void carregarStatusDoBackend(false, true);
      if (conversaSelecionada) {
        historicoRef.current.delete(conversaSelecionada);
        void carregarHistorico(conversaSelecionada, false, false);
      }
    };
    window.addEventListener("norium:whatsapp-event", atualizarEmTempoReal);
    return () => window.removeEventListener("norium:whatsapp-event", atualizarEmTempoReal);
  }, [carregarConversasDoBackend, carregarHistorico, carregarStatusDoBackend, conversaSelecionada]);

  useEffect(() => {
    if (secaoWhatsApp !== "status" || !canaisStatus.whatsapp?.conectado) return;
    const atualizarStatusVisivel = () => {
      if (!document.hidden) void carregarStatusDoBackend(false, true);
    };
    void atualizarStatusVisivel();
    const interval = window.setInterval(atualizarStatusVisivel, 3_000);
    return () => window.clearInterval(interval);
  }, [canaisStatus.whatsapp?.conectado, carregarStatusDoBackend, secaoWhatsApp]);

  useEffect(() => {
    if (!canaisStatus.whatsapp?.conectado || typeof whatsappApi.syncStatus !== "function") return;
    let active = true;
    const controller = new AbortController();
    let interval: number | undefined;
    const stopPolling = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };
    const consultarProgresso = async () => {
      try {
        const progress = normalizarProgressoSincronizacao(await whatsappApi.syncStatus(controller.signal));
        if (!active) return;
        const previousStatus = syncStatusRef.current;
        syncStatusRef.current = progress.status;
        setProgressoSincronizacao(progress);
        if (progress.status === "syncing") {
          setSincronizandoCatalogo(true);
          syncCompletionHandledRef.current = false;
          return;
        }
        if (progress.status === "error") {
          setSincronizandoCatalogo(false);
          stopPolling();
          return;
        }
        if (progress.status === "partial") {
          setSincronizandoCatalogo(false);
          stopPolling();
          if (!syncCompletionHandledRef.current) {
            syncCompletionHandledRef.current = true;
            await recarregarCatalogosAposSync(false);
            if (!active) return;
            if (syncShowSuccessRef.current) {
              mostrarAviso("info", progress.message || "O cache disponível foi carregado; tente atualizar o catálogo novamente.");
              syncShowSuccessRef.current = false;
            }
          }
          return;
        }
        if (progress.status === "complete" && previousStatus === "syncing" && !syncCompletionHandledRef.current) {
          syncCompletionHandledRef.current = true;
          const loaded = await recarregarCatalogosAposSync();
          if (!active) return;
          setSincronizandoCatalogo(false);
          if (syncShowSuccessRef.current) {
            mostrarAviso("success", `${loaded.contacts.length} contatos e ${loaded.groups.length} grupos atualizados.`);
            syncShowSuccessRef.current = false;
          }
        }
      } catch {
        // O painel continua utilizavel mesmo quando uma versao anterior do
        // backend ainda nao oferece o acompanhamento detalhado.
      }
    };
    void consultarProgresso();
    interval = window.setInterval(() => void consultarProgresso(), 2_500);
    return () => {
      active = false;
      controller.abort();
      stopPolling();
    };
  }, [canaisStatus.whatsapp?.conectado, mostrarAviso, recarregarCatalogosAposSync, syncPollVersion]);

  useEffect(() => {
    if (!canaisStatus.whatsapp?.conectado) return;
    if (secaoWhatsApp === "contacts" && !contatosCarregados && !carregandoContatos && !erroContatos) void carregarContatosDoBackend(false);
    if (secaoWhatsApp === "groups" && !gruposCarregados && !carregandoGrupos && !erroGrupos) void carregarGruposDoBackend(false);
    if (secaoWhatsApp === "status" && !statusWhatsAppCarregados && !carregandoStatusWhatsApp && !erroStatusWhatsApp) void carregarStatusDoBackend(false);
    if (secaoWhatsApp === "profile" && !perfilWhatsApp) void carregarPerfilWhatsApp();
  }, [
    canaisStatus.whatsapp?.conectado,
    carregandoContatos,
    carregandoGrupos,
    carregandoStatusWhatsApp,
    contatosCarregados,
    gruposCarregados,
    statusWhatsAppCarregados,
    carregarContatosDoBackend,
    carregarGruposDoBackend,
    carregarPerfilWhatsApp,
    carregarStatusDoBackend,
    grupos.length,
    erroContatos,
    erroGrupos,
    erroStatusWhatsApp,
    listaContatos.length,
    perfilWhatsApp,
    secaoWhatsApp,
    statusWhatsApp.length,
  ]);

  const abrirAgendaContatos = async () => {
    setModalContatosAberto(true);
    setFiltroContatoNome("");
    await carregarContatosDoBackend();
  };

  const abrirModalGrupo = async () => {
    setModalGrupoAberto(true);
    setFiltroContatoNome("");
    await carregarContatosDoBackend();
  };

  const gerenciarSelecaoContatoGrupo = (id: string) => {
    setContatosSelecionadosGrupo(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const executarCriacaoGrupo = async () => {
    if (!nomeNovoGrupo.trim() || contatosSelecionadosGrupo.length === 0) {
      mostrarAviso("error", "Preencha o nome e selecione ao menos um contato.");
      return;
    }
    setCriandoGrupo(true);
    try {
      const payload = await whatsappApi.createGroup(nomeNovoGrupo.trim(), contatosSelecionadosGrupo);
      const created = normalizarGrupoWhatsApp(payload.group);
      if (created) {
        const now = Date.now();
        created.timestampUltimaMsg = Math.max(Number(created.timestampUltimaMsg || 0), Math.floor(now / 1000));
        created.horario = created.horario || new Date(now).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        created.ultimoTexto = created.ultimoTexto || "Grupo criado agora";
        setGrupos((current) => [created, ...current.filter((group) => group.id !== created.id)]);
        setConversas((current) => [created, ...current.filter((conversation) => conversation.id !== created.id)]);
      }
      mostrarAviso("success", `Grupo "${nomeNovoGrupo}" criado no WhatsApp.`);
      setModalGrupoAberto(false);
      setNomeNovoGrupo("");
      setContatosSelecionadosGrupo([]);
      await Promise.all([carregarConversasDoBackend(), carregarGruposDoBackend(false)]);
      if (created) {
        setGrupos((current) => [created, ...current.filter((group) => group.id !== created.id)]);
        setConversas((current) => [created, ...current.filter((conversation) => conversation.id !== created.id)]);
      }
    } catch (error) {
      mostrarAviso("error", error instanceof Error ? error.message : "Nao foi possivel criar o grupo.");
    } finally {
      setCriandoGrupo(false);
    }
  };

  const selecionarConversa = async (id: string, abrirPerfil = false) => {
    setSecaoWhatsApp("conversations");
    setConversaSelecionada(id);
    setPainelPerfilAberto(abrirPerfil);
    if (abrirPerfil) setAbaDireitaModo("perfil");
    setMobileSidebarOpen(false);
    const selected = conversas.find((conversation) => conversation.id === id);
    if (!historicoRef.current.has(id) || !selected?.mensagens.length) void carregarHistorico(id);
    void whatsappApi.details(id).then((details) => {
      setConversas((current) => mergeConversationDetails(current, details));
    }).catch(() => undefined);
    try {
      await whatsappApi.markConversation(id, "lida", true);
      if (selected) void carregarConversasDoBackend();
    } catch (error) { mostrarAviso("error", error instanceof Error ? error.message : "Falha ao marcar conversa como lida."); }
  };

  const iniciarConversaContato = (contact: Contact, abrirPerfil = false) => {
    const conversation = contactToConversation(contact);
    if (!conversation.id) return;
    setConversas((current) => current.some((item) => item.id === conversation.id)
      ? current
      : [conversation, ...current]);
    setModalContatosAberto(false);
    setSecaoWhatsApp("conversations");
    void selecionarConversa(conversation.id, abrirPerfil);
  };

  const iniciarConversaMembroGrupo = (member: ParticipanteGrupo) => {
    const memberKeys = new Set([...whatsappIdentifierKeys(member.id), ...whatsappIdentifierKeys(member.phone)]);
    const known = listaContatos.find((contact) => [contact.id, contact.phone, contact.lid, ...(contact.aliases || [])]
      .some((value) => whatsappIdentifierKeys(value).some((key) => memberKeys.has(key))));
    const contact: Contact = known || {
      id: member.id || member.phone,
      phone: member.phone || member.id,
      name: member.name,
      photoUrl: member.photoUrl,
    };
    iniciarConversaContato(contact);
    setPainelPerfilAberto(false);
  };

  const abrirGrupo = async (group: ChatConversa) => {
    setSecaoWhatsApp("conversations");
    setConversas((current) => current.some((item) => item.id === group.id) ? current : [group, ...current]);
    setConversaSelecionada(group.id);
    setPainelPerfilAberto(true);
    setAbaDireitaModo("perfil");
    setMobileSidebarOpen(false);
    try {
      const payload = await whatsappApi.groupDetails(group.id);
      const rawDetails = "group" in payload ? payload.group : payload;
      const details = normalizarGrupoWhatsApp(rawDetails);
      if (details) setConversas((current) => mergeConversationDetails(current, details));
    } catch {
      // O grupo ja veio com dados suficientes do catalogo. Detalhes adicionais
      // sao carregados novamente ao abrir o cabecalho da conversa.
    }
    void carregarHistorico(group.id);
    void whatsappApi.markConversation(group.id, "lida", true).catch(() => undefined);
  };

  const selecionarStatusWhatsApp = async (item: WhatsAppStatusItem) => {
    setStatusSelecionado(item.id);
    setMobileSidebarOpen(false);
    if (item.viewed || item.mine) return;
    setStatusWhatsApp((current) => current.map((status) => status.id === item.id ? { ...status, viewed: true } : status));
    try {
      await whatsappApi.markStatusViewed(item.id);
    } catch (error) {
      setStatusWhatsApp((current) => current.map((status) => status.id === item.id ? { ...status, viewed: false } : status));
      mostrarAviso("error", error instanceof Error ? error.message : "Nao foi possivel marcar o status como visualizado.");
    }
  };

  const selecionarSecaoWhatsApp = (section: WhatsAppSection) => {
    setSecaoWhatsApp(section);
    setPainelPerfilAberto(false);
    if (section !== "conversations") setMobileSidebarOpen(true);
  };

  const atualizarCatalogo = useCallback(async () => {
    await forcarSincronizacaoCatalogo(true);
  }, [forcarSincronizacaoCatalogo]);

  const abrirDadosPerfil = useCallback(async () => {
    if (!conversaSelecionada) return;
    setPainelPerfilAberto(true);
    setAbaDireitaModo("perfil");
    try {
      const details = await whatsappApi.details(conversaSelecionada);
      setConversas((current) => mergeConversationDetails(current, details));
    } catch (error) {
      mostrarAviso("error", error instanceof Error ? error.message : "Falha ao carregar os dados do contato.");
    }
  }, [conversaSelecionada, mostrarAviso]);

  const carregarMensagensAntigas = useCallback(async () => {
    if (!conversaSelecionada) return;
    await carregarHistorico(conversaSelecionada, true);
  }, [carregarHistorico, conversaSelecionada]);

  const arquivoParaDataUrl = (arquivo: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(arquivo);
    });

  const destinoStatus = (item: WhatsAppStatusItem) => {
    const raw = String(item.contactId || "").trim();
    if (!raw) throw new Error("O WhatsApp não informou o contato deste Status.");
    const statusKeys = new Set(whatsappIdentifierKeys(raw));
    const known = listaContatos.find((contact) => [contact.id, contact.phone, contact.lid, ...(contact.aliases || [])]
      .some((value) => whatsappIdentifierKeys(value).some((key) => statusKeys.has(key))));
    return known?.id || raw;
  };

  const responderStatusTexto = async (item: WhatsAppStatusItem, text: string) => {
    const destination = destinoStatus(item);
    await whatsappApi.sendText(destination, text, item.id);
    mostrarAviso("success", `Resposta enviada para ${item.name}.`);
  };

  const responderStatusAudio = async (item: WhatsAppStatusItem, audio: Blob, mimeType: string) => {
    const destination = destinoStatus(item);
    const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
    await whatsappApi.sendMedia({
      conversationId: destination,
      fileName: `resposta-status-${Date.now()}.${extension}`,
      mimeType,
      dataUrl: await arquivoParaDataUrl(audio),
      quotedId: item.id,
    });
    mostrarAviso("success", `Resposta de áudio enviada para ${item.name}.`);
  };

  const enviarArquivoOuAudio = async (arquivo: File | Blob, nomeArquivo: string, mimeType: string, legenda?: string, asSticker = false) => {
    if (!conversaSelecionada) {
      throw new Error("Selecione uma conversa antes de enviar.");
    }
    if (arquivo.size > 14 * 1024 * 1024) {
      throw new Error("O arquivo precisa ter ate 14 MB.");
    }

    const dataUrl = await arquivoParaDataUrl(arquivo);
    await whatsappApi.sendMedia({
      conversationId: conversaSelecionada,
      fileName: nomeArquivo,
      mimeType: mimeType || arquivo.type || "application/octet-stream",
      dataUrl,
      caption: legenda,
      asSticker,
    });
  };

  const handleFigurinhaSelecionada = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const arquivo = event.target.files?.[0];
    event.target.value = "";
    if (!arquivo || !conversaSelecionada) return;
    if (!arquivo.type.startsWith("image/")) {
      mostrarAviso("error", "Escolha uma imagem para criar a figurinha.");
      return;
    }
    setEnviandoAnexos(true);
    try {
      await enviarArquivoOuAudio(arquivo, arquivo.name || "figurinha.webp", arquivo.type, undefined, true);
      historicoRef.current.delete(conversaSelecionada);
      await carregarHistorico(conversaSelecionada);
    } catch (error) {
      mostrarAviso("error", error instanceof Error ? error.message : "Nao foi possivel enviar a figurinha.");
    } finally {
      setEnviandoAnexos(false);
    }
  };

  const handleEnviarFigurinhaExistente = async (figurinha: MsgConteudo) => {
    if (!conversaSelecionada || !figurinha.arquivoUrl) return;
    setEnviandoAnexos(true);
    try {
      const blob = await apiBlobRequest(figurinha.arquivoUrl, {
        headers: { Accept: "image/webp,image/*,*/*" },
        cache: "no-store",
      });
      await enviarArquivoOuAudio(
        blob,
        figurinha.nomeArquivo || `figurinha-${figurinha.id}.webp`,
        figurinha.arquivoMime || blob.type || "image/webp",
        undefined,
        true,
      );
      historicoRef.current.delete(conversaSelecionada);
      await carregarHistorico(conversaSelecionada);
    } catch (error) {
      mostrarAviso("error", error instanceof Error ? error.message : "Nao foi possivel reenviar a figurinha.");
    } finally {
      setEnviandoAnexos(false);
    }
  };

  const handleReagirMensagem = async (messageId: string, emoji: string) => {
    if (!conversaSelecionada) return;
    const conversationId = conversaSelecionada;
    setConversas((current) => current.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      return {
        ...conversation,
        mensagens: conversation.mensagens.map((message) => {
          if (message.id !== messageId) return message;
          const reactions = (message.reacoes || []).filter((reaction) => !reaction.fromMe);
          return { ...message, reacoes: emoji ? [...reactions, { emoji, count: 1, fromMe: true }] : reactions };
        }),
      };
    }));
    try {
      await whatsappApi.react(conversationId, messageId, emoji);
    } catch (error) {
      historicoRef.current.delete(conversationId);
      void carregarHistorico(conversationId);
      mostrarAviso("error", error instanceof Error ? error.message : "Nao foi possivel reagir a mensagem.");
    }
  };

  const classificarArquivo = (mimeType: string, nomeArquivo: string): AnexoPendente["tipo"] => {
    const mime = mimeType.toLowerCase();
    const nome = nomeArquivo.toLowerCase();
    if (mime.startsWith("audio/") || /\.(ogg|opus|mp3|m4a|wav|webm)$/i.test(nome)) return "audio";
    if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(nome)) return "image";
    if (mime.startsWith("video/") || /\.(mp4|mov|avi|mkv|webm)$/i.test(nome)) return "video";
    return "document";
  };

  const adicionarAnexosPendentes = (itens: Array<{ arquivo: Blob; nomeArquivo: string; mimeType: string }>) => {
    const novos: AnexoPendente[] = [];
    let ignorados = 0;

    itens.forEach((item) => {
      if (item.arquivo.size > 14 * 1024 * 1024) {
        ignorados += 1;
        return;
      }

      const mimeType = item.mimeType || item.arquivo.type || "application/octet-stream";
      novos.push({
        id: `anexo-${crypto.randomUUID()}`,
        arquivo: item.arquivo,
        nomeArquivo: item.nomeArquivo,
        mimeType,
        tamanho: item.arquivo.size,
        tipo: classificarArquivo(mimeType, item.nomeArquivo),
        urlPreview: URL.createObjectURL(item.arquivo),
      });
    });

    if (ignorados > 0) {
      mostrarAviso("error", `${ignorados} arquivo(s) ficaram fora porque passam de 14 MB.`);
    }
    if (novos.length > 0) {
      setAnexosPendentes((prev) => [...prev, ...novos]);
    }
  };

  const removerAnexoPendente = (id: string) => {
    setAnexosPendentes((prev) => {
      const alvo = prev.find((anexo) => anexo.id === id);
      if (alvo) URL.revokeObjectURL(alvo.urlPreview);
      return prev.filter((anexo) => anexo.id !== id);
    });
  };

  const limparAnexosPendentes = () => {
    setAnexosPendentes((prev) => {
      prev.forEach((anexo) => URL.revokeObjectURL(anexo.urlPreview));
      return [];
    });
  };

  const handleEnviarMensagem = async (texto: string, responderA?: string) => {
    const textoLimpo = texto.trim();
    const anexosParaEnviar = [...anexosPendentesRef.current];
    if (!conversaSelecionada || (!textoLimpo && anexosParaEnviar.length === 0)) return;

    setEnviandoAnexos(true);
    const anexosEnviados = new Set<string>();
    try {
      if (textoLimpo) {
        await whatsappApi.sendText(conversaSelecionada, textoLimpo, responderA);
      }

      for (const anexo of anexosParaEnviar) {
        await enviarArquivoOuAudio(anexo.arquivo, anexo.nomeArquivo, anexo.mimeType);
        anexosEnviados.add(anexo.id);
      }

      if (anexosEnviados.size > 0) {
        setAnexosPendentes((prev) => prev.filter((anexo) => !anexosEnviados.has(anexo.id)));
        anexosParaEnviar.forEach((anexo) => {
          if (anexosEnviados.has(anexo.id)) URL.revokeObjectURL(anexo.urlPreview);
        });
      }
      await carregarConversasDoBackend();
    } catch (err) {
      console.error(err);
      mostrarAviso("error", err instanceof Error ? err.message : "Nao foi possivel enviar.");
    } finally {
      setEnviandoAnexos(false);
    }
  };

  const handleAnexarArquivo = () => {
    if (!conversaSelecionada) {
      mostrarAviso("info", "Selecione uma conversa antes de anexar.");
      return;
    }
    arquivoInputRef.current?.click();
  };

  const handleArquivoSelecionado = (event: React.ChangeEvent<HTMLInputElement>) => {
    const arquivos = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (arquivos.length === 0) return;

    adicionarAnexosPendentes(
      arquivos.map((arquivo) => ({
        arquivo,
        nomeArquivo: arquivo.name,
        mimeType: arquivo.type || "application/octet-stream",
      }))
    );
  };

  const handleColarAnexos = (arquivos: File[]) => {
    if (!conversaSelecionada || arquivos.length === 0) return;
    const timestamp = Date.now();
    adicionarAnexosPendentes(
      arquivos.map((arquivo, index) => {
        const mimeType = arquivo.type || "application/octet-stream";
        const extension = mimeType.startsWith("image/")
          ? mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png"
          : "bin";
        return {
          arquivo,
          nomeArquivo: arquivo.name || `anexo-colado-${timestamp}-${index + 1}.${extension}`,
          mimeType,
        };
      }),
    );
  };

  const escolherMimeAudio = () => {
    const candidatos = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    return candidatos.find((tipo) => MediaRecorder.isTypeSupported(tipo)) || "";
  };

  const pararGravacaoAudio = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") {
      cancelarEnvioAudioRef.current = false;
      setGravando(false);
      recorder.stop();
    }
  };

  const handleGravarAudio = async () => {
    if (gravando) {
      pararGravacaoAudio();
      return;
    }
    if (!conversaSelecionada) {
      mostrarAviso("info", "Selecione uma conversa antes de gravar audio.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      mostrarAviso("error", "Seu navegador nao liberou gravacao de audio.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      mostrarAviso("error", "Seu navegador nao suporta gravacao de audio.");
      return;
    }

    try {
      setStatusMicrofone("solicitando");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      setStatusMicrofone("liberado");
      const mimeType = escolherMimeAudio();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      cancelarEnvioAudioRef.current = false;
      audioStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      audioMimeRef.current = mimeType || recorder.mimeType || "audio/webm";

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const deveEnviar = !cancelarEnvioAudioRef.current;
        const tipoAudioComCodec = audioMimeRef.current || recorder.mimeType || "audio/webm";
        const tipoAudio = tipoAudioComCodec.split(";")[0] || "audio/webm";
        const extensao = tipoAudio.includes("ogg") ? "ogg" : tipoAudio.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(audioChunksRef.current, { type: tipoAudio });

        stream.getTracks().forEach((track) => track.stop());
        audioStreamRef.current = null;
        mediaRecorderRef.current = null;
        audioChunksRef.current = [];
        setGravando(false);

        if (deveEnviar && blob.size > 0) {
          adicionarAnexosPendentes([{ arquivo: blob, nomeArquivo: `audio-${Date.now()}.${extensao}`, mimeType: tipoAudio }]);
        } else if (deveEnviar) {
          mostrarAviso("error", "A gravacao saiu vazia. Verifique a permissao do microfone.");
        }
      };

      recorder.start(250);
      setGravando(true);
    } catch (err) {
      console.error(err);
      setGravando(false);
      setStatusMicrofone("negado");
      mostrarAviso("error", "Nao foi possivel acessar o microfone.");
    }
  };

  const handleApagarMensagensMassa = async (mensagensIds: string[], paraTodos = false) => {
    if (!conversaSelecionada) return;
    for (const msgId of mensagensIds) {
      try {
        await whatsappApi.deleteMessage(conversaSelecionada, msgId, paraTodos);
      } catch (err) { mostrarAviso("error", err instanceof Error ? err.message : "Falha ao apagar mensagem."); }
    }
    carregarConversasDoBackend();
  };

  const handleEditarMensagem = async (messageId: string, text: string) => {
    if (!conversaSelecionada) return;
    try {
      await whatsappApi.editMessage(conversaSelecionada, messageId, text);
      setConversas((current) => current.map((conversation) => conversation.id !== conversaSelecionada ? conversation : {
        ...conversation,
        mensagens: conversation.mensagens.map((message) => message.id === messageId ? { ...message, texto: text, edited: true } : message),
        ultimoTexto: conversation.mensagens.at(-1)?.id === messageId ? text : conversation.ultimoTexto,
      }));
    } catch (error) {
      mostrarAviso("error", error instanceof Error ? error.message : "Não foi possível editar a mensagem.");
      throw error;
    }
  };

  const handleAcaoChat = async (id: string, acao: "lida" | "fixada" | "favorita" | "silenciada" | "arquivada", valor: boolean) => {
    try {
      await whatsappApi.markConversation(id, acao, valor);
      carregarConversasDoBackend();
    } catch (err) { mostrarAviso("error", err instanceof Error ? err.message : "Falha ao atualizar conversa."); }
  };

  const iniciarQrCode = async (canal: "whatsapp") => {
    setQrCodeString(null);
    setErroLogin(null);
    setMensagemLogin(null);
    try {
      const data = await whatsappApi.start();
      if (data.qrcode) setQrCodeString(data.qrcode);
      if (canal === "whatsapp") {
        setMensagemLogin(
          data.status === "conectado"
            ? "WhatsApp conectado com sucesso."
            : data.qrcode
              ? "Escaneie o QR Code com o WhatsApp do celular."
              : "Preparando uma conexao segura e gerando o QR Code..."
        );
      }
    } catch (error) {
      // Defesa: se o backend recusou por falta de aceite, volta para a etapa de consentimento.
      try {
        const info = await whatsappApi.consentStatus();
        if (!info.accepted) { setConsentInfo(info); return; }
      } catch { /* mantém o erro original abaixo */ }
      setErroLogin(error instanceof Error ? error.message : "Erro de conexao.");
    }
  };

  const handleIniciarLogin = async (canal: "whatsapp") => {
    setCanalSelecionadoLogin(canal);
    setQrCodeString(null);
    setErroLogin(null);
    setMensagemLogin(null);
    setConsentChecked(false);
    try {
      const info = await whatsappApi.consentStatus();
      setConsentInfo(info);
      // Sem aceite válido, o QR não é solicitado: exibe primeiro a etapa obrigatória.
      if (!info.accepted) return;
    } catch {
      setConsentInfo({ termVersion: "", accepted: false });
      return;
    }
    await iniciarQrCode(canal);
  };

  const handleAceitarConsentimento = async () => {
    if (!consentChecked || aceitandoConsent) return;
    setAceitandoConsent(true);
    setErroLogin(null);
    try {
      const info = await whatsappApi.acceptConsent(consentInfo?.termVersion || undefined);
      setConsentInfo(info);
      await iniciarQrCode("whatsapp");
    } catch (error) {
      setErroLogin(error instanceof Error ? error.message : "Nao foi possivel registrar o aceite.");
    } finally {
      setAceitandoConsent(false);
    }
  };

  const handleExcluirChat = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConversaParaExcluir(id);
  };

  const confirmarExclusaoChat = async () => {
    const id = conversaParaExcluir;
    if (!id) return;
    setExcluindoConversa(true);
    try {
      await whatsappApi.deleteConversation(id);
      setConversas((prev) => prev.filter(c => c.id !== id));
      historicoRef.current.delete(id);
      if (conversaSelecionada === id) setConversaSelecionada(null);
      setConversaParaExcluir(null);
    } catch (err) {
      mostrarAviso("error", err instanceof Error ? err.message : "Falha ao excluir conversa.");
    } finally {
      setExcluindoConversa(false);
    }
  };

  const confirmarDesconexao = async () => {
    setDesconectando(true);
    try {
      await whatsappApi.disconnect();
      whatsappConectadoRef.current = false;
      cursorConversasRef.current = 0;
      historicoRef.current.clear();
      setConversas([]);
      setConversaSelecionada(null);
      setQrCodeString(null);
      catalogoInicialTentadoRef.current = true;
      setCanaisStatus({ whatsapp: { conectado: false, qrcode: null, status: "desconectado" } });
      setConfirmarDesconexaoAberta(false);
      setModalConfigAberto(false);
      mostrarAviso("success", "WhatsApp desconectado deste usuario.");
    } catch (error) {
      mostrarAviso("error", error instanceof Error ? error.message : "Nao foi possivel desconectar o WhatsApp.");
    } finally {
      setDesconectando(false);
    }
  };

  const handleAbrirEncaminhar = (ids: string[]) => {
    if (ids.length === 0) return;
    setMensagensParaEncaminhar(ids);
    setDestinoEncaminhar(null);
    setModalEncaminharAberto(true);
  };

  const confirmarEncaminhamento = async () => {
    if (!destinoEncaminhar || !conversaAtiva) return;
    const destino = [...conversas, ...grupos].find((c) => c.id === destinoEncaminhar);
    if (!destino) return;
    if (mensagensParaEncaminhar.length === 0) {
      mostrarAviso("error", "Selecione ao menos uma mensagem para encaminhar.");
      setModalEncaminharAberto(false);
      return;
    }
    setEncaminhando(true);
    try {
      await whatsappApi.forwardMessages(destino.id, mensagensParaEncaminhar);
      await carregarConversasDoBackend();
      mostrarAviso("success", `${mensagensParaEncaminhar.length} mensagem(ns) encaminhada(s) para ${destino.contato}.`);
    } catch (err) {
      mostrarAviso("error", err instanceof Error ? err.message : "Nao foi possivel encaminhar.");
    } finally {
      setEncaminhando(false);
      setModalEncaminharAberto(false);
      setMensagensParaEncaminhar([]);
      setDestinoEncaminhar(null);
    }
  };

  const figurinhasRecentes = useMemo(() => {
    const unicas = new Map<string, MsgConteudo>();
    for (const conversation of conversas) {
      for (const message of conversation.mensagens) {
        if (message.tipo !== "sticker" || !message.arquivoUrl) continue;
        unicas.set(message.arquivoUrl, message);
      }
    }
    return [...unicas.values()]
      .sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0))
      .slice(0, 48);
  }, [conversas]);

  const conversaAtiva = conversas.find(c => c.id === conversaSelecionada);
  const gruposDisponiveis = grupos.length > 0 ? grupos : conversas.filter((conversation) => conversation.esGrupo);
  const destinosEncaminhamento = [...new Map([...conversas, ...gruposDisponiveis].map((conversation) => [conversation.id, conversation])).values()];
  const totalNaoLidas = conversas.reduce((total, conversation) => total + Number(conversation.naoLidasCount || 0), 0);
  const totalStatusNaoVisualizados = statusWhatsApp.filter((item) => !item.mine && !item.viewed).length;
  const contatosFiltrados = listaContatos.filter((contact) => contactMatchesSearch(contact, filtroContatoNome));
  const paginaHistoricoAtiva = conversaSelecionada ? historicoRef.current.get(conversaSelecionada) : undefined;
  const nenhumConectado = !canaisStatus.whatsapp?.conectado;

  if (loadingStatus) return <div className="w-full h-full flex items-center justify-center text-xs font-semibold opacity-50 text-[var(--text)]">Sincronizando...</div>;

  if (nenhumConectado && !canalSelecionadoLogin) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[var(--background)] p-6 font-sans">
        <div className="w-[400px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 text-center text-xs font-bold shadow-2xl">
          <h3 className="text-sm font-extrabold tracking-tight mb-4 text-[var(--text)]">Painel de Acesso Unificado</h3>
          {canaisStatus.whatsapp?.detail && (
            <p className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-left font-semibold leading-5 text-red-400">
              {canaisStatus.whatsapp.detail}
            </p>
          )}
          <div className="space-y-3">
            <button onClick={() => handleIniciarLogin("whatsapp")} className="h-12 w-full rounded-xl bg-[var(--primary)] text-white shadow-md">Conectar WhatsApp</button>
          </div>
        </div>
      </div>
    );
  }

  if (canalSelecionadoLogin === "whatsapp" && consentInfo && !consentInfo.accepted) {
    return (
      <div className="w-full h-full min-h-0 overflow-y-auto flex items-start sm:items-center justify-center bg-[var(--background)] p-4 sm:p-6 font-sans">
        <div className="w-full max-w-[520px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 sm:p-7 space-y-4 text-xs font-bold text-[var(--text)] shadow-2xl">
          <div className="text-center">
            <h3 className="text-base font-extrabold text-[var(--primary)]">Uso responsavel e risco de banimento</h3>
            <p className="mt-2 text-[var(--text-secondary)] leading-5">
              Antes de conectar, leia e confirme as orientacoes de uso responsavel. Nenhuma integracao consegue garantir ausencia de bloqueio ou banimento da conta.
            </p>
          </div>
          <ul className="list-disc space-y-1.5 pl-5 text-left font-semibold leading-5 text-[var(--text-secondary)]">
            <li>Use a conta de forma gradual e com comportamento natural.</li>
            <li>Evite disparos em massa, spam, automacoes agressivas e volumes anormais.</li>
            <li>Envie mensagens apenas para pessoas que autorizaram o contato.</li>
            <li>Respeite pedidos de descadastro e evite insistencia.</li>
            <li>Evite conteudo enganoso, proibido ou que gere muitas denuncias e bloqueios.</li>
            <li>Nao repita mensagens identicas nem inicie muitas conversas em sequencia.</li>
            <li>Respeite os Termos de Servico e as politicas oficiais do WhatsApp.</li>
          </ul>
          <p className="text-left font-semibold leading-5 text-[var(--text-secondary)]">
            Saiba mais:{" "}
            <a href="https://docs.w-api.app/banimentos/intro" target="_blank" rel="noreferrer" className="text-[var(--primary)] underline">
              orientacoes da W-API
            </a>{" "}
            e{" "}
            <a href="https://www.whatsapp.com/legal" target="_blank" rel="noreferrer" className="text-[var(--primary)] underline">
              Termos e politicas do WhatsApp
            </a>.
          </p>
          {erroLogin && <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-left font-semibold leading-5 text-red-400">{erroLogin}</p>}
          <label className="flex items-start gap-2 text-left font-semibold leading-5 text-[var(--text)] cursor-pointer">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]"
            />
            <span>
              Li as orientacoes de uso responsavel, compreendo o risco de bloqueio ou banimento da conta e concordo com os Termos de Uso e politicas aplicaveis.
            </span>
          </label>
          <Button
            onClick={() => void handleAceitarConsentimento()}
            className="w-full"
            variant="primary"
            disabled={!consentChecked || aceitandoConsent}
          >
            {aceitandoConsent ? "Registrando aceite..." : "Concordar e gerar QR Code"}
          </Button>
          <Button onClick={() => setCanalSelecionadoLogin(null)} className="w-full">Voltar</Button>
        </div>
      </div>
    );
  }

  if (canalSelecionadoLogin === "whatsapp") {
    return (
      <div className="w-full h-full min-h-0 overflow-y-auto flex items-start sm:items-center justify-center bg-[var(--background)] p-4 sm:p-6 font-sans">
        <div className="w-full max-w-[420px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 sm:p-7 text-center space-y-4 text-xs font-bold text-[var(--text)] shadow-2xl">
          <div>
            <h3 className="text-base font-extrabold text-[var(--primary)]">Conectar WhatsApp</h3>
            <p className="mt-2 text-[var(--text-secondary)] leading-5">O QR Code e gerado com seguranca e atualizado automaticamente nesta tela.</p>
          </div>
          <div className="aspect-square w-full max-w-[300px] bg-white mx-auto flex items-center justify-center rounded-2xl p-3 shadow-inner overflow-hidden">
            {erroLogin ? (
              <span className="text-red-600 px-4 leading-5">{erroLogin}</span>
            ) : qrCodeString ? (
              <img src={qrCodeString} alt="QR Code para conectar o WhatsApp ao Norium" className="w-full h-full object-contain" />
            ) : canaisStatus.whatsapp?.conectado ? (
              <span className="px-4 text-sm text-[var(--primary)]">Conectado</span>
            ) : (
              <span className="text-neutral-500 animate-pulse px-4">Gerando QR Code...</span>
            )}
          </div>
          <p className="min-h-10 text-[var(--text-secondary)] leading-5">{mensagemLogin}</p>
          {sincronizandoCatalogo && progressoSincronizacao && (
            <div className="rounded-xl border border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] p-3 text-left" role="status" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-[11px]"><span className="truncate">{progressoSincronizacao.message || "Sincronizando contatos e fotos"}</span><span className="text-[var(--primary)]">{Math.round(progressoSincronizacao.progress)}%</span></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/45"><div className="h-full rounded-full bg-[var(--primary)] transition-[width]" style={{ width: `${progressoSincronizacao.progress}%` }} /></div>
            </div>
          )}
          {erroLogin && (
            <Button onClick={() => void handleIniciarLogin("whatsapp")} className="w-full" variant="primary">
              Tentar novamente
            </Button>
          )}
          <Button onClick={() => setCanalSelecionadoLogin(null)} className="w-full">
            {canaisStatus.whatsapp?.conectado ? "Abrir conversas" : "Voltar"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`norium-chat ${mobileSidebarOpen ? "mobile-sidebar-open" : ""} relative flex h-full min-h-0 w-full overflow-hidden bg-[var(--background)] font-sans`}>
      <button
        type="button"
        className="mobile-sidebar-toggle mobile-screen-fab"
        aria-label="Abrir lista de conversas"
        onClick={() => setMobileSidebarOpen(true)}
      >
        <Menu size={18} />
      </button>
      {mobileSidebarOpen && (
        <button
          type="button"
          className="mobile-sidebar-backdrop"
          aria-label="Fechar lista de conversas"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <input
        ref={arquivoInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar"
        className="hidden"
        onChange={handleArquivoSelecionado}
      />
      <input
        ref={figurinhaInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleFigurinhaSelecionada}
      />
      <WhatsAppRail
        section={secaoWhatsApp}
        unreadCount={totalNaoLidas}
        statusUnreadCount={totalStatusNaoVisualizados}
        online={Boolean(canaisStatus.whatsapp?.conectado)}
        profile={perfilWhatsApp}
        onSelect={selecionarSecaoWhatsApp}
      />

      {secaoWhatsApp === "conversations" && (
        <>
          <SidebarEsquerda
            conversas={conversas} conversaSelecionada={conversaSelecionada}
            onSelecionar={selecionarConversa} onAcao={handleAcaoChat} onExcluir={handleExcluirChat}
            onAbrirConfigPropria={() => setModalConfigAberto(true)}
            onAbrirModalContatos={abrirAgendaContatos}
            onAbrirModalCriarGrupo={abrirModalGrupo}
            onAtualizar={() => void atualizarCatalogo()}
            sincronizando={sincronizandoCatalogo}
            syncProgress={progressoSincronizacao}
            onClose={() => setMobileSidebarOpen(false)}
          />

          <AreaCentralChat
            key={conversaAtiva?.id || "vazio"}
            conversaAtiva={conversaAtiva} onEnviar={handleEnviarMensagem}
            onAbrirDadosPerfil={() => void abrirDadosPerfil()}
            onAnexarArquivo={handleAnexarArquivo} onColarAnexos={handleColarAnexos} onGravarAudio={handleGravarAudio}
            gravando={gravando} tempoGravacao={tempoGravacao} formatarTempo={formatarTempo}
            anexosPendentes={anexosPendentes}
            enviandoAnexos={enviandoAnexos}
            statusMicrofone={statusMicrofone}
            onRemoverAnexo={removerAnexoPendente}
            onLimparAnexos={limparAnexosPendentes}
            onApagarMensagensEmMassa={handleApagarMensagensMassa}
            onEncaminharMensagens={handleAbrirEncaminhar}
            onEditarMensagem={handleEditarMensagem}
            onFeedback={(tone, text) => mostrarAviso(tone, text)}
            onReagirMensagem={handleReagirMensagem}
            onEscolherFigurinha={() => figurinhaInputRef.current?.click()}
            figurinhasRecentes={figurinhasRecentes}
            onEnviarFigurinhaExistente={handleEnviarFigurinhaExistente}
            onCarregarMensagensAntigas={carregarMensagensAntigas}
            temMaisMensagens={paginaHistoricoAtiva?.hasMore ?? true}
            carregandoMensagens={historicoCarregandoId === conversaSelecionada}
          />
        </>
      )}

      {(secaoWhatsApp === "contacts" || secaoWhatsApp === "groups") && (
        <WhatsAppDirectory
          mode={secaoWhatsApp}
          contacts={listaContatos}
          groups={gruposDisponiveis}
          loading={secaoWhatsApp === "contacts" ? carregandoContatos : carregandoGrupos}
          error={secaoWhatsApp === "contacts" ? erroContatos : erroGrupos}
          sync={progressoSincronizacao}
          onOpenContact={(contact) => iniciarConversaContato(contact, true)}
          onOpenGroup={(group) => void abrirGrupo(group)}
          onCreateGroup={() => void abrirModalGrupo()}
          onRefresh={() => void (secaoWhatsApp === "contacts" ? carregarContatosDoBackend() : carregarGruposDoBackend())}
        />
      )}

      {secaoWhatsApp === "status" && (
        <WhatsAppStatusView
          items={statusWhatsApp}
          selectedId={statusSelecionado}
          profile={perfilWhatsApp}
          loading={carregandoStatusWhatsApp}
          error={erroStatusWhatsApp}
          sync={progressoSincronizacao}
          onSelect={(item) => void selecionarStatusWhatsApp(item)}
          onRefresh={() => void carregarStatusDoBackend()}
          onCreateUnavailable={() => mostrarAviso("info", "A W-API ainda nao oferece publicacao de Status. Publique no celular; o feed recebido aparece aqui automaticamente.")}
          onReplyText={responderStatusTexto}
          onReplyAudio={responderStatusAudio}
        />
      )}

      {secaoWhatsApp === "profile" && (
        <WhatsAppProfileView
          profile={perfilWhatsApp}
          connected={Boolean(canaisStatus.whatsapp?.conectado)}
          onDisconnect={() => setConfirmarDesconexaoAberta(true)}
          onUnavailableSetting={(label) => {
            if (label === "Conta") setModalConfigAberto(true);
            else mostrarAviso("info", `${label}: altere esta configuracao no WhatsApp do celular; o Norium sincroniza os dados permitidos pela W-API.`);
          }}
        />
      )}

      {aviso && (
        <div className="absolute left-1/2 top-4 z-[80] w-[min(420px,90%)] -translate-x-1/2">
          <StatusBanner tone={aviso.tone === "success" ? "success" : aviso.tone} onDismiss={() => setAviso(null)}>
            {aviso.texto}
          </StatusBanner>
        </div>
      )}

      {conversaParaExcluir && (
        <ConfirmDialog
          title="Apagar conversa?"
          description="Essa acao remove a conversa e o historico de mensagens associado a ela."
          confirmLabel="Apagar"
          danger
          busy={excluindoConversa}
          onConfirm={confirmarExclusaoChat}
          onCancel={() => setConversaParaExcluir(null)}
        />
      )}

      {confirmarDesconexaoAberta && (
        <ConfirmDialog
          title="Desconectar WhatsApp?"
          description="A sessao e o historico local deste usuario serao removidos. Nenhum outro usuario sera afetado."
          confirmLabel="Desconectar"
          danger
          busy={desconectando}
          onConfirm={confirmarDesconexao}
          onCancel={() => setConfirmarDesconexaoAberta(false)}
        />
      )}

      {modalEncaminharAberto && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[80vh] w-[420px] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-xs font-bold text-[var(--text)] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[var(--border)] p-4">
              <h3 className="text-sm font-extrabold">Encaminhar {mensagensParaEncaminhar.length} mensagem(ns)</h3>
              <Button variant="ghost" onClick={() => setModalEncaminharAberto(false)} aria-label="Fechar" className="rounded p-1">
                <X size={16} />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {destinosEncaminhamento.filter((c) => c.id !== conversaSelecionada).length === 0 ? (
                <p className="p-4 text-[var(--text-secondary)]">Nenhuma outra conversa disponivel.</p>
              ) : (
                destinosEncaminhamento
                  .filter((c) => c.id !== conversaSelecionada)
                  .map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setDestinoEncaminhar(c.id)}
                      className={`flex w-full items-center gap-3 border-b border-[var(--border)] p-3 text-left hover:bg-[var(--surface-hover)] ${destinoEncaminhar === c.id ? "bg-[var(--surface-hover)]" : ""}`}
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--primary)_16%,transparent)] text-[var(--primary)]">
                        <User size={16} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{c.contato}</span>
                      {destinoEncaminhar === c.id && <Send size={14} className="text-[var(--primary)]" />}
                    </button>
                  ))
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--border)] p-4">
              <Button variant="ghost" onClick={() => setModalEncaminharAberto(false)}>Cancelar</Button>
              <Button variant="primary" disabled={!destinoEncaminhar} loading={encaminhando} onClick={confirmarEncaminhamento}>
                Encaminhar
              </Button>
            </div>
          </div>
        </div>
      )}

      {secaoWhatsApp === "conversations" && painelPerfilAberto && (
        <PainelDireito modo={abaDireitaModo} conversaAtiva={conversaAtiva} onFechar={() => setPainelPerfilAberto(false)} onContinuarConversa={() => setPainelPerfilAberto(false)} onStartMemberConversation={iniciarConversaMembroGrupo} onAskNora={onOpenNora} />
      )}

      {modalContatosAberto && (
        <div className="absolute inset-0 bg-black/60 z-50 flex items-center justify-center p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setModalContatosAberto(false);
        }}>
          <div role="dialog" aria-modal="true" aria-labelledby="contact-picker-title" className="w-[450px] max-h-[80vh] bg-[var(--surface)] border border-[var(--border)] rounded-2xl flex flex-col shadow-2xl overflow-hidden text-xs font-bold text-[var(--text)]">
            <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
              <div>
                <h3 id="contact-picker-title" className="text-sm font-extrabold">Novo chat</h3>
                <p className="mt-0.5 text-[11px] font-medium text-[var(--text-secondary)]">Escolha um contato para iniciar a conversa</p>
              </div>
              <Button variant="ghost" size="sm" iconOnly aria-label="Fechar lista de contatos" onClick={() => setModalContatosAberto(false)}><X size={16}/></Button>
            </div>
            <div className="p-3 bg-[var(--background)] border-b border-[var(--border)] flex items-center gap-2">
              <Search size={14} className="opacity-40" />
              <input autoFocus type="search" aria-label="Buscar contatos" placeholder="Buscar por nome ou telefone" value={filtroContatoNome} onChange={(e) => setFiltroContatoNome(e.target.value)} className="bg-transparent flex-1 outline-none text-xs font-semibold text-[var(--text)]"/>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]/30">
              {carregandoContatos && (
                <div className="p-8 text-center font-semibold text-[var(--text-secondary)]">Carregando contatos...</div>
              )}
              {!carregandoContatos && erroContatos && (
                <div className="p-8 text-center">
                  <p className="font-semibold text-red-400">Não foi possível carregar os contatos.</p>
                  <Button className="mt-3" size="sm" onClick={() => void abrirAgendaContatos()}>Tentar novamente</Button>
                </div>
              )}
              {!carregandoContatos && !erroContatos && contatosFiltrados.length === 0 && (
                <div className="p-8 text-center font-semibold text-[var(--text-secondary)]">
                  {filtroContatoNome ? "Nenhum contato encontrado." : "Nenhum contato disponível."}
                </div>
              )}
              {!carregandoContatos && !erroContatos && contatosFiltrados.map((c) => (
                <button type="button" key={contactConversationId(c)} onClick={() => iniciarConversaContato(c)} className="w-full p-3 flex items-center gap-3 text-left hover:bg-[var(--surface-hover)] cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]">
                  <ContactAvatar contact={c} />
                  <div className="flex flex-col min-w-0">
                    <span className="font-bold text-sm truncate">{contactDisplayName(c)}</span>
                    <span className="text-xs opacity-50 font-mono">{c.phone || c.id}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {modalGrupoAberto && (
        <div className="absolute inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="w-[450px] max-h-[85vh] bg-[var(--surface)] border border-[var(--border)] rounded-2xl flex flex-col shadow-2xl overflow-hidden text-xs font-bold text-[var(--text)]">
            <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
              <h3 className="text-sm font-extrabold">Criar Novo Grupo</h3>
              <button onClick={() => setModalGrupoAberto(false)}><X size={16}/></button>
            </div>
            
            <div className="p-4 space-y-3 bg-[var(--background)] border-b border-[var(--border)]">
              <input type="text" placeholder="Nome do grupo..." value={nomeNovoGrupo} onChange={(e) => setNomeNovoGrupo(e.target.value)} className="w-full h-10 border border-[var(--border)] bg-[var(--surface)] px-3 rounded-xl outline-none font-semibold text-xs text-[var(--text)] focus:border-[var(--primary)]"/>
              <label className="flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 focus-within:border-[var(--primary)]">
                <Search size={14} className="text-[var(--text-secondary)]" />
                <input type="search" aria-label="Buscar participantes" placeholder="Buscar participantes" value={filtroContatoNome} onChange={(e) => setFiltroContatoNome(e.target.value)} className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-[var(--text)] outline-none" />
              </label>
              <div className="rounded-xl border border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] px-3 py-2 text-center text-[var(--primary)]">Grupo do WhatsApp</div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]/30">
              {contatosFiltrados.map((c) => {
                const phone = contactGroupPhone(c);
                const rowId = contactConversationId(c);
                const marcado = Boolean(phone && contatosSelecionadosGrupo.includes(phone));
                return (
                  <button type="button" key={rowId} disabled={!phone} onClick={() => phone && gerenciarSelecaoContatoGrupo(phone)} className="p-3 flex w-full items-center justify-between text-left hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-55">
                    <div className="flex items-center gap-3">
                      <ContactAvatar contact={c} />
                      <span className="min-w-0"><span className="block truncate text-sm font-bold">{contactDisplayName(c)}</span>{!phone && <span className="mt-0.5 block text-[10px] font-semibold text-amber-400">Número indisponível para grupo</span>}</span>
                    </div>
                    <span aria-hidden="true" className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] ${marcado ? "border-[var(--primary)] bg-[var(--primary)] text-white" : "border-[var(--border)]"}`}>{marcado ? "✓" : ""}</span>
                  </button>
                );
              })}
            </div>

            <div className="p-4 bg-[var(--background)] border-t border-[var(--border)]">
              <button onClick={executarCriacaoGrupo} disabled={criandoGrupo} className="w-full h-11 bg-[var(--primary)] text-white rounded-xl shadow-md font-bold text-xs transition hover:opacity-95 disabled:cursor-wait disabled:opacity-60">{criandoGrupo ? "Criando grupo..." : `Concluir criação (${contatosSelecionadosGrupo.length})`}</button>
            </div>
          </div>
        </div>
      )}

      {modalConfigAberto && (
        <div className="absolute inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="w-[450px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl flex flex-col shadow-2xl overflow-hidden text-xs font-bold text-[var(--text)]">
            <div className="p-4 border-b border-[var(--border)] flex items-center justify-between bg-[var(--background)]">
              <h3 className="text-sm font-extrabold">Configurações Gerais do Painel</h3>
              <button onClick={() => setModalConfigAberto(false)} className="hover:opacity-70"><X size={16}/></button>
            </div>
            
            <div className="p-5 space-y-4 flex-1">
              <div className="space-y-1.5">
                <label className="opacity-60 block text-xs uppercase tracking-wider">Endereço da API Backend (URL)</label>
                <input type="text" readOnly value={BACKEND_URL} className="w-full h-10 border border-[var(--border)] bg-[var(--background)] px-3 rounded-xl outline-none font-semibold text-xs text-[var(--text)] opacity-70"/>
              </div>

              <div className="bg-[var(--background)] border border-[var(--border)] p-3 rounded-xl space-y-1.5">
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--primary)]">Status do Gateway</p>
                <div className="flex justify-between font-medium text-xs opacity-80">
                  <span>WhatsApp:</span>
                  <span className="font-bold text-[var(--primary)]">
                    {canaisStatus.whatsapp?.conectado ? `Conectado${canaisStatus.whatsapp.numero ? ` (${canaisStatus.whatsapp.numero})` : ""}` : "Desconectado"}
                  </span>
                </div>
              </div>
            </div>

            <div className="p-4 bg-[var(--background)] border-t border-[var(--border)] flex gap-2">
              <Button variant="danger" className="flex-1" onClick={() => setConfirmarDesconexaoAberta(true)}>Desconectar WhatsApp</Button>
              <Button className="flex-1" onClick={() => setModalConfigAberto(false)}>Fechar</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
