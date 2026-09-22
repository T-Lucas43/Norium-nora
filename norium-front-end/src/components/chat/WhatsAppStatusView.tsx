import { Camera, ChevronLeft, ChevronRight, CircleDot, Eye, Image as ImageIcon, Mic, Pencil, RefreshCw, SendHorizontal, Square, Video, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WhatsAppProfile, WhatsAppStatusItem, WhatsAppSyncProgress } from "./whatsappApi";
import { useAuthenticatedMedia, useAuthenticatedMediaState, useWhatsAppProfilePhoto } from "./useAuthenticatedMedia";

interface WhatsAppStatusViewProps {
  items: WhatsAppStatusItem[];
  selectedId: string | null;
  profile?: WhatsAppProfile | null;
  loading?: boolean;
  error?: string | null;
  sync?: WhatsAppSyncProgress | null;
  onSelect: (item: WhatsAppStatusItem) => void;
  onRefresh: () => void;
  onCreateUnavailable: () => void;
  onReplyText?: (item: WhatsAppStatusItem, text: string) => void | Promise<void>;
  onReplyAudio?: (item: WhatsAppStatusItem, audio: Blob, mimeType: string) => void | Promise<void>;
}

function formatTime(timestamp: number) {
  const value = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Agora";
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type StatusContactGroup = {
  key: string;
  items: WhatsAppStatusItem[];
  latest: WhatsAppStatusItem;
  latestMedia?: WhatsAppStatusItem;
  photoUrl?: string;
};

function statusContactKey(item: WhatsAppStatusItem) {
  const contactId = item.contactId?.trim().toLocaleLowerCase();
  const name = item.name.trim().toLocaleLowerCase("pt-BR");
  const identity = contactId ? `contact:${contactId}` : name ? `name:${name}` : `id:${item.id}`;
  return `${item.mine ? "mine" : "contact"}:${identity}`;
}

function groupStatusesByContact(items: WhatsAppStatusItem[]) {
  const grouped = new Map<string, StatusContactGroup>();

  items.forEach((item) => {
    const key = statusContactKey(item);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        key,
        items: [item],
        latest: item,
        latestMedia: item.type !== "text" ? item : undefined,
        photoUrl: item.photoUrl,
      });
      return;
    }

    current.items.push(item);
    if (item.timestamp >= current.latest.timestamp) current.latest = item;
    if (item.type !== "text" && (!current.latestMedia || item.timestamp >= current.latestMedia.timestamp)) current.latestMedia = item;
    if (item.photoUrl && (!current.photoUrl || item.timestamp >= current.latest.timestamp)) current.photoUrl = item.photoUrl;
  });

  return Array.from(grouped.values()).sort((left, right) => right.latest.timestamp - left.latest.timestamp);
}

function StatusAvatar({ identifier, name, photoUrl, viewed = false }: { identifier?: string; name: string; photoUrl?: string; viewed?: boolean }) {
  const { source, onError } = useWhatsAppProfilePhoto(identifier, photoUrl);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
  return (
    <span className={`grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full border-[3px] bg-[var(--background)] text-xs font-extrabold ${viewed ? "border-[var(--border)] text-[var(--text-secondary)]" : "border-[var(--primary)] text-[var(--text)]"}`}>
      {source ? <img src={source} alt="" className="h-full w-full rounded-full object-cover" onError={onError} /> : initials}
    </span>
  );
}

