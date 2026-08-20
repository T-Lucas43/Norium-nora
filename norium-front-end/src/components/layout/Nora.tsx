import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  CalendarDays,
  CheckCircle2,
  Copy,
  FileSignature,
  FolderKanban,
  Loader2,
  Lock,
  Languages,
  Mail,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  SendHorizontal,
  Settings2,
  SpellCheck,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  Wallet,
  WandSparkles,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { authToken } from "../../core/api/config";
import type { EventSource, OmnichannelEvent, PerfilOperador } from "../../types/omnichannel";
import { apiBaseUrl } from "../../utils/api";
import NoraAvatar from "./NoraAvatar";
import Button from "../shared/Button";
import { speechTextFromDisplay, takeNaturalSpeechSegments } from "./noraSpeech";

interface NoraProps {
  open: boolean;
  onClose: () => void;
  conversaId?: string;
  profile?: PerfilOperador | null;
  eventsBySource?: Partial<Record<EventSource, OmnichannelEvent[]>>;
  userId?: string;
  activeTab?: string;
  onOpenEmail?: (messageId: string) => void;
  contextualRequest?: { id: number; prompt: string } | null;
}

const SCREEN_LABELS: Record<string, string> = {
  Dashboard: "Dashboard",
  Controle: "Controle operacional",
  Central: "Central de atividades",
  Pendencias: "Central de atividades",
  "E-mails": "E-mails",
  "E-mail": "E-mails",
  Agenda: "Agenda",
  Chat: "Chat",
  Tarefas: "Tarefas",
  Gastos: "Financeiro",
  Financeiro: "Financeiro",
  Automacoes: "Automações",
  "Automações": "Automações",
  Relatorios: "Relatórios",
  "Relatórios": "Relatórios",
  Equipe: "Equipe",
  Clientes: "Clientes",
  Governanca: "Governança",
  Brainstorm: "Brainstorm",
  Perfil: "Perfil",
  Configuracoes: "Configurações",
  "Configurações": "Configurações",
  Ajuda: "Ajuda",
  Mais: "Mais recursos",
};

function buildScreenContext(
  activeTab: string | undefined,
  eventsBySource: Partial<Record<EventSource, OmnichannelEvent[]>> | undefined,
): string {
  if (!activeTab) return "";
  const label = SCREEN_LABELS[activeTab] || activeTab;
  const parts = [`O usuario esta na tela "${label}" do Norium.`];
  if (eventsBySource) {
    const counts = Object.entries(eventsBySource)
      .map(([source, events]) => [source, events?.length ?? 0] as const)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([source, count]) => `${count} em ${source}`);
    if (counts.length > 0) {
      parts.push(`Eventos recentes monitorados: ${counts.join(", ")}.`);
    }
  }
  return parts.join(" ");
}

const BACKEND_URL = apiBaseUrl();
let activeNoraAudio: HTMLAudioElement | null = null;
let activeNoraVoiceRequest: AbortController | null = null;
let finishActiveNoraAudio: (() => void) | null = null;
let finishBrowserSpeech: (() => void) | null = null;
let serverVoiceUnavailable = false;

type Msg = {
  role: "user" | "ai";
  text: string;
  agent?: NoraAgentKind;
  status?: string;
  emailMessages?: NoraEmailMessage[];
  agendaEvents?: NoraAgendaEvent[];
};

type VoiceAccessStatus = "locked" | "requesting" | "unlocked" | "denied" | "unsupported";
type NoraRunState = "idle" | "submitting" | "thinking" | "searching" | "analyzing" | "streaming" | "synthesizing_audio" | "speaking" | "completed" | "cancelled" | "error";
type NoraAgentKind = "geral" | "whatsapp" | "email" | "agenda" | "tarefas" | "financeiro" | "comercial" | "automacoes" | "operacoes" | "equipe" | "mensagens" | "erro";

const ACTIVE_NORA_STATES = new Set<NoraRunState>(["submitting", "thinking", "searching", "analyzing", "streaming", "synthesizing_audio", "speaking"]);
const NORA_STATE_LABELS: Record<NoraRunState, string> = {
  idle: "Pronta",
  submitting: "Enviando...",
  thinking: "Pensando...",
  searching: "Consultando dados...",
  analyzing: "Analisando...",
  streaming: "Respondendo...",
  synthesizing_audio: "Conectando voz ao vivo...",
  speaking: "Falando...",
  completed: "Concluído",
  cancelled: "Interrompido",
  error: "Não foi possível concluir",
};

type NoraEmailAttachment = {
  attachmentId?: string;
  fileName: string;
  mimeType?: string;
  size?: number;
  downloadUrl?: string;
};

type NoraEmailMessage = {
  id: string;
  threadId?: string;
  fromName?: string;
  fromEmail?: string;
  to?: string;
  cc?: string;
  replyToEmail?: string;
  subject?: string;
  snippet?: string;
  dateLabel?: string;
  dateFull?: string;
  labels?: string[];
  unread?: boolean;
  starred?: boolean;
  important?: boolean;
  hasAttachment?: boolean;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: NoraEmailAttachment[];
};

type NoraAgendaEvent = {
  id?: string;
  titulo?: string;
  title?: string;
  inicio?: string;
  fim?: string;
  descricao?: string;
  local?: string;
  status?: string;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: {
    resultIndex: number;
    results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
  }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognition() {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
}

function readBooleanPreference(key: string, fallback = false) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function pickPortugueseVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((voice) => voice.lang.toLowerCase() === "pt-br" && /google|microsoft|francisca|maria|daniel/i.test(voice.name)) ||
    voices.find((voice) => voice.lang.toLowerCase() === "pt-br") ||
    voices.find((voice) => voice.lang.toLowerCase().startsWith("pt")) ||
    null
  );
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Falha ao ler o audio."));
    reader.readAsDataURL(blob);
  });
}

function requestMicrophoneStream(timeoutMs = 12_000) {
  return new Promise<MediaStream>((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      settled = true;
      reject(new DOMException("Tempo esgotado ao solicitar o microfone.", "NotAllowedError"));
    }, timeoutMs);

    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((stream) => {
        if (settled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(stream);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function stopNoraVoice() {
  activeNoraVoiceRequest?.abort();
  activeNoraVoiceRequest = null;
  finishActiveNoraAudio?.();
  finishActiveNoraAudio = null;
  if (activeNoraAudio) {
    activeNoraAudio.pause();
    activeNoraAudio.removeAttribute("src");
    activeNoraAudio.load();
    activeNoraAudio = null;
  }
  window.speechSynthesis?.cancel();
  finishBrowserSpeech?.();
  finishBrowserSpeech = null;
}

function speakWithBrowserVoice(cleanText: string, onPlayback?: () => void) {
  return new Promise<boolean>((resolve) => {
    if (!("speechSynthesis" in window) || !cleanText) {
      resolve(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleanText);
    const voice = pickPortugueseVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = "pt-BR";
    utterance.rate = 0.98;
    utterance.pitch = 1.02;
    utterance.volume = 1;
    let settled = false;
    const finish = (played: boolean) => {
      if (settled) return;
      settled = true;
      finishBrowserSpeech = null;
      resolve(played);
    };
    finishBrowserSpeech = () => finish(false);
    utterance.onstart = () => onPlayback?.();
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    window.speechSynthesis.speak(utterance);
  });
}

async function tryServerNoraVoice(cleanText: string, onPlayback?: () => void): Promise<boolean | null> {
  if (serverVoiceUnavailable || !cleanText) return false;
  const controller = new AbortController();
  activeNoraVoiceRequest?.abort();
  activeNoraVoiceRequest = controller;
  try {
    const response = await fetch(`${BACKEND_URL}/api/nora/voz`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
      },
      body: JSON.stringify({
        text: cleanText,
      }),
    });

    if (!response.ok) {
      if ([401, 402, 403, 503].includes(response.status)) {
        serverVoiceUnavailable = true;
      }
      return false;
    }

    return await playProgressiveNoraAudio(response, controller, onPlayback);
  } catch {
    return controller.signal.aborted ? null : false;
  } finally {
    if (activeNoraVoiceRequest === controller && controller.signal.aborted) activeNoraVoiceRequest = null;
  }
}

function supportedMp3MediaType() {
  if (typeof MediaSource === "undefined") return "";
  return ["audio/mpeg", 'audio/mpeg; codecs="mp3"'].find((type) => MediaSource.isTypeSupported(type)) || "";
}

function waitForSourceBuffer(sourceBuffer: SourceBuffer) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", handleUpdateEnd);
      sourceBuffer.removeEventListener("error", handleError);
    };
    const handleUpdateEnd = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Falha ao anexar audio progressivo."));
    };
    sourceBuffer.addEventListener("updateend", handleUpdateEnd, { once: true });
    sourceBuffer.addEventListener("error", handleError, { once: true });
  });
}

async function appendAudioChunk(sourceBuffer: SourceBuffer, chunk: Uint8Array) {
  if (sourceBuffer.updating) await waitForSourceBuffer(sourceBuffer);
  const stableChunk = new Uint8Array(chunk.byteLength);
  stableChunk.set(chunk);
  sourceBuffer.appendBuffer(stableChunk);
  await waitForSourceBuffer(sourceBuffer);
}

