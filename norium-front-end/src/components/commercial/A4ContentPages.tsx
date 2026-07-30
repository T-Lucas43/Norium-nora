import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Branding, Signer } from "../../features/commercial/types";

type A4ContentPagesProps = {
  title: string;
  contentHtml: string;
  branding: Branding;
  signers?: Signer[];
  firstPageNumber?: number;
  compact?: boolean;
};

export default function A4ContentPages({
  title,
  contentHtml,
  branding,
  signers = [],
  firstPageNumber = 2,
  compact = false,
}: A4ContentPagesProps) {
  const printableHtml = useMemo(
    () => [
      branding.logoUrl
        ? `<div class="commercial-a4-inline-logo" style="text-align:${safeAlignment(branding.logoAlignment)}"><img src="${escapeAttribute(branding.logoUrl)}" alt="Logo" style="max-height:${Math.max(36, branding.logoScale * 0.62)}px"></div>`
        : "",
      `<h1>${escapeHtml(title)}</h1>`,
      sanitizeRichHtml(contentHtml),
      signers.length ? signerMarkup(signers) : "",
    ].join(""),
    [branding.logoAlignment, branding.logoScale, branding.logoUrl, contentHtml, signers, title],
  );
  const [pages, setPages] = useState<string[]>(() => [printableHtml]);
  const gaugeContentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const gaugeContent = gaugeContentRef.current;
    if (!gaugeContent) return;

    const recompute = () => {
      const style = getComputedStyle(gaugeContent);
      // clientWidth/Height incluem o padding; a area util e o que sobra depois dele.
      const innerWidth =
        gaugeContent.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const innerHeight =
        gaugeContent.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
      if (!(innerWidth > 0) || !(innerHeight > 0)) return;
      setPages(
        paginateRichHtml(printableHtml, {
          width: innerWidth,
          height: innerHeight,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          fontFamily: style.fontFamily,
        }),
      );
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(gaugeContent);
    return () => observer.disconnect();
  }, [printableHtml]);

  return (
    <div
      className={
        compact
          ? "commercial-a4-pages-grid relative mx-auto grid w-full max-w-[794px] gap-5"
          : "commercial-a4-pages-grid relative mx-auto w-full max-w-[794px] space-y-8"
      }
    >
      {/* Pagina gabarito, invisivel: mede o espaco real disponivel (mesmas classes/
          largura/padding/font-size da pagina de verdade) para paginar com precisao. */}
      <div aria-hidden className="pointer-events-none invisible absolute inset-x-0 top-0 -z-10">
        <article className="commercial-document-page commercial-a4-preview-page flex w-full flex-col overflow-hidden bg-white shadow-2xl">
          <header
            className="commercial-a4-page-header border-b border-slate-200 text-xs text-slate-500"
            dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(branding.headerHtml) }}
          />
          <div ref={gaugeContentRef} className="commercial-rich-editor commercial-a4-page-content" />
          <footer
            className="commercial-a4-page-footer mt-auto border-t border-slate-200 text-xs text-slate-500"
            dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(branding.footerHtml) }}
          />
        </article>
      </div>

      {pages.map((pageHtml, index) => (
        <section className="commercial-page-shell" key={`${index}-${pageHtml.length}`}>
          <div className="commercial-page-label">
            <span>Página {firstPageNumber + index}</span>
            <strong>Conteúdo A4{index ? " · continuação" : ""}</strong>
          </div>
          <article
            className="commercial-document-page commercial-a4-preview-page flex w-full flex-col overflow-hidden bg-white shadow-2xl"
            style={{
              color: branding.textColor,
              "--document-primary": branding.primaryColor,
              "--document-secondary": branding.secondaryColor,
            } as CSSProperties}
          >
            <header
              className="commercial-a4-page-header border-b border-slate-200 text-xs text-slate-500"
              dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(branding.headerHtml) }}
            />
            <div
              className="commercial-rich-editor commercial-a4-page-content"
              dangerouslySetInnerHTML={{ __html: pageHtml }}
            />
            <footer
              className="commercial-a4-page-footer mt-auto border-t border-slate-200 text-xs text-slate-500"
              dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(branding.footerHtml) }}
            />
          </article>
        </section>
      ))}
    </div>
  );
}