function StatusPreview({ item, name }: { item?: WhatsAppStatusItem; name: string }) {
  const source = useAuthenticatedMedia(item?.mediaUrl);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item?.id, source]);

  if (!item) return null;

  if (item.type === "image") return (
    <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-[var(--border)] bg-black text-[var(--text-secondary)]">
      {source && !failed
        ? <img src={source} alt={`Pr\u00e9via do Status de ${name}`} className="h-full w-full object-cover" onError={() => setFailed(true)} />
        : <ImageIcon size={17} aria-hidden="true" />}
    </span>
  );

  if (item.type === "video") return (
    <span className="relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-[var(--border)] bg-black text-white" role="img" aria-label={`Pr\u00e9via em v\u00eddeo do Status de ${name}`}>
      {source && !failed && <video src={source} muted playsInline preload="metadata" className="h-full w-full object-cover opacity-70" onError={() => setFailed(true)} />}
      <span className="absolute inset-0 grid place-items-center bg-black/25"><Video size={17} aria-hidden="true" /></span>
    </span>
  );

  return (
    <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[var(--border)] bg-black ${source ? "text-[var(--primary)]" : "text-[var(--text-secondary)]"}`} role="img" aria-label={`Pr\u00e9via em \u00e1udio do Status de ${name}`}>
      <Volume2 size={18} aria-hidden="true" />
    </span>
  );
}

function StatusMedia({ item }: { item: WhatsAppStatusItem }) {
  const { source, loading, error, retry } = useAuthenticatedMediaState(item.mediaUrl);
  const [elementError, setElementError] = useState(false);
  useEffect(() => setElementError(false), [item.id, item.mediaUrl]);
  const retryMedia = () => {
    setElementError(false);
    retry();
  };

  if (item.type === "text") return (
    <div className="flex min-h-[360px] w-full max-w-[660px] items-center justify-center rounded-3xl px-12 py-20 text-center text-3xl font-semibold leading-normal text-white shadow-2xl" style={{ background: item.color || "linear-gradient(145deg, #0759f5, #07265d)" }}>
      {item.text || "Status sem legenda"}
    </div>
  );

  if (loading) return (
    <div className="grid min-h-[360px] w-full max-w-[660px] animate-pulse place-items-center rounded-3xl border border-white/10 bg-black/70 text-sm font-semibold text-white/70" role="status">
      Carregando mídia do Status...
    </div>
  );

  if ((!source || error || elementError)) return (
    <div className="grid min-h-[360px] w-full max-w-[660px] place-items-center rounded-3xl border border-amber-400/25 bg-black/80 px-8 text-center text-white" role="alert">
      <div>
        <p className="text-base font-bold">Mídia do Status indisponível</p>
        <p className="mt-2 text-sm text-white/60">A publicação foi reconhecida como {item.type === "audio" ? "áudio" : item.type === "video" ? "vídeo" : "imagem"}, mas o arquivo não pôde ser carregado.</p>
        {item.mediaUrl && <button type="button" onClick={retryMedia} className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-bold hover:border-[var(--primary)]"><RefreshCw size={15} /> Tentar novamente</button>}
        {item.text?.trim() && <p className="mt-5 text-sm font-semibold text-white/80">{item.text}</p>}
      </div>
    </div>
  );

  if (item.type === "audio") return (
    <figure className="w-full max-w-[660px] rounded-3xl border border-white/10 bg-black/80 px-8 py-12 text-white shadow-2xl">
      <audio src={source} controls autoPlay className="w-full" onError={() => setElementError(true)} />
      {item.text?.trim() && <figcaption className="mt-5 text-center text-sm font-semibold leading-6 text-white/85">{item.text}</figcaption>}
    </figure>
  );

  return (
    <figure className="relative max-h-[72vh] max-w-full overflow-hidden rounded-2xl bg-black shadow-2xl">
      {item.type === "video"
        ? <video src={source} controls autoPlay className="max-h-[72vh] max-w-full object-contain" onError={() => setElementError(true)} />
        : <img src={source} alt={`Status de ${item.name}`} className="max-h-[72vh] max-w-full object-contain" onError={() => setElementError(true)} />}
      {item.text?.trim() && <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/80 to-transparent px-5 pb-5 pt-12 text-center text-sm font-semibold leading-6 text-white drop-shadow">{item.text}</figcaption>}
    </figure>
  );
}

export default function WhatsAppStatusView({ items, selectedId, profile, loading, error, sync, onSelect, onRefresh, onCreateUnavailable, onReplyText, onReplyAudio }: WhatsAppStatusViewProps) {
  const selected = items.find((item) => item.id === selectedId) || null;
  const selectedIndex = selected ? items.findIndex((item) => item.id === selected.id) : -1;
  const contactGroups = groupStatusesByContact(items);
  const mine = contactGroups.filter((group) => group.latest.mine);
  const recent = contactGroups.filter((group) => !group.latest.mine && group.items.some((item) => !item.viewed));
  const viewed = contactGroups.filter((group) => !group.latest.mine && group.items.every((item) => item.viewed));
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [preparingRecording, setPreparingRecording] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const canceledRef = useRef(false);
  const swipeStartRef = useRef<number | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const navigationLocked = recording || preparingRecording;

  const goTo = (offset: number) => {
    if (navigationLocked) return;
    const next = items[selectedIndex + offset];
    if (next) onSelect(next);
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!selected || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "ArrowLeft") goTo(-1);
      if (event.key === "ArrowRight") goTo(1);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  useEffect(() => () => {
    canceledRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const sendTextReply = async () => {
    const text = reply.trim();
    if (!selected || selected.mine || !text || !onReplyText || sending || navigationLocked) return;
    setSending(true);
    setReplyError(null);
    try {
      await onReplyText(selected, text);
      setReply("");
    } catch (sendError) {
      setReplyError(sendError instanceof Error ? sendError.message : "Não foi possível responder ao Status.");
    } finally {
      setSending(false);
    }
  };

  const toggleRecording = async () => {
    if (!selected || selected.mine || !onReplyAudio || sending || preparingRecording) return;
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
      setRecording(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setReplyError("Seu navegador não liberou a gravação de áudio.");
      return;
    }
    let pendingStream: MediaStream | null = null;
    try {
      setReplyError(null);
      canceledRef.current = false;
      const target = selected;
      setPreparingRecording(true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      pendingStream = stream;
      if (canceledRef.current || selectedIdRef.current !== target.id) {
        stream.getTracks().forEach((track) => track.stop());
        pendingStream = null;
        if (!canceledRef.current) setPreparingRecording(false);
        return;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        const resolvedMime = (recorder.mimeType || mimeType || "audio/webm").split(";")[0];
        const audio = new Blob(chunksRef.current, { type: resolvedMime });
        chunksRef.current = [];
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        if (canceledRef.current || audio.size === 0) return;
        setSending(true);
        try {
          await onReplyAudio(target, audio, resolvedMime);
        } catch (sendError) {
          setReplyError(sendError instanceof Error ? sendError.message : "Não foi possível responder com áudio.");
        } finally {
          setSending(false);
        }
      };
      recorder.start(250);
      pendingStream = null;
      setPreparingRecording(false);
      setRecording(true);
    } catch (recordError) {
      pendingStream?.getTracks().forEach((track) => track.stop());
      if (streamRef.current === pendingStream) streamRef.current = null;
      if (recorderRef.current?.state !== "recording") recorderRef.current = null;
      setPreparingRecording(false);
      setReplyError(recordError instanceof Error ? recordError.message : "Não foi possível acessar o microfone.");
    }
  };

  const renderItems = (sectionItems: StatusContactGroup[], label: string) => sectionItems.length ? (
    <section className="pb-2">
      <h3 className="px-4 pb-2 pt-4 text-[10px] font-extrabold uppercase tracking-[0.16em] text-[var(--text-secondary)]">{label}</h3>
      {sectionItems.map((group) => {
        const item = group.latest;
        const count = group.items.length;
        const countLabel = `${count} ${count === 1 ? "atualiza\u00e7\u00e3o" : "atualiza\u00e7\u00f5es"}`;
        const hasUnviewed = !item.mine && group.items.some((status) => !status.viewed);
        const active = group.items.some((status) => status.id === selectedId);
        return (
          <button key={group.key} type="button" disabled={navigationLocked} onClick={() => onSelect(item)} aria-label={`${item.name}, ${countLabel}, ${formatTime(item.timestamp)}`} aria-current={active ? "true" : undefined} className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${active ? "bg-[color-mix(in_srgb,var(--primary)_14%,transparent)]" : ""}`}>
            <StatusAvatar identifier={item.contactId} name={item.name} photoUrl={group.photoUrl} viewed={!hasUnviewed} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-[var(--text)]">{item.name}</span>
              <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">{formatTime(item.timestamp)} - {countLabel}</span>
            </span>
            <StatusPreview item={group.latestMedia} name={item.name} />
            {hasUnviewed && <span className="h-2 w-2 rounded-full bg-[var(--primary)]" />}
          </button>
        );
      })}
    </section>
  ) : null;

  return (
    <>
      <aside className="norium-chat-sidebar flex h-full min-h-0 w-[380px] min-w-[320px] flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
        <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold"><CircleDot size={20} className="text-[var(--primary)]" /> Status</h2>
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">Atualizações recebidas pelo WhatsApp</p>
          </div>
          <button type="button" onClick={onRefresh} disabled={loading} className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--border)] hover:border-[var(--primary)] disabled:opacity-50" aria-label="Atualizar status"><RefreshCw size={16} className={loading ? "animate-spin" : ""} /></button>
        </header>

        <div className="border-b border-[var(--border)] px-4 py-4">
          <div className="flex items-center gap-3">
            <StatusAvatar identifier={profile?.phone} name={profile?.name || "Meu status"} photoUrl={profile?.photoUrl} viewed />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">Meu status</p>
              <p className="mt-0.5 text-xs text-[var(--text-secondary)]">Publique pelo WhatsApp no celular</p>
            </div>
          </div>
          {sync?.status === "syncing" && (
            <div className="mt-3 rounded-xl border border-[var(--primary)]/25 bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] px-3 py-2" role="status" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-[10px] font-bold"><span className="truncate">{sync.message || "Recebendo contatos e Status"}</span><span className="text-[var(--primary)]">{Math.round(sync.progress || 0)}%</span></div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/60"><div className="h-full rounded-full bg-[var(--primary)] transition-[width]" style={{ width: `${Math.max(0, Math.min(100, sync.progress || 0))}%` }} /></div>
            </div>
          )}
        </div>

        <div className="norium-chat-list min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {loading && <p className="p-8 text-center text-sm font-semibold text-[var(--text-secondary)]">Atualizando status...</p>}
          {!loading && error && <div className="p-8 text-center"><p className="text-sm font-semibold text-red-400">{error}</p><button type="button" onClick={onRefresh} className="mt-3 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold">Tentar novamente</button></div>}
          {!loading && !error && items.length === 0 && (
            <div className="grid place-items-center gap-2 p-10 text-center text-[var(--text-secondary)]">
              <CircleDot size={28} />
              <p className="text-sm font-semibold">Nenhum Status recebido ainda.</p>
              <p className="text-xs leading-5">A W-API não disponibilizou Status recentes para esta sessão. Novos eventos aparecerão aqui se forem entregues pela integração.</p>
              {sync?.status === "error" && <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">A sincronização da agenda falhou, mas o Norium continuará aguardando novos Status.</p>}
              <button type="button" onClick={onRefresh} className="mt-1 rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--text)] hover:border-[var(--primary)]">Atualizar Status</button>
            </div>
          )}
          {!loading && !error && renderItems(mine, "Meus status")}
          {!loading && !error && renderItems(recent, "Recentes")}
          {!loading && !error && renderItems(viewed, "Visualizados")}
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[#090b0d] text-[var(--text)]">
        {selected ? (
          <>
            <header className="flex h-[72px] shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5">
              <StatusAvatar identifier={selected.contactId} name={selected.name} photoUrl={selected.photoUrl} viewed={selected.viewed} />
              <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-bold">{selected.name}</h3><p className="text-xs text-[var(--text-secondary)]">{formatTime(selected.timestamp)}</p></div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"><Eye size={13} /> Visualizado</span>
            </header>
            <div
              className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center overflow-auto p-6"
              onPointerDown={(event) => { swipeStartRef.current = navigationLocked ? null : event.clientX; }}
              onPointerCancel={() => { swipeStartRef.current = null; }}
              onPointerUp={(event) => {
                const start = swipeStartRef.current;
                swipeStartRef.current = null;
                if (start === null) return;
                const delta = event.clientX - start;
                if (Math.abs(delta) < 48) return;
                goTo(delta < 0 ? 1 : -1);
              }}
              data-testid="status-swipe-area"
            >
              <button type="button" onClick={() => goTo(-1)} disabled={navigationLocked || selectedIndex <= 0} className="absolute left-5 z-10 grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-black/70 text-white shadow-xl disabled:invisible" aria-label="Status anterior"><ChevronLeft size={24} /></button>
              <StatusMedia key={`${selected.id}:${selected.mediaUrl || ""}:${selected.type}`} item={selected} />
              <button type="button" onClick={() => goTo(1)} disabled={navigationLocked || selectedIndex < 0 || selectedIndex >= items.length - 1} className="absolute right-5 z-10 grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-black/70 text-white shadow-xl disabled:invisible" aria-label="Próximo Status"><ChevronRight size={24} /></button>
            </div>
            {!selected.mine && (onReplyText || onReplyAudio) && (
              <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3">
                {replyError && <p className="mb-2 text-xs font-semibold text-red-400" role="alert">{replyError}</p>}
                {preparingRecording && <p className="mb-2 text-xs font-semibold text-amber-300" role="status">Solicitando acesso ao microfone. Aguarde antes de mudar de Status.</p>}
                {recording && <p className="mb-2 text-xs font-semibold text-amber-300" role="status">Gravação em andamento. Finalize o áudio antes de mudar de Status.</p>}
                <div className="flex items-center gap-2">
                  <input value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void sendTextReply(); }} disabled={sending || navigationLocked} placeholder={`Responder ao Status de ${selected.name}`} className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-black px-4 text-sm text-[var(--text)] outline-none focus:border-[var(--primary)] disabled:opacity-60" />
                  {onReplyAudio && <button type="button" onClick={() => void toggleRecording()} disabled={sending || preparingRecording} aria-label={preparingRecording ? "Preparando gravação de áudio" : recording ? "Parar e enviar áudio" : "Responder com áudio"} className={`grid h-11 w-11 place-items-center rounded-xl border transition ${recording ? "animate-pulse border-red-500 bg-red-500 text-white" : "border-[var(--border)] bg-black text-[var(--text)] hover:border-[var(--primary)]"} disabled:opacity-50`}>{recording ? <Square size={16} fill="currentColor" /> : <Mic size={19} />}</button>}
                  {onReplyText && <button type="button" onClick={() => void sendTextReply()} disabled={sending || navigationLocked || !reply.trim()} aria-label="Enviar resposta ao Status" className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--primary)] text-white disabled:opacity-40"><SendHorizontal size={18} /></button>}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center">
            <div className="grid h-28 w-28 place-items-center rounded-full border border-[var(--primary)]/25 bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)]"><CircleDot size={48} strokeWidth={1.25} /></div>
            <h3 className="mt-6 text-xl font-semibold">Status do WhatsApp</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-[var(--text-secondary)]">{loading ? "Buscando as atualizações mais recentes do WhatsApp..." : items.length === 0 ? "A W-API não disponibilizou Status recentes para esta sessão. Novos eventos aparecerão aqui se forem entregues pela integração." : "Visualize aqui as atualizações recebidas. Elas ficam separadas das mensagens e não poluem sua caixa de conversas."}</p>
            <div className="mt-6 flex gap-3">
              <button type="button" onClick={onCreateUnavailable} className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-4 py-2.5 text-sm font-semibold hover:border-[var(--primary)]"><Pencil size={16} /> Status de texto</button>
              <button type="button" onClick={onCreateUnavailable} className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-4 py-2.5 text-sm font-semibold hover:border-[var(--primary)]"><Camera size={16} /> Foto e vídeo</button>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