async function playProgressiveNoraAudio(
  response: Response,
  controller: AbortController,
  onPlayback?: () => void,
): Promise<boolean | null> {
  const mediaType = supportedMp3MediaType();
  if (!response.body || !mediaType) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }

  const mediaSource = new MediaSource();
  const audioUrl = URL.createObjectURL(mediaSource);
  const audio = new Audio();
  audio.preload = "auto";
  activeNoraAudio = audio;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let playbackStarted = false;
  let settled = false;
  let resolvePlayback: (played: boolean | null) => void = () => undefined;
  const playbackDone = new Promise<boolean | null>((resolve) => {
    resolvePlayback = resolve;
  });
  const finish = (played: boolean | null) => {
    if (settled) return;
    settled = true;
    resolvePlayback(played);
  };

  finishActiveNoraAudio = () => {
    void reader?.cancel().catch(() => undefined);
    finish(null);
  };
  audio.onplaying = () => {
    if (playbackStarted) return;
    playbackStarted = true;
    onPlayback?.();
  };
  audio.onended = () => finish(true);
  audio.onerror = () => finish(playbackStarted);

  try {
    const opened = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        mediaSource.removeEventListener("sourceopen", handleOpen);
        mediaSource.removeEventListener("error", handleError);
        controller.signal.removeEventListener("abort", handleAbort);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("Falha ao iniciar audio progressivo."));
      };
      const handleAbort = () => {
        cleanup();
        reject(new DOMException("Audio cancelado.", "AbortError"));
      };
      mediaSource.addEventListener("sourceopen", handleOpen, { once: true });
      mediaSource.addEventListener("error", handleError, { once: true });
      controller.signal.addEventListener("abort", handleAbort, { once: true });
    });
    audio.src = audioUrl;
    audio.load();
    await opened;

    const sourceBuffer = mediaSource.addSourceBuffer(mediaType);
    reader = response.body.getReader();
    let receivedAudio = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      receivedAudio = true;
      await appendAudioChunk(sourceBuffer, value);
      if (!playbackStarted && audio.paused) {
        void audio.play().catch(() => finish(false));
      }
    }
    if (!receivedAudio) return false;
    if (sourceBuffer.updating) await waitForSourceBuffer(sourceBuffer);
    if (mediaSource.readyState === "open") mediaSource.endOfStream();
    return await playbackDone;
  } catch {
    return controller.signal.aborted ? null : playbackStarted;
  } finally {
    finishActiveNoraAudio = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(audioUrl);
    if (activeNoraAudio === audio) activeNoraAudio = null;
    if (activeNoraVoiceRequest === controller) activeNoraVoiceRequest = null;
  }
}

async function playNoraSpeechSegment(text: string, onStage?: (stage: "synthesizing_audio" | "speaking") => void) {
  const cleanText = speechTextFromDisplay(text);
  if (!cleanText) return;
  onStage?.("synthesizing_audio");
  const played = await tryServerNoraVoice(cleanText, () => onStage?.("speaking"));
  if (played === false) {
    await speakWithBrowserVoice(cleanText, () => onStage?.("speaking"));
  }
}

function speakNoraResponse(text: string) {
  stopNoraVoice();
  void playNoraSpeechSegment(text);
}

function eventCount(eventsBySource: NoraProps["eventsBySource"], source: EventSource) {
  return eventsBySource?.[source]?.length ?? 0;
}

function buildOpeningSummary(profile: PerfilOperador | null | undefined, eventsBySource: NoraProps["eventsBySource"]) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const name = (profile?.nome || "").split(" ")[0] || "";
  const emails = eventCount(eventsBySource, "gmail");
  const whatsapp = eventCount(eventsBySource, "whatsapp");
  const calendar = eventCount(eventsBySource, "calendar");
  const tasks = eventCount(eventsBySource, "kanban");
  const total = emails + whatsapp + calendar + tasks + eventCount(eventsBySource, "telegram");
  return `${greeting}${name ? `, ${name}` : ""}. Aqui esta seu resumo: ${total} eventos recentes, ${emails} e-mails, ${whatsapp} mensagens, ${calendar} compromissos de agenda e ${tasks} atualizacoes de tarefas.`;
}

const suggestions = [
  { icon: Mail, title: "Resumir esta conversa", action: "summary" },
  { icon: WandSparkles, title: "Gerar rascunho do agente", action: "agent" },
  { icon: SpellCheck, title: "Corrigir ortografia", action: "spellcheck" },
  { icon: Languages, title: "Traduzir texto", action: "translate" },
  { icon: FolderKanban, title: "O que o cliente quer?", action: "question" },
  { icon: CheckCircle2, title: "Me ajuda a responder com firmeza", action: "question" },
  { icon: CalendarDays, title: "Organizar minha agenda", action: "agenda" },
  { icon: FolderKanban, title: "Organizar minhas tarefas", action: "tasks" },
  { icon: Mail, title: "Ver meus e-mails", action: "emails" },
  { icon: Wallet, title: "Ver meus gastos", action: "finance" },
] as const;

const agentPresentation = {
  geral: {
    icon: Sparkles,
    className: "nora-agent-card nora-agent-general",
  },
  whatsapp: {
    icon: MessageSquare,
    className: "nora-agent-card nora-agent-chat",
  },
  email: {
    icon: Mail,
    className: "nora-agent-card nora-agent-email",
  },
  agenda: {
    icon: CalendarDays,
    className: "nora-agent-card nora-agent-calendar",
  },
  tarefas: {
    icon: FolderKanban,
    className: "nora-agent-card nora-agent-tasks",
  },
  financeiro: {
    icon: Wallet,
    className: "nora-agent-card nora-agent-finance",
  },
  comercial: {
    icon: FileSignature,
    className: "nora-agent-card nora-agent-commercial",
  },
  automacoes: {
    icon: WandSparkles,
    className: "nora-agent-card nora-agent-automation",
  },
  operacoes: {
    icon: Settings2,
    className: "nora-agent-card nora-agent-operations",
  },
  equipe: {
    icon: MessageSquare,
    className: "nora-agent-card nora-agent-team",
  },
  mensagens: {
    icon: WandSparkles,
    className: "nora-agent-card nora-agent-messages",
  },
  erro: {
    icon: Bot,
    className: "nora-agent-card nora-agent-error",
  },
} satisfies Record<NoraAgentKind, { icon: LucideIcon; className: string }>;

function inferAgentFromText(message: Msg): NoraAgentKind {
  if (message.agent) return message.agent;
  if (message.role === "user") return "geral";
  const normalized = normalizeIntentText(message.text);
  if (/erro|falha|nao consegui|bloquead|indisponivel/.test(normalized)) return "erro";
  if (/rascunho do agente|agente de mensagens|whatsapp|conversa|cliente/.test(normalized)) return "mensagens";
  if (/gmail|e-mail|email|caixa de entrada|rascunho|assunto|destinatario|categoria/.test(normalized)) return "email";
  if (/agenda|calendario|compromisso|reuniao|horario|disponibilidade/.test(normalized)) return "agenda";
  if (/automacao|automacoes|workflow|fluxo|gatilho/.test(normalized)) return "automacoes";
  if (/controle operacional|governanca|central de atividades|pendencias|configuracoes|como usar|como funciona/.test(normalized)) return "operacoes";
  if (/equipe|time|chat interno|mensagem interna/.test(normalized)) return "equipe";
  if (/tarefa|kanban|projeto|prioridade|pendente|concluida|vencimento/.test(normalized)) return "tarefas";
  if (/financeiro|gasto|boleto|pix|saldo|lancamento|entrada|saida|despesa|receita/.test(normalized)) return "financeiro";
  if (/whatsapp|telegram|chat|mensagem/.test(normalized)) return "whatsapp";
  return "geral";
}

function meaningfulLines(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[\s>*\-•\d.)]+/, "").trim())
    .filter(Boolean);
}

function splitLabelValue(line: string) {
  const match = line.match(/^([^:]{2,48}):\s*(.+)$/);
  if (!match) return null;
  return { label: match[1].trim(), value: match[2].trim() };
}

function normalizeLoose(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isNoraCommentLine(line: string) {
  const normalized = normalizeLoose(line).trim();
  const looksLikeLabelValue = /^[^:]{2,48}:\s+.+/.test(line);
  if (looksLikeLabelValue && !normalized.startsWith("nora:")) return false;
  return /^(nora\s*:|ola\b|claro[,\s.!]|aqui\b|segue\b|resumo\b|posso\b|encontrei\b|separei\b|boa\b|ah\b|nota\b|detalhe\b|pronto\b|feito\b|beleza\b|perfeito\b|combinado\b)/.test(normalized);
}

function markdownFallback(text: string) {
  return (
    <div className="nora-message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function NoraCommentary({ lines }: { lines: string[] }) {
  const text = lines.join("\n\n").trim();
  if (!text) return null;
  return (
    <div className="nora-commentary mb-3 rounded-xl border border-current/10 bg-white/[0.10] px-3 py-2 text-xs font-semibold leading-5">
      {markdownFallback(text)}
    </div>
  );
}

function normalizeEmailMessages(value: unknown): NoraEmailMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NoraEmailMessage => Boolean(item && typeof item === "object" && "id" in item));
}

function normalizeAgendaEvents(value: unknown): NoraAgendaEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NoraAgendaEvent => Boolean(item && typeof item === "object"));
}

function agendaEventTitle(event: NoraAgendaEvent) {
  return String(event.titulo || event.title || "Compromisso sem titulo");
}

