import { useCallback, useState, useEffect, useRef } from "react";
import SidebarEsquerda from "./SidebarEsquerda";
import AreaCentralChat from "./AreaCentralChat";
import PainelDireito from "./PainelDireito";
import { Menu, X, Search, User, Send } from "lucide-react";
import type { AnexoPendente, ChatConversa } from "./types";
import { apiBaseUrl } from "../../utils/api";
import StatusBanner from "../shared/StatusBanner";
import ConfirmDialog from "../shared/ConfirmDialog";
import Button from "../shared/Button";

const BACKEND_URL = apiBaseUrl();

interface ContatoAgenda {
  id: string;
  phone: string;
  name?: string;
  pushname?: string;
  photoUrl?: string;
}

interface ChatCentralProps {
  userId?: string;
  telegramEnabled?: boolean;
  onConversaAtivaChange?: (conversaId: string | null) => void;
  onOpenNora?: (prompt?: string) => void;
}

export default function ChatCentral({ userId = "lucas123", telegramEnabled = true, onConversaAtivaChange, onOpenNora }: ChatCentralProps) {
  const [loadingStatus, setLoadingStatus] = useState<boolean>(true);
  const [canaisStatus, setCanaisStatus] = useState<{ [key: string]: { conectado: boolean; qrcode?: string | null; detail?: string; username?: string; webhookUrl?: string; webhookEsperado?: string } }>({});
  const [canalSelecionadoLogin, setCanalSelecionadoLogin] = useState<"whatsapp" | "telegram" | null>(null);
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
  const [listaContatos, setListaContatos] = useState<ContatoAgenda[]>([]);
  const [filtroContatoNome, setFiltroContatoNome] = useState<string>("");

  const [nomeNovoGrupo, setNomeNovoGrupo] = useState("");
  const [plataformaGrupo, setPlataformaGrupo] = useState<"whatsapp" | "telegram">("whatsapp");
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
  const avisoTimeoutRef = useRef<number | null>(null);
  const arquivoInputRef = useRef<HTMLInputElement>(null);
  const anexosPendentesRef = useRef<AnexoPendente[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const audioMimeRef = useRef<string>("audio/webm");
  const cancelarEnvioAudioRef = useRef<boolean>(false);
  const carregandoConversasRef = useRef(false);
  const cursorConversasRef = useRef(0);

  const formatarTempo = (segundos: number): string => {
    const mins = Math.floor(segundos / 60);
    const secs = segundos % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const carregarConversasDoBackend = useCallback(async (incremental = false) => {
    if (carregandoConversasRef.current) return [];
    carregandoConversasRef.current = true;
    try {
      const since = incremental && cursorConversasRef.current > 0
        ? `&since=${cursorConversasRef.current}`
        : "";
      const res = await fetch(`${BACKEND_URL}/api/chat/conversas?user_id=${userId}${since}`);
      if (res.ok) {
        const payload = await res.json() as ChatConversa[] | { items: ChatConversa[]; cursor: number };
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
      }
    } catch (err) {
      console.error(err);
    } finally {
      carregandoConversasRef.current = false;
    }
    return [];
  }, [userId]);

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
    async function checarAutenticacao() {
      try {
        setLoadingStatus(true);
        const res = await fetch(`${BACKEND_URL}/api/chat/status-canais?user_id=${userId}`);
        if (res.ok) {
          const data = await res.json();
          setCanaisStatus(data);
          await carregarConversasDoBackend();
        }
      } catch (err) { console.error(err); } 
      finally { setLoadingStatus(false); }
    }
    checarAutenticacao();
  }, [carregarConversasDoBackend, userId]);

  useEffect(() => {
    const atualizarSeVisivel = () => {
      if (!document.hidden && !canalSelecionadoLogin) {
        void carregarConversasDoBackend(true);
      }
    };
    const intervaloChats = window.setInterval(atualizarSeVisivel, 10_000);
    document.addEventListener("visibilitychange", atualizarSeVisivel);
    return () => {
      window.clearInterval(intervaloChats);
      document.removeEventListener("visibilitychange", atualizarSeVisivel);
    };
  }, [canalSelecionadoLogin, carregarConversasDoBackend]);

  const abrirAgendaContatos = async () => {
    setModalContatosAberto(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/chat/contatos-disponiveis?user_id=${userId}`);
      if (res.ok) setListaContatos(await res.json());
    } catch (err) { console.error(err); }
  };

  const abrirModalGrupo = async () => {
    setModalGrupoAberto(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/chat/contatos-disponiveis?user_id=${userId}`);
      if (res.ok) setListaContatos(await res.json());
    } catch (err) { console.error(err); }
  };

  const gerenciarSelecaoContatoGrupo = (id: string) => {
    setContatosSelecionadosGrupo(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const executarCriacaoGrupo = () => {
    if (!nomeNovoGrupo.trim() || contatosSelecionadosGrupo.length === 0) {
      mostrarAviso("error", "Preencha o nome e selecione ao menos um contato.");
      return;
    }
    mostrarAviso("success", `Grupo "${nomeNovoGrupo}" criado.`);
    setModalGrupoAberto(false);
    setNomeNovoGrupo("");
    setContatosSelecionadosGrupo([]);
  };

  const selecionarConversa = async (id: string) => {
    setConversaSelecionada(id);
    setPainelPerfilAberto(false);
    setMobileSidebarOpen(false);
    try {
      await fetch(`${BACKEND_URL}/api/chat/modificar`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, conversa_id: id, acao: "lida", valor: true })
      });
      carregarConversasDoBackend();
    } catch (e) { console.error(e); }
  };

  const arquivoParaDataUrl = (arquivo: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(arquivo);
    });

  const enviarArquivoOuAudio = async (arquivo: File | Blob, nomeArquivo: string, mimeType: string, legenda?: string) => {
    if (!conversaSelecionada) {
      throw new Error("Selecione uma conversa antes de enviar.");
    }
    if (arquivo.size > 14 * 1024 * 1024) {
      throw new Error("O arquivo precisa ter ate 14 MB.");
    }

    const dataUrl = await arquivoParaDataUrl(arquivo);
    const res = await fetch(`${BACKEND_URL}/api/chat/enviar-arquivo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        conversa_id: conversaSelecionada,
        canal: conversaAtiva?.canal ?? "whatsapp",
        nome_arquivo: nomeArquivo,
        mime_type: mimeType || arquivo.type || "application/octet-stream",
        data_url: dataUrl,
        legenda,
      }),
    });

    if (!res.ok) {
      const erro = await res.json().catch(() => null);
      throw new Error(erro?.detail || "Falha ao enviar arquivo.");
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
        id: `anexo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
        const res = await fetch(`${BACKEND_URL}/api/chat/enviar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId, conversa_id: conversaSelecionada, canal: conversaAtiva?.canal ?? "whatsapp", texto: textoLimpo })
        });
        if (!res.ok) {
          const erro = await res.json().catch(() => null);
          throw new Error(erro?.detail || "Falha ao enviar mensagem.");
        }
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
        await fetch(`${BACKEND_URL}/api/chat/apagar-mensagem`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId, conversa_id: conversaSelecionada, mensagem_id: msgId })
        });
      } catch (err) { console.error(err); }
    }
    carregarConversasDoBackend();
  };

  const handleAcaoChat = async (id: string, acao: string, valor: any) => {
    try {
      await fetch(`${BACKEND_URL}/api/chat/modificar`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, conversa_id: id, acao, valor })
      });
      carregarConversasDoBackend();
    } catch (err) { console.error(err); }
  };

  const handleIniciarLogin = async (canal: "whatsapp" | "telegram") => {
    if (canal === "telegram" && !telegramEnabled) {
      setCanalSelecionadoLogin("telegram");
      setErroLogin("Telegram liberado somente para a conta principal do Norium.");
      return;
    }
    setCanalSelecionadoLogin(canal);
    setQrCodeString(null);
    setErroLogin(null);
    setMensagemLogin(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/chat/inicializar-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, canal })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.qrcode) setQrCodeString(data.qrcode);
        if (canal === "telegram") {
          setMensagemLogin(
            data.status === "conectado_polling"
              ? "Telegram conectado em modo local. Envie uma mensagem para o bot e mantenha a tela de Chat aberta para sincronizar."
              : `Telegram conectado${data.username ? ` como @${data.username}` : ""}. Envie uma mensagem para o bot para a conversa aparecer aqui.`
          );
          setCanaisStatus((prev) => ({ ...prev, telegram: { ...(prev.telegram || {}), ...data, conectado: true } }));
          await carregarConversasDoBackend();
        }
      } else {
        setErroLogin((await res.json()).detail || "Erro Z-API.");
      }
    } catch { setErroLogin("Erro de conexão."); }
  };

  const mostrarAviso = useCallback((tone: "error" | "info" | "success", texto: string) => {
    if (avisoTimeoutRef.current) window.clearTimeout(avisoTimeoutRef.current);
    setAviso({ tone, texto });
    avisoTimeoutRef.current = window.setTimeout(() => setAviso(null), 5000);
  }, []);

  const handleExcluirChat = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConversaParaExcluir(id);
  };

  const confirmarExclusaoChat = async () => {
    const id = conversaParaExcluir;
    if (!id) return;
    setExcluindoConversa(true);
    try {
      await fetch(`${BACKEND_URL}/api/chat/conversas/${encodeURIComponent(id)}?user_id=${userId}`, {
        method: "DELETE"
      });
    } catch (err) { console.error(err); }
    finally {
      setConversas((prev) => prev.filter(c => c.id !== id));
      if (conversaSelecionada === id) setConversaSelecionada(null);
      setExcluindoConversa(false);
      setConversaParaExcluir(null);
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
    const textos = conversaAtiva.mensagens
      .filter((m) => mensagensParaEncaminhar.includes(m.id) && m.texto?.trim())
      .map((m) => m.texto as string);
    if (textos.length === 0) {
      mostrarAviso("error", "As mensagens selecionadas nao tem texto para encaminhar.");
      setModalEncaminharAberto(false);
      return;
    }
    setEncaminhando(true);
    try {
      for (const texto of textos) {
        const res = await fetch(`${BACKEND_URL}/api/chat/enviar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId, conversa_id: destino.id, canal: destino.canal, texto }),
        });
        if (!res.ok) throw new Error("Falha ao encaminhar para " + destino.contato);
      }
      await carregarConversasDoBackend();
      mostrarAviso("success", `${textos.length} mensagem(ns) encaminhada(s) para ${destino.contato}.`);
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
  const nenhumConectado = !canaisStatus.whatsapp?.conectado && !canaisStatus.telegram?.conectado && conversas.length === 0;

  if (loadingStatus) return <div className="w-full h-full flex items-center justify-center text-xs font-semibold opacity-50 text-[var(--text)]">Sincronizando...</div>;

  if (nenhumConectado && !canalSelecionadoLogin) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[var(--background)] p-6 font-sans">
        <div className="w-[400px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 text-center text-xs font-bold shadow-2xl">
          <h3 className="text-sm font-extrabold tracking-tight mb-4 text-[var(--text)]">Painel de Acesso Unificado</h3>
          <div className="space-y-3">
            <button onClick={() => handleIniciarLogin("whatsapp")} className="w-full h-12 bg-emerald-600 text-white rounded-xl shadow-md">Conectar WhatsApp</button>
            {telegramEnabled && (
              <button onClick={() => handleIniciarLogin("telegram")} className="w-full h-12 bg-sky-600 text-white rounded-xl shadow-md">Conectar Telegram</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (canalSelecionadoLogin === "whatsapp") {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[var(--background)] p-6 font-sans">
        <div className="w-[400px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 text-center space-y-4 text-xs font-bold text-[var(--text)]">
          <h3 className="text-sm font-extrabold text-emerald-500">Autenticação WhatsApp</h3>
          <div className="h-48 w-48 bg-white mx-auto flex items-center justify-center rounded-xl p-3 shadow-inner overflow-hidden">
            {erroLogin ? <span className="text-red-500">{erroLogin}</span> : qrCodeString ? <img src={qrCodeString} className="w-full h-full object-contain" /> : <span className="text-neutral-400 animate-pulse">Gerando...</span>}
          </div>
          <button onClick={() => setCanalSelecionadoLogin(null)} className="text-[var(--text-secondary)] hover:underline block mx-auto mt-2">Voltar</button>
        </div>
      </div>
    );
  }

  if (canalSelecionadoLogin === "telegram") {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[var(--background)] p-6 font-sans">
        <div className="w-[430px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 text-center space-y-4 text-xs font-bold text-[var(--text)] shadow-2xl">
          <h3 className="text-sm font-extrabold text-sky-500">Autenticacao Telegram</h3>
          {erroLogin ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-left text-red-400">{erroLogin}</div>
          ) : (
            <div className="rounded-xl border border-sky-500/25 bg-sky-500/10 p-4 text-left leading-6">
              <p>{mensagemLogin || "Conectando ao bot do Telegram..."}</p>
              <p className="mt-3 text-[var(--text-secondary)]">
                O Telegram nao usa QR Code. A conversa aparece quando alguem envia mensagem para o bot ou quando o bot e adicionado a um grupo.
              </p>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => setCanalSelecionadoLogin(null)} className="flex-1 h-10 rounded-xl border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">Voltar</button>
            <button onClick={() => { setCanalSelecionadoLogin(null); carregarConversasDoBackend(); }} className="flex-1 h-10 rounded-xl bg-sky-600 text-white shadow-md">Abrir chat</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`norium-chat ${mobileSidebarOpen ? "mobile-sidebar-open" : ""} w-full h-full flex bg-[var(--background)] font-sans overflow-hidden relative`}>
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
      <SidebarEsquerda 
        conversas={conversas} conversaSelecionada={conversaSelecionada} 
        onSelecionar={selecionarConversa} onAcao={handleAcaoChat} onExcluir={handleExcluirChat}
        telegramEnabled={telegramEnabled}
        canaisConectados={{
          whatsapp: Boolean(canaisStatus.whatsapp?.conectado),
          telegram: Boolean(canaisStatus.telegram?.conectado),
        }}
        onConectarCanal={handleIniciarLogin}
        onAbrirConfigPropria={() => setModalConfigAberto(true)}
        onAbrirModalContatos={abrirAgendaContatos}
        onAbrirModalCriarGrupo={abrirModalGrupo}
      />
      
      <AreaCentralChat 
        key={conversaAtiva?.id || "vazio"}
        conversaAtiva={conversaAtiva} onEnviar={handleEnviarMensagem} 
        onAbrirDadosPerfil={() => { setPainelPerfilAberto(true); setAbaDireitaModo("perfil"); }}
        onAnexarArquivo={handleAnexarArquivo} onGravarAudio={handleGravarAudio}
        gravando={gravando} tempoGravacao={tempoGravacao} formatarTempo={formatarTempo}
        anexosPendentes={anexosPendentes}
        enviandoAnexos={enviandoAnexos}
        statusMicrofone={statusMicrofone}
        onRemoverAnexo={removerAnexoPendente}
        onLimparAnexos={limparAnexosPendentes}
        onApagarMensagensEmMassa={handleApagarMensagensMassa}
        onEncaminharMensagens={handleAbrirEncaminhar}
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

      {modalEncaminharAberto && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[80vh] w-[420px] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-xs font-bold text-[var(--text)] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[var(--border)] p-4">
              <h3 className="text-sm font-extrabold">Encaminhar {mensagensParaEncaminhar.length} mensagem(ns)</h3>
              <button onClick={() => setModalEncaminharAberto(false)} aria-label="Fechar" className="rounded p-1 hover:bg-[var(--surface-hover)]">
                <X size={16} />
              </button>
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
                    <span className="text-[10px] opacity-50 font-mono">{c.phone}</span>
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
              <div className="flex gap-2 font-bold">
                <button onClick={() => setPlataformaGrupo("whatsapp")} className={`flex-1 py-2 rounded-xl border text-center transition ${plataformaGrupo === "whatsapp" ? "bg-emerald-600 text-white border-transparent" : "border-[var(--border)] opacity-60"}`}>WhatsApp</button>
                <button onClick={() => setPlataformaGrupo("telegram")} className={`flex-1 py-2 rounded-xl border text-center transition ${plataformaGrupo === "telegram" ? "bg-blue-600 text-white border-transparent" : "border-[var(--border)] opacity-60"}`}>Telegram</button>
              </div>
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
                <label className="opacity-60 block text-[10px] uppercase tracking-wider">Endereço da API Backend (URL)</label>
                <input type="text" readOnly value={BACKEND_URL} className="w-full h-10 border border-[var(--border)] bg-[var(--background)] px-3 rounded-xl outline-none font-semibold text-xs text-[var(--text)] opacity-70"/>
              </div>

              <div className="space-y-1.5">
                <label className="opacity-60 block text-[10px] uppercase tracking-wider">ID Global do Usuário (Session ID)</label>
                <input type="text" readOnly value={userId} className="w-full h-10 border border-[var(--border)] bg-[var(--background)] px-3 rounded-xl outline-none font-semibold text-xs text-[var(--text)] opacity-70"/>
              </div>

              <div className="bg-[var(--background)] border border-[var(--border)] p-3 rounded-xl space-y-1.5">
                <p className="text-emerald-500 font-bold text-[11px] uppercase tracking-wide">Status do Gateway</p>
                <div className="flex justify-between font-medium text-xs opacity-80">
                  <span>Servidor Backend:</span>
                  <span className="text-emerald-400 font-bold">Online (127.0.0.1)</span>
                </div>
              </div>
            </div>

            <div className="p-4 bg-[var(--background)] border-t border-[var(--border)] flex gap-2">
              <button onClick={() => setModalConfigAberto(false)} className="w-full h-11 bg-[var(--primary)] text-white rounded-xl shadow-md font-bold text-xs hover:opacity-90">Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
