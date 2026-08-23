import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  Clock3,
  Copy,
  CornerUpRight,
  FileText,
  Languages,
  Maximize2,
  Mic,
  MoreVertical,
  Paperclip,
  Pause,
  Play,
  Search,
  SendHorizontal,
  Smile,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import type { AnexoPendente, ChatConversa, MsgConteudo } from "./types";
import Button from "../shared/Button";
import { useAuthenticatedMedia } from "./useAuthenticatedMedia";

interface AreaCentralProps {
  conversaAtiva: ChatConversa | undefined;
  onEnviar: (texto: string) => void | Promise<void>;
  onAbrirDadosPerfil: () => void;
  onAnexarArquivo: () => void;
  onGravarAudio: () => void;
  gravando: boolean;
  tempoGravacao: number;
  formatarTempo: (segundos: number) => string;
  anexosPendentes: AnexoPendente[];
  enviandoAnexos: boolean;
  statusMicrofone: "idle" | "solicitando" | "liberado" | "negado";
  onRemoverAnexo: (id: string) => void;
  onLimparAnexos: () => void;
  onApagarMensagensEmMassa: (mensagensIds: string[]) => void;
  onEncaminharMensagens: (mensagensIds: string[]) => void;
  onCarregarMensagensAntigas: () => Promise<void>;
  temMaisMensagens: boolean;
  carregandoMensagens: boolean;
  onReagirMensagem: (messageId: string, emoji: string) => void | Promise<void>;
  onEscolherFigurinha: () => void;
  figurinhasRecentes: MsgConteudo[];
  onEnviarFigurinhaExistente: (figurinha: MsgConteudo) => void | Promise<void>;
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
  const [failed, setFailed] = useState(false);
  const photoUrl = useAuthenticatedMedia(conversa.metadados?.photoUrl || conversa.photoUrl);

