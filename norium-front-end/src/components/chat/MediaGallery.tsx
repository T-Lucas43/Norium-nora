import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, CornerUpRight, Download, Image as ImageIcon, Play, RefreshCw, X } from "lucide-react";
import type { ChatConversa, MsgConteudo } from "./types";
import { useAuthenticatedMedia, useAuthenticatedMediaState } from "./useAuthenticatedMedia";
import { conversationDisplayName } from "./contactPicker";

function isVideo(message: MsgConteudo) {
  return message.arquivoMime?.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(message.nomeArquivo || "");
}

function GalleryThumbnail({ message, active, onClick }: { message: MsgConteudo; active: boolean; onClick: () => void }) {
  const preview = useAuthenticatedMedia(message.miniaturaUrl);
  return <button type="button" className="nx-whatsapp-gallery-thumb" aria-current={active || undefined}
    aria-label={`Abrir ${isVideo(message) ? "vídeo" : "imagem"} de ${message.horario}`} onClick={onClick}>
    {preview ? <img src={preview} alt="" /> : isVideo(message) ? <Play size={20} /> : <ImageIcon size={20} />}
  </button>;
}

export default function MediaGallery({ conversation, messageId, onSelect, onClose, onForward }: {
  conversation: ChatConversa; messageId: string; onSelect: (id: string) => void; onClose: () => void;
  onForward: (ids: string[]) => void;
}) {
  const items = conversation.mensagens.filter(message => message.tipo === "midia" && !message.viewOnce && message.arquivoUrl);
  const index = items.findIndex(message => message.id === messageId);
  const message = items[index];
  const media = useAuthenticatedMediaState(message?.arquivoUrl);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus?.(); };
  }, []);
  useEffect(() => {
    if (!message) onClose();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.target instanceof HTMLVideoElement) return;
      if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); onSelect(items[index - 1].id); }
      if (event.key === "ArrowRight" && index < items.length - 1) { event.preventDefault(); onSelect(items[index + 1].id); }
      if (event.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],video[controls]');
        if (!focusable?.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keyboard, true);
    return () => document.removeEventListener("keydown", keyboard, true);
  }, [index, items, message, onClose, onSelect]);
  if (!message) return null;
  const sender = message.remetente === "usuario" ? "Você" : message.remetenteNome || conversationDisplayName(conversation);
  const date = message.timestamp ? new Date(message.timestamp * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : message.horario;
  return createPortal(<div ref={dialogRef} className="nx-whatsapp-gallery" role="dialog" aria-modal="true" aria-label="Mídia em tela cheia">
    <header><div className="min-w-0 flex-1"><strong>{sender}</strong><p>{date} · {index + 1} de {items.length}</p></div>
      <button type="button" aria-label="Encaminhar mídia" onClick={() => { onClose(); onForward([message.id]); }}><CornerUpRight size={20} /></button>
      <a aria-label="Baixar mídia" aria-disabled={!media.source} href={media.source || undefined} download={message.nomeArquivo || "midia"}><Download size={20} /></a>
      <button type="button" ref={closeRef} onClick={onClose} aria-label="Fechar"><X size={22} /></button>
    </header>
    <div className="nx-whatsapp-gallery-stage">
      <button type="button" aria-label="Mídia anterior" disabled={index <= 0} onClick={() => onSelect(items[index - 1].id)}><ChevronLeft size={26} /></button>
      <div className="nx-whatsapp-gallery-content">
        {media.loading && <p role="status">Carregando mídia…</p>}
        {media.error && <div role="alert"><p>Não foi possível abrir esta mídia.</p><button onClick={media.retry} type="button"><RefreshCw size={16} /> Tentar novamente</button></div>}
        {media.source && (isVideo(message) ? <video key={message.id} src={media.source} controls autoPlay /> : <img src={media.source} alt={message.texto || "Midia em tela cheia"} />)}
      </div>
      <button type="button" aria-label="Próxima mídia" disabled={index >= items.length - 1} onClick={() => onSelect(items[index + 1].id)}><ChevronRight size={26} /></button>
    </div>
    <p className="nx-whatsapp-gallery-caption">{message.texto}</p>
    <nav aria-label="Miniaturas da conversa">{items.slice(Math.max(0, index - 8), index + 9).map(item => <GalleryThumbnail key={item.id} message={item} active={item.id === messageId} onClick={() => onSelect(item.id)} />)}</nav>
  </div>, document.body);
}