type PageMetrics = {
  width: number;
  height: number;
  fontSize: string;
  lineHeight: string;
  fontFamily: string;
};

function paginateRichHtml(value: string, metrics: PageMetrics): string[] {
  if (typeof document === "undefined") return [value || "<p></p>"];
  const parsed = new DOMParser().parseFromString(value || "<p></p>", "text/html");
  const nodes = Array.from(parsed.body.childNodes).filter(
    (node) => node.nodeType !== Node.TEXT_NODE || Boolean(node.textContent?.trim()),
  );
  if (!nodes.length) return ["<p></p>"];

  // Caixa util da pagina real (ja sem padding), com a tipografia resolvida copiada da
  // pagina gabarito - o host fica fora de um container query, entao unidades cqw nao
  // resolveriam corretamente aqui.
  const host = document.createElement("div");
  host.className = "commercial-rich-editor commercial-a4-measure";
  Object.assign(host.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${metrics.width}px`,
    height: `${metrics.height}px`,
    padding: "0",
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    fontFamily: metrics.fontFamily,
    overflow: "hidden",
    visibility: "hidden",
    pointerEvents: "none",
  });
  document.body.appendChild(host);

  const pages: string[] = [];
  let pageNodes: Node[] = [];

  const commitPage = () => {
    const html = pageNodes.map((node) => serializeNode(node)).join("");
    if (html.trim()) pages.push(html);
    pageNodes = [];
    host.innerHTML = "";
  };

  try {
    nodes.forEach((sourceNode) => {
      const node = sourceNode.cloneNode(true);
      host.appendChild(node);
      if (host.scrollHeight <= metrics.height || pageNodes.length === 0) {
        pageNodes.push(node);
        return;
      }

      host.removeChild(node);
      commitPage();
      const nextNode = sourceNode.cloneNode(true);
      host.appendChild(nextNode);
      pageNodes.push(nextNode);
    });
    commitPage();
  } finally {
    host.remove();
  }

  return pages.length ? pages : ["<p></p>"];
}

function signerMarkup(signers: Signer[]) {
  return `<section class="commercial-preview-signatures">${signers.map((signer) => `
    <div class="commercial-preview-signature">
      <span class="commercial-preview-signature-line"></span>
      <strong>${escapeHtml(signer.name || "Assinante")}</strong>
      <small>${escapeHtml(roleLabel(signer.role))} · ordem ${Number(signer.order) || 1}</small>
      ${signer.status === "signed" && signer.signedAt ? `<em>Assinado em ${escapeHtml(formatDate(signer.signedAt))}</em>` : ""}
    </div>
  `).join("")}</section>`;
}

function serializeNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent || "");
  const container = document.createElement("div");
  container.appendChild(node.cloneNode(true));
  return container.innerHTML;
}

function sanitizeRichHtml(value: string) {
  if (typeof document === "undefined") return value || "";
  const parsed = new DOMParser().parseFromString(value || "", "text/html");
  parsed.querySelectorAll("script, style, iframe, object, embed, form, input, button").forEach((node) => node.remove());
  parsed.querySelectorAll("*").forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      const name = attribute.name.toLocaleLowerCase("pt-BR");
      if (name.startsWith("on")) {
        node.removeAttribute(attribute.name);
        return;
      }
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attribute.value)) {
        node.removeAttribute(attribute.name);
      }
    });
  });
  return parsed.body.innerHTML;
}

function escapeHtml(value: string) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function safeAlignment(value: string) {
  return value === "center" || value === "right" ? value : "left";
}

function roleLabel(role: string) {
  return role === "provider" ? "Contratado" : role === "witness" ? "Testemunha" : role === "approver" ? "Aprovador" : "Contratante";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