  return (
    <div className="h-10 w-10 rounded-full bg-[var(--background)] border border-[var(--border)] flex items-center justify-center overflow-hidden shrink-0 text-[var(--text-secondary)]">
      {photoUrl && !failed ? (
        <img src={photoUrl} alt={conversa.contato} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : conversa.esGrupo ? (
        <Users size={17} />
      ) : conversa.contato ? (
        <span className="text-xs font-extrabold">{initials(conversa.contato)}</span>
      ) : (
        <User size={17} />
      )}
    </div>
  );
}

function ParticipantAvatar({ conversa, message }: { conversa: ChatConversa; message: MsgConteudo }) {
  const participant = conversa.metadados?.participantes?.find((item) => item.id === message.remetenteId || item.phone === message.remetenteId);
  const photoUrl = useAuthenticatedMedia(participant?.photoUrl);
  return (
    <div className="mb-0.5 grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface)] text-[9px] font-extrabold text-[var(--text-secondary)]">
      {photoUrl ? <img src={photoUrl} alt={message.remetenteNome || "Participante"} className="h-full w-full object-cover" /> : initials(message.remetenteNome || "?")}
    </div>
  );
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

function MediaLightbox({ src, kind, onClose }: { src: string; kind: "image" | "video"; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Fechar"
        className="absolute right-4 top-4 z-10 grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white transition hover:bg-white/25"
      >
        <X size={20} />
      </button>
      {kind === "video" ? (
        <video
          src={src}
          controls
          autoPlay
          className="max-h-[92vh] max-w-[92vw]"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          src={src}
          alt="Midia em tela cheia"
          className="max-h-[92vh] max-w-[92vw] object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}

function MessageMedia({ msg, outgoing }: { msg: MsgConteudo; outgoing: boolean }) {
  const mime = msg.arquivoMime || "";
  const fileName = msg.nomeArquivo || "Arquivo";
  const looksVideo = mime.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(fileName);
  const mediaUrl = useAuthenticatedMedia(msg.arquivoUrl);
  const [telaCheia, setTelaCheia] = useState(false);

  if (!msg.arquivoUrl) {
    return <p className="text-sm font-medium">{msg.texto || "Midia sem URL disponivel"}</p>;
  }

  if (msg.tipo === "audio") {
    return mediaUrl ? <AudioMessage src={mediaUrl} outgoing={outgoing} /> : null;
  }

  if (msg.tipo === "sticker") {
    return (
      <div className="h-36 w-36 bg-transparent">
        {mediaUrl ? <img src={mediaUrl} alt="Figurinha" className="h-full w-full object-contain" /> : null}
      </div>
    );
  }

  if (msg.tipo === "documento") {
    return (
      <a href={mediaUrl || undefined} download={fileName} className={`flex max-w-[320px] items-center gap-3 rounded-lg p-3 ${outgoing ? "bg-white/15" : "bg-[var(--background)]"}`}>
        <FileText size={24} />
        <span className="min-w-0 flex-1 truncate text-xs font-bold">{fileName}</span>
      </a>
    );
  }

  if (looksVideo) {
    return (
      <div className="max-w-[420px] overflow-hidden rounded-lg">
        {mediaUrl ? (
          <div className="group relative">
            <video src={mediaUrl} controls className="max-h-[320px] w-full bg-black" />
            <button
              type="button"
              onClick={() => setTelaCheia(true)}
              aria-label="Abrir em tela cheia"
              title="Tela cheia"
              className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white opacity-0 transition group-hover:opacity-100"
            >
              <Maximize2 size={15} />
            </button>
          </div>
        ) : null}
        {msg.texto && msg.texto !== "[Video]" && <p className="mt-2 text-sm font-medium">{msg.texto}</p>}
        {telaCheia && mediaUrl && <MediaLightbox src={mediaUrl} kind="video" onClose={() => setTelaCheia(false)} />}
      </div>
    );
  }

  return (
    <div className="max-w-[420px] overflow-hidden rounded-lg">
      {mediaUrl ? (
        <img
          src={mediaUrl}
          alt={msg.texto || "Imagem"}
          onClick={() => setTelaCheia(true)}
          className="max-h-[320px] w-full cursor-zoom-in object-contain bg-black/5"
        />
      ) : null}
      {msg.texto && msg.texto !== "[Imagem]" && <p className="mt-2 text-sm font-medium">{msg.texto}</p>}
      {telaCheia && mediaUrl && <MediaLightbox src={mediaUrl} kind="image" onClose={() => setTelaCheia(false)} />}
    </div>
  );
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

function AttachmentPreviewCard({ anexo, onRemover }: { anexo: AnexoPendente; onRemover: (id: string) => void }) {
  return (
    <div className={`relative h-32 shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--text)] ${anexo.tipo === "audio" ? "w-[340px]" : "w-44"}`}>
      <Button variant="ghost" iconOnly
        onClick={() => onRemover(anexo.id)}
        className="absolute right-1.5 top-1.5 z-10 h-7 w-7 rounded-full bg-black/65 shadow"
        title="Remover anexo"
       aria-label="Remover anexo">
        <X size={14} />
      </Button>

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
}: {
  anexos: AnexoPendente[];
  onRemover: (id: string) => void;
  onLimpar: () => void;
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
          <AttachmentPreviewCard key={anexo.id} anexo={anexo} onRemover={onRemover} />
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
  onGravarAudio,
  gravando,
  tempoGravacao,
  formatarTempo,
  anexosPendentes,
  enviandoAnexos,
  statusMicrofone,
  onRemoverAnexo,
  onLimparAnexos,
  onApagarMensagensEmMassa,
  onEncaminharMensagens,
  onCarregarMensagensAntigas,
  temMaisMensagens,
  carregandoMensagens,
  onReagirMensagem,
  onEscolherFigurinha,
  figurinhasRecentes,
  onEnviarFigurinhaExistente,
}: AreaCentralProps) {
  const [resposta, setResposta] = useState("");
  const [mostrarPesquisa, setMostrarPesquisa] = useState(false);
  const [termoPesquisa, setTermoPesquisa] = useState("");
  const [traduzirChat, setTraduzirChat] = useState(false);
  const [menuMensagemId, setMenuMensagemId] = useState<string | null>(null);
  const [modoSelecao, setModoSelecao] = useState(false);
  const [selecionadas, setSelecionadas] = useState<string[]>([]);
  const [mostrarPainelEmojis, setMostrarPainelEmojis] = useState(false);
  const [modoPainelEmojis, setModoPainelEmojis] = useState<"emoji" | "figurinha">("emoji");
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
    if (container.scrollTop <= 80) carregarAnterioresPreservandoPosicao();
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

  if (!conversaAtiva) {
    return (
      <div className="norium-chat-thread flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--background)] text-sm font-semibold text-[var(--text-secondary)]">
        Selecione uma conversa para comecar.
      </div>
    );
  }

  const mensagensFiltradas = conversaAtiva.mensagens.filter((mensagem) => {
    if (!termoPesquisa) return true;
    return mensagem.texto?.toLowerCase().includes(termoPesquisa.toLowerCase());
  });

  const acionarEnviar = () => {
    const texto = resposta.trim();
    if (!texto && anexosPendentes.length === 0) return;
    void onEnviar(texto);
    setResposta("");
  };

  const alternarSelecaoMensagem = (id: string) => {
    setSelecionadas((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  return (
    <section className="norium-chat-thread flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--background)]">
      {!modoSelecao ? (
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4">
          <button className="min-w-0 flex items-center gap-3 text-left" onClick={onAbrirDadosPerfil}>
            <HeaderAvatar conversa={conversaAtiva} />
            <div className="min-w-0">
              <h3 className="font-semibold text-sm truncate text-[var(--text)]">{conversaAtiva.contato}</h3>
              <p className="text-xs text-[var(--text-secondary)] truncate">
                {conversaAtiva.esGrupo ? `${conversaAtiva.metadados?.participantes?.length || 0} participantes` : conversaAtiva.metadados?.numeroCompleto || conversaAtiva.id}
              </p>
            </div>
          </button>

          <div className="flex items-center gap-1">
            <button title="Pesquisar" onClick={() => setMostrarPesquisa(!mostrarPesquisa)} className={`h-9 w-9 rounded-lg flex items-center justify-center transition ${mostrarPesquisa ? "bg-[var(--primary)] text-white" : "hover:bg-[var(--surface-hover)] text-[var(--text)]"}`} aria-label="Pesquisar">
              <Search size={17} />
            </button>
            <button title="Traduzir" onClick={() => setTraduzirChat(!traduzirChat)} className={`h-9 w-9 rounded-lg flex items-center justify-center transition ${traduzirChat ? "bg-[var(--primary)] text-white" : "hover:bg-[var(--surface-hover)] text-[var(--text)]"}`} aria-label="Traduzir">
              <Languages size={17} />
            </button>
            <Button size="sm" onClick={onAbrirDadosPerfil}>
              Dados
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 text-[var(--text)]">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" iconOnly onClick={() => { setModoSelecao(false); setSelecionadas([]); }}>
              <X size={17} />
            </Button>
            <span className="text-sm font-bold">{selecionadas.length} selecionadas</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => { onEncaminharMensagens(selecionadas); setModoSelecao(false); setSelecionadas([]); }}>
              <CornerUpRight size={14} /> Encaminhar
            </Button>
            <Button variant="danger" size="sm" onClick={() => { onApagarMensagensEmMassa(selecionadas); setModoSelecao(false); setSelecionadas([]); }} className="bg-red-600">
              <Trash2 size={14} /> Apagar
            </Button>
          </div>
        </div>
      )}

      {mostrarPesquisa && (
        <div className="flex shrink-0 gap-2 border-b border-[var(--border)] bg-[var(--surface)] p-2.5">
          <input
            type="text"
            placeholder="Buscar nesta conversa"
            value={termoPesquisa}
            onChange={(event) => setTermoPesquisa(event.target.value)}
            className="flex-1 h-9 bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 text-sm outline-none text-[var(--text)]"
          />
          <Button variant="ghost" size="sm" iconOnly onClick={() => { setTermoPesquisa(""); setMostrarPesquisa(false); }}>
            <X size={15} />
          </Button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleMessageScroll}
        className="norium-chat-message-scroll norium-chat-wallpaper min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-8 py-6"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20px 20px, rgba(255,255,255,0.035) 1px, transparent 1.4px), radial-gradient(circle at 70px 60px, rgba(255,255,255,0.025) 1.4px, transparent 1.8px)",
          backgroundSize: "96px 96px",
        }}
      >
        {(temMaisMensagens || carregandoMensagens) && (
          <div className="flex justify-center pb-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={carregandoMensagens}
              onClick={carregarAnterioresPreservandoPosicao}
              className="rounded-full bg-[var(--surface)]/80 text-[var(--text)]"
            >
              {carregandoMensagens ? "Carregando mensagens..." : "Carregar mensagens anteriores"}
            </Button>
          </div>
        )}
        {mensagensFiltradas.map((msg) => {
          const outgoing = msg.remetente === "usuario";
          const estaSelecionada = selecionadas.includes(msg.id);

          return (
            <div key={msg.id} onClick={() => modoSelecao && alternarSelecaoMensagem(msg.id)} className={`flex w-full items-end gap-3 group ${outgoing ? "justify-end" : "justify-start"} ${modoSelecao ? "cursor-pointer" : ""}`}>
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
                className={`norium-message-bubble relative max-w-[min(66%,620px)] rounded-xl px-3 py-2 shadow-sm ${outgoing ? "norium-message-outgoing text-white" : "norium-message-incoming text-[var(--text)]"} ${estaSelecionada ? "ring-2 ring-[var(--primary)]" : ""}`}
                data-message-menu-root
              >
                {!modoSelecao && (
                  <button onClick={(event) => { event.stopPropagation(); setMenuMensagemId(menuMensagemId === msg.id ? null : msg.id); }} className="absolute top-1 right-1 h-7 w-7 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition hover:bg-black/20">
                    <MoreVertical size={14} />
                  </button>
                )}

                {menuMensagemId === msg.id && (
                  <div className="absolute right-1 top-8 z-50 w-48 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 text-xs font-bold text-[var(--text)] shadow-xl">
                    <div className="flex items-center justify-between border-b border-[var(--border)] px-2 py-1.5">
                      {["👍", "❤️", "😂", "😮", "😢", "🙏"].map((emoji) => (
                        <button key={emoji} className="grid h-7 w-7 place-items-center rounded-full text-base hover:bg-[var(--surface-hover)]" onClick={() => { void onReagirMensagem(msg.id, emoji); setMenuMensagemId(null); }} aria-label={`Reagir com ${emoji}`}>{emoji}</button>
                      ))}
                    </div>
                    <button onClick={() => { if (msg.texto) void navigator.clipboard.writeText(msg.texto); setMenuMensagemId(null); }} className="flex items-center gap-2 px-3 py-2 w-full hover:bg-[var(--surface-hover)] text-left">
                      <Copy size={13} /> Copiar
                    </button>
                    <button onClick={() => { setModoSelecao(true); setSelecionadas([msg.id]); setMenuMensagemId(null); }} className="flex items-center gap-2 px-3 py-2 w-full hover:bg-[var(--surface-hover)] text-left">
                      <Check size={13} /> Selecionar
                    </button>
                    <button onClick={() => { onApagarMensagensEmMassa([msg.id]); setMenuMensagemId(null); }} className="flex items-center gap-2 px-3 py-2 w-full hover:bg-[var(--surface-hover)] text-red-500 text-left">
                      <Trash2 size={13} /> Apagar
                    </button>
                  </div>
                )}

                {msg.remetenteNome && !outgoing && (
                  <span className="mb-1 block text-xs font-extrabold text-[var(--primary)]">~ {msg.remetenteNome}</span>
                )}

                {msg.citada?.content && (
                  <div className="mb-1.5 rounded-md border-l-2 border-[var(--primary)] bg-black/10 px-2 py-1 text-xs opacity-80">
                    {msg.citada.senderName && <span className="block font-bold text-[var(--primary)]">{msg.citada.senderName}</span>}
                    <span className="line-clamp-2">{msg.citada.content}</span>
                  </div>
                )}

                {msg.tipo === "texto" ? (
                  <p className="whitespace-pre-wrap break-words pr-6 text-sm leading-relaxed font-medium">{msg.texto}</p>
                ) : (
                  <MessageMedia msg={msg} outgoing={outgoing} />
                )}

                <div className="mt-1 flex items-center justify-end gap-1 opacity-70">
                  <span className="text-xs font-medium">{msg.horario}</span>
                  {outgoing && <MessageStatus status={msg.status} />}
                </div>
                {Boolean(msg.reacoes?.length) && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {msg.reacoes?.map((reaction, index) => (
                      <button
                        key={`${reaction.emoji}-${index}`}
                        onClick={() => void onReagirMensagem(msg.id, reaction.fromMe ? "" : reaction.emoji)}
                        className={`rounded-full border px-1.5 py-0.5 text-xs shadow-sm ${reaction.fromMe ? "border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_18%,var(--surface))]" : "border-[var(--border)] bg-[var(--surface)]"}`}
                        title={reaction.fromMe ? "Remover sua reacao" : "Reagir igual"}
                      >
                        {reaction.emoji}{reaction.count > 1 ? ` ${reaction.count}` : ""}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="norium-chat-composer relative shrink-0 border-t border-[var(--border)] bg-[var(--surface)] p-3">
        {mostrarPainelEmojis && (
          <div data-emoji-panel-root className="absolute bottom-16 left-4 z-50 w-[340px] max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-xs font-bold text-[var(--text)] shadow-2xl">
            <div className="flex border-b border-[var(--border)] p-1.5">
              <button onClick={() => setModoPainelEmojis("emoji")} className={`flex-1 rounded-lg px-3 py-2 ${modoPainelEmojis === "emoji" ? "bg-[var(--surface-hover)] text-[var(--primary)]" : "text-[var(--text-secondary)]"}`}>Emojis</button>
              <button onClick={() => setModoPainelEmojis("figurinha")} className={`flex-1 rounded-lg px-3 py-2 ${modoPainelEmojis === "figurinha" ? "bg-[var(--surface-hover)] text-[var(--primary)]" : "text-[var(--text-secondary)]"}`}>Figurinhas</button>
            </div>
            {modoPainelEmojis === "emoji" ? (
              <div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto p-3 text-xl">
                {["😀", "😃", "😄", "😁", "😆", "😂", "🤣", "😊", "😍", "🥰", "😘", "😎", "🤩", "🥳", "😢", "😭", "😡", "🤯", "😴", "🤔", "🫡", "👍", "👎", "👏", "🙌", "🙏", "💪", "🔥", "❤️", "💙", "💚", "✨", "🎉", "🚀", "✅", "👀", "💬", "📌", "📷", "🎧"].map((emoji) => (
                  <button className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--surface-hover)]" key={emoji} onClick={() => setResposta((prev) => prev + emoji)}>{emoji}</button>
                ))}
              </div>
            ) : (
              <div className="p-3">
                <p className="mb-2 px-1 text-left font-bold text-[var(--text-secondary)]">Figurinhas recentes</p>
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
                  <p className="rounded-xl bg-[var(--background)] p-4 text-center font-medium text-[var(--text-secondary)]">As figurinhas usadas nas suas conversas aparecerao aqui.</p>
                )}
                <Button variant="ghost" onClick={() => { onEscolherFigurinha(); setMostrarPainelEmojis(false); }} className="mt-3 w-full">Adicionar nova figurinha</Button>
              </div>
            )}
          </div>
        )}

        <AttachmentPreviewTray anexos={anexosPendentes} onRemover={onRemoverAnexo} onLimpar={onLimparAnexos} />

        {(gravando || statusMicrofone === "solicitando" || statusMicrofone === "negado") && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs font-bold text-[var(--text)]">
            <span className={`h-2 w-2 rounded-full ${gravando ? "animate-pulse bg-red-500" : statusMicrofone === "negado" ? "bg-red-500" : "bg-amber-400"}`} />
            <span>
              {gravando
                ? `Gravando audio: ${formatarTempo(tempoGravacao)}`
                : statusMicrofone === "negado"
                  ? "Microfone bloqueado"
                  : "Permissao do microfone"}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button size="lg" iconOnly onClick={onAnexarArquivo} title="Anexar" aria-label="Anexar">
            <Paperclip size={19} />
          </Button>
          <button data-emoji-panel-root onClick={() => setMostrarPainelEmojis(!mostrarPainelEmojis)} title="Emoji" className={`h-11 w-11 border rounded-lg flex items-center justify-center transition ${mostrarPainelEmojis ? "bg-[var(--primary)] text-white border-transparent" : "border-[var(--border)] hover:bg-[var(--surface-hover)] text-[var(--text)]"}`} aria-label="Emoji">
            <Smile size={19} />
          </button>
          <input
            type="text"
            value={resposta}
            disabled={gravando || enviandoAnexos}
            onChange={(event) => setResposta(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") acionarEnviar(); }}
            placeholder={gravando ? `Gravando audio: ${formatarTempo(tempoGravacao)}` : "Digite uma mensagem"}
            className="h-11 min-w-0 flex-1 bg-[var(--background)] border border-[var(--border)] rounded-lg px-4 text-sm outline-none focus:border-[var(--primary)] text-[var(--text)]"
          />
          <button onClick={onGravarAudio} disabled={enviandoAnexos} title="Audio" className={`h-11 w-11 border rounded-lg flex items-center justify-center ${gravando ? "bg-red-500 text-white animate-pulse border-transparent" : "border-[var(--border)] hover:bg-[var(--surface-hover)] text-[var(--text)]"} ${enviandoAnexos ? "opacity-50" : ""}`} aria-label="Audio">
            <Mic size={19} />
          </button>
          <button
            onClick={acionarEnviar}
            disabled={enviandoAnexos || (!resposta.trim() && anexosPendentes.length === 0)}
            title="Enviar"
            className={`h-11 w-11 bg-[var(--primary)] text-white rounded-lg flex items-center justify-center shadow-sm ${enviandoAnexos || (!resposta.trim() && anexosPendentes.length === 0) ? "opacity-50" : ""}`}
           aria-label="Enviar">
            <SendHorizontal size={18} />
          </button>
        </div>
      </div>
    </section>
  );
}
