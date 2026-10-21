import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  CheckCheck,
  Clock3,
  Copy,
  CornerUpRight,
  Eye,
  FileText,
  Image as ImageIcon,
  ListChecks,
  Languages,
  Maximize2,
  MessageCircle,
  Mic,
  MoreVertical,
  Paperclip,
  Plus,
  PencilLine,
  Pause,
  Play,
  SendHorizontal,
  Smile,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import type { AnexoPendente, ChatConversa, MsgConteudo } from "./types";
import Button from "../shared/Button";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";
import { conversationDisplayName, formatWhatsAppPhone, isTechnicalWhatsAppLabel } from "./contactPicker";
import NoraChatComposer from "./NoraChatComposer";
import MessageNoraActions, { type MessageNoraRequest } from "./MessageNoraActions";
import MessageTemplatePicker from "../message-templates/MessageTemplatePicker";
import { useQuickReplies } from "../message-templates/useQuickReplies";
import { ContactLabels } from "./ContactLabels";
import ConversationHeader from "./ConversationHeader";
import MediaGallery from "./MediaGallery";
import MessageSearch, { HighlightedText, useMessageSearch } from "./MessageSearch";
import MessageTranslation, { TranslationToolbar } from "./MessageTranslation";
import { useWhatsAppScope } from "./WhatsAppScope";
import type { Attendance } from "./TeamAttendance";
import { InternalNoteCard, InternalNoteComposer } from "./InternalNote";
import type { ReactNode } from "react";
import { avatarColor } from "./avatarColor";

