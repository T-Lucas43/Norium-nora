import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Archive, ChevronLeft, Download, FileText, Image, Loader2, MailCheck, MailOpen,
  Maximize2, Minimize2, MoreVertical, ShieldAlert, Star, Trash2, X,
} from "lucide-react";
import { cn } from "../../utils/cn";
import {
  classifyEmailCategory, emailCategoryMeta, formatBytes, friendlyGmailLabel, initials, isImage, normalizeText,
} from "../../features/mail/formatters";
import type { GmailLabel, GmailMessage } from "../../features/mail/types";
import { mailCategoryBadge } from "./mailCategoryTone";

/** Rotulos ja representados por outros elementos da tela; nao repetir na lista. */
const ROTULOS_REDUNDANTES = ["Caixa de entrada", "Nao lido", "Com estrela", "Importante"];
const MAX_ROTULOS = 10;

function PortalWhen({ active, children }: { active: boolean; children: ReactNode }) {
  if (active && typeof document !== "undefined") {
    return createPortal(
      <div className="norium-mail nx-mail mail-fullscreen-portal">{children}</div>,
      document.body,
    );
  }
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
    const reader = frameRef.current?.closest<HTMLElement>(".mail-reader-scroll");
    frameDocument.addEventListener("wheel", (event) => {
      if (!reader || !event.deltaY) return;
      reader.scrollBy({ top: event.deltaY, behavior: "auto" });
      event.preventDefault();
    }, { passive: false });
  }

  return (
    <iframe
      ref={frameRef}
      title="Conteúdo do e-mail"
      sandbox="allow-same-origin"
      srcDoc={documentHtml}
      scrolling="no"
      onLoad={resizeToContent}
      style={{ height }}
      className="mail-message-frame"
    />
  );
}

