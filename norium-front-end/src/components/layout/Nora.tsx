import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import {
  Bot,
  BrainCircuit,
  CalendarDays,
  CheckCircle2,
  Copy,
  FileSignature,
  FolderKanban,
  Loader2,
  Languages,
  Mail,
  Maximize2,
  MessageSquare,
  Mic,
  Minimize2,
  Paperclip,
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
import { apiRequest } from "../../core/api/client";
import { authToken } from "../../core/api/config";
import type { EventSource, OmnichannelEvent, PerfilOperador } from "../../types/omnichannel";
import { apiBaseUrl } from "../../utils/api";
import NoraAvatar from "./NoraAvatar";
import { NoraAutomationCards, NoraCalendar, NoraFinanceTable, NoraMarkdown, NoraTaskCards } from "../nora/NoraResponseContent";
import { buildNoraResponseView, legacyFinanceView, legacyTaskView, type NoraResponseView, type NoraCalendarEvent as NoraAgendaEvent } from "../nora/responseView";
import { drainNoraSseEvents, type NoraStreamEvent } from "../nora/noraStream";
import { NoraFileCards, type NoraChatFile } from "../nora/NoraFiles";
import Button from "../shared/Button";
import { speechTextFromDisplay, takeNaturalSpeechSegments } from "./noraSpeech";

interface NoraProps {
  open: boolean;
  variant?: "drawer" | "page";
  initialState?: NoraConversationState;
  onStateChange?: (state: NoraConversationState, running: boolean) => void;
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
  Brainstorm: "Estúdio",
  "Estúdio": "Estúdio",
  Nora: "Nora",
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

export type Msg = {
  role: "user" | "ai";
  text: string;
  agent?: NoraAgentKind;
  status?: string;
  emailMessages?: NoraEmailMessage[];
  agendaEvents?: NoraAgendaEvent[];
  responseView?: NoraResponseView;
  files?: NoraChatFile[];
};

export type NoraConversationState = {
  messages: Msg[];
  agendaSessionId?: string | null;
  agendaAgentActive?: boolean;
  emailSessionId?: string | null;
  emailAgentActive?: boolean;
  commercialSessionId?: string | null;
  commercialAgentActive?: boolean;
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

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Falha ao ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

function inferFileMime(file: File) {
  if (file.type) return file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  return ({
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    txt: "text/plain", csv: "text/csv", json: "application/json", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint", zip: "application/zip",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime",
  } as Record<string, string>)[extension || ""] || "application/octet-stream";
}

function normalizeChatFiles(value: unknown): NoraChatFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = String(record.id || "").trim();
    const name = String(record.name || record.fileName || "arquivo").trim();
    const previewUrl = String(record.previewUrl || record.url || "").trim();
    const downloadUrl = String(record.downloadUrl || record.url || previewUrl).trim();
    if (!id || !previewUrl || !downloadUrl) return [];
    const editTarget = record.editTarget && typeof record.editTarget === "object" ? record.editTarget as Record<string, unknown> : undefined;
    return [{
      id,
      name,
      mimeType: String(record.mimeType || "application/octet-stream"),
      size: Number(record.size || 0),
      previewUrl,
      downloadUrl,
      source: String(record.source || "") || undefined,
      createdAt: String(record.createdAt || "") || undefined,
      inLibrary: Boolean(record.inLibrary),
      editTarget: editTarget && editTarget.entityId ? {
        tab: String(editTarget.tab || "Documentos"),
        entityType: String(editTarget.entityType || "proposal"),
        entityId: String(editTarget.entityId),
        label: String(editTarget.label || "Editar no Documentos"),
      } : undefined,
    }];
  }).slice(0, 40);
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
      "X-Norium-Workspace": localStorage.getItem("norium-workspace-id") || "primary",
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
  const total = emails + whatsapp + calendar + tasks;
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
  if (/whatsapp|chat|mensagem/.test(normalized)) return "whatsapp";
  return "geral";
}

function meaningfulLines(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[\s>*\-•\d.)]+/, "").trim())
    .filter(Boolean);
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

function markdownFallback(text: string) { return <NoraMarkdown text={text} />; }

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