function messageDayLabel(timestamp?: number) {
  if (!timestamp) return "";
  const date = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Hoje";
  if (date.toDateString() === yesterday.toDateString()) return "Ontem";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

interface AreaCentralProps {
  attendance?: Attendance | null;
  attendanceHeader?: ReactNode;
  conversaAtiva: ChatConversa | undefined;
  onEnviar: (texto: string, responderA?: string) => void | Promise<void>;
  onAbrirDadosPerfil: () => void;
  onAnexarArquivo: (kind?: "media" | "document") => void;
  onColarAnexos: (files: File[]) => void;
  onGravarAudio: () => void;
  gravando: boolean;
  tempoGravacao: number;
  formatarTempo: (segundos: number) => string;
  anexosPendentes: AnexoPendente[];
  enviandoAnexos: boolean;
  statusMicrofone: "idle" | "solicitando" | "liberado" | "negado";
  onRemoverAnexo: (id: string) => void;
  onAlternarVisualizacaoUnica: (id: string) => void;
  onLimparAnexos: () => void;
  onApagarMensagensEmMassa: (mensagensIds: string[], paraTodos?: boolean) => void;
  onEncaminharMensagens: (mensagensIds: string[]) => void;
  onEditarMensagem: (messageId: string, text: string) => void | Promise<void>;
  onFeedback?: (tone: "error" | "success", text: string) => void;
  onCarregarMensagensAntigas: () => Promise<void>;
  temMaisMensagens: boolean;
  carregandoMensagens: boolean;
  onReagirMensagem: (messageId: string, emoji: string) => void | Promise<void>;
  onEscolherFigurinha: () => void;
  figurinhasRecentes: MsgConteudo[];
  onEnviarFigurinhaExistente: (figurinha: MsgConteudo) => void | Promise<void>;
  wallpaperUrl?: string | null;
  painelAberto?: boolean;
  onVoltarLista?: () => void;
  onAcaoCabecalho?: (action: "silenciar" | "arquivar" | "papel" | "excluir") => void;
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}

function HeaderAvatar({ conversa }: { conversa: ChatConversa }) {
  const [failedSource, setFailedSource] = useState("");
  const photoUrl = useAuthenticatedMedia(conversa.metadados?.photoUrl || conversa.photoUrl);
  const displayName = conversationDisplayName(conversa);
  const hasPhoto = Boolean(photoUrl && photoUrl !== failedSource);
  const showInitials = !hasPhoto && !conversa.esGrupo && Boolean(displayName) && !isTechnicalWhatsAppLabel(displayName);

  return (
    <div className={`nx-conv-av h-[34px] w-[34px] ${showInitials ? "" : "is-photo"}`} style={showInitials ? { background: avatarColor(displayName) } : undefined}>
      {hasPhoto ? (
        <img src={photoUrl} alt={displayName} className="h-full w-full object-cover" onError={() => setFailedSource(photoUrl)} />
      ) : conversa.esGrupo ? (
        <Users size={16} />
      ) : showInitials ? (
        <span>{initials(displayName)}</span>
      ) : (
        <User size={16} />
      )}
    </div>
  );
}

function ParticipantAvatar({ conversa, message }: { conversa: ChatConversa; message: MsgConteudo }) {
  const participant = conversa.metadados?.participantes?.find((item) => item.id === message.remetenteId || item.phone === message.remetenteId);
  const photoUrl = useAuthenticatedMedia(participant?.photoUrl);
  return (
    <div className={`nx-conv-av mb-0.5 h-7 w-7 text-[10.5px] ${photoUrl ? "is-photo" : ""}`} style={photoUrl ? undefined : { background: avatarColor(message.remetenteNome || "?") }}>
      {photoUrl ? <img src={photoUrl} alt={message.remetenteNome || "Participante"} className="h-full w-full object-cover" /> : initials(message.remetenteNome || "?")}
    </div>
  );
}

const GROUP_MENTION_PATTERN = /@(\d{5,})(?:@(lid|c\.us|s\.whatsapp\.net))?(?![\w])/gi;

function MessageText({ conversa, text, query = "" }: { conversa: ChatConversa; text: string; query?: string }) {
  if (!conversa.esGrupo) return <HighlightedText text={text} query={query} />;

  const participantNames = new Map<string, string>();
  for (const participant of conversa.metadados?.participantes || []) {
    const name = participant.name?.trim();
    if (!name) continue;
    const aliases = (participant as typeof participant & { aliases?: string[] }).aliases || [];
    for (const identifier of [participant.id, participant.phone, ...aliases]) {
      const localId = String(identifier || "").trim().replace(/^@/, "").split("@", 1)[0];
      const digits = localId.replace(/\D/g, "");
      if (digits.length >= 5) participantNames.set(digits, name);
    }
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let foundMention = false;
  for (const match of text.matchAll(GROUP_MENTION_PATTERN)) {
    const participantName = participantNames.get(match[1]);
    if (!participantName) continue;
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) parts.push(<HighlightedText key={`text-${lastIndex}`} text={text.slice(lastIndex, matchIndex)} query={query} />);
    parts.push(
      <span key={`${matchIndex}-${match[1]}`} className="font-extrabold text-[var(--primary)]">
        @{participantName}
      </span>,
    );
    lastIndex = matchIndex + match[0].length;
    foundMention = true;
  }

  if (!foundMention) return <HighlightedText text={text} query={query} />;
  if (lastIndex < text.length) parts.push(<HighlightedText key={`text-${lastIndex}`} text={text.slice(lastIndex)} query={query} />);
  return parts;
}

function MessageStatus({ status }: { status?: MsgConteudo["status"] }) {
  if (status === "lido" || status === "reproduzido") return <CheckCheck size={15} className="text-sky-400" />;
  if (status === "entregue") return <CheckCheck size={15} className="text-current opacity-60" />;
  if (status === "enviado") return <Check size={15} className="text-current opacity-60" />;
  if (status === "erro") return <X size={14} className="text-red-400" />;
  return <Clock3 size={13} className="text-current opacity-40" />;
}

function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function AudioMessage({ src, outgoing }: { src: string; outgoing: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const bars = [12, 18, 9, 24, 16, 28, 11, 20, 30, 15, 23, 13, 26, 18, 10, 22, 29, 14, 20, 11, 25, 16, 28, 12, 18, 24, 10, 21];
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const activeBars = Math.round((progress / 100) * bars.length);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const updateMetadata = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.playbackRate = speed;
    };
    const updateTime = () => setCurrentTime(audio.currentTime || 0);
    const finish = () => {
      setPlaying(false);
      setCurrentTime(Number.isFinite(audio.duration) ? audio.duration : 0);
    };

    audio.addEventListener("loadedmetadata", updateMetadata);
    audio.addEventListener("timeupdate", updateTime);
    audio.addEventListener("ended", finish);
    updateMetadata();

    return () => {
      audio.removeEventListener("loadedmetadata", updateMetadata);
      audio.removeEventListener("timeupdate", updateTime);
      audio.removeEventListener("ended", finish);
    };
  }, [src, speed]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }

    try {
      await audio.play();
      setPlaying(true);
    } catch (err) {
      console.error(err);
    }
  };

  const cycleSpeed = () => {
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(event.target.value);
    setCurrentTime(nextTime);
    if (audioRef.current) {
      audioRef.current.currentTime = nextTime;
    }
  };

  return (
    <div className={`w-[320px] max-w-[70vw] rounded-xl px-3 py-2.5 ${outgoing ? "bg-white/10" : "bg-[var(--background)]"}`}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className={`h-10 w-10 shrink-0 rounded-full flex items-center justify-center transition ${outgoing ? "bg-white text-[var(--primary)]" : "bg-[var(--primary)] text-white"}`}
          title={playing ? "Pausar audio" : "Tocar audio"}
         aria-label={playing ? "Pausar audio" : "Tocar audio"}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="relative h-8">
            <div className="absolute inset-0 flex items-center gap-[3px] overflow-hidden">
              {bars.map((height, index) => (
                <span
                  key={`${height}-${index}`}
                  className={`w-[3px] shrink-0 rounded-full transition-colors ${index <= activeBars ? "bg-current" : "bg-current/30"}`}
                  style={{ height }}
                />
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step="0.01"
              value={Math.min(currentTime, duration || 0)}
              onChange={handleSeek}
              className="absolute inset-0 h-8 w-full cursor-pointer opacity-0"
              aria-label="Progresso do audio"
            />
          </div>
          <div className="mt-0.5 flex items-center justify-between text-xs font-bold opacity-70">
            <span>{formatAudioTime(currentTime)}</span>
            <span>{formatAudioTime(duration)}</span>
          </div>
        </div>

        <Button size="sm" onClick={cycleSpeed} className="min-w-10 rounded-full border-current/20 font-extrabold">
          {speed}x
        </Button>
      </div>
    </div>
  );
}

function MessageMedia({ msg, outgoing, onOpen }: { msg: MsgConteudo; outgoing: boolean; onOpen: (id: string) => void }) {
  const fileName = msg.nomeArquivo || "Arquivo";
  const looksVideo = msg.arquivoMime?.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(fileName);
  const source = msg.viewOnce ? undefined : msg.tipo === "midia" ? msg.miniaturaUrl : msg.arquivoUrl;
  const mediaUrl = useAuthenticatedMedia(source);
  if (msg.viewOnce) return <div className="flex min-w-0 items-center gap-3 rounded-lg border border-white/15 bg-black/10 px-3 py-2.5">
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] px-2 py-1 text-xs font-black text-white"><Eye size={14} />1x</span>
    <span className="text-xs font-semibold">{outgoing ? "Mídia enviada para visualização única" : "Mídia de visualização única"}</span>
  </div>;
  if (!msg.arquivoUrl) return <p className="text-sm font-medium">{msg.texto || "Mídia indisponível"}</p>;
  if (msg.tipo === "audio") return mediaUrl ? <AudioMessage src={mediaUrl} outgoing={outgoing} /> : null;
  if (msg.tipo === "sticker") return <div className="h-36 w-36 bg-transparent">{mediaUrl && <img src={mediaUrl} alt="Figurinha" className="h-full w-full object-contain" />}</div>;
  if (msg.tipo === "documento") return <a href={mediaUrl || undefined} download={fileName} className={`flex max-w-[320px] items-center gap-3 rounded-lg p-3 ${outgoing ? "bg-white/15" : "bg-[var(--background)]"}`}>
    <FileText size={24} /><span className="min-w-0 flex-1 truncate text-xs font-bold">{fileName}</span>
  </a>;
  return <div className="max-w-[420px] overflow-hidden rounded-lg">
    <button type="button" aria-label="Abrir em tela cheia" onClick={() => onOpen(msg.id)} className="nx-whatsapp-media-preview">
      {mediaUrl ? <img loading="lazy" src={mediaUrl} alt={msg.texto || "Imagem"} /> : <span><ImageIcon size={26} />Abrir {looksVideo ? "vídeo" : "imagem"}</span>}
      {looksVideo && <Play size={26} className="nx-whatsapp-video-play" />}
      <Maximize2 size={15} className="nx-whatsapp-media-expand" />
    </button>
    {msg.texto && !["[Imagem]", "[Video]"].includes(msg.texto) && <p className="mt-2 text-sm font-medium">{msg.texto}</p>}
  </div>;
}

function StickerLibraryItem({
  sticker,
  onSelect,
}: {
  sticker: MsgConteudo;
  onSelect: (sticker: MsgConteudo) => void | Promise<void>;
}) {
  const mediaUrl = useAuthenticatedMedia(sticker.arquivoUrl);
  return (
    <button
      type="button"
      onClick={() => void onSelect(sticker)}
      disabled={!mediaUrl}
      className="grid aspect-square place-items-center rounded-xl bg-[var(--background)] p-1.5 transition hover:bg-[var(--surface-hover)] disabled:opacity-40"
      title="Enviar figurinha"
    >
      {mediaUrl ? <img src={mediaUrl} alt="Figurinha recente" className="h-full w-full object-contain" /> : <span className="animate-pulse text-[var(--text-secondary)]">...</span>}
    </button>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentPreviewCard({ anexo, onRemover, onToggleViewOnce }: { anexo: AnexoPendente; onRemover: (id: string) => void; onToggleViewOnce: (id: string) => void }) {
  const canViewOnce = anexo.tipo === "image" || anexo.tipo === "audio" || anexo.tipo === "video";
  return (
    <div className={`relative h-32 shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--text)] ${anexo.tipo === "audio" ? "w-[340px]" : "w-44"}`}>
      <Button variant="ghost" iconOnly
        onClick={() => onRemover(anexo.id)}
        className="absolute right-1.5 top-1.5 z-10 h-7 w-7 rounded-full bg-black/65 shadow"
        title="Remover anexo"
       aria-label="Remover anexo">
        <X size={14} />
      </Button>
      {canViewOnce && (
        <button
          type="button"
          onClick={() => onToggleViewOnce(anexo.id)}
          aria-pressed={Boolean(anexo.viewOnce)}
          aria-label={anexo.viewOnce ? `Desativar visualiza\u00e7\u00e3o \u00fanica de ${anexo.nomeArquivo}` : `Enviar ${anexo.nomeArquivo} para visualizar uma vez`}
          title={"Visualiza\u00e7\u00e3o \u00fanica"}
          className={`absolute left-1.5 top-1.5 z-10 inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[10px] font-black shadow ${anexo.viewOnce ? "border-[var(--primary)] bg-[var(--primary)] text-white" : "border-white/20 bg-black/65 text-white hover:border-[var(--primary)]"}`}
        >
          <Eye size={13} /> 1x
        </button>
      )}

      {anexo.tipo === "image" && (
        <img src={anexo.urlPreview} alt={anexo.nomeArquivo} className="h-full w-full object-cover" />
      )}

      {anexo.tipo === "video" && (
        <video src={anexo.urlPreview} controls className="h-full w-full bg-black object-contain" />
      )}

      {anexo.tipo === "audio" && (
        <div className="flex h-full w-full items-center justify-center p-2">
          <AudioMessage src={anexo.urlPreview} outgoing />
        </div>
      )}

      {anexo.tipo === "document" && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
          <FileText size={28} className="text-[var(--primary)]" />
          <span className="line-clamp-2 max-w-full break-words text-xs font-bold">{anexo.nomeArquivo}</span>
        </div>
      )}

      {anexo.tipo !== "audio" && (
        <div className="absolute bottom-0 left-0 right-0 bg-black/65 px-2 py-1.5 text-white">
          <p className="truncate text-xs font-bold">{anexo.nomeArquivo}</p>
          <p className="text-xs opacity-75">{formatFileSize(anexo.tamanho)}</p>
        </div>
      )}
    </div>
  );
}

function AttachmentPreviewTray({
  anexos,
  onRemover,
  onLimpar,
  onToggleViewOnce,
}: {
  anexos: AnexoPendente[];
  onRemover: (id: string) => void;
  onLimpar: () => void;
  onToggleViewOnce: (id: string) => void;
}) {
  if (anexos.length === 0) return null;

  return (
    <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-2">
      <div className="mb-2 flex items-center justify-between px-1 text-xs font-bold text-[var(--text)]">
        <span>{anexos.length} anexo{anexos.length > 1 ? "s" : ""}</span>
        <Button variant="ghost" onClick={onLimpar} className="h-7 text-[var(--text-secondary)] hover:text-[var(--text)]">
          <X size={13} /> Limpar
        </Button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {anexos.map((anexo) => (
          <AttachmentPreviewCard key={anexo.id} anexo={anexo} onRemover={onRemover} onToggleViewOnce={onToggleViewOnce} />
        ))}
      </div>
    </div>
  );
}

export default function AreaCentralChat({
  conversaAtiva,
  onEnviar,
  onAbrirDadosPerfil,
  onAnexarArquivo,
  onColarAnexos,
  onGravarAudio,
  gravando,
  tempoGravacao,
  formatarTempo,
  anexosPendentes,
  enviandoAnexos,
  statusMicrofone,
  onRemoverAnexo,
  onAlternarVisualizacaoUnica,
  onLimparAnexos,
  onApagarMensagensEmMassa,
  onEncaminharMensagens,
  onEditarMensagem,
  onFeedback,
  onCarregarMensagensAntigas,
  temMaisMensagens,
  carregandoMensagens,
  onReagirMensagem,
  onEscolherFigurinha,
  figurinhasRecentes,
  onEnviarFigurinhaExistente,
  wallpaperUrl,
  painelAberto, onVoltarLista, onAcaoCabecalho, attendance, attendanceHeader,
}: AreaCentralProps) {
  const { inboxId } = useWhatsAppScope();
  const [noteMode, setNoteMode] = useState(false);
  const [resposta, setResposta] = useState("");
  const quick = useQuickReplies({ channel: "whatsapp", text: resposta,
    variables: { client_name: conversaAtiva ? conversationDisplayName(conversaAtiva) : "", nome: conversaAtiva ? conversationDisplayName(conversaAtiva) : "" },
    onApply: ({ body }) => setResposta(body) });
  const [respondendoA, setRespondendoA] = useState<MsgConteudo | null>(null);
  const [mostrarPesquisa, setMostrarPesquisa] = useState(false);
  const [galleryId, setGalleryId] = useState<string | null>(null);
  const [traduzirChat, setTraduzirChat] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState("pt-BR");
  const [translationRequest, setTranslationRequest] = useState({ conversationId: "", messageId: "", trigger: 0 });
  const [menuMensagemId, setMenuMensagemId] = useState<string | null>(null);
  const [menuMensagemPosicao, setMenuMensagemPosicao] = useState({ top: 8, left: 8 });
  const [modoSelecao, setModoSelecao] = useState(false);
  const [selecionadas, setSelecionadas] = useState<string[]>([]);
  const [mostrarPainelEmojis, setMostrarPainelEmojis] = useState(false);
  const [modoPainelEmojis, setModoPainelEmojis] = useState<"emoji" | "figurinha">("emoji");
  const [editandoMensagem, setEditandoMensagem] = useState<MsgConteudo | null>(null);
  const [textoEdicao, setTextoEdicao] = useState("");
  const [salvandoEdicao, setSalvandoEdicao] = useState(false);
  const [noraRequest, setNoraRequest] = useState<MessageNoraRequest | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageSearch = useMessageSearch(conversaAtiva?.mensagens || [], conversaAtiva?.id, scrollRef);
  const previousHeightRef = useRef<number | null>(null);
  const nearBottomRef = useRef(true);
  const previousConversationRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const conversationChanged = previousConversationRef.current !== conversaAtiva?.id;
    previousConversationRef.current = conversaAtiva?.id;
    if (previousHeightRef.current !== null) {
      container.scrollTop += container.scrollHeight - previousHeightRef.current;
      previousHeightRef.current = null;
      return;
    }
    if (conversationChanged || nearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      nearBottomRef.current = true;
    }
  }, [conversaAtiva?.id, conversaAtiva?.mensagens.length]);

  const carregarAnterioresPreservandoPosicao = () => {
    const container = scrollRef.current;
    if (!container || !temMaisMensagens || carregandoMensagens || previousHeightRef.current !== null) return;
    previousHeightRef.current = container.scrollHeight;
    void onCarregarMensagensAntigas().finally(() => {
      window.requestAnimationFrame(() => {
        const current = scrollRef.current;
        if (current && previousHeightRef.current !== null) {
          current.scrollTop += current.scrollHeight - previousHeightRef.current;
          previousHeightRef.current = null;
        }
      });
    });
  };

  const handleMessageScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    nearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (menuMensagemId) setMenuMensagemId(null);
    if (container.scrollTop <= 80) carregarAnterioresPreservandoPosicao();
  };

  const alternarMenuMensagem = (event: React.MouseEvent<HTMLElement>, messageId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (menuMensagemId === messageId) {
      setMenuMensagemId(null);
      return;
    }
    const anchor = event.currentTarget.getBoundingClientRect();
    const menuWidth = 192;
    const menuHeight = 510;
    const gutter = 8;
    const preferredLeft = anchor.right - menuWidth;
    const left = Math.max(gutter, Math.min(window.innerWidth - menuWidth - gutter, preferredLeft));
    const preferredTop = anchor.bottom + 4;
    const top = preferredTop + menuHeight <= window.innerHeight - gutter
      ? preferredTop
      : Math.max(gutter, anchor.top - menuHeight - 4);
    setMenuMensagemPosicao({ top, left });
    setMenuMensagemId(messageId);
  };

  useEffect(() => {
    const fecharFlutuantes = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-message-menu-root]")) {
        setMenuMensagemId(null);
      }
      if (!target.closest("[data-emoji-panel-root]")) {
        setMostrarPainelEmojis(false);
      }
    };

    document.addEventListener("mousedown", fecharFlutuantes);
    return () => document.removeEventListener("mousedown", fecharFlutuantes);
  }, []);

  useEffect(() => {
    if (!menuMensagemId) return;
    const closeFloatingMenu = () => setMenuMensagemId(null);
    window.addEventListener("resize", closeFloatingMenu);
    window.addEventListener("scroll", closeFloatingMenu, true);
    return () => {
      window.removeEventListener("resize", closeFloatingMenu);
      window.removeEventListener("scroll", closeFloatingMenu, true);
    };
  }, [menuMensagemId]);

  if (!conversaAtiva) {
    return (
      <div className="norium-chat-thread flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden bg-[var(--nx-bg)] p-6 text-center text-[var(--nx-text-2)]">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-[var(--nx-surface)] text-[var(--nx-text-3)] ring-1 ring-[var(--nx-border)]"><MessageCircle size={20} /></span>
        <p className="text-sm">Selecione uma conversa para começar.</p>
      </div>
    );
  }

  const displayName = conversationDisplayName(conversaAtiva);
  const phoneLabel = formatWhatsAppPhone(conversaAtiva.metadados?.numeroCompleto || conversaAtiva.id);
  const mensagensFiltradas = conversaAtiva.mensagens.filter((mensagem) => {
    const hasVisibleContent = Boolean(mensagem.texto?.trim() || mensagem.arquivoUrl);
    return hasVisibleContent;
  });

  const acionarEnviar = () => {
    if (quick.missingVariables.length) return;
    const texto = resposta.trim();
    if (!texto && anexosPendentes.length === 0) return;
    void onEnviar(texto, respondendoA?.id);
    setResposta("");
    setRespondendoA(null);
  };

  const handlePasteAttachments = (event: React.ClipboardEvent<HTMLElement>) => {
    const itemFiles = Array.from(event.clipboardData.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const files = itemFiles.length > 0 ? itemFiles : Array.from(event.clipboardData.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    onColarAnexos(files);
  };

  const alternarSelecaoMensagem = (id: string) => {
    setSelecionadas((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const abrirEdicao = (message: MsgConteudo) => {
    setEditandoMensagem(message);
    setTextoEdicao(message.texto || "");
    setMenuMensagemId(null);
  };

  const salvarEdicao = async () => {
    const text = textoEdicao.trim();
    if (!editandoMensagem || !text || salvandoEdicao) return;
    setSalvandoEdicao(true);
    try {
      await onEditarMensagem(editandoMensagem.id, text);
      setEditandoMensagem(null);
      onFeedback?.("success", "Mensagem editada no WhatsApp.");
    } catch (editError) {
      onFeedback?.("error", editError instanceof Error ? editError.message : "Não foi possível editar a mensagem.");
    } finally {
      setSalvandoEdicao(false);
    }
  };

  const abrirAcaoNora = (mode: MessageNoraRequest["mode"], message: MsgConteudo) => {
    setNoraRequest({ mode, message });
    setMenuMensagemId(null);
  };

  const usarRespostaNora = (message: MsgConteudo, draft: string) => {
    setRespondendoA(message);
    setResposta(draft);
  };

  const mensagensSelecionadas = conversaAtiva.mensagens.filter((message) => selecionadas.includes(message.id));
  const podeApagarSelecionadasParaTodos = mensagensSelecionadas.length > 0 && mensagensSelecionadas.every((message) => message.remetente === "usuario");

  return (
    <section onPaste={noteMode ? undefined : handlePasteAttachments} className="norium-chat-thread flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--background)]">
      {galleryId && <MediaGallery key={conversaAtiva.id} conversation={conversaAtiva} messageId={galleryId} onSelect={setGalleryId} onClose={() => setGalleryId(null)} onForward={onEncaminharMensagens} />}
      {!modoSelecao ? (
        <ConversationHeader avatar={<HeaderAvatar conversa={conversaAtiva} />} name={displayName}
          subtitle={conversaAtiva.esGrupo ? `${conversaAtiva.metadados?.participantes?.length || 0} participantes` : phoneLabel}
          group={Boolean(conversaAtiva.esGrupo)} panelOpen={painelAberto} searching={mostrarPesquisa} translating={traduzirChat}
          onPanel={onAbrirDadosPerfil} onSearch={() => setMostrarPesquisa(!mostrarPesquisa)}
          onTranslate={() => inboxId ? onFeedback?.("error", "A tradução da caixa compartilhada será integrada à Nora contextual.") : setTraduzirChat(!traduzirChat)} onBack={onVoltarLista} onAction={onAcaoCabecalho} />
      ) : (
        <div className="nx-conv-thread-head">
          <div className="flex items-center gap-2">
            <button type="button" className="nx-conv-iconbtn" onClick={() => { setModoSelecao(false); setSelecionadas([]); }} aria-label="Cancelar seleção" title="Cancelar seleção">
              <X size={16} />
            </button>
            <span className="text-sm font-semibold">{selecionadas.length} selecionadas</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <button type="button" className="nx-btn is-sm" onClick={() => { onEncaminharMensagens(selecionadas); setModoSelecao(false); setSelecionadas([]); }}>
              <CornerUpRight size={14} /> Encaminhar
            </button>
            {podeApagarSelecionadasParaTodos && <button type="button" className="nx-btn is-sm border-transparent bg-[var(--nx-danger)] text-white hover:bg-[var(--nx-danger)]" onClick={() => { onApagarMensagensEmMassa(selecionadas, true); setModoSelecao(false); setSelecionadas([]); }}>
              <Trash2 size={14} /> Apagar para todos
            </button>}
            <button type="button" className="nx-btn is-sm text-[var(--nx-danger)]" onClick={() => { onApagarMensagensEmMassa(selecionadas, false); setModoSelecao(false); setSelecionadas([]); }}>
              <Trash2 size={14} /> Apagar para mim
            </button>
          </div>
        </div>
      )}

      {attendanceHeader}
      {mostrarPesquisa && (
        <MessageSearch search={messageSearch} hasOlder={temMaisMensagens} onClose={() => { messageSearch.setQuery(""); setMostrarPesquisa(false); }} />
      )}
      {traduzirChat && <TranslationToolbar language={translationLanguage} onLanguage={setTranslationLanguage} onClose={() => setTraduzirChat(false)} />}

      <div className="nx-whatsapp-header-tags"><ContactLabels contactId={conversaAtiva.id} editable limit={5} /></div>
      <div
        ref={scrollRef}
        onScroll={handleMessageScroll}
        className="norium-chat-message-scroll norium-chat-wallpaper min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-7 py-5"
        style={{
          backgroundImage: wallpaperUrl
            ? `linear-gradient(var(--chat-wallpaper-overlay), var(--chat-wallpaper-overlay)), url("${wallpaperUrl}")`
            : "radial-gradient(circle at 20px 20px, var(--nx-whatsapp-dot) 1px, transparent 1.4px), radial-gradient(circle at 70px 60px, var(--nx-whatsapp-dot) 1px, transparent 1.8px)",
          backgroundPosition: wallpaperUrl ? "center" : undefined,
          backgroundRepeat: wallpaperUrl ? "no-repeat" : undefined,
          backgroundSize: wallpaperUrl ? "cover" : "96px 96px",
          backgroundAttachment: wallpaperUrl ? "scroll" : undefined,
        }}
      >
        {(temMaisMensagens || carregandoMensagens) && (
          <div className="flex justify-center pb-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={carregandoMensagens}
              onClick={carregarAnterioresPreservandoPosicao}
              className="rounded-full border border-[var(--nx-border)] bg-[var(--nx-surface)] font-medium text-[var(--nx-text-2)]"
            >
              {carregandoMensagens ? "Carregando mensagens..." : "Carregar mensagens anteriores"}
            </Button>
          </div>
        )}
        {attendance?.notes.hasMore && <div className="flex justify-center"><button type="button" className="nx-btn is-sm" disabled={attendance.busy} onClick={() => void attendance.more("notes")}>Notas internas anteriores</button></div>}
        {!carregandoMensagens && mensagensFiltradas.length === 0 && (
          <div className="flex min-h-40 items-center justify-center text-center text-sm text-[var(--nx-text-3)]">
            Nenhuma mensagem disponível nesta conversa.
          </div>
        )}
        {[...mensagensFiltradas.map(message => ({ message, timestamp: message.timestamp || 0, id: message.id })),
          ...(attendance?.notes.items || []).map(note => ({ note, timestamp: note.createdAt, id: `note-${note.id}` }))]
          .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)).map((entry) => {
          if ("note" in entry) return attendance && <InternalNoteCard key={entry.id} note={entry.note} attendance={attendance} />;
          const msg = entry.message;
          const index = mensagensFiltradas.indexOf(msg);
          const outgoing = msg.remetente === "usuario";
          const estaSelecionada = selecionadas.includes(msg.id);
          const dayLabel = messageDayLabel(msg.timestamp);
          const previousDayLabel = index > 0 ? messageDayLabel(mensagensFiltradas[index - 1].timestamp) : "";
          const showDay = Boolean(dayLabel) && dayLabel !== previousDayLabel;

          return (
            <Fragment key={msg.id}>
            {showDay && <div className="nx-conv-day py-1">{dayLabel}</div>}
            <div data-message-id={msg.id} data-search-active={messageSearch.activeId === msg.id || undefined} onClick={() => modoSelecao && alternarSelecaoMensagem(msg.id)} className={`flex w-full items-end gap-3 group ${outgoing ? "justify-end" : "justify-start"} ${modoSelecao ? "cursor-pointer" : ""}`}>
              {modoSelecao && (
                <input
                  type="checkbox"
                  checked={estaSelecionada}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => alternarSelecaoMensagem(msg.id)}
                  className="h-4 w-4 cursor-pointer"
                />
              )}

              {!outgoing && conversaAtiva.esGrupo && <ParticipantAvatar conversa={conversaAtiva} message={msg} />}

              <div
                className={`norium-message-bubble relative ${outgoing ? "norium-message-outgoing" : "norium-message-incoming"} ${estaSelecionada ? "ring-2 ring-[var(--nx-primary)]" : ""}`}
                data-message-menu-root
                onContextMenu={(event) => { if (!modoSelecao) alternarMenuMensagem(event, msg.id); }}
              >
                {!modoSelecao && (
                  <button type="button" aria-label="Ações da mensagem" onClick={(event) => alternarMenuMensagem(event, msg.id)} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md text-[var(--nx-text-2)] opacity-0 transition hover:bg-black/10 focus:opacity-100 group-hover:opacity-100">
                    <MoreVertical size={14} />
                  </button>
                )}

                {menuMensagemId === msg.id && createPortal(
                  <div
                    data-message-menu-root
                    role="menu"
                    className="nx-conv-menu fixed z-[210] max-h-[min(520px,80vh)] w-56 overflow-y-auto py-1"
                    style={{ top: menuMensagemPosicao.top, left: menuMensagemPosicao.left }}
                  >
                    <div className="flex items-center justify-between border-b border-[var(--nx-border)] px-2 py-1.5">
                      {["👍", "❤️", "😂", "😮", "😢", "🙏"].map((emoji) => (
                        <button key={emoji} className="grid h-7 w-7 place-items-center rounded-full text-base" onClick={() => { void onReagirMensagem(msg.id, emoji); setMenuMensagemId(null); }} aria-label={`Reagir com ${emoji}`}>{emoji}</button>
                      ))}
                    </div>
                    <button onClick={() => { setRespondendoA(msg); setMenuMensagemId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                      <CornerUpRight size={14} /> Responder
                    </button>
                    {outgoing && msg.tipo === "texto" && Boolean(msg.texto?.trim()) && <button onClick={() => abrirEdicao(msg)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                      <PencilLine size={14} /> Editar mensagem
                    </button>}
                    <button onClick={() => { onEncaminharMensagens([msg.id]); setMenuMensagemId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                      <CornerUpRight size={14} /> Encaminhar
                    </button>
                    <button onClick={() => { if (msg.texto) void navigator.clipboard.writeText(msg.texto); setMenuMensagemId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                      <Copy size={14} /> Copiar
                    </button>
                    {msg.texto?.trim() && !msg.viewOnce && <button disabled={Boolean(inboxId)} title={inboxId ? "Tradução contextual: em implementação" : undefined} onClick={() => { setTraduzirChat(true); setTranslationRequest(current => ({ conversationId: conversaAtiva.id, messageId: msg.id, trigger: current.trigger + 1 })); setMenuMensagemId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left"><Languages size={14} />Traduzir mensagem</button>}
                    <button onClick={() => { setModoSelecao(true); setSelecionadas([msg.id]); setMenuMensagemId(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                      <Check size={14} /> Selecionar
                    </button>
                    <div className="my-1 border-t border-[var(--nx-border)]" />
                    <p className="nx-conv-menu-label px-3 py-1">Nora</p>
                    <button disabled={Boolean(inboxId)} title={inboxId ? "Nora contextual da caixa: em implementação" : undefined} onClick={() => abrirAcaoNora("reply", msg)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                      <Sparkles size={14} className="text-[var(--nx-primary-text)]" /> Responder com a Nora
                    </button>
                    <button disabled={Boolean(inboxId)} title={inboxId ? "Nora contextual da caixa: em implementação" : undefined} onClick={() => abrirAcaoNora("summary", msg)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                      <Sparkles size={14} className="text-[var(--nx-primary-text)]" /> Resumir com a Nora
                    </button>
                    <button disabled={Boolean(inboxId)} title={inboxId ? "Nora contextual da caixa: em implementação" : undefined} onClick={() => abrirAcaoNora("task", msg)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                      <ListChecks size={14} className="text-[var(--nx-primary-text)]" /> Transformar em tarefa
                    </button>
                    <div className="my-1 border-t border-[var(--nx-border)]" />
                    {outgoing && <button onClick={() => { onApagarMensagensEmMassa([msg.id], true); setMenuMensagemId(null); }} className="is-danger flex w-full items-center gap-2 px-3 py-2 text-left">
                      <Trash2 size={14} /> Apagar para todos
                    </button>}
                    <button onClick={() => { onApagarMensagensEmMassa([msg.id], false); setMenuMensagemId(null); }} className="is-danger flex w-full items-center gap-2 px-3 py-2 text-left">
                      <Trash2 size={14} /> Apagar para mim
                    </button>
                  </div>,
                  document.body,
                )}

                {msg.remetenteNome && !outgoing && (
                  <span className="mb-1 block text-xs font-semibold text-[var(--nx-primary-text)]">~ {msg.remetenteNome}</span>
                )}

                {msg.citada?.content && (
                  <div className="mb-1.5 rounded-md border-l-2 border-[var(--nx-primary)] bg-black/5 px-2 py-1 text-xs text-[var(--nx-text-2)]">
                    {msg.citada.senderName && <span className="block font-semibold text-[var(--nx-primary-text)]">{msg.citada.senderName}</span>}
                    <span className="line-clamp-2">{msg.citada.content}</span>
                  </div>
                )}

                {(msg.forwarded || msg.edited) && (
                  <div className="mb-1 flex items-center gap-2 pr-6 text-[11px] italic text-[var(--nx-text-3)]">
                    {msg.forwarded && <span>Encaminhada</span>}
                    {msg.edited && <span>Editada</span>}
                  </div>
                )}

                {msg.tipo === "texto" ? (
                  <p className="whitespace-pre-wrap break-words pr-6">
                    <MessageText conversa={conversaAtiva} text={msg.texto || ""} query={messageSearch.query} />
                  </p>
                ) : (
                  <MessageMedia msg={msg} outgoing={outgoing} onOpen={setGalleryId} />
                )}

                {traduzirChat && msg.texto?.trim() && !msg.viewOnce && <MessageTranslation key={`${conversaAtiva.id}:${msg.id}`} conversationId={conversaAtiva.id} messageId={msg.id} language={translationLanguage}
                  trigger={translationRequest.conversationId === conversaAtiva.id && translationRequest.messageId === msg.id ? translationRequest.trigger : 0} />}
                <div className="nx-conv-msg-time mt-[3px] flex items-center justify-end gap-1">
                  <span>{msg.horario}</span>
                  {outgoing && <MessageStatus status={msg.status} />}
                </div>
                {Boolean(msg.reacoes?.length) && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {msg.reacoes?.map((reaction, index) => (
                      <button
                        key={`${reaction.emoji}-${index}`}
                        onClick={() => void onReagirMensagem(msg.id, reaction.fromMe ? "" : reaction.emoji)}
                        className={`rounded-full border px-1.5 py-0.5 text-xs ${reaction.fromMe ? "border-[var(--nx-primary)] bg-[var(--nx-primary-soft)]" : "border-[var(--nx-border)] bg-[var(--nx-surface)]"}`}
                        title={reaction.fromMe ? "Remover sua reação" : "Reagir igual"}
                      >
                        {reaction.emoji}{reaction.count > 1 ? ` ${reaction.count}` : ""}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="norium-chat-composer relative shrink-0">
        <div className="nx-whatsapp-composer-mode">
          {attendance ? <div className="nx-whatsapp-note-mode" role="group" aria-label="Modo de composição">
          <button type="button" aria-pressed={!noteMode} disabled={gravando} onClick={() => setNoteMode(false)}><MessageCircle size={14} />Responder</button>
          <button type="button" aria-pressed={noteMode} disabled={gravando || enviandoAnexos} onClick={() => setNoteMode(true)}>Nota interna</button>
        </div> : <span className="nx-whatsapp-reply-mode"><MessageCircle size={14} />Responder</span>}
          <NoraChatComposer conversationId={conversaAtiva.id} disabled={Boolean(inboxId) || gravando || enviandoAnexos} onInsertDraft={setResposta} />
          <small>/ respostas rápidas</small>
        </div>
        {attendance && noteMode ? <InternalNoteComposer attendance={attendance} /> : <>

        {mostrarPainelEmojis && (
          <div data-emoji-panel-root className="nx-conv-menu absolute bottom-full left-5 z-50 mb-2 w-[340px] max-w-[calc(100vw-24px)] overflow-hidden">
            <div className="p-2">
              <div className="nx-conv-seg" role="group" aria-label="Emojis ou figurinhas">
                <button type="button" aria-pressed={modoPainelEmojis === "emoji"} onClick={() => setModoPainelEmojis("emoji")} className="flex-1">Emojis</button>
                <button type="button" aria-pressed={modoPainelEmojis === "figurinha"} onClick={() => setModoPainelEmojis("figurinha")} className="flex-1">Figurinhas</button>
              </div>
            </div>
            {modoPainelEmojis === "emoji" ? (
              <div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto p-3 text-xl">
                {["😀", "😃", "😄", "😁", "😆", "😂", "🤣", "😊", "😍", "🥰", "😘", "😎", "🤩", "🥳", "😢", "😭", "😡", "🤯", "😴", "🤔", "🫡", "👍", "👎", "👏", "🙌", "🙏", "💪", "🔥", "❤️", "💙", "💚", "✨", "🎉", "🚀", "✅", "👀", "💬", "📌", "📷", "🎧"].map((emoji) => (
                  <button className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--surface-hover)]" key={emoji} onClick={() => setResposta((prev) => prev + emoji)}>{emoji}</button>
                ))}
              </div>
            ) : (
              <div className="p-3">
                <p className="mb-2 px-1 text-left text-[12.5px] font-medium text-[var(--nx-text-2)]">Figurinhas recentes</p>
                {figurinhasRecentes.length > 0 ? (
                  <div className="grid max-h-60 grid-cols-4 gap-2 overflow-y-auto pr-1">
                    {figurinhasRecentes.map((sticker) => (
                      <StickerLibraryItem
                        key={`${sticker.id}-${sticker.arquivoUrl}`}
                        sticker={sticker}
                        onSelect={async (selected) => {
                          await onEnviarFigurinhaExistente(selected);
                          setMostrarPainelEmojis(false);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg bg-[var(--nx-surface-2)] p-4 text-center text-[12.5px] text-[var(--nx-text-3)]">As figurinhas usadas nas suas conversas aparecerão aqui.</p>
                )}
                <Button variant="ghost" onClick={() => { onEscolherFigurinha(); setMostrarPainelEmojis(false); }} className="mt-3 w-full">Adicionar nova figurinha</Button>
              </div>
            )}
          </div>
        )}

        <div className="nx-conv-composer-box">
          <AttachmentPreviewTray anexos={anexosPendentes} onRemover={onRemoverAnexo} onLimpar={onLimparAnexos} onToggleViewOnce={onAlternarVisualizacaoUnica} />

          {(gravando || statusMicrofone === "solicitando" || statusMicrofone === "negado") && (
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-[var(--nx-surface-2)] px-3 py-2 text-xs font-medium text-[var(--nx-text)]">
              <span className={`h-2 w-2 rounded-full ${gravando ? "animate-pulse bg-[var(--nx-danger)]" : statusMicrofone === "negado" ? "bg-[var(--nx-danger)]" : "bg-[var(--nx-warning)]"}`} />
              <span>
                {gravando
                  ? `Gravando áudio: ${formatarTempo(tempoGravacao)}`
                  : statusMicrofone === "negado"
                    ? "Microfone bloqueado"
                    : "Permissão do microfone"}
              </span>
            </div>
          )}

          {respondendoA && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-[var(--nx-primary)] bg-[var(--nx-surface-2)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-[var(--nx-primary-text)]">
                  Respondendo{respondendoA.remetenteNome ? ` a ${respondendoA.remetenteNome}` : ""}
                </p>
                <p className="truncate text-xs text-[var(--nx-text-2)]">
                  {respondendoA.texto || "[mídia]"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRespondendoA(null)}
                aria-label="Cancelar resposta"
                className="nx-conv-iconbtn h-6 w-6"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {quick.panel}
          {quick.missingVariables.length > 0 && <p role="status" className="business-note">Preencha antes de enviar: {quick.missingVariables.join(", ")}.</p>}
          <div className="nx-whatsapp-input-row">
          <details className="nx-whatsapp-attachments" onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.stopPropagation(); } }}>
            <summary className="nx-conv-iconbtn" aria-label="Anexar" title="Anexar"><Plus size={20} /></summary>
            <div className="nx-conv-menu">
              <button type="button" onClick={event => { event.currentTarget.closest("details")!.open = false; onAnexarArquivo("media"); }}><ImageIcon size={16} />Foto, vídeo ou áudio</button>
              <button type="button" onClick={event => { event.currentTarget.closest("details")!.open = false; onAnexarArquivo("document"); }}><Paperclip size={16} />Documento</button>
              <MessageTemplatePicker channel="whatsapp" clientName={displayName} onApply={({ body }) => setResposta(body)} />
            </div>
          </details>
          <button type="button" data-emoji-panel-root onClick={() => setMostrarPainelEmojis(!mostrarPainelEmojis)} title="Emoji" aria-pressed={mostrarPainelEmojis} className="nx-conv-iconbtn" aria-label="Emoji"><Smile size={18} /></button>
          <input
            type="text"
            value={resposta}
            {...quick.inputProps}
            disabled={gravando || enviandoAnexos}
            onChange={(event) => setResposta(event.target.value)}
            onKeyDown={(event) => { if (quick.onKeyDown(event)) return; if (event.key === "Enter") acionarEnviar(); }}
            placeholder={gravando ? `Gravando áudio: ${formatarTempo(tempoGravacao)}` : "Mensagem · / para respostas rápidas"}
            aria-label="Mensagem"
            className="nx-conv-composer-input"
          />

          {(gravando || (!resposta.trim() && anexosPendentes.length === 0)) ? (
            <button type="button" onClick={onGravarAudio} disabled={enviandoAnexos} title={gravando ? "Parar gravação" : "Áudio"} className={`nx-conv-send ${gravando ? "is-recording" : ""}`} aria-label="Audio"><Mic size={19} /></button>
          ) : <button
                type="button"
                onClick={acionarEnviar}
                disabled={enviandoAnexos || quick.missingVariables.length > 0 || (!resposta.trim() && anexosPendentes.length === 0)}
                title="Enviar"
                className="nx-conv-send"
                aria-label="Enviar">
                <SendHorizontal size={19} />
              </button>}
          </div>
        </div>
        </>}
      </div>

      {editandoMensagem && (
        <div className="fixed inset-0 z-[225] flex items-center justify-center bg-black/50 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="edit-message-title" className="nx-conv-panel w-full max-w-lg p-5 shadow-2xl">
            <div className="flex items-center justify-between"><div><h3 id="edit-message-title" className="text-[15px] font-semibold">Editar mensagem enviada</h3><p className="mt-1 text-[12.5px] text-[var(--nx-text-2)]">A alteração será sincronizada com o WhatsApp.</p></div><button type="button" onClick={() => setEditandoMensagem(null)} disabled={salvandoEdicao} aria-label="Fechar edição" className="nx-conv-iconbtn h-8 w-8"><X size={16} /></button></div>
            <textarea autoFocus value={textoEdicao} onChange={(event) => setTextoEdicao(event.target.value)} rows={5} className="nx-conv-field mt-4 w-full resize-y p-3 text-sm leading-6" />
            <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setEditandoMensagem(null)} disabled={salvandoEdicao}>Cancelar</Button><Button onClick={() => void salvarEdicao()} loading={salvandoEdicao} disabled={!textoEdicao.trim()}>Salvar edição</Button></div>
          </section>
        </div>
      )}

      {!inboxId && <MessageNoraActions conversationId={conversaAtiva.id} request={noraRequest} onClose={() => setNoraRequest(null)} onUseReply={usarRespostaNora} onFeedback={onFeedback} />}
    </section>
  );
}