type MailMessageDetailProps = {
  message: GmailMessage;
  labelById: Map<string, GmailLabel>;
  loading: boolean;
  error?: string;
  onRetry?: () => void;
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
  error,
  onRetry,
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
  const categoryKey = classifyEmailCategory(message);
  const category = emailCategoryMeta[categoryKey];
  const labels = (message.labels || [])
    .map((label) => friendlyGmailLabel(labelById.get(label)?.name || label))
    .filter((label) => !ROTULOS_REDUNDANTES.includes(label))
    .filter((label) => normalizeText(label) !== normalizeText(category.label))
    .slice(0, MAX_ROTULOS);

  useEffect(() => {
    if (!fullscreen || typeof document === "undefined") return undefined;
    document.documentElement.classList.add("mail-fullscreen-open");
    return () => document.documentElement.classList.remove("mail-fullscreen-open");
  }, [fullscreen]);

  return (
    <PortalWhen active={fullscreen}>
      <aside
        className={cn(
          "mail-message-detail nx-mail-detail",
          fullscreen && "mail-message-fullscreen relative h-full max-h-full w-full",
        )}
        aria-label={fullscreen ? "E-mail aberto em tela cheia" : "Leitura do e-mail"}
      >
        <div className="nx-mail-detail-bar">
          <div>
            <button type="button" onClick={onClose} className="nx-mail-iconbtn" title="Voltar para a lista" aria-label="Voltar para a lista">
              <ChevronLeft size={16} />
            </button>
            <button type="button" onClick={() => onAction("archive", true)} className="nx-mail-iconbtn" title="Arquivar" aria-label="Arquivar">
              <Archive size={16} />
            </button>
            <button type="button" onClick={() => onAction("trash", true)} className="nx-mail-iconbtn" title="Mover para a lixeira" aria-label="Mover para a lixeira">
              <Trash2 size={16} />
            </button>
            <button
              type="button"
              onClick={() => onAction(message.unread ? "read" : "unread")}
              className="nx-mail-iconbtn"
              title={message.unread ? "Marcar como lido" : "Marcar como não lido"}
              aria-label={message.unread ? "Marcar como lido" : "Marcar como não lido"}
            >
              {message.unread ? <MailOpen size={16} /> : <MailCheck size={16} />}
            </button>
            <button
              type="button"
              onClick={() => onAction(message.starred ? "unstar" : "star")}
              className={cn("nx-mail-iconbtn", message.starred && "is-active")}
              title={message.starred ? "Remover estrela" : "Adicionar estrela"}
              aria-label={message.starred ? "Remover estrela" : "Adicionar estrela"}
            >
              <Star size={16} fill={message.starred ? "currentColor" : "none"} />
            </button>
            <button
              type="button"
              onClick={onToggleMenu}
              className={cn("nx-mail-iconbtn", menuOpen && "is-active")}
              title={menuOpen ? "Recolher ações" : "Mais ações"}
              aria-expanded={menuOpen}
              aria-label={menuOpen ? "Recolher ações" : "Mais ações"}
            >
              <MoreVertical size={16} />
            </button>
          </div>
          <div>
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="nx-mail-iconbtn"
              title={fullscreen ? "Sair da tela cheia" : "Abrir em tela cheia"}
              aria-label={fullscreen ? "Sair da tela cheia" : "Abrir e-mail em tela cheia"}
            >
              {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" onClick={onClose} className="nx-mail-iconbtn" title="Fechar e-mail" aria-label="Fechar e-mail">
              <X size={16} />
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="nx-mail-detail-menu">
            <button
              type="button"
              onClick={() => onAction(message.important ? "unimportant" : "important")}
              className="nx-btn is-sm"
            >
              <Star size={14} fill={message.important ? "currentColor" : "none"} />
              {message.important ? "Remover importante" : "Marcar importante"}
            </button>
            <button type="button" onClick={() => onAction("spam", true)} className="nx-btn is-sm">
              <ShieldAlert size={14} />
              Spam
            </button>
            {!fullscreen && (
              <button type="button" onClick={onToggleFullscreen} className="nx-btn is-sm">
                <Maximize2 size={14} />
                Tela cheia
              </button>
            )}
          </div>
        )}

        <div
          ref={scrollRef}
          tabIndex={0}
          aria-label="Conteúdo rolável do e-mail"
          className="mail-reader-scroll nx-mail-reader"
        >
          {loading ? (
            <div className="nx-mail-state" role="status">
              <Loader2 size={18} className="nx-mail-spin" />
              Abrindo e-mail...
            </div>
          ) : (
            <>
              <div className="nx-mail-reader-head">
                <h2>{message.subject}</h2>

                <div className="nx-mail-from">
                  <span className="nx-av nx-mail-av" aria-hidden="true">{initials(message.fromName)}</span>
                  <div>
                    <div className="nx-ell">
                      <b>{message.fromName}</b>{" "}
                      <span className="nx-faint nx-small">{message.fromEmail}</span>
                    </div>
                    <div className="nx-faint nx-small nx-ell">
                      {message.to ? `Para: ${message.to}` : "Para: não informado"}{message.dateFull ? ` · ${message.dateFull}` : ""}
                    </div>
                  </div>
                </div>

                <div className="nx-mail-badges">
                  <span className={cn("nx-badge", mailCategoryBadge[categoryKey])}>{category.label}</span>
                  <span className={cn("nx-badge", message.unread && "is-blue")}>{message.unread ? "Não lido" : "Lido"}</span>
                  {message.important && <span className="nx-badge is-amber">Importante</span>}
                  {message.starred && <span className="nx-badge is-blue">Com estrela</span>}
                </div>

                <dl className="nx-mail-meta">
                  <dt>Para</dt>
                  <dd>{message.to || "Não informado"}</dd>
                  <dt>Recebido em</dt>
                  <dd>{message.dateFull || message.dateLabel || "Sem data"}</dd>
                  {message.cc && (
                    <>
                      <dt>Cc</dt>
                      <dd>{message.cc}</dd>
                    </>
                  )}
                  {message.replyToEmail && (
                    <>
                      <dt>Responder para</dt>
                      <dd>{message.replyToEmail}</dd>
                    </>
                  )}
                  <dt>Anexos</dt>
                  <dd>{message.attachments?.length || 0} anexo(s)</dd>
                  <dt>Marcadores</dt>
                  <dd>
                    {labels.length ? (
                      <span className="nx-mail-tags">
                        {labels.map((label) => (
                          <span key={label} className="nx-badge">{label}</span>
                        ))}
                      </span>
                    ) : (
                      <span>Nenhum marcador adicional.</span>
                    )}
                  </dd>
                </dl>
              </div>

              <div className="nx-mail-content">
                {error ? <div className="nx-mail-state" role="alert"><p>{error}</p><button type="button" className="nx-btn is-sm" onClick={onRetry}>Tentar novamente</button></div> : message.bodyHtml ? (
                  <ResponsiveEmailFrame html={message.bodyHtml} />
                ) : (
                  <div className="nx-mail-text">
                    {message.bodyText || message.snippet || "Sem conteúdo disponível."}
                  </div>
                )}
              </div>

              {Boolean(message.attachments?.length) && (
                <div className="nx-mail-attachments">
                  <span className="nx-mail-section-l">Anexos</span>
                  {message.attachments?.map((attachment) => (
                    <button
                      key={attachment.attachmentId}
                      type="button"
                      onClick={() => onDownloadAttachment(attachment.downloadUrl, attachment.fileName)}
                      className="nx-mail-file"
                    >
                      <span className="nx-mail-file-ic">
                        {isImage(attachment.mimeType) ? <Image size={16} /> : <FileText size={16} />}
                      </span>
                      <span>
                        <strong>{attachment.fileName}</strong>
                        <span className="nx-faint nx-small">{formatBytes(attachment.size)}</span>
                      </span>
                      <Download size={16} className="nx-faint" />
                    </button>
                  ))}
                </div>
              )}

              {!error && replyBox}
            </>
          )}
        </div>
      </aside>
    </PortalWhen>
  );
}