function EmailContent({ text, emailMessages = [], onOpenEmail }: { text: string; emailMessages?: NoraEmailMessage[]; onOpenEmail?: (messageId: string) => void }) {
  const lines = meaningfulLines(text);
  const commentary = lines.filter(isNoraCommentLine);
  const rows = emailMessages;

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

function NoraStructuredContent({ agent, text, emailMessages, agendaEvents, responseView, onOpenEmail, onAgendaPrompt }: {
  agent: NoraAgentKind; text: string; emailMessages?: NoraEmailMessage[]; agendaEvents?: NoraAgendaEvent[];
  responseView?: NoraResponseView; onOpenEmail?: (messageId: string) => void; onAgendaPrompt?: (prompt: string) => void;
}) {
  const view = responseView || (agent === "tarefas" ? legacyTaskView(text) : agent === "financeiro" ? legacyFinanceView(text) : undefined)
    || (agent === "agenda" && agendaEvents?.length ? { kind: "agenda" as const, events: agendaEvents } : undefined);
  if (view?.kind === "tasks") return <NoraTaskCards view={view} text={text} />;
  if (view?.kind === "finance") return <NoraFinanceTable view={view} text={text} />;
  if (view?.kind === "agenda") return <NoraCalendar view={view} text={text} onAgendaPrompt={onAgendaPrompt} />;
  if (view?.kind === "automations") return <NoraAutomationCards view={view} text={text} />;
  if (agent === "email") return <EmailContent text={text} emailMessages={emailMessages} onOpenEmail={onOpenEmail} />;
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
        {msg.text && <NoraMarkdown text={msg.text} />}
        {msg.files?.length ? <NoraFileCards files={msg.files} /> : null}
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
      <span className="nora-agent-portrait mt-0.5" aria-hidden="true">
        <NoraAvatar className="h-9 w-9" />
        <span className="nora-agent-badge"><Icon size={11} /></span>
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
            responseView={msg.responseView}
            onOpenEmail={onOpenEmail}
            onAgendaPrompt={onAgendaPrompt}
          />
          {msg.files?.length ? <NoraFileCards files={msg.files} /> : null}
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

async function askNoraWhatsAppBackend(message: string, conversaId: string, prepareForApproval: boolean) {
  const data = await apiRequest<Record<string, unknown>>("/api/nora/chat-whatsapp", {
    method: "POST",
    timeoutMs: 60_000,
    body: JSON.stringify({
      conversa_id: conversaId,
      texto_usuario: message,
      enviar_direto_whatsapp: prepareForApproval,
    }),
  });
  return {
    text: String(data?.response || "Nao consegui gerar resposta."),
    sent: Boolean(data?.whatsapp_enviado),
    approvalPending: Boolean(data?.approval || data?.approval_id || data?.awaiting_approval || data?.status === "aguardando_aprovacao"),
    blockedReason: data?.blocked_reason as string | undefined,
  };
}

async function askAgendaAgent(message: string, sessionId: string | null, userId: string) {
  const res = await fetch(`${BACKEND_URL}/api/agenda/agente/mensagem`, {
    method: "POST",
    headers: {
      Accept: "application/json", "Content-Type": "application/json",
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
      "X-Norium-Workspace": localStorage.getItem("norium-workspace-id") || "primary",
    },
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
    headers: {
      Accept: "application/json", "Content-Type": "application/json",
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
      "X-Norium-Workspace": localStorage.getItem("norium-workspace-id") || "primary",
    },
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
  modelId: string | null,
  attachmentIds: string[],
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
      "X-Norium-Workspace": localStorage.getItem("norium-workspace-id") || "primary",
    },
    body: JSON.stringify({
      user_id: userId,
      message: finalText,
      messages: payloadMessages,
      agenda_session_id: agendaSessionId,
      email_session_id: emailSessionId,
      commercial_session_id: commercialSessionId,
      screen_context: screenContext || undefined,
      model_id: modelId || undefined,
      routing_mode: modelId && modelId !== "auto" ? "manual" : "automatic",
      attachment_ids: attachmentIds,
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
  let completed = false;
  if (responseId) handlers.onResponseId(responseId);

  const consume = (parsed: NoraStreamEvent) => {
    if (parsed.response_id && parsed.response_id !== responseId) {
      responseId = parsed.response_id;
      handlers.onResponseId(responseId);
    }
    if (parsed.type === "status" && parsed.state) handlers.onStatus(parsed.state as NoraRunState);
    if (parsed.type === "done") {
      completed = true;
      handlers.onDone(parsed.metrics || {});
    }
    if ((parsed.type === "delta" || !parsed.type) && typeof parsed.delta === "string") {
      fullText += parsed.delta;
      handlers.onDelta(fullText, parsed.delta);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const drained = drainNoraSseEvents(buffer);
    buffer = drained.rest;
    drained.events.forEach(consume);
  }

  buffer += decoder.decode();
  drainNoraSseEvents(buffer, true).events.forEach(consume);
  if (!completed || !fullText.trim()) throw new Error("A resposta progressiva terminou incompleta.");

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
      "X-Norium-Workspace": localStorage.getItem("norium-workspace-id") || "primary",
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
  modelId: string | null,
  attachmentIds: string[],
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
      "X-Norium-Workspace": localStorage.getItem("norium-workspace-id") || "primary",
    },
    body: JSON.stringify({
      user_id: userId,
      message: finalText,
      messages: payloadMessages,
      agenda_session_id: agendaSessionId,
      email_session_id: emailSessionId,
      commercial_session_id: commercialSessionId,
      screen_context: screenContext || undefined,
      model_id: modelId || undefined,
      routing_mode: modelId && modelId !== "auto" ? "manual" : "automatic",
      attachment_ids: attachmentIds,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || "Erro no entendimento natural da Nora.");
  return data as {
    intent: "whatsapp" | "financeiro" | "tarefas" | "email" | "agenda" | "comercial" | "automacoes" | "operacoes" | "equipe" | "chat";
    session_kind: "email" | "agenda" | "commercial" | null;
    session_id: string | null;
    status: string;
    response: string;
    speech_text?: string;
    agent_result?: Record<string, unknown> & { messages?: unknown; events?: unknown; event?: unknown; files?: unknown };
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
  return /proposta|propostas|contrato|contratos|assinatura|assinante|escopo comercial|orcamento|documento|curriculo|cv|carta|relatorio|ata|plano de negocio|recibo|fatura|politica|termo|declaracao|certificado|briefing|manual|checklist|apresentacao|slides?|powerpoint|pptx|pitch deck/.test(normalized);
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

export default function Nora({ open, onClose, conversaId, profile, eventsBySource, userId = "primary", activeTab, onOpenEmail, contextualRequest, variant = "drawer", initialState, onStateChange }: NoraProps) {
  const screenContext = buildScreenContext(activeTab, eventsBySource);
  const welcomeName = (profile?.nome || "").trim().split(/\s+/)[0] || "";
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>(() => initialState?.messages || []);
  const [runState, setRunState] = useState<NoraRunState>("idle");
  const loading = ACTIVE_NORA_STATES.has(runState);
  const [showSuggestions, setShowSuggestions] = useState(!initialState?.messages.length);
  const [prepareWhatsAppApproval, setPrepareWhatsAppApproval] = useState(false);
  const [agentDraft, setAgentDraft] = useState<string | null>(null);
  const [agendaSessionId, setAgendaSessionId] = useState<string | null>(initialState?.agendaSessionId || null);
  const [agendaAgentActive, setAgendaAgentActive] = useState(Boolean(initialState?.agendaAgentActive));
  const [emailSessionId, setEmailSessionId] = useState<string | null>(initialState?.emailSessionId || null);
  const [emailAgentActive, setEmailAgentActive] = useState(Boolean(initialState?.emailAgentActive));
  const [commercialSessionId, setCommercialSessionId] = useState<string | null>(initialState?.commercialSessionId || null);
  const [commercialAgentActive, setCommercialAgentActive] = useState(Boolean(initialState?.commercialAgentActive));
  const [listening, setListening] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [voiceAccess, setVoiceAccess] = useState<VoiceAccessStatus>("locked");
  const [voiceError, setVoiceError] = useState("");
  const [voiceRepliesEnabled, setVoiceRepliesEnabled] = useState(() => readBooleanPreference("norium:nora:voice-replies-v2", false));
  const [voiceGreetingEnabled, setVoiceGreetingEnabled] = useState(() => readBooleanPreference("norium:nora:voice-greeting", false));
  const [expanded, setExpanded] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [modelChoice, setModelChoice] = useState(() => localStorage.getItem("norium:nora:model-choice") || "auto");
  const [autoModelId, setAutoModelId] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; name: string; model: string }>>([]);
  const [pendingFiles, setPendingFiles] = useState<NoraChatFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [fileError, setFileError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (!open) return;
    let active = true;
    void apiRequest<{ providers?: Array<{ id: string; name: string; model: string; enabled: boolean; configured: boolean }> }>("/api/modelos-ia")
      .then(async (overview) => {
        if (!active) return;
        const available = (overview.providers || []).filter((item) => item.enabled && item.configured);
        setModelOptions(available.map(({ id, name, model }) => ({ id, name, model })));
        if (!available.length) return;
        try {
          const routed = await apiRequest<{ selected?: { id?: string } | null }>("/api/modelos-ia/route", {
            method: "POST",
            body: JSON.stringify({ requiredCapabilities: ["text"], estimatedInputTokens: 1000, estimatedOutputTokens: 500, privacy: "any", externalActionCommitted: false }),
          });
          if (active) setAutoModelId(routed.selected?.id || available[0]?.id || null);
        } catch {
          if (active) setAutoModelId(available[0]?.id || null);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    onStateChange?.({ messages, agendaSessionId, agendaAgentActive, emailSessionId, emailAgentActive, commercialSessionId, commercialAgentActive }, loading);
  }, [messages, agendaSessionId, agendaAgentActive, emailSessionId, emailAgentActive, commercialSessionId, commercialAgentActive, loading, onStateChange]);

  const effectiveModelId = modelChoice === "auto" ? "auto" : modelChoice;

  function setCycleState(cycleId: number, state: NoraRunState) {
    if (activeCycleRef.current === cycleId) setRunState(state);
  }

  async function uploadFiles(selected: FileList | null) {
    const files = Array.from(selected || []).slice(0, Math.max(0, 8 - pendingFiles.length));
    if (!files.length) return;
    setUploadingFiles(true);
    setFileError("");
    try {
      const uploaded: NoraChatFile[] = [];
      for (const file of files) {
        if (file.size > 24 * 1024 * 1024) throw new Error(`${file.name} ultrapassa o limite de 24 MB.`);
        const result = await apiRequest<{ file: NoraChatFile }>("/api/nora/files", {
          method: "POST",
          timeoutMs: 90_000,
          body: JSON.stringify({ fileName: file.name, mimeType: inferFileMime(file), dataBase64: await fileToBase64(file) }),
        });
        uploaded.push(result.file);
      }
      setPendingFiles((current) => [...current, ...uploaded].slice(0, 8));
    } catch (reason) {
      setFileError(reason instanceof Error ? reason.message : "Não foi possível anexar o arquivo.");
    } finally {
      setUploadingFiles(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
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
    if (variant === "page") return;
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
    setPrepareWhatsAppApproval(false);
    setAgendaSessionId(null);
    setAgendaAgentActive(false);
    setEmailSessionId(null);
    setEmailAgentActive(false);
    setCommercialSessionId(null);
    setCommercialAgentActive(false);
  }, [conversaId, variant]);

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
      if (["criada", "editada", "excluida", "analisada", "contrato_criado", "enviado_assinatura"].includes(status)) {
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
    if (intent === "whatsapp") return "whatsapp";
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
    const queuedFiles = pendingFiles;
    const typedText = (text || input).trim();
    const finalText = typedText || (queuedFiles.length === 1 ? `Enviei o arquivo ${queuedFiles[0].name}.` : queuedFiles.length > 1 ? `Enviei ${queuedFiles.length} arquivos.` : "");
    if (!finalText || uploadingFiles) return;

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
    setPendingFiles([]);
    setFileError("");
    setVoiceError("");
    setShowSuggestions(false);
    setAgentDraft(null);

    const currentMessages: Msg[] = [...messages, { role: "user", text: finalText, files: queuedFiles.length ? queuedFiles : undefined }];
    setMessages(currentMessages);

    try {
      let response = "";
      let responseSpeechText = "";
      let responseAgent: NoraAgentKind = "geral";
      let responseStatus = "";
      let responseEmailMessages: NoraEmailMessage[] | undefined;
      let responseAgendaEvents: NoraAgendaEvent[] | undefined;
      let responseView: NoraResponseView | undefined;
      let responseFiles: NoraChatFile[] | undefined;
      let handledInline = false;
      let speechWasQueued = false;
      let speechBuffer = "";
      const shouldSpeak = speakReply || voiceRepliesEnabled;
      const sessionInterrupted = interruptsActiveAgentSession(finalText);
      const explicitEmailSwitch = sessionInterrupted || isTaskIntent(finalText) || isFinanceIntent(finalText) || isAgendaIntent(finalText) || isCommercialIntent(finalText) || isAutomationIntent(finalText) || isTeamIntent(finalText);
      const explicitAgendaSwitch = sessionInterrupted || isTaskIntent(finalText) || isFinanceIntent(finalText) || isEmailIntent(finalText) || isCommercialIntent(finalText) || isAutomationIntent(finalText) || isTeamIntent(finalText);
      const explicitCommercialSwitch = sessionInterrupted || isTaskIntent(finalText) || isFinanceIntent(finalText) || isEmailIntent(finalText) || isAgendaIntent(finalText) || isAutomationIntent(finalText) || isTeamIntent(finalText);
      const continueEmailSession = emailAgentActive && !explicitEmailSwitch && queuedFiles.length === 0;
      const continueAgendaSession = agendaAgentActive && !explicitAgendaSwitch && queuedFiles.length === 0;
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
        (prepareWhatsAppApproval || isWhatsAppConversationIntent(finalText)) &&
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
        responseView = buildNoraResponseView("agenda", result);
        setAgendaSessionId(result.session_id);
        setAgendaAgentActive(Boolean(result.session_id && !["criado", "cancelado", "consulta", "atualizado"].includes(result.status)));
        response = result.response;
      } else if (shouldUseWhatsAppContext) {
        setCycleState(cycleId, "analyzing");
        const result = await askNoraWhatsAppBackend(finalText, conversaId, prepareWhatsAppApproval);
        if (activeCycleRef.current !== cycleId) return;
        responseAgent = "whatsapp";
        responseStatus = result.approvalPending ? "aguardando aprovação" : result.sent ? "enviado" : result.blockedReason || "";
        response = result.approvalPending
          ? `${result.text}\n\nEnvio preparado e aguardando sua aprovação no Centro de aprovações.`
          : result.sent
            ? `${result.text}\n\nA execução foi registrada pelo Norium.`
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
            effectiveModelId,
            queuedFiles.map((file) => file.id),
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
          response = streamResult.fullText;
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
            effectiveModelId,
            queuedFiles.map((file) => file.id),
          );
          if (activeCycleRef.current !== cycleId) return;
          applyNaturalAgentEffects(result);
          responseAgent = naturalIntentToAgent(result.intent);
          responseView = buildNoraResponseView(result.intent, result.agent_result);
          responseFiles = normalizeChatFiles(result.agent_result?.files);
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
          if (!result.response?.trim()) {
            throw new Error("A Nora recebeu uma resposta incompleta. Tente novamente em instantes.");
          }
          response = result.response;
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
            responseView,
            files: responseFiles,
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
      setMessages((prev) => [...prev, { role: "ai", text: "Abra uma conversa para que eu possa resumir o histórico registrado.", agent: "erro" }]);
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
      setMessages((prev) => [...prev, { role: "ai", text: data?.resumo || "Não há conteúdo registrado para resumir.", agent: "mensagens", status: "resumo" }]);
      setCycleState(cycleId, "completed");
    } catch {
      if (controller.signal.aborted || activeCycleRef.current !== cycleId) return;
      setMessages((prev) => [...prev, { role: "ai", text: "Não consegui acessar o histórico desta conversa agora. Tente novamente em instantes.", agent: "erro" }]);
      setCycleState(cycleId, "error");
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }

  async function runAgentDraft() {
    if (!conversaId) {
      setMessages((prev) => [...prev, { role: "ai", text: "Selecione um chat para que eu use o contexto correto ao preparar o rascunho.", agent: "erro" }]);
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
      "X-Norium-Workspace": localStorage.getItem("norium-workspace-id") || "primary",
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
      "X-Norium-Workspace": localStorage.getItem("norium-workspace-id") || "primary",
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
      setMessages((prev) => [...prev, { role: "ai", text: "Rascunho enviado pelo Agente de Mensagens e registrado no histórico.", agent: "mensagens", status: "enviado" }]);
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
  const voiceButtonLabel = listening
    ? "Parar gravação de voz"
    : voiceAccess === "requesting"
      ? "Solicitando acesso ao microfone"
      : transcribing
        ? "Transcrevendo mensagem de voz"
        : "Gravar mensagem de voz";

  function closeNora() {
    cancelActiveResponse(false);
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          {variant === "drawer" && <motion.div
            className="nora-drawer-backdrop fixed inset-0 z-40 bg-black/35 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeNora}
          />}

          <motion.aside
            initial={{ x: variant === "page" ? 0 : 500, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 500, opacity: 0 }}
            transition={{ type: "spring", stiffness: 120, damping: 18 }}
            className={`nora-drawer ${variant === "page" ? `nora-page relative ${messages.length === 0 ? "nora-page-empty" : ""}` : "fixed"} z-[90] flex max-w-[100vw] flex-col overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-2xl transition-all duration-300 ${
              variant === "page" ? "" : expanded
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
                    {conversaId ? `Contexto ativo: ${conversaId}` : variant === "page" ? "Sua assistente no Norium" : "Pronta para ajudar no Norium"}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setControlsOpen(true)}
                  className="hidden h-9 max-w-52 items-center gap-2 rounded-lg border border-white/10 px-3 text-xs font-bold text-white/80 transition hover:bg-white/10 sm:flex"
                  title="Trocar modelo da conversa"
                  aria-label="Trocar modelo da conversa"
                >
                  <BrainCircuit size={14} />
                  <span className="truncate">{modelChoice === "auto" ? "Modelo automático" : modelOptions.find((item) => item.id === modelChoice)?.name || "Modelo manual"}</span>
                </button>
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
                {variant === "drawer" && <><Button variant="ghost" size="sm" iconOnly
                  onClick={() => setExpanded((value) => !value)}
                  className="nora-expand-toggle hover:bg-white/10"
                  title={expanded ? "Voltar para lateral" : "Expandir Nora"}
                 aria-label={expanded ? "Voltar para lateral" : "Expandir Nora"}>
                  {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </Button>
                <Button variant="ghost" size="sm" iconOnly aria-label="Fechar Nora" title="Fechar Nora" onClick={closeNora} className="hover:bg-white/10">
                  <X size={18} />
                </Button></>}
              </div>
            </div>

            {controlsOpen && (
            <div className="nora-drawer-controls border-b border-[var(--border)] p-3">
              <label className="mb-3 block rounded-lg border border-cyan-400/20 bg-[var(--surface)] px-3 py-2 text-xs font-bold text-[var(--text)]">
                <span className="mb-1.5 flex items-center gap-2"><BrainCircuit size={14} /> Modelo da conversa</span>
                <select
                  value={modelChoice}
                  onChange={(event) => {
                    setModelChoice(event.target.value);
                    localStorage.setItem("norium:nora:model-choice", event.target.value);
                  }}
                  className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-xs font-bold outline-none"
                >
                  <option value="auto">Automático — alternar quando necessário</option>
                  {modelOptions.map((item) => <option key={item.id} value={item.id}>{item.name} / {item.model}</option>)}
                </select>
                <small className="mt-1.5 block text-[var(--text-secondary)]">{modelChoice === "auto" ? `O Norium escolhe e troca em caso de falha, limite ou resposta vazia${autoModelId ? `; primeira opção: ${modelOptions.find((item) => item.id === autoModelId)?.name || "modelo disponível"}.` : "."}` : "Seleção manual para respostas gerais."}</small>
              </label>
              <label className={`flex items-center justify-between gap-3 rounded-lg border border-cyan-400/20 bg-[var(--surface)] px-3 py-2 text-xs font-bold ${conversaId ? "text-[var(--text)]" : "text-[var(--text-secondary)]"}`}>
                <span>Preparar envio para aprovação</span>
                <input
                  type="checkbox"
                  checked={prepareWhatsAppApproval}
                  disabled={!conversaId}
                  onChange={(event) => setPrepareWhatsAppApproval(event.target.checked)}
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
                  <h3>{welcomeName && <span>{`Olá, ${welcomeName}. `}</span>}<strong>O que vamos resolver hoje?</strong></h3>
                  <p>Converse, crie e acione qualquer área do Norium.</p>
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
                  <p className="nora-suggestions-label text-xs font-bold mb-3 text-[var(--text-secondary)] uppercase tracking-wide">Sugestões rápidas</p>

                  <div className="nora-suggestions-grid flex flex-wrap justify-center gap-2">
                    {suggestions.filter((suggestion) => variant !== "page" || !["summary", "agent", "question"].includes(suggestion.action)).map((suggestion) => {
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
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.mp3,.wav,.ogg,.webm,.mp4,.mov"
                onChange={(event) => void uploadFiles(event.target.files)}
              />
              {pendingFiles.length > 0 && (
                <div className="nora-pending-files" aria-label="Arquivos anexados">
                  {pendingFiles.map((file) => (
                    <span key={file.id}><Paperclip size={13} /><strong title={file.name}>{file.name}</strong><button type="button" onClick={() => setPendingFiles((items) => items.filter((item) => item.id !== file.id))} aria-label={`Remover ${file.name}`}><X size={13} /></button></span>
                  ))}
                </div>
              )}
              {fileError && <p className="nora-file-composer-error">{fileError}</p>}
              {voiceError && (
                <p className="mb-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs font-bold text-amber-300">
                  {voiceError}
                </p>
              )}
              {listening && (
                <div className="nora-listening-status mb-2 flex items-center gap-3 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2">
                  <span className="nora-voice-waveform nora-voice-waveform-status" aria-hidden="true"><i /><i /><i /><i /><i /></span>
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
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingFiles || loading || pendingFiles.length >= 8}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-cyan-300 disabled:opacity-45"
                  title="Enviar arquivo para a Nora"
                  aria-label="Enviar arquivo para a Nora"
                >
                  {uploadingFiles ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
                </button>
                <textarea
                  aria-label="Mensagem para a Nora"
                  maxLength={4000}
                  rows={2}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }}
                  placeholder={transcribing ? "Transcrevendo sua voz..." : listening ? "Ouvindo sua mensagem..." : "Escreva para a Nora..."}
                  className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm font-semibold outline-none text-[var(--text)] placeholder:text-[var(--text-secondary)]"
                />

                {variant === "page" && (
                  <button
                    type="button"
                    onClick={() => setControlsOpen((value) => !value)}
                    className="nora-composer-model"
                    title="Modelo e preferências da conversa"
                    aria-label="Modelo e preferências da conversa"
                    aria-expanded={controlsOpen}
                  >
                    <BrainCircuit size={14} />
                    <span>{modelChoice === "auto" ? "Automático" : modelOptions.find((item) => item.id === modelChoice)?.name || "Modelo"}</span>
                  </button>
                )}
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
                  data-recording={listening ? "true" : "false"}
                  className={`nora-voice-button flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition ${
                    listening
                      ? "is-recording bg-cyan-400/15 text-cyan-200"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                  }`}
                  title={voiceButtonLabel}
                 aria-label={voiceButtonLabel}>
                  {listening ? <span className="nora-voice-waveform" aria-hidden="true"><i /><i /><i /><i /><i /></span> : <Mic size={18} />}
                </button>

                <motion.button
                  whileTap={{ scale: 0.94 }}
                  type="button"
                  onClick={() => loading ? cancelActiveResponse() : void sendMessage()}
                  disabled={!loading && uploadingFiles}
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