function agendaEventDate(event: NoraAgendaEvent) {
  const start = String(event.inicio || "");
  if (!start) return "";
  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime())) return start;
  return parsed.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function FinanceContent({ text }: { text: string }) {
  const lines = meaningfulLines(text);
  const rows = lines
    .map((line) => {
      const pair = splitLabelValue(line);
      if (pair && /r\$|valor|saldo|entrada|saida|despesa|receita|boleto|pendente|pago|categoria|metodo/i.test(`${pair.label} ${pair.value}`)) {
        return { ...pair, source: line };
      }
      const money = line.match(/R\$\s*[\d.,]+/i);
      if (money) return { label: line.replace(money[0], "").replace(/[-–—:]+$/g, "").trim() || "Valor", value: money[0], source: line };
      return null;
    })
    .filter(Boolean) as Array<{ label: string; value: string; source: string }>;
  const rowSources = new Set(rows.map((row) => row.source));
  const commentary = lines.filter((line) => !rowSources.has(line));

  if (rows.length < 2) return markdownFallback(text);

  return (
    <div className="nora-finance-layout">
      <NoraCommentary lines={commentary} />
      <table className="w-full overflow-hidden rounded-xl text-left text-xs">
        <tbody>
          {rows.slice(0, 8).map((row) => (
            <tr key={`${row.label}-${row.value}`} className="border-b border-current/10 last:border-b-0">
              <th className="w-2/5 px-3 py-2 font-black uppercase opacity-70">{row.label}</th>
              <td className="px-3 py-2 font-bold">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmailContent({ text, emailMessages = [], onOpenEmail }: { text: string; emailMessages?: NoraEmailMessage[]; onOpenEmail?: (messageId: string) => void }) {
  const lines = meaningfulLines(text);
  const commentary = lines.filter(isNoraCommentLine);
  const commentarySet = new Set(commentary);
  const fallbackRows: NoraEmailMessage[] = lines
    .filter((line) => !commentarySet.has(line))
    .slice(0, 7)
    .map((line, index) => {
      const clean = line.replace(/^assunto:\s*/i, "");
      const parts = clean.split(/\s+-\s+|\s+—\s+|:\s+/).map((item) => item.trim()).filter(Boolean);
      return {
        id: `fallback-${index}`,
        fromName: parts[0] || "Gmail",
        subject: parts[1] || clean,
        snippet: parts.slice(2).join(" - "),
      } satisfies NoraEmailMessage;
    });
  const rows = emailMessages.length ? emailMessages.slice(0, 8) : fallbackRows;

  if (!rows.length) return markdownFallback(text);

  return (
    <div>
      <NoraCommentary lines={commentary} />
      <div className="nora-gmail-layout overflow-hidden rounded-xl border border-current/10">
        <div className="flex items-center gap-3 border-b border-current/10 px-3 py-2 text-xs font-bold uppercase opacity-75">
          <span className="h-3 w-3 rounded border border-current/30" />
          <span className="h-3 w-3 rounded-full border border-current/30" />
          <span>Caixa de entrada</span>
        </div>
        <div className="divide-y divide-current/10">
          {rows.map((message) => {
            return (
              <div key={message.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!message.id.startsWith("fallback-")) onOpenEmail?.(message.id);
                  }}
                  className="w-full px-3 py-3 text-left text-xs transition hover:bg-current/[0.06]"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-1 h-3 w-3 shrink-0 rounded border border-current/25" />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <strong className="break-words font-black">{message.fromName || message.fromEmail || "Gmail"}</strong>
                        {message.dateLabel && <span className="shrink-0 text-xs font-bold opacity-55">{message.dateLabel}</span>}
                      </div>
                      <p className="break-words font-black leading-5">{message.subject || "(sem assunto)"}</p>
                      {message.snippet && <p className="mt-1 break-words leading-5 opacity-75">{message.snippet}</p>}
                      {emailMessages.length > 0 && (
                        <span className="mt-2 inline-flex rounded-full border border-current/15 px-2 py-1 text-xs font-bold uppercase opacity-70">
                          Abrir na tela de e-mails
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TaskContent({ text }: { text: string }) {
  const lines = meaningfulLines(text);
  const details = lines
    .map((line) => {
      if (isNoraCommentLine(line)) return null;
      const pair = splitLabelValue(line);
      return pair ? { ...pair, source: line } : null;
    })
    .filter(Boolean) as Array<{ label: string; value: string; source: string }>;
  const detailKeys = new Set(details.map((detail) => detail.source));
  const commentary = lines.filter((line) => !detailKeys.has(line));

  if (details.length < 2) return markdownFallback(text);

  return (
    <div>
      <NoraCommentary lines={commentary} />
      <div className="grid gap-2">
        {details.slice(0, 8).map((detail) => (
          <div key={`${detail.label}-${detail.value}`} className="rounded-xl border border-current/10 bg-black/10 px-3 py-2">
            <p className="text-xs font-bold uppercase opacity-65">{detail.label}</p>
            <p className="mt-1 text-xs font-bold">{detail.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgendaContent({ text, events = [], onAgendaPrompt }: { text: string; events?: NoraAgendaEvent[]; onAgendaPrompt?: (prompt: string) => void }) {
  const rawLines = meaningfulLines(text);
  const commentary = rawLines.filter(isNoraCommentLine);
  const commentarySet = new Set(commentary);
  const lines = rawLines.filter((line) => !commentarySet.has(line)).slice(0, 7);
  if (events.length) {
    return (
      <div>
        <NoraCommentary lines={commentary.length ? commentary : ["Encontrei estes compromissos. Voce pode abrir a edicao de qualquer um deles por aqui."]} />
        <div className="space-y-2">
          {events.slice(0, 6).map((event, index) => {
            const title = agendaEventTitle(event);
            const date = agendaEventDate(event);
            return (
              <div key={`${event.id || title}-${index}`} className="rounded-xl border border-current/10 bg-black/10 p-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words font-black">{title}</p>
                    {date && <p className="mt-1 font-semibold opacity-75">{date}</p>}
                    {event.local && <p className="mt-1 break-words font-semibold opacity-75">{event.local}</p>}
                  </div>
                  <span className="shrink-0 rounded-full border border-current/15 px-2 py-1 text-xs font-bold uppercase opacity-70">
                    Evento
                  </span>
                </div>
                <Button
                 
                  onClick={() => onAgendaPrompt?.(`editar evento ${title}${date ? ` em ${date}` : ""}`)}
                  className="mt-3 rounded-full border-current/15 py-1.5 uppercase opacity-90 hover:bg-current/[0.08]"
                >
                  Editar evento
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  if (lines.length < 2) return markdownFallback(text);

  return (
    <div>
      <NoraCommentary lines={commentary} />
      <div className="space-y-2">
        {lines.map((line, index) => (
          <div key={`${line}-${index}`} className="relative rounded-xl border border-current/10 bg-black/10 px-3 py-2 pl-9 text-xs font-semibold">
            <span className="absolute left-3 top-3 grid h-4 w-4 place-items-center rounded-full bg-current/15 text-xs font-bold">{index + 1}</span>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChatContent({ text }: { text: string }) {
  const lines = meaningfulLines(text);
  if (lines.length < 2) return markdownFallback(text);

  return (
    <div className="space-y-2">
      {lines.slice(0, 6).map((line, index) => (
        <div key={`${line}-${index}`} className={`max-w-[92%] rounded-2xl px-3 py-2 text-xs font-semibold ${index % 2 === 0 ? "bg-black/[0.14]" : "ml-auto bg-white/[0.14]"}`}>
          {line}
        </div>
      ))}
    </div>
  );
}

function NoraStructuredContent({
  agent,
  text,
  emailMessages,
  agendaEvents,
  onOpenEmail,
  onAgendaPrompt,
}: {
  agent: NoraAgentKind;
  text: string;
  emailMessages?: NoraEmailMessage[];
  agendaEvents?: NoraAgendaEvent[];
  onOpenEmail?: (messageId: string) => void;
  onAgendaPrompt?: (prompt: string) => void;
}) {
  if (agent === "financeiro") return <FinanceContent text={text} />;
  if (agent === "email") return <EmailContent text={text} emailMessages={emailMessages} onOpenEmail={onOpenEmail} />;
  if (agent === "tarefas") return <TaskContent text={text} />;
  if (agent === "agenda") return <AgendaContent text={text} events={agendaEvents} onAgendaPrompt={onAgendaPrompt} />;
  if (agent === "whatsapp" || agent === "mensagens") return <ChatContent text={text} />;
  return markdownFallback(text);
}

function NoraMessageBubble({ msg, onOpenEmail, onAgendaPrompt }: { msg: Msg; onOpenEmail?: (messageId: string) => void; onAgendaPrompt?: (prompt: string) => void }) {
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(msg.text);
      } else {
        const input = document.createElement("textarea");
        input.value = msg.text;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  if (msg.role === "user") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="nora-user-message group ml-auto max-w-[82%] rounded-2xl px-4 py-3 text-sm font-semibold select-text"
      >
        <div className="nora-message-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
        <Button variant="ghost"
         
          onClick={copyMessage}
          className="nora-message-copy mt-2 py-1 text-white/65 hover:bg-white/10 hover:text-white"
          title="Copiar mensagem"
         aria-label="Copiar mensagem">
          <Copy size={12} /> {copied ? "Copiada" : "Copiar"}
        </Button>
      </motion.div>
    );
  }

  const agent = inferAgentFromText(msg);
  const presentation = agentPresentation[agent];
  const Icon = presentation.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`${presentation.className} nora-assistant-message group flex w-full max-w-full items-start gap-3 text-sm select-text`}
    >
      <span className="nora-agent-icon mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="nora-assistant-meta mb-2 flex min-h-5 items-center justify-between gap-3">
          <strong className="text-xs font-bold text-[var(--text)]">Nora</strong>
          {msg.status && msg.status.toLowerCase() !== "chat" && (
            <span className="rounded-full border border-current/15 px-2 py-0.5 text-xs font-bold uppercase text-[var(--text-secondary)]">
              {msg.status}
            </span>
          )}
        </div>
        <div className="nora-assistant-content">
          <NoraStructuredContent
            agent={agent}
            text={msg.text}
            emailMessages={msg.emailMessages}
            agendaEvents={msg.agendaEvents}
            onOpenEmail={onOpenEmail}
            onAgendaPrompt={onAgendaPrompt}
          />
        </div>
        <span className="mt-2 flex items-center gap-2">
          <Button variant="ghost"
           
            onClick={copyMessage}
            className="nora-message-copy h-7 text-[var(--text-secondary)] hover:text-[var(--text)]"
            title="Copiar mensagem"
           aria-label="Copiar mensagem">
            <Copy size={12} /> {copied ? "Copiada" : "Copiar"}
          </Button>
        </span>
      </div>
    </motion.div>
  );
}

async function askNoraWhatsAppBackend(message: string, conversaId: string, sendDirect: boolean) {
  const res = await fetch(`${BACKEND_URL}/api/nora/chat-whatsapp`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversa_id: conversaId,
      texto_usuario: message,
      enviar_direto_whatsapp: sendDirect,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || "Erro inesperado no servidor da Nora.");
  return {
    text: data?.response || "Nao consegui gerar resposta.",
    sent: Boolean(data?.whatsapp_enviado),
    blockedReason: data?.blocked_reason as string | undefined,
  };
}

async function askAgendaAgent(message: string, sessionId: string | null, userId: string) {
  const res = await fetch(`${BACKEND_URL}/api/agenda/agente/mensagem`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      session_id: sessionId,
      message,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || "Erro no Agente de Agenda.");
  return data as {
    session_id: string | null;
    status: "coletando" | "confirmar" | "criado" | "consulta" | "cancelado" | "atualizado" | "precisa_dados" | "nao_encontrado";
    response: string;
    events?: NoraAgendaEvent[];
    event?: NoraAgendaEvent;
  };
}

async function askEmailAgent(message: string, sessionId: string | null, userId: string) {
  const res = await fetch(`${BACKEND_URL}/api/emails/gmail/agente/mensagem`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      session_id: sessionId,
      message,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || "Erro no Agente de E-mails.");
  return data as {
    session_id: string | null;
    status: "desconectado" | "consulta" | "resumo" | "categorias" | "coletando" | "confirmar" | "enviado" | "cancelado" | "ajuda";
    response: string;
    messages?: NoraEmailMessage[];
  };
}

async function askNaturalNoraStream(
  messages: Msg[],
  finalText: string,
  agendaSessionId: string | null,
  emailSessionId: string | null,
  commercialSessionId: string | null,
  userId: string,
  screenContext: string,
  signal: AbortSignal,
  handlers: {
    onDelta: (fullText: string, delta: string) => void;
    onStatus: (state: NoraRunState) => void;
    onResponseId: (responseId: string) => void;
    onDone: (metrics: Record<string, number>) => void;
  },
): Promise<{ redirect: true } | { redirect: false; fullText: string; responseId: string }> {
  const payloadMessages = messages.slice(-6).map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: message.text,
  }));

  const res = await fetch(`${BACKEND_URL}/api/nora/natural/stream`, {
    method: "POST",
    signal,
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
    },
    body: JSON.stringify({
      user_id: userId,
      message: finalText,
      messages: payloadMessages,
      agenda_session_id: agendaSessionId,
      email_session_id: emailSessionId,
      commercial_session_id: commercialSessionId,
      screen_context: screenContext || undefined,
    }),
  });

  const contentType = res.headers.get("content-type") || "";
  if (!res.ok || !res.body || !contentType.includes("text/event-stream")) {
    return { redirect: true };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let responseId = res.headers.get("X-Norium-Response-Id") || "";
  if (responseId) handlers.onResponseId(responseId);

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      try {
        const parsed = JSON.parse(data) as {
          type?: "status" | "delta" | "done";
          state?: NoraRunState;
          response_id?: string;
          delta?: string;
          metrics?: Record<string, number>;
        };
        if (parsed.response_id && parsed.response_id !== responseId) {
          responseId = parsed.response_id;
          handlers.onResponseId(responseId);
        }
        if (parsed.type === "status" && parsed.state) handlers.onStatus(parsed.state);
        if (parsed.type === "done") handlers.onDone(parsed.metrics || {});
        if ((parsed.type === "delta" || !parsed.type) && typeof parsed.delta === "string") {
          fullText += parsed.delta;
          handlers.onDelta(fullText, parsed.delta);
        }
      } catch {
        // pedaco de evento incompleto ou malformado; ignora e segue
      }
    }
  }

  return { redirect: false, fullText, responseId };
}

function recordNoraTelemetry(
  responseId: string,
  event: "first_visible_token" | "first_audio" | "playback_started" | "completed" | "cancelled",
  elapsedMs: number,
  channel: "text" | "voice" | "stream" = "stream",
) {
  if (!responseId) return;
  void fetch(`${BACKEND_URL}/api/nora/telemetry`, {
    method: "POST",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
    },
    body: JSON.stringify({ response_id: responseId, event, elapsed_ms: Math.max(0, elapsedMs), channel }),
  }).catch(() => undefined);
}

async function askNaturalNora(
  messages: Msg[],
  finalText: string,
  agendaSessionId: string | null,
  emailSessionId: string | null,
  commercialSessionId: string | null,
  userId: string,
  screenContext: string,
) {
  const payloadMessages = messages.slice(-6).map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: message.text,
  }));

  const res = await fetch(`${BACKEND_URL}/api/nora/natural`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
    },
    body: JSON.stringify({
      user_id: userId,
      message: finalText,
      messages: payloadMessages,
      agenda_session_id: agendaSessionId,
      email_session_id: emailSessionId,
      commercial_session_id: commercialSessionId,
      screen_context: screenContext || undefined,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || "Erro no entendimento natural da Nora.");
  return data as {
    intent: "financeiro" | "tarefas" | "email" | "agenda" | "comercial" | "automacoes" | "operacoes" | "equipe" | "chat";
    session_kind: "email" | "agenda" | "commercial" | null;
    session_id: string | null;
    status: string;
    response: string;
    speech_text?: string;
    agent_result?: Record<string, unknown> & { messages?: unknown; events?: unknown; event?: unknown };
  };
}

function normalizeIntentText(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isAgendaIntent(text: string) {
  const normalized = normalizeIntentText(text);
  return /agenda|agendar|marcar|compromisso|calendario|reuniao|livre|ocupado/.test(normalized);
}

function isTaskIntent(text: string) {
  const normalized = normalizeIntentText(text);
  return /tarefa|tarefas|kanban|pendente|concluida|prioridade|vencid|atrasad|andamento|revisao|planejar|priorizar|por onde comecar/.test(normalized);
}

function isEmailIntent(text: string) {
  const normalized = normalizeIntentText(text);
  return /gmail|e-mail|email|emails|caixa de entrada|nao lidos|rascunho|assunto|enviado|enviados|mandar|mande|envie|redigir|escrever|anexo|anexos|remetente|destinatario|prioridade|importante|agrupar|categorizar|categoria|categorias|classificar emails|classificar e-mails/.test(normalized);
}

function isFinanceIntent(text: string) {
  const normalized = normalizeIntentText(text);
  return /financeiro|financas|gasto|gastos|gastei|despesa|despesas|receita|entrada|saida|saldo|lancamento|lancar|boleto|boletos|cpf|pagar|paguei|pago|programado|fixo|recorrente|comprovante|nota fiscal|pix|cartao|dinheiro|comprei|comprando|mercado|comida|almoco|jantar|lanche/.test(normalized);
}

function isAutomationIntent(text: string) {
  const normalized = normalizeIntentText(text);
  return /automacao|automacoes|automatizar|workflow|fluxo|gatilho|executar automacao|rodar automacao/.test(normalized);
}

function isCommercialIntent(text: string) {
  const normalized = normalizeIntentText(text);
  return /proposta|propostas|contrato|contratos|assinatura|assinante|escopo comercial|orcamento comercial|documento comercial/.test(normalized);
}

function isTeamIntent(text: string) {
  const normalized = normalizeIntentText(text);
  return /chat da equipe|cht da equipe|chat interno|mensagem interna|mensagem no time|mensagem para o time|avisar o time|avise o time|avisar a equipe|avise a equipe/.test(normalized)
    || (/equipe|time/.test(normalized) && /mensagem|avise|avisar|mandar|mande|enviar/.test(normalized));
}

function isWhatsAppConversationIntent(text: string) {
  const normalized = normalizeIntentText(text);
  return /resumir (esta|essa) conversa|resumo (da|desta|dessa) conversa|o que (o )?cliente quer|gerar rascunho|rascunho (da|de|para) (resposta|mensagem)|me ajude a responder|responder com firmeza|corrigir ortografia|traduzir (esta|essa|a) mensagem|analise (esta|essa) conversa/.test(normalized);
}

function interruptsActiveAgentSession(text: string) {
  const normalized = normalizeIntentText(text)
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const greetings = new Set([
    "oi",
    "ola",
    "opa",
    "e ai",
    "bom dia",
    "boa tarde",
    "boa noite",
    "oi nora",
    "ola nora",
    "bom dia nora",
    "boa tarde nora",
    "boa noite nora",
    "tudo bem",
    "como voce esta",
  ]);
  return (
    greetings.has(normalized) ||
    /^(?:(?:eu )?(?:so )?(?:te )?(?:dei|disse|falei) )?(?:bom dia|boa tarde|boa noite|oi|ola|ol|opa|e ai)(?: nora)?$/.test(normalized) ||
    /mudei de assunto|outro assunto|outra coisa|esqueca isso|deixa isso pra la|nova conversa|recomece do zero/.test(normalized)
  );
}

export default function Nora({ open, onClose, conversaId, profile, eventsBySource, userId = "primary", activeTab, onOpenEmail, contextualRequest }: NoraProps) {
  const screenContext = buildScreenContext(activeTab, eventsBySource);
  const welcomeName = (profile?.nome || "").trim().split(/\s+/)[0] || "";
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [runState, setRunState] = useState<NoraRunState>("idle");
  const loading = ACTIVE_NORA_STATES.has(runState);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [sendDirect, setSendDirect] = useState(false);
  const [agentDraft, setAgentDraft] = useState<string | null>(null);
  const [agendaSessionId, setAgendaSessionId] = useState<string | null>(null);
  const [agendaAgentActive, setAgendaAgentActive] = useState(false);
  const [emailSessionId, setEmailSessionId] = useState<string | null>(null);
  const [emailAgentActive, setEmailAgentActive] = useState(false);
  const [commercialSessionId, setCommercialSessionId] = useState<string | null>(null);
  const [commercialAgentActive, setCommercialAgentActive] = useState(false);
  const [listening, setListening] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [voiceAccess, setVoiceAccess] = useState<VoiceAccessStatus>("locked");
  const [voiceError, setVoiceError] = useState("");
  const [voiceRepliesEnabled, setVoiceRepliesEnabled] = useState(() => readBooleanPreference("norium:nora:voice-replies-v2", false));
  const [voiceGreetingEnabled, setVoiceGreetingEnabled] = useState(() => readBooleanPreference("norium:nora:voice-greeting", false));
  const [expanded, setExpanded] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const mediaStopTimerRef = useRef<number | null>(null);
  const voiceDraftRef = useRef("");
  const voiceSendTimerRef = useRef<number | null>(null);
  const greetedRef = useRef(false);
  const contextualRequestHandledRef = useRef(0);
  const activeCycleRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const speechQueueRef = useRef<Promise<void>>(Promise.resolve());
  const speechGenerationRef = useRef(0);
  const streamingCompleteRef = useRef(false);
  const responseIdRef = useRef("");
  const requestStartedRef = useRef(0);
  const firstAudioReportedRef = useRef(false);
  const pinnedToBottomRef = useRef(true);

  function setCycleState(cycleId: number, state: NoraRunState) {
    if (activeCycleRef.current === cycleId) setRunState(state);
  }

  function cancelActiveResponse(markCancelled = true) {
    const wasActive = ACTIVE_NORA_STATES.has(runState);
    activeCycleRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    speechGenerationRef.current += 1;
    streamingCompleteRef.current = true;
    stopNoraVoice();
    speechQueueRef.current = Promise.resolve();
    if (markCancelled && wasActive) {
      recordNoraTelemetry(
        responseIdRef.current,
        "cancelled",
        performance.now() - requestStartedRef.current,
      );
      setRunState("cancelled");
    }
  }

  function queueSpeechSegment(text: string, cycleId: number) {
    const speechText = speechTextFromDisplay(text);
    if (!speechText) return speechQueueRef.current;
    const speechGeneration = speechGenerationRef.current;
    const next = speechQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (activeCycleRef.current !== cycleId || speechGenerationRef.current !== speechGeneration) return;
        await playNoraSpeechSegment(speechText, (stage) => {
          if (activeCycleRef.current !== cycleId || speechGenerationRef.current !== speechGeneration) return;
          setRunState(stage);
          if (stage === "speaking" && !firstAudioReportedRef.current) {
            firstAudioReportedRef.current = true;
            const elapsed = performance.now() - requestStartedRef.current;
            recordNoraTelemetry(responseIdRef.current, "first_audio", elapsed, "voice");
            recordNoraTelemetry(responseIdRef.current, "playback_started", elapsed, "voice");
          }
        });
        if (
          activeCycleRef.current === cycleId &&
          speechGenerationRef.current === speechGeneration &&
          !streamingCompleteRef.current
        ) {
          setRunState("streaming");
        }
      });
    speechQueueRef.current = next;
    return next;
  }

  useEffect(() => {
    if (!pinnedToBottomRef.current || !scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: runState === "streaming" ? "auto" : "smooth",
    });
  }, [messages, runState, agentDraft]);

  useEffect(() => {
    activeCycleRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    speechGenerationRef.current += 1;
    streamingCompleteRef.current = true;
    stopNoraVoice();
    speechQueueRef.current = Promise.resolve();
    setRunState("idle");
    setMessages([]);
    setShowSuggestions(true);
    setAgentDraft(null);
    setSendDirect(false);
    setAgendaSessionId(null);
    setAgendaAgentActive(false);
    setEmailSessionId(null);
    setEmailAgentActive(false);
    setCommercialSessionId(null);
    setCommercialAgentActive(false);
  }, [conversaId]);

  useEffect(() => {
    if (!open || !contextualRequest?.prompt || contextualRequestHandledRef.current === contextualRequest.id) return;
    contextualRequestHandledRef.current = contextualRequest.id;
    setExpanded(false);
    setShowSuggestions(false);
    window.setTimeout(() => void sendMessage(contextualRequest.prompt), 0);
  }, [contextualRequest?.id, contextualRequest?.prompt, open]);

  useEffect(() => {
    return () => {
      clearVoiceTimer();
      recognitionRef.current?.abort();
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (mediaStopTimerRef.current !== null) window.clearTimeout(mediaStopTimerRef.current);
      activeCycleRef.current += 1;
      requestAbortRef.current?.abort();
      speechGenerationRef.current += 1;
      stopNoraVoice();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("norium:nora:voice-replies-v2", String(voiceRepliesEnabled));
    if (!voiceRepliesEnabled) {
      speechGenerationRef.current += 1;
      speechQueueRef.current = Promise.resolve();
      stopNoraVoice();
    }
  }, [voiceRepliesEnabled]);

  useEffect(() => {
    localStorage.setItem("norium:nora:voice-greeting", String(voiceGreetingEnabled));
  }, [voiceGreetingEnabled]);

  useEffect(() => {
    if (!open || !voiceRepliesEnabled || !voiceGreetingEnabled || greetedRef.current) return;
    const timer = window.setTimeout(() => {
      greetedRef.current = true;
      speakNoraResponse(buildOpeningSummary(profile, eventsBySource));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [open, voiceRepliesEnabled, voiceGreetingEnabled, profile, eventsBySource]);

  useEffect(() => {
    if (!open) {
      clearVoiceTimer();
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      voiceDraftRef.current = "";
      setListening(false);
      setTranscribing(false);
      setVoiceAccess("locked");
      setVoiceError("");
      setExpanded(false);
      activeCycleRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      speechGenerationRef.current += 1;
      streamingCompleteRef.current = true;
      speechQueueRef.current = Promise.resolve();
      setRunState("idle");
      stopNoraVoice();
    }
  }, [open]);

  function applyNaturalAgentEffects(result: Awaited<ReturnType<typeof askNaturalNora>>) {
    const status = String(result.status || "");
    const intent = result.intent;

    if (intent === "tarefas" && ["criada", "concluida", "atualizada", "projeto_criado"].includes(status)) {
      window.dispatchEvent(new Event("tasks:changed"));
    }

    if (
      intent === "financeiro" &&
      [
        "lancamento_criado",
        "lancamento_atualizado",
        "lancamento_excluido",
        "programado_criado",
        "programado_excluido",
        "boletos",
      ].includes(status)
    ) {
      window.dispatchEvent(new Event("finance:changed"));
    }

    if (intent === "email") {
      setEmailSessionId(result.session_id);
      setEmailAgentActive(Boolean(result.session_id && !["enviado", "cancelado", "consulta", "resumo", "desconectado", "ajuda"].includes(status)));
      if (status === "enviado") window.dispatchEvent(new Event("emails:changed"));
    }

    if (intent === "agenda") {
      setAgendaSessionId(result.session_id);
      setAgendaAgentActive(Boolean(result.session_id && !["criado", "cancelado", "consulta", "atualizado"].includes(status)));
      if (["criado", "atualizado"].includes(status)) window.dispatchEvent(new Event("calendar:changed"));
    }

    if (intent === "comercial") {
      setCommercialSessionId(result.session_id);
      setCommercialAgentActive(Boolean(result.session_id && ["precisa_dados", "confirmar"].includes(status)));
      if (["criada", "excluida", "analisada", "contrato_criado", "enviado_assinatura"].includes(status)) {
        window.dispatchEvent(new Event("commercial:changed"));
      }
    }

    if (intent === "automacoes" && ["criada", "executada", "ativada", "desativada"].includes(status)) {
      window.dispatchEvent(new Event("automations:changed"));
    }

    if (intent === "equipe" && status === "enviado") {
      window.dispatchEvent(new Event("team-chat:changed"));
    }
  }

  function naturalIntentToAgent(intent: Awaited<ReturnType<typeof askNaturalNora>>["intent"]): NoraAgentKind {
    if (intent === "email") return "email";
    if (intent === "agenda") return "agenda";
    if (intent === "tarefas") return "tarefas";
    if (intent === "financeiro") return "financeiro";
    if (intent === "comercial") return "comercial";
    if (intent === "automacoes") return "automacoes";
    if (intent === "operacoes") return "operacoes";
    if (intent === "equipe") return "equipe";
    if (intent === "chat") return "whatsapp";
    return "geral";
  }

  async function sendMessage(text?: string, speakReply = false) {
    const finalText = (text || input).trim();
    if (!finalText) return;

    cancelActiveResponse(false);
    const cycleId = activeCycleRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    speechGenerationRef.current += 1;
    streamingCompleteRef.current = false;
    speechQueueRef.current = Promise.resolve();
    responseIdRef.current = "";
    requestStartedRef.current = performance.now();
    firstAudioReportedRef.current = false;
    pinnedToBottomRef.current = true;
    setCycleState(cycleId, "submitting");
    setInput("");
    setVoiceError("");
    setShowSuggestions(false);
    setAgentDraft(null);

    const currentMessages: Msg[] = [...messages, { role: "user", text: finalText }];
    setMessages(currentMessages);

    try {
      let response = "";
      let responseSpeechText = "";
      let responseAgent: NoraAgentKind = "geral";
      let responseStatus = "";
      let responseEmailMessages: NoraEmailMessage[] | undefined;
      let responseAgendaEvents: NoraAgendaEvent[] | undefined;
      let handledInline = false;
      let speechWasQueued = false;
      let speechBuffer = "";
      const shouldSpeak = speakReply || voiceRepliesEnabled;
      const sessionInterrupted = interruptsActiveAgentSession(finalText);
      const explicitEmailSwitch = sessionInterrupted || isTaskIntent(finalText) || isFinanceIntent(finalText) || isAgendaIntent(finalText) || isCommercialIntent(finalText) || isAutomationIntent(finalText) || isTeamIntent(finalText);
      const explicitAgendaSwitch = sessionInterrupted || isTaskIntent(finalText) || isFinanceIntent(finalText) || isEmailIntent(finalText) || isCommercialIntent(finalText) || isAutomationIntent(finalText) || isTeamIntent(finalText);
      const explicitCommercialSwitch = sessionInterrupted || isTaskIntent(finalText) || isFinanceIntent(finalText) || isEmailIntent(finalText) || isAgendaIntent(finalText) || isAutomationIntent(finalText) || isTeamIntent(finalText);
      const continueEmailSession = emailAgentActive && !explicitEmailSwitch;
      const continueAgendaSession = agendaAgentActive && !explicitAgendaSwitch;
      const continueCommercialSession = commercialAgentActive && !explicitCommercialSwitch;
      const effectiveEmailSessionId = sessionInterrupted ? null : emailSessionId;
      const effectiveAgendaSessionId = sessionInterrupted ? null : agendaSessionId;
      const effectiveCommercialSessionId = sessionInterrupted ? null : commercialSessionId;
      if (sessionInterrupted) {
        setEmailSessionId(null);
        setEmailAgentActive(false);
        setAgendaSessionId(null);
        setAgendaAgentActive(false);
        setCommercialSessionId(null);
        setCommercialAgentActive(false);
      }
      const shouldUseWhatsAppContext =
        conversaId &&
        (sendDirect || isWhatsAppConversationIntent(finalText)) &&
        !emailAgentActive &&
        !agendaAgentActive &&
        !commercialAgentActive &&
        !isTaskIntent(finalText) &&
        !isFinanceIntent(finalText) &&
        !isEmailIntent(finalText) &&
        !isAgendaIntent(finalText) &&
        !isCommercialIntent(finalText) &&
        !isAutomationIntent(finalText) &&
        !isTeamIntent(finalText);

      if (continueEmailSession) {
        setCycleState(cycleId, "searching");
        const result = await askEmailAgent(finalText, emailSessionId, userId);
        if (activeCycleRef.current !== cycleId) return;
        responseAgent = "email";
        responseStatus = result.status;
        responseEmailMessages = normalizeEmailMessages(result.messages);
        setEmailSessionId(result.session_id);
        setEmailAgentActive(Boolean(result.session_id && !["enviado", "cancelado", "consulta", "resumo", "desconectado"].includes(result.status)));
        if (result.status === "enviado") {
          window.dispatchEvent(new Event("emails:changed"));
        }
        response = result.response;
      } else if (continueAgendaSession) {
        setCycleState(cycleId, "searching");
        const result = await askAgendaAgent(finalText, agendaSessionId, userId);
        if (activeCycleRef.current !== cycleId) return;
        responseAgent = "agenda";
        responseStatus = result.status;
        responseAgendaEvents = result.events || (result.event ? [result.event] : undefined);
        setAgendaSessionId(result.session_id);
        setAgendaAgentActive(Boolean(result.session_id && !["criado", "cancelado", "consulta", "atualizado"].includes(result.status)));
        response = result.response;
      } else if (shouldUseWhatsAppContext) {
        setCycleState(cycleId, "analyzing");
        const result = await askNoraWhatsAppBackend(finalText, conversaId, sendDirect);
        if (activeCycleRef.current !== cycleId) return;
        responseAgent = "whatsapp";
        responseStatus = result.sent ? "enviado" : result.blockedReason || "";
        response = result.sent
          ? `${result.text}\n\nEnviado no WhatsApp. A Nora apertou o botao sem inventar moda.`
          : result.blockedReason === "historico_vazio"
            ? `${result.text}\n\nEnvio bloqueado porque o historico esta vazio. Muito sensato da minha parte, diga-se.`
            : result.text;
      } else {
        let streamStarted = false;
        let firstVisibleReported = false;
        let streamResult: Awaited<ReturnType<typeof askNaturalNoraStream>>;
        try {
          streamResult = await askNaturalNoraStream(
            messages,
            finalText,
            effectiveAgendaSessionId,
            effectiveEmailSessionId,
            continueCommercialSession ? effectiveCommercialSessionId : null,
            userId,
            screenContext,
            controller.signal,
            {
              onResponseId: (responseId) => {
                if (activeCycleRef.current !== cycleId) return;
                responseIdRef.current = responseId;
              },
              onStatus: (state) => setCycleState(cycleId, state),
              onDone: () => {
                if (activeCycleRef.current === cycleId) streamingCompleteRef.current = true;
              },
              onDelta: (partial, delta) => {
                if (activeCycleRef.current !== cycleId) return;
                if (!firstVisibleReported) {
                  firstVisibleReported = true;
                  window.requestAnimationFrame(() => {
                    recordNoraTelemetry(
                      responseIdRef.current,
                      "first_visible_token",
                      performance.now() - requestStartedRef.current,
                      "text",
                    );
                  });
                }
                if (!streamStarted) {
                  streamStarted = true;
                  setMessages((prev) => [
                    ...prev,
                    { role: "ai", text: partial, agent: "geral", status: "chat" },
                  ]);
                } else {
                  setMessages((prev) => {
                    const lastMessage = prev.at(-1);
                    if (lastMessage?.role !== "ai" || lastMessage.status !== "chat") {
                      return [...prev, { role: "ai", text: partial, agent: "geral", status: "chat" }];
                    }
                    return [...prev.slice(0, -1), { ...lastMessage, text: partial }];
                  });
                }

                if (shouldSpeak) {
                  speechBuffer += delta;
                  const extracted = takeNaturalSpeechSegments(speechBuffer);
                  speechBuffer = extracted.remainder;
                  for (const segment of extracted.segments) {
                    speechWasQueued = true;
                    queueSpeechSegment(segment, cycleId);
                  }
                }
              },
            },
          );
        } catch (error) {
          if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
          streamResult = { redirect: true };
        }

        if (!streamResult.redirect) {
          if (activeCycleRef.current !== cycleId) return;
          responseIdRef.current = streamResult.responseId || responseIdRef.current;
          streamingCompleteRef.current = true;
          if (shouldSpeak) {
            const finalSegments = takeNaturalSpeechSegments(speechBuffer, true);
            speechBuffer = finalSegments.remainder;
            for (const segment of finalSegments.segments) {
              speechWasQueued = true;
              queueSpeechSegment(segment, cycleId);
            }
          }
          response = streamResult.fullText || "Entendi, mas nao recebi resposta do agente.";
          responseSpeechText = speechTextFromDisplay(response);
          responseAgent = "geral";
          responseStatus = "chat";
          handledInline = streamStarted;
        } else {
          setCycleState(cycleId, "analyzing");
          if (streamStarted) {
            setMessages((prev) => {
              const lastMessage = prev.at(-1);
              return lastMessage?.role === "ai" && lastMessage.status === "chat"
                ? prev.slice(0, -1)
                : prev;
            });
          }
          const result = await askNaturalNora(
            messages,
            finalText,
            effectiveAgendaSessionId,
            effectiveEmailSessionId,
            continueCommercialSession ? effectiveCommercialSessionId : null,
            userId,
            screenContext,
          );
          if (activeCycleRef.current !== cycleId) return;
          applyNaturalAgentEffects(result);
          responseAgent = naturalIntentToAgent(result.intent);
          responseStatus = result.status;
          if (result.intent === "email") {
            responseEmailMessages = normalizeEmailMessages(result.agent_result?.messages);
          }
          if (result.intent === "agenda") {
            responseAgendaEvents = normalizeAgendaEvents(result.agent_result?.events);
            if (!responseAgendaEvents.length && result.agent_result?.event && typeof result.agent_result.event === "object") {
              responseAgendaEvents = [result.agent_result.event as NoraAgendaEvent];
            }
          }
          response = result.response || "Entendi, mas nao recebi resposta do agente.";
          responseSpeechText = result.speech_text || speechTextFromDisplay(response);
        }
      }
      if (activeCycleRef.current !== cycleId) return;
      streamingCompleteRef.current = true;
      if (!handledInline) {
        setMessages((prev) => [
          ...prev,
          {
            role: "ai",
            text: response,
            agent: responseAgent,
            status: responseStatus,
            emailMessages: responseEmailMessages,
            agendaEvents: responseAgendaEvents,
          },
        ]);
      }
      if (shouldSpeak && !speechWasQueued) {
        queueSpeechSegment(responseSpeechText || response, cycleId);
      }
      if (shouldSpeak) await speechQueueRef.current;
      if (activeCycleRef.current !== cycleId) return;
      recordNoraTelemetry(
        responseIdRef.current,
        "completed",
        performance.now() - requestStartedRef.current,
        shouldSpeak ? "voice" : "stream",
      );
      setCycleState(cycleId, "completed");
    } catch (err) {
      if (controller.signal.aborted || activeCycleRef.current !== cycleId || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      setMessages((prev) => [...prev, { role: "ai", text: err instanceof Error ? err.message : "Erro ao se conectar com o back-end.", agent: "erro" }]);
      setCycleState(cycleId, "error");
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }

  function clearVoiceTimer() {
    if (voiceSendTimerRef.current !== null) {
      window.clearTimeout(voiceSendTimerRef.current);
      voiceSendTimerRef.current = null;
    }
  }

  function scheduleVoiceSend() {
    clearVoiceTimer();
    voiceSendTimerRef.current = window.setTimeout(() => {
      const finalText = voiceDraftRef.current.trim();
      if (!finalText) {
        stopVoice();
        return;
      }
      voiceDraftRef.current = "";
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setListening(false);
      void sendMessage(finalText, true);
    }, 1400);
  }

  async function unlockVoice() {
    setVoiceError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceAccess("unsupported");
      setVoiceError("Nao consegui acessar o pedido de permissao do microfone neste navegador.");
      return false;
    }

    setVoiceAccess("requesting");
    try {
      const stream = await requestMicrophoneStream();
      stream.getTracks().forEach((track) => track.stop());
      setVoiceAccess("unlocked");
      setVoiceError("");
      return true;
    } catch (err) {
      setVoiceAccess("denied");
      setVoiceError(
        err instanceof DOMException && err.name === "NotFoundError"
          ? "Nao encontrei um microfone conectado."
          : "Microfone bloqueado pelo navegador. Libere a permissao para este site e tente de novo.",
      );
      return false;
    }
  }

  function stopVoice() {
    clearVoiceTimer();
    if (mediaRecorderRef.current?.state === "recording") {
      if (mediaStopTimerRef.current !== null) window.clearTimeout(mediaStopTimerRef.current);
      mediaRecorderRef.current.stop();
      return;
    }
    const finalText = voiceDraftRef.current.trim();
    voiceDraftRef.current = "";
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    setVoicePreview("");
    if (finalText) void sendMessage(finalText, true);
  }

  async function startServerVoiceRecording() {
    if (!("MediaRecorder" in window) || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Este navegador nao oferece uma forma compativel de capturar audio.");
      return;
    }
    try {
      const stream = await requestMicrophoneStream();
      const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: preferredType });
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      mediaChunksRef.current = [];
      setVoicePreview("Gravando com reconhecimento seguro...");
      setListening(true);
      setVoiceError("");
      recorder.ondataavailable = (event) => {
        if (event.data.size) mediaChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setListening(false);
        setVoiceError("Nao consegui gravar o audio. Verifique o microfone e tente novamente.");
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        setListening(false);
        setTranscribing(true);
        setVoicePreview("");
        try {
          const audio = new Blob(mediaChunksRef.current, { type: recorder.mimeType || "audio/webm" });
          if (audio.size < 800) throw new Error("O audio ficou curto demais para transcrever.");
          const response = await fetch(`${BACKEND_URL}/api/nora/transcrever`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio_data_url: await blobToDataUrl(audio), mime_type: audio.type || "audio/webm" }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result?.detail || "Falha ao transcrever o audio.");
          const transcript = String(result?.text || "").trim();
          if (!transcript) throw new Error("Nao identifiquei nenhuma fala no audio.");
          setInput(transcript);
          await sendMessage(transcript, true);
        } catch (error) {
          setVoiceError(error instanceof Error ? error.message : "Nao consegui transcrever o audio.");
        } finally {
          mediaChunksRef.current = [];
          setTranscribing(false);
        }
      };
      recorder.start(250);
      mediaStopTimerRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 20_000);
    } catch {
      setListening(false);
      setVoiceError("Microfone indisponivel. Confirme a permissao do navegador e o dispositivo de entrada.");
    }
  }

  async function startVoice(permissionReady = false) {
    setVoiceError("");
    const unlocked = permissionReady || voiceAccess === "unlocked" || (await unlockVoice());
    if (!unlocked) return;

    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      await startServerVoiceRecording();
      return;
    }

    clearVoiceTimer();
    voiceDraftRef.current = "";
    setVoicePreview("");
    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.lang = "pt-BR";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setListening(true);
      setVoiceError("");
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      if (voiceDraftRef.current.trim()) scheduleVoiceSend();
      else clearVoiceTimer();
    };
    recognition.onerror = (event) => {
      clearVoiceTimer();
      setListening(false);
      recognitionRef.current = null;
      setVoicePreview("");
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setVoiceAccess("denied");
        setVoiceError("Permissao do microfone negada pelo navegador.");
        return;
      }
      if (event.error === "audio-capture") {
        setVoiceError("Nao encontrei entrada de audio ativa para ouvir voce.");
        return;
      }
      if (event.error === "no-speech") {
        setVoiceError("Nao ouvi nada ainda. Tente falar mais perto do microfone.");
        return;
      }
      if (event.error === "network") {
        voiceDraftRef.current = "";
        setVoiceError("O reconhecimento do navegador falhou. Alternando para a transcricao segura...");
        window.setTimeout(() => void startServerVoiceRecording(), 250);
        return;
      }
      setVoiceError("Nao consegui ouvir agora. Tente desbloquear a voz novamente.");
    };
    recognition.onresult = (event) => {
      let transcript = "";
      let hasFinalResult = false;
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        transcript += result[0].transcript;
        hasFinalResult = hasFinalResult || result.isFinal;
      }

      const cleanedTranscript = transcript.trim();
      if (!cleanedTranscript) return;
      voiceDraftRef.current = cleanedTranscript;
      setVoicePreview(cleanedTranscript);
      setInput(cleanedTranscript);
      if (hasFinalResult) scheduleVoiceSend();
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setVoiceError("A escuta ja estava ativa. Pare e tente novamente.");
    }
  }

  async function runSummary() {
    if (!conversaId) {
      setMessages((prev) => [...prev, { role: "ai", text: "Abre uma conversa primeiro. Eu sou boa, mas clarividencia ainda nao esta no plano.", agent: "erro" }]);
      return;
    }

    cancelActiveResponse(false);
    const cycleId = activeCycleRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setShowSuggestions(false);
    setCycleState(cycleId, "analyzing");
    setMessages((prev) => [...prev, { role: "user", text: "Resumir esta conversa" }]);
    try {
      const res = await fetch(`${BACKEND_URL}/api/nora/resumir-conversa?conversa_id=${encodeURIComponent(conversaId)}`, {
        signal: controller.signal,
        headers: { ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}) },
      });
      const data = await res.json();
      if (activeCycleRef.current !== cycleId) return;
      setMessages((prev) => [...prev, { role: "ai", text: data?.resumo || "Nao achei nada para resumir.", agent: "mensagens", status: "resumo" }]);
      setCycleState(cycleId, "completed");
    } catch (error) {
      if (controller.signal.aborted || activeCycleRef.current !== cycleId) return;
      setMessages((prev) => [...prev, { role: "ai", text: "Falhei no resumo. O back-end resolveu tirar um cochilo.", agent: "erro" }]);
      setCycleState(cycleId, "error");
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }

  async function runAgentDraft() {
    if (!conversaId) {
      setMessages((prev) => [...prev, { role: "ai", text: "Seleciona um chat antes de chamar o Agente de Mensagens. Ele trabalha com contexto, nao com chute.", agent: "erro" }]);
      return;
    }

    cancelActiveResponse(false);
    const cycleId = activeCycleRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setShowSuggestions(false);
    setCycleState(cycleId, "analyzing");
    setAgentDraft(null);
    setMessages((prev) => [...prev, { role: "user", text: "Gerar rascunho do Agente de Mensagens" }]);

    try {
      const res = await fetch(`${BACKEND_URL}/api/nora/agentes/mensagens/rascunho`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
        },
        body: JSON.stringify({
          conversa_id: conversaId,
          instrucao: input.trim() || undefined,
          tom_atendente: "humano, claro e eficiente",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "Erro ao gerar rascunho.");
      if (activeCycleRef.current !== cycleId) return;
      setAgentDraft(data.draft);
      setMessages((prev) => [...prev, { role: "ai", text: `Rascunho do agente:\n\n${data.draft}`, agent: "mensagens", status: "rascunho" }]);
      setCycleState(cycleId, "completed");
    } catch (err) {
      if (controller.signal.aborted || activeCycleRef.current !== cycleId) return;
      setMessages((prev) => [...prev, { role: "ai", text: err instanceof Error ? err.message : "Nao consegui gerar o rascunho.", agent: "erro" }]);
      setCycleState(cycleId, "error");
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }

  async function sendAgentDraft() {
    if (!conversaId || !agentDraft) return;
    cancelActiveResponse(false);
    const cycleId = activeCycleRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setCycleState(cycleId, "submitting");
    try {
      const res = await fetch(`${BACKEND_URL}/api/nora/agentes/mensagens/enviar`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
        },
        body: JSON.stringify({
          conversa_id: conversaId,
          texto: agentDraft,
          canal: "whatsapp",
          autorizado: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "Falha ao enviar rascunho.");
      if (activeCycleRef.current !== cycleId) return;
      setMessages((prev) => [...prev, { role: "ai", text: "Rascunho enviado pelo Agente de Mensagens. Trabalho limpo, sem fanfic.", agent: "mensagens", status: "enviado" }]);
      setAgentDraft(null);
      setCycleState(cycleId, "completed");
    } catch (err) {
      if (controller.signal.aborted || activeCycleRef.current !== cycleId) return;
      setMessages((prev) => [...prev, { role: "ai", text: err instanceof Error ? err.message : "Nao consegui enviar o rascunho.", agent: "erro" }]);
      setCycleState(cycleId, "error");
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }

  function handleSuggestion(action: (typeof suggestions)[number]["action"], title: string) {
    if (action === "summary") {
      void runSummary();
      return;
    }
    if (action === "agent") {
      void runAgentDraft();
      return;
    }
    if (action === "agenda") {
      void sendMessage("agendar");
      return;
    }
    if (action === "tasks") {
      void sendMessage("minhas tarefas pendentes");
      return;
    }
    if (action === "emails") {
      void sendMessage("listar e-mails nao lidos");
      return;
    }
    if (action === "finance") {
      void sendMessage("resumo financeiro e ultimos lancamentos");
      return;
    }
    if (action === "spellcheck") {
      setShowSuggestions(false);
      setInput("Corrija a ortografia e pontuacao do texto abaixo, mantendo o sentido e devolvendo apenas a versao corrigida:\n\n");
      return;
    }
    if (action === "translate") {
      setShowSuggestions(false);
      setInput("Traduza o texto abaixo para ingles. Se eu pedir outro idioma, use o idioma pedido. Devolva apenas a traducao:\n\n");
      return;
    }
    void sendMessage(title);
  }

  const voiceIsLocked = voiceAccess !== "unlocked";
  const voiceStatusLabel =
    voiceAccess === "requesting"
      ? "Solicitando microfone..."
      : voiceAccess === "denied"
        ? "Microfone bloqueado"
        : voiceAccess === "unsupported"
          ? "Voz indisponivel"
          : "Voz bloqueada";

  function closeNora() {
    cancelActiveResponse(false);
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="nora-drawer-backdrop fixed inset-0 z-40 bg-black/35 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeNora}
          />

          <motion.aside
            initial={{ x: 500, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 500, opacity: 0 }}
            transition={{ type: "spring", stiffness: 120, damping: 18 }}
            className={`nora-drawer fixed z-[90] flex max-w-[100vw] flex-col overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-2xl transition-all duration-300 ${
              expanded
                ? "nora-drawer-expanded"
                : "nora-drawer-side"
            }`}
          >
            <div className="nora-drawer-header flex items-center justify-between border-b border-[var(--border)] p-4 text-white">
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-blue-400/35 bg-black shadow-sm">
                  <NoraAvatar className="h-11 w-11" />
                </div>

                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-bold text-white">
                    Nora <span className="nora-online-dot" /> <span className="text-xs font-bold text-emerald-400">{loading ? NORA_STATE_LABELS[runState] : "Online"}</span>
                  </h2>
                  <p className="truncate text-xs font-semibold text-white/75">
                    {conversaId ? `Contexto ativo: ${conversaId}` : "Sem conversa ativa"}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setControlsOpen((value) => !value)}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg text-white transition hover:bg-white/10 ${
                    controlsOpen ? "bg-white/10" : ""
                  }`}
                  title="Preferencias da conversa"
                  aria-label="Preferencias da conversa"
                  aria-expanded={controlsOpen}
                >
                  <Settings2 size={18} />
                </button>
                <Button variant="ghost" size="sm" iconOnly
                  onClick={() => setExpanded((value) => !value)}
                  className="nora-expand-toggle hover:bg-white/10"
                  title={expanded ? "Voltar para lateral" : "Expandir Nora"}
                 aria-label={expanded ? "Voltar para lateral" : "Expandir Nora"}>
                  {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </Button>
                <Button variant="ghost" size="sm" iconOnly aria-label="Fechar Nora" title="Fechar Nora" onClick={closeNora} className="hover:bg-white/10">
                  <X size={18} />
                </Button>
              </div>
            </div>

            {controlsOpen && (
            <div className="nora-drawer-controls border-b border-[var(--border)] p-3">
              <label className={`flex items-center justify-between gap-3 rounded-lg border border-cyan-400/20 bg-[var(--surface)] px-3 py-2 text-xs font-bold ${conversaId ? "text-[var(--text)]" : "text-[var(--text-secondary)]"}`}>
                <span>Enviar direto no WhatsApp</span>
                <input
                  type="checkbox"
                  checked={sendDirect}
                  disabled={!conversaId}
                  onChange={(event) => setSendDirect(event.target.checked)}
                  className="h-4 w-4 accent-cyan-500"
                />
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setVoiceRepliesEnabled((value) => !value)}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs font-bold transition ${
                    voiceRepliesEnabled
                      ? "border-cyan-300/40 bg-cyan-400/15 text-[var(--text)]"
                      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {voiceRepliesEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
                    Voz natural PT-BR
                  </span>
                  <span>{voiceRepliesEnabled ? "Ligada" : "Off"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setVoiceGreetingEnabled((value) => !value)}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs font-bold transition ${
                    voiceGreetingEnabled
                      ? "border-cyan-300/40 bg-cyan-400/15 text-[var(--text)]"
                      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Sparkles size={14} />
                    Saudacao
                  </span>
                  <span>{voiceGreetingEnabled ? "Ativa" : "Off"}</span>
                </button>
              </div>
            </div>
            )}

            <div
              ref={scrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                pinnedToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
              }}
              className={`nora-drawer-conversation flex-1 space-y-5 overflow-y-auto px-4 py-5 ${messages.length === 0 ? "is-empty" : ""}`}
            >
              {messages.length === 0 && !loading && (
                <div className="nora-empty-state">
                  <NoraAvatar className="nora-empty-avatar" />
                  <h3>{welcomeName ? `Ola, ${welcomeName}` : "Ola"}</h3>
                  <p>Como posso ajudar?</p>
                </div>
              )}

              {messages.map((msg, index) => (
                <NoraMessageBubble
                  key={`${msg.role}-${index}`}
                  msg={msg}
                  onOpenEmail={onOpenEmail}
                  onAgendaPrompt={(prompt) => void sendMessage(prompt)}
                />
              ))}

              {loading && (
                <div aria-live="polite" className="nora-typing flex items-center gap-2 text-sm font-semibold text-[var(--text-secondary)]">
                  <Loader2 size={15} className="animate-spin text-blue-400" />
                  {NORA_STATE_LABELS[runState]}
                </div>
              )}

              {agentDraft && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs font-semibold text-[var(--text)] shadow-sm">
                  <p className="mb-2 text-[var(--text-secondary)] uppercase tracking-wide text-xs">Rascunho aprovado pelo operador?</p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void navigator.clipboard.writeText(agentDraft)} className="flex-1">
                      <Copy size={14} /> Copiar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={sendAgentDraft} className="flex-1 bg-gradient-to-r from-blue-700 to-cyan-500">
                      <SendHorizontal size={14} /> Enviar
                    </Button>
                  </div>
                </div>
              )}

              {showSuggestions && (
                <div className="nora-quick-suggestions mt-4">
                  <p className="nora-suggestions-label text-xs font-bold mb-3 text-[var(--text-secondary)] uppercase tracking-wide">Sugestoes rapidas</p>

                  <div className="nora-suggestions-grid flex flex-wrap justify-center gap-2">
                    {suggestions.map((suggestion) => {
                      const Icon = suggestion.icon;
                      return (
                        <Button
                          key={suggestion.title}
                          variant="secondary"
                          onClick={() => handleSuggestion(suggestion.action, suggestion.title)}
                          className="nora-quick-suggestion min-h-11 w-auto flex-row items-center justify-start gap-2 px-3 py-2 text-left"
                        >
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-r from-blue-800 to-cyan-500 text-white">
                            <Icon size={14} />
                          </div>
                          <span className="text-xs leading-4">{suggestion.title}</span>
                        </Button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="nora-composer border-t border-[var(--border)] p-3">
              {voiceIsLocked && (
                <Button
                 
                  onClick={() => void unlockVoice()}
                  disabled={voiceAccess === "requesting"}
                  className="mb-2 h-7 rounded-full text-[var(--text-secondary)] hover:text-[var(--text)]"
                  title={voiceStatusLabel}
                 aria-label={voiceStatusLabel}>
                  {voiceAccess === "requesting" ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
                  {voiceAccess === "requesting" ? "Solicitando microfone..." : "Ativar microfone"}
                </Button>
              )}

              {voiceError && (
                <p className="mb-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs font-bold text-amber-300">
                  {voiceError}
                </p>
              )}
              {listening && (
                <div className="nora-listening-status mb-2 flex items-center gap-3 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2">
                  <span className="nora-listening-pulse" aria-hidden="true" />
                  <span className="min-w-0 text-xs font-bold text-cyan-100">
                    {voicePreview ? `Ouvindo: ${voicePreview}` : "Ouvindo... fale normalmente em portugues."}
                  </span>
                </div>
              )}
              {transcribing && (
                <div className="mb-2 flex items-center gap-3 rounded-lg border border-blue-400/30 bg-blue-400/10 px-3 py-2 text-xs font-bold text-blue-100">
                  <Loader2 size={14} className="shrink-0 animate-spin" />
                  Transcrevendo sua mensagem com seguranca...
                </div>
              )}
              <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-1.5">
                <button
                  type="button"
                  onClick={() => {
                    if (voiceIsLocked) {
                      void unlockVoice().then((unlocked) => {
                        if (unlocked) void startVoice(true);
                      });
                      return;
                    }
                    if (listening) {
                      stopVoice();
                    } else {
                      void startVoice();
                    }
                  }}
                  disabled={voiceAccess === "requesting" || transcribing}
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition ${
                    voiceIsLocked
                      ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                      : listening
                      ? "border-cyan-300/50 bg-cyan-400/20 text-cyan-200"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                  }`}
                  title={voiceIsLocked ? "Desbloquear voz" : listening ? "Parar voz" : "Falar com a Nora"}
                 aria-label={voiceIsLocked ? "Desbloquear voz" : listening ? "Parar voz" : "Falar com a Nora"}>
                  {voiceIsLocked ? <Lock size={18} /> : listening ? <MicOff size={18} /> : <Mic size={18} />}
                </button>
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void sendMessage(); }}
                  placeholder={transcribing ? "Transcrevendo sua voz..." : listening ? "Ouvindo sua mensagem..." : "Escreva para a Nora..."}
                  className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm font-semibold outline-none text-[var(--text)] placeholder:text-[var(--text-secondary)]"
                />

                <motion.button
                  whileTap={{ scale: 0.94 }}
                  type="button"
                  onClick={() => loading ? cancelActiveResponse() : void sendMessage()}
                  aria-label={loading ? "Parar resposta da Nora" : "Enviar mensagem para a Nora"}
                  title={loading ? "Parar resposta" : "Enviar mensagem"}
                  className={`flex h-10 w-10 items-center justify-center rounded-lg text-white shadow-sm ${
                    loading ? "bg-red-500 hover:bg-red-400" : "bg-gradient-to-r from-blue-700 to-cyan-500"
                  }`}
                >
                  {loading ? <Square size={16} fill="currentColor" /> : <SendHorizontal size={18} />}
                </motion.button>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
