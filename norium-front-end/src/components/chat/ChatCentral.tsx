import { useCallback, useState, useEffect, useRef } from "react";
import SidebarEsquerda from "./SidebarEsquerda";
import AreaCentralChat from "./AreaCentralChat";
import PainelDireito from "./PainelDireito";
import { Menu, X, Search, User, Send } from "lucide-react";
import type { AnexoPendente, ChatConversa, MsgConteudo } from "./types";
import { apiBaseUrl } from "../../utils/api";
import StatusBanner from "../shared/StatusBanner";
import ConfirmDialog from "../shared/ConfirmDialog";
import Button from "../shared/Button";
import { whatsappApi, type Contact, type WhatsAppConnection } from "./whatsappApi";

const BACKEND_URL = apiBaseUrl();

interface ChatCentralProps {
  userId?: string;
  onConversaAtivaChange?: (conversaId: string | null) => void;
  onOpenNora?: (prompt?: string) => void;
}

export default function ChatCentral({ userId = "primary", onConversaAtivaChange, onOpenNora }: ChatCentralProps) {
  const [loadingStatus, setLoadingStatus] = useState<boolean>(true);
  const [canaisStatus, setCanaisStatus] = useState<{ whatsapp?: WhatsAppConnection }>({});
  const [canalSelecionadoLogin, setCanalSelecionadoLogin] = useState<"whatsapp" | null>(null);
  const [qrCodeString, setQrCodeString] = useState<string | null>(null);
  const [erroLogin, setErroLogin] = useState<string | null>(null);
  const [mensagemLogin, setMensagemLogin] = useState<string | null>(null);

  const [conversas, setConversas] = useState<ChatConversa[]>([]);
  const [conversaSelecionada, setConversaSelecionada] = useState<string | null>(null);
  const [painelPerfilAberto, setPainelPerfilAberto] = useState<boolean>(false);
  const [abaDireitaModo, setAbaDireitaModo] = useState<"nora" | "perfil" | "config-propria">("nora");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const [modalContatosAberto, setModalContatosAberto] = useState<boolean>(false);
  const [modalGrupoAberto, setModalGrupoAberto] = useState<boolean>(false);
  const [modalConfigAberto, setModalConfigAberto] = useState<boolean>(false);
  const [listaContatos, setListaContatos] = useState<Contact[]>([]);
  const [filtroContatoNome, setFiltroContatoNome] = useState<string>("");

  const [nomeNovoGrupo, setNomeNovoGrupo] = useState("");
  const [contatosSelecionadosGrupo, setContatosSelecionadosGrupo] = useState<string[]>([]);

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
  const cursorConversasRef = useRef(0);
  const whatsappConectadoRef = useRef(false);
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

  const carregarConversasDoBackend = useCallback(async (incremental = false, refresh = false) => {
    if (carregandoConversasRef.current) return null;
    carregandoConversasRef.current = true;
    try {
      const since = incremental && cursorConversasRef.current > 0 ? cursorConversasRef.current : undefined;
      const payload = await whatsappApi.conversations(since, refresh);
      const data = Array.isArray(payload) ? payload : payload.items;
      const nextCursor = Array.isArray(payload)
        ? Math.max(0, ...data.map((item) => Number(item.timestampUltimaMsg || 0)))
        : Number(payload.cursor || cursorConversasRef.current);
      cursorConversasRef.current = Math.max(cursorConversasRef.current, nextCursor);
      setConversas((current) => {
        if (Array.isArray(payload)) return data;
        if (!data.length) return current;
        const merged = new Map(current.map((item) => [item.id, item]));
        data.forEach((item) => merged.set(item.id, item));
        return [...merged.values()].sort(
          (left, right) => Number(right.timestampUltimaMsg || 0) - Number(left.timestampUltimaMsg || 0),
        );
      });
      return data;
    } catch (err) {
      mostrarAviso("error", err instanceof Error ? err.message : "Falha ao carregar conversas.");
      return null;
    } finally {
      carregandoConversasRef.current = false;
    }
  }, [mostrarAviso, userId]);

  const carregarHistorico = useCallback(async (conversationId: string, older = false) => {
    if (historicoCarregandoId === conversationId) return;
    const currentPage = historicoRef.current.get(conversationId);
    if (older && currentPage?.hasMore === false) return;
    setHistoricoCarregandoId(conversationId);
    try {
      const page = await whatsappApi.history(conversationId, older ? currentPage?.cursor : undefined);
      setConversas((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        const merged = new Map<string, MsgConteudo>();
        for (const message of [...conversation.mensagens, ...page.items]) merged.set(message.id, message);
        return {
          ...conversation,
          mensagens: [...merged.values()].sort(
            (left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0),
          ),
        };
      }));
      historicoRef.current.set(conversationId, { cursor: page.cursor, hasMore: page.hasMore });
    } catch (error) {
      mostrarAviso("error", error instanceof Error ? error.message : "Falha ao carregar o historico do WhatsApp.");
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
    cursorConversasRef.current = 0;
    historicoRef.current.clear();
    setConversas([]);
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

    async function checarAutenticacao() {
      try {
        const whatsapp = await whatsappApi.status();
        if (!active) return;
        const conectado = whatsapp.conectado === true;
        const estavaConectado = whatsappConectadoRef.current;
        whatsappConectadoRef.current = conectado;
        setCanaisStatus({ whatsapp });
        if (conectado) {
          if (!estavaConectado) {
            await carregarConversasDoBackend();
            catalogoInicialTentadoRef.current = true;
          }
        } else if (!catalogoInicialTentadoRef.current) {
          catalogoInicialTentadoRef.current = true;
          await carregarConversasDoBackend();
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
        if (active) setLoadingStatus(false);
      }
    }

    void checarAutenticacao();
    const intervalo = window.setInterval(() => void checarAutenticacao(), 12_000);
    return () => {
      active = false;
      window.clearInterval(intervalo);
    };
  }, [carregarConversasDoBackend, userId]);

  useEffect(() => {
    if (canalSelecionadoLogin !== "whatsapp") return;
    let active = true;

    const atualizarQrCode = async () => {
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
          await carregarConversasDoBackend();
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
      }
    };

    void atualizarQrCode();
    const interval = window.setInterval(() => void atualizarQrCode(), 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [canalSelecionadoLogin, carregarConversasDoBackend, userId]);

  useEffect(() => {
    const atualizarSeVisivel = () => {
      if (!document.hidden && !canalSelecionadoLogin && canaisStatus.whatsapp?.conectado) {
        void carregarConversasDoBackend(true);
      }
    };
    const intervaloChats = window.setInterval(atualizarSeVisivel, 30_000);
    document.addEventListener("visibilitychange", atualizarSeVisivel);
    return () => {
      window.clearInterval(intervaloChats);
      document.removeEventListener("visibilitychange", atualizarSeVisivel);
    };
  }, [canalSelecionadoLogin, canaisStatus.whatsapp?.conectado, carregarConversasDoBackend]);

  useEffect(() => {
    const atualizarEmTempoReal = () => {
      if (!whatsappConectadoRef.current) return;
      void carregarConversasDoBackend(true);
      if (conversaSelecionada) {
        historicoRef.current.delete(conversaSelecionada);
        void carregarHistorico(conversaSelecionada);
      }
    };
    window.addEventListener("norium:whatsapp-event", atualizarEmTempoReal);
    return () => window.removeEventListener("norium:whatsapp-event", atualizarEmTempoReal);
  }, [carregarConversasDoBackend, carregarHistorico, conversaSelecionada]);

  const abrirAgendaContatos = async () => {
    setModalContatosAberto(true);
    try {
      setListaContatos(await whatsappApi.contacts());
    } catch (err) { mostrarAviso("error", err instanceof Error ? err.message : "Falha ao carregar contatos."); }
  };

  const abrirModalGrupo = async () => {
    setModalGrupoAberto(true);
    try {
      setListaContatos(await whatsappApi.contacts());
    } catch (err) { mostrarAviso("error", err instanceof Error ? err.message : "Falha ao carregar contatos."); }
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
    try {
      await whatsappApi.createGroup(nomeNovoGrupo.trim(), contatosSelecionadosGrupo);
      mostrarAviso("success", `Grupo "${nomeNovoGrupo}" criado no WhatsApp.`);
      setModalGrupoAberto(false);
      setNomeNovoGrupo("");
      setContatosSelecionadosGrupo([]);
      await carregarConversasDoBackend();
    } catch (error) {
      mostrarAviso("error", error instanceof Error ? error.message : "Nao foi possivel criar o grupo.");
    }
  };

  const selecionarConversa = async (id: string) => {
    setConversaSelecionada(id);
    setPainelPerfilAberto(false);
    setMobileSidebarOpen(false);
    const selected = conversas.find((conversation) => conversation.id === id);
    if (!historicoRef.current.has(id) || !selected?.mensagens.length) void carregarHistorico(id);
    void whatsappApi.details(id).then((details) => {
      setConversas((current) => current.map((conversation) => (
        conversation.id === id
          ? { ...conversation, ...details, mensagens: details.mensagens?.length ? details.mensagens : conversation.mensagens }
          : conversation
      )));
    }).catch(() => undefined);
    try {
      await whatsappApi.markConversation(id, "lida", true);
      carregarConversasDoBackend();
    } catch (error) { mostrarAviso("error", error instanceof Error ? error.message : "Falha ao marcar conversa como lida."); }
  };

  const atualizarCatalogo = useCallback(async () => {
    setSincronizandoCatalogo(true);
    try {
      const result = await carregarConversasDoBackend(false, true);
      if (result) mostrarAviso("success", "Conversas, contatos e grupos atualizados.");
    } finally {
      setSincronizandoCatalogo(false);
    }
  }, [carregarConversasDoBackend, mostrarAviso]);

  const abrirDadosPerfil = useCallback(async () => {
    if (!conversaSelecionada) return;
    setPainelPerfilAberto(true);
    setAbaDireitaModo("perfil");
    try {
      const details = await whatsappApi.details(conversaSelecionada);
      setConversas((current) => current.map((conversation) => (
        conversation.id === conversaSelecionada
          ? { ...conversation, ...details, mensagens: details.mensagens?.length ? details.mensagens : conversation.mensagens }
          : conversation
      )));
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

  const handleEnviarMensagem = async (texto: string) => {
    const textoLimpo = texto.trim();
    const anexosParaEnviar = [...anexosPendentesRef.current];
    if (!conversaSelecionada || (!textoLimpo && anexosParaEnviar.length === 0)) return;

    setEnviandoAnexos(true);
    const anexosEnviados = new Set<string>();
    try {
      if (textoLimpo) {
        await whatsappApi.sendText(conversaSelecionada, textoLimpo);
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

  const handleApagarMensagensMassa = async (mensagensIds: string[]) => {
    if (!conversaSelecionada) return;
    for (const msgId of mensagensIds) {
      try {
        await whatsappApi.deleteMessage(conversaSelecionada, msgId);
      } catch (err) { mostrarAviso("error", err instanceof Error ? err.message : "Falha ao apagar mensagem."); }
    }
    carregarConversasDoBackend();
  };

  const handleAcaoChat = async (id: string, acao: "lida" | "fixada" | "favorita" | "silenciada" | "arquivada", valor: boolean) => {
    try {
      await whatsappApi.markConversation(id, acao, valor);
      carregarConversasDoBackend();
    } catch (err) { mostrarAviso("error", err instanceof Error ? err.message : "Falha ao atualizar conversa."); }
  };

  const handleIniciarLogin = async (canal: "whatsapp") => {
    setCanalSelecionadoLogin(canal);
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
    } catch (error) { setErroLogin(error instanceof Error ? error.message : "Erro de conexao."); }
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
    const destino = conversas.find((c) => c.id === destinoEncaminhar);
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

  const conversaAtiva = conversas.find(c => c.id === conversaSelecionada);
  const paginaHistoricoAtiva = conversaSelecionada ? historicoRef.current.get(conversaSelecionada) : undefined;
  const nenhumConectado = !canaisStatus.whatsapp?.conectado && conversas.length === 0;

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

  if (canalSelecionadoLogin === "whatsapp") {
    return (
      <div className="w-full h-full min-h-0 overflow-y-auto flex items-start sm:items-center justify-center bg-[var(--background)] p-4 sm:p-6 font-sans">
        <div className="w-full max-w-[420px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 sm:p-7 text-center space-y-4 text-xs font-bold text-[var(--text)] shadow-2xl">
          <div>
            <h3 className="text-base font-extrabold text-[var(--primary)]">Conectar WhatsApp</h3>
            <p className="mt-2 text-[var(--text-secondary)] leading-5">O QR Code e gerado pela API privada do Norium e atualizado automaticamente nesta tela.</p>
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
      {!canaisStatus.whatsapp?.conectado && conversas.length > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-[65] -translate-x-1/2 rounded-full border border-[var(--primary)]/30 bg-[var(--surface)]/95 px-3 py-1.5 text-[11px] font-bold text-[var(--primary)] shadow-lg backdrop-blur">
          Reconectando a sessao. O cache permanece disponivel.
        </div>
      )}
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
      <SidebarEsquerda 
        conversas={conversas} conversaSelecionada={conversaSelecionada} 
        onSelecionar={selecionarConversa} onAcao={handleAcaoChat} onExcluir={handleExcluirChat}
        onAbrirConfigPropria={() => setModalConfigAberto(true)}
        onAbrirModalContatos={abrirAgendaContatos}
        onAbrirModalCriarGrupo={abrirModalGrupo}
        onAtualizar={() => void atualizarCatalogo()}
        sincronizando={sincronizandoCatalogo}
        onClose={() => setMobileSidebarOpen(false)}
      />
      
      <AreaCentralChat 
        key={conversaAtiva?.id || "vazio"}
        conversaAtiva={conversaAtiva} onEnviar={handleEnviarMensagem} 
        onAbrirDadosPerfil={() => void abrirDadosPerfil()}
        onAnexarArquivo={handleAnexarArquivo} onGravarAudio={handleGravarAudio}
        gravando={gravando} tempoGravacao={tempoGravacao} formatarTempo={formatarTempo}
        anexosPendentes={anexosPendentes}
        enviandoAnexos={enviandoAnexos}
        statusMicrofone={statusMicrofone}
        onRemoverAnexo={removerAnexoPendente}
        onLimparAnexos={limparAnexosPendentes}
        onApagarMensagensEmMassa={handleApagarMensagensMassa}
        onEncaminharMensagens={handleAbrirEncaminhar}
        onReagirMensagem={handleReagirMensagem}
        onEscolherFigurinha={() => figurinhaInputRef.current?.click()}
        onCarregarMensagensAntigas={carregarMensagensAntigas}
        temMaisMensagens={paginaHistoricoAtiva?.hasMore ?? true}
        carregandoMensagens={historicoCarregandoId === conversaSelecionada}
      />

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
              {conversas.filter((c) => c.id !== conversaSelecionada).length === 0 ? (
                <p className="p-4 text-[var(--text-secondary)]">Nenhuma outra conversa disponivel.</p>
              ) : (
                conversas
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

      {painelPerfilAberto && (
        <PainelDireito modo={abaDireitaModo} conversaAtiva={conversaAtiva} onFechar={() => setPainelPerfilAberto(false)} onAskNora={onOpenNora} />
      )}

      {modalContatosAberto && (
        <div className="absolute inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="w-[450px] max-h-[80vh] bg-[var(--surface)] border border-[var(--border)] rounded-2xl flex flex-col shadow-2xl overflow-hidden text-xs font-bold text-[var(--text)]">
            <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
              <h3 className="text-sm font-extrabold">Lista de Contatos</h3>
              <button onClick={() => setModalContatosAberto(false)}><X size={16}/></button>
            </div>
            <div className="p-3 bg-[var(--background)] border-b border-[var(--border)] flex items-center gap-2">
              <Search size={14} className="opacity-40" />
              <input type="text" placeholder="Buscar contato..." value={filtroContatoNome} onChange={(e) => setFiltroContatoNome(e.target.value)} className="bg-transparent flex-1 outline-none text-xs font-semibold text-[var(--text)]"/>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]/30">
              {listaContatos.filter(c => (c.name || "").toLowerCase().includes(filtroContatoNome.toLowerCase())).map((c) => (
                <div key={c.id || c.phone} onClick={() => { setModalContatosAberto(false); selecionarConversa(c.phone || c.id); }} className="p-3 flex items-center gap-3 hover:bg-[var(--surface-hover)] cursor-pointer transition-all">
                  <div className="h-8 w-8 rounded-full bg-neutral-700 flex items-center justify-center text-neutral-300"><User size={14}/></div>
                  <div className="flex flex-col min-w-0">
                    <span className="font-bold text-sm truncate">{c.name || c.pushname || "Sem Nome"}</span>
                    <span className="text-xs opacity-50 font-mono">{c.phone}</span>
                  </div>
                </div>
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
              <div className="rounded-xl border border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] px-3 py-2 text-center text-[var(--primary)]">Grupo do WhatsApp</div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]/30">
              {listaContatos.map((c) => {
                const jid = c.phone || c.id;
                const marcado = contatosSelecionadosGrupo.includes(jid);
                return (
                  <div key={jid} onClick={() => gerenciarSelecaoContatoGrupo(jid)} className="p-3 flex items-center justify-between hover:bg-[var(--surface-hover)] cursor-pointer">
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-neutral-700 flex items-center justify-center text-neutral-300"><User size={14}/></div>
                      <span className="font-bold text-sm truncate">{c.name || c.pushname || "Sem Nome"}</span>
                    </div>
                    <input type="checkbox" checked={marcado} readOnly className="rounded border-zinc-700 h-4 w-4 text-[var(--primary)] focus:ring-0"/>
                  </div>
                );
              })}
            </div>

            <div className="p-4 bg-[var(--background)] border-t border-[var(--border)]">
              <button onClick={executarCriacaoGrupo} className="w-full h-11 bg-[var(--primary)] text-white rounded-xl shadow-md font-bold text-xs transition hover:opacity-95">Concluir Criação</button>
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
