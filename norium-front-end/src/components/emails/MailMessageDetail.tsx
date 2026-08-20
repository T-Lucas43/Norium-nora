import { useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Archive, ChevronLeft, Download, FileText, Image, Loader2, MailCheck, MailOpen,
  Maximize2, Minimize2, MoreVertical, ShieldAlert, Star, Trash2, X,
} from "lucide-react";
import Button from "../shared/Button";
import { cn } from "../../utils/cn";
import {
  classifyEmailCategory, emailCategoryMeta, formatBytes, friendlyGmailLabel, initials, isImage, normalizeText,
} from "../../features/mail/formatters";
import type { GmailLabel, GmailMessage } from "../../features/mail/types";

/** Rotulos ja representados por outros elementos da tela; nao repetir na lista. */
const ROTULOS_REDUNDANTES = ["Caixa de entrada", "Nao lido", "Com estrela", "Importante"];
const MAX_ROTULOS = 10;

function PortalWhen({ active, children }: { active: boolean; children: ReactNode }) {
  if (active && typeof document !== "undefined") return createPortal(children, document.body);
  return children;
}

function responsiveEmailDocument(rawHtml: string) {
  const protections = `
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'" />
    <style>
      :root { color-scheme: light; }
      html, body { width: 100% !important; max-width: 100% !important; margin: 0 !important; overflow-x: hidden !important; }
      body { box-sizing: border-box; padding: 12px; color: #111827; background: #fff; font-family: Arial, Helvetica, sans-serif; line-height: 1.5; overflow-wrap: anywhere; }
      *, *::before, *::after { box-sizing: border-box !important; max-width: 100% !important; }
      img, video, svg, canvas { height: auto !important; max-width: 100% !important; }
      table { width: 100% !important; max-width: 100% !important; table-layout: fixed !important; }
      td, th, pre, code, a { white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
      form, input, button, textarea, select { display: none !important; }
    </style>`;
  if (/<head(?:\s[^>]*)?>/i.test(rawHtml)) {
    return rawHtml.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${protections}`);
  }
  return `<!doctype html><html><head>${protections}</head><body>${rawHtml}</body></html>`;
}

function ResponsiveEmailFrame({ html }: { html: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(420);
  const documentHtml = useMemo(() => responsiveEmailDocument(html), [html]);

  function resizeToContent() {
    const frameDocument = frameRef.current?.contentDocument;
    if (!frameDocument) return;
    const measured = Math.max(
      frameDocument.body?.scrollHeight || 0,
      frameDocument.documentElement?.scrollHeight || 0,
      180,
    );
    setHeight(Math.min(measured + 4, 20_000));
    frameDocument.querySelectorAll("img").forEach((image) => {
      if (!image.complete) image.addEventListener("load", resizeToContent, { once: true });
    });
  }

  return (
    <iframe
      ref={frameRef}
      title="Conteudo do e-mail"
      sandbox="allow-same-origin"
      srcDoc={documentHtml}
      scrolling="no"
      onLoad={resizeToContent}
      style={{ height }}
      className="mail-message-frame block w-full min-w-0 border-0 bg-white"
    />
  );
}

type MailMessageDetailProps = {
  message: GmailMessage;
  labelById: Map<string, GmailLabel>;
  loading: boolean;
  fullscreen: boolean;
  menuOpen: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Caixa de resposta, montada pelo dashboard. */
  replyBox?: ReactNode;
  onClose: () => void;
  onToggleFullscreen: () => void;
  onToggleMenu: () => void;
  onAction: (action: string, closeAfter?: boolean) => void;
  onDownloadAttachment: (url: string, fileName: string) => void;
};

/** Painel de leitura do e-mail: acoes, metadados, corpo e anexos. */
export default function MailMessageDetail({
  message,
  labelById,
  loading,
  fullscreen,
  menuOpen,
  scrollRef,
  replyBox,
  onClose,
  onToggleFullscreen,
  onToggleMenu,
  onAction,
  onDownloadAttachment,
}: MailMessageDetailProps) {
  const category = emailCategoryMeta[classifyEmailCategory(message)];
  const labels = (message.labels || [])
    .map((label) => friendlyGmailLabel(labelById.get(label)?.name || label))
    .filter((label) => !ROTULOS_REDUNDANTES.includes(label))
    .filter((label) => normalizeText(label) !== normalizeText(category.label))
    .slice(0, MAX_ROTULOS);

  return (
    <PortalWhen active={fullscreen}>
      <aside
        className={cn(
          "mail-message-detail flex min-w-0 max-w-full flex-col overflow-hidden bg-[#18181B]",
          fullscreen
            ? "fixed inset-0 z-[100] h-[100dvh] max-h-[100dvh] w-screen min-h-0"
            : "h-full w-[520px] shrink-0 border-l border-white/10",
        )}
        aria-label={fullscreen ? "E-mail aberto em tela cheia" : "Leitura do e-mail"}
      >
        <div className="mail-surface flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
          <div className="flex items-center gap-1 text-white/70">
            <Button variant="ghost" size="sm" iconOnly onClick={onClose} className="hover:bg-white/7" title="Voltar para a lista" aria-label="Voltar para a lista">
              <ChevronLeft size={17} />
            </Button>
            <Button variant="ghost" size="sm" iconOnly onClick={() => onAction("archive", true)} className="hover:bg-white/7" title="Arquivar" aria-label="Arquivar">
              <Archive size={17} />
            </Button>
            <Button variant="ghost" size="sm" iconOnly onClick={() => onAction("trash", true)} className="hover:bg-white/7" title="Mover para a lixeira" aria-label="Mover para a lixeira">
              <Trash2 size={17} />
            </Button>
            <Button
              variant="ghost" size="sm" iconOnly
              onClick={() => onAction(message.unread ? "read" : "unread")}
              className="hover:bg-white/7"
              title={message.unread ? "Marcar como lido" : "Marcar como nao lido"}
              aria-label={message.unread ? "Marcar como lido" : "Marcar como nao lido"}
            >
              {message.unread ? <MailOpen size={17} /> : <MailCheck size={17} />}
            </Button>
            <Button
              variant="ghost" size="sm" iconOnly
              onClick={() => onAction(message.starred ? "unstar" : "star")}
              className="hover:bg-white/7"
              title={message.starred ? "Remover estrela" : "Adicionar estrela"}
              aria-label={message.starred ? "Remover estrela" : "Adicionar estrela"}
            >
              <Star size={17} fill={message.starred ? "currentColor" : "none"} />
            </Button>
            <button
              onClick={onToggleMenu}
              className={cn("flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/7", menuOpen && "bg-white/10 text-white")}
              title={menuOpen ? "Recolher acoes" : "Mais acoes"}
              aria-expanded={menuOpen}
              aria-label={menuOpen ? "Recolher acoes" : "Mais acoes"}
            >
              <MoreVertical size={17} />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost" size="sm" iconOnly
              onClick={onToggleFullscreen}
              className="text-white/70 hover:bg-white/7 hover:text-white"
              title={fullscreen ? "Sair da tela cheia" : "Abrir em tela cheia"}
              aria-label={fullscreen ? "Sair da tela cheia" : "Abrir e-mail em tela cheia"}
            >
              {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </Button>
            <Button variant="ghost" size="sm" iconOnly onClick={onClose} className="text-white/60 hover:bg-white/7 hover:text-white" title="Fechar e-mail" aria-label="Fechar e-mail">
              <X size={18} />
            </Button>
          </div>
        </div>

        {menuOpen && (
          <div className="mail-surface flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5 text-xs font-bold text-white/75">
            <Button
              size="sm"
              onClick={() => onAction(message.important ? "unimportant" : "important")}
              className="mail-hover min-w-[150px] flex-1 whitespace-nowrap border-white/12 hover:bg-white/7"
            >
              <Star size={15} fill={message.important ? "currentColor" : "none"} />
              {message.important ? "Remover importante" : "Marcar importante"}
            </Button>
            <Button size="sm" onClick={() => onAction("spam", true)} className="mail-hover min-w-[110px] flex-1 whitespace-nowrap border-white/12 hover:bg-white/7">
              <ShieldAlert size={15} />
              Spam
            </Button>
            {!fullscreen && (
              <Button size="sm" onClick={onToggleFullscreen} className="mail-hover min-w-[120px] flex-1 whitespace-nowrap border-white/12 hover:bg-white/7">
                <Maximize2 size={15} />
                Tela cheia
              </Button>
            )}
          </div>
        )}

        <div
          ref={scrollRef}
          tabIndex={0}
          aria-label="Conteúdo rolável do e-mail"
          className="mail-reader-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pb-24 select-text outline-none"
        >
          {loading ? (
            <div className="flex h-64 items-center justify-center text-sm font-bold text-white/50">
              <Loader2 size={18} className="mr-2 animate-spin" />
              Abrindo e-mail...
            </div>
          ) : (
            <>
              <h2 className="text-xl font-bold leading-7">{message.subject}</h2>

              <div className="mail-card mt-4 flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-[#121217] p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#246BFD] text-sm font-bold">
                    {initials(message.fromName)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{message.fromName}</p>
                    <p className="truncate text-xs font-semibold text-white/45">{message.fromEmail}</p>
                    {message.to && <p className="truncate text-xs font-semibold text-white/35">para {message.to}</p>}
                  </div>
                </div>
                <span className="shrink-0 text-xs font-semibold text-white/45">{message.dateFull}</span>
              </div>

              <div className="mail-card mt-3 rounded-lg border border-white/10 bg-[#121217] p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase", category.tone)}>
                    {category.label}
                  </span>
                  <span
                    className={cn(
                      "inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase",
                      message.unread ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100" : "border-white/10 bg-white/5 text-white/55",
                    )}
                  >
                    {message.unread ? "Nao lido" : "Lido"}
                  </span>
                  {message.important && (
                    <span className="inline-flex rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-xs font-bold uppercase text-amber-100">
                      Importante
                    </span>
                  )}
                  {message.starred && (
                    <span className="inline-flex rounded-full border border-sky-300/25 bg-sky-300/10 px-2.5 py-1 text-xs font-bold uppercase text-sky-100">
                      Com estrela
                    </span>
                  )}
                </div>

                <div className="grid gap-2 text-xs md:grid-cols-2">
                  <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                    <p className="font-black uppercase text-white/40">Para</p>
                    <p className="mt-1 break-words font-semibold text-white/80">{message.to || "Nao informado"}</p>
                  </div>
                  <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                    <p className="font-black uppercase text-white/40">Recebido em</p>
                    <p className="mt-1 font-semibold text-white/80">{message.dateFull || message.dateLabel || "Sem data"}</p>
                  </div>
                  {message.cc && (
                    <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                      <p className="font-black uppercase text-white/40">Cc</p>
                      <p className="mt-1 break-words font-semibold text-white/80">{message.cc}</p>
                    </div>
                  )}
                  {message.replyToEmail && (
                    <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                      <p className="font-black uppercase text-white/40">Responder para</p>
                      <p className="mt-1 break-words font-semibold text-white/80">{message.replyToEmail}</p>
                    </div>
                  )}
                  <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                    <p className="font-black uppercase text-white/40">Anexos</p>
                    <p className="mt-1 font-semibold text-white/80">{message.attachments?.length || 0} anexo(s)</p>
                  </div>
                </div>

                <div className="mt-3 border-t border-white/10 pt-3">
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-white/40">Marcadores</p>
                  {labels.length ? (
                    <div className="flex flex-wrap gap-2">
                      {labels.map((label) => (
                        <span key={label} className="rounded-full border border-white/10 bg-white/[0.055] px-2.5 py-1 text-xs font-bold text-white/70">
                          {label}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs font-semibold text-white/45">Nenhum marcador adicional.</p>
                  )}
                </div>
              </div>

              <div className="mail-message-body mt-5 rounded-lg border border-white/10 bg-white p-4 text-black">
                {message.bodyHtml ? (
                  <ResponsiveEmailFrame html={message.bodyHtml} />
                ) : (
                  <div className="whitespace-pre-wrap text-sm leading-6 text-zinc-900">
                    {message.bodyText || message.snippet || "Sem conteudo disponivel."}
                  </div>
                )}
              </div>

              {Boolean(message.attachments?.length) && (
                <div className="mt-5">
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-white/45">Anexos</p>
                  <div className="grid gap-2">
                    {message.attachments?.map((attachment) => (
                      <button
                        key={attachment.attachmentId}
                        type="button"
                        onClick={() => onDownloadAttachment(attachment.downloadUrl, attachment.fileName)}
                        className="mail-card mail-hover flex w-full items-center justify-between rounded-lg border border-white/10 bg-[#121217] p-3 text-left hover:bg-white/7"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/8">
                            {isImage(attachment.mimeType) ? <Image size={18} /> : <FileText size={18} />}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-bold">{attachment.fileName}</span>
                            <span className="text-xs font-semibold text-white/45">{formatBytes(attachment.size)}</span>
                          </span>
                        </span>
                        <Download size={17} className="text-white/55" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {replyBox}
            </>
          )}
        </div>
      </aside>
    </PortalWhen>
  );
}
