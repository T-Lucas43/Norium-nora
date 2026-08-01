import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Branding, Signer } from "../../features/commercial/types";

type A4ContentPagesProps = {
  title: string;
  contentHtml: string;
  branding: Branding;
  signers?: Signer[];
  firstPageNumber?: number;
  compact?: boolean;
  editable?: boolean;
  editorRef?: RefObject<HTMLDivElement | null>;
  onChange?: (contentHtml: string) => void;
  paginationKey?: string | number;
};

type EditablePageContentProps = {
  html: string;
  onInput: () => void;
};

function EditablePageContent({ html, onInput }: EditablePageContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const appliedHtmlRef = useRef("");

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || document.activeElement === content || appliedHtmlRef.current === html) return;
    content.innerHTML = html;
    appliedHtmlRef.current = html;
  }, [html]);

  return (
    <div
      ref={contentRef}
      data-commercial-page-content
      className="commercial-rich-editor commercial-a4-page-content"
      contentEditable
      suppressContentEditableWarning
      spellCheck
      lang="pt-BR"
      onInput={() => {
        appliedHtmlRef.current = contentRef.current?.innerHTML || "";
        onInput();
      }}
    />
  );
}

export default function A4ContentPages({
  contentHtml,
  branding,
  signers = [],
  compact = false,
  editable = false,
  editorRef,
  onChange,
  paginationKey,
}: A4ContentPagesProps) {
  const printableHtml = useMemo(
    () => [
      sanitizeRichHtml(contentHtml),
      signers.length ? `<div data-document-decoration contenteditable="false">${signerMarkup(signers)}</div>` : "",
    ].join(""),
    [contentHtml, signers],
  );
  const [pages, setPages] = useState<string[]>(() => [printableHtml]);
  const gaugeContentRef = useRef<HTMLDivElement>(null);
  const pagesRootRef = useRef<HTMLDivElement | null>(null);
  const editingRef = useRef(false);

  function assignRoot(node: HTMLDivElement | null) {
    pagesRootRef.current = node;
    if (editorRef) editorRef.current = node;
  }

  useLayoutEffect(() => {
    const gaugeContent = gaugeContentRef.current;
    if (!gaugeContent) return;

    let timer = 0;
    const recompute = () => {
      // Recriar o HTML paginado durante a digitacao desmonta o contentEditable
      // e move o cursor. A pagina permanece estavel enquanto houver foco e e
      // recalculada assim que o usuario sair do editor.
      if (editable && editingRef.current) return;
      const style = getComputedStyle(gaugeContent);
      // clientWidth/Height incluem o padding; a area util e o que sobra depois dele.
      const innerWidth =
        gaugeContent.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const innerHeight =
        gaugeContent.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
      if (!(innerWidth > 0) || !(innerHeight > 0)) return;
      const nextPages = paginateRichHtml(printableHtml, {
          width: innerWidth,
          height: innerHeight,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          fontFamily: style.fontFamily,
        });
      setPages((current) => arraysEqual(current, nextPages) ? current : nextPages);
    };

    const scheduleRecompute = () => {
      window.clearTimeout(timer);
      if (editable && editingRef.current) return;
      timer = window.setTimeout(recompute, 0);
    };

    scheduleRecompute();
    const observer = new ResizeObserver(scheduleRecompute);
    observer.observe(gaugeContent);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [editable, paginationKey, printableHtml]);

  function handleInput() {
    if (!pagesRootRef.current || !onChange) return;
    onChange(readEditableHtml(pagesRootRef.current));
  }

  function handleEditorFocus() {
    editingRef.current = true;
  }

  function handleEditorBlur() {
    window.requestAnimationFrame(() => {
      if (pagesRootRef.current?.contains(document.activeElement)) return;
      editingRef.current = false;
    });
  }

  return (
    <div
      ref={assignRoot}
      tabIndex={editable ? -1 : undefined}
      onFocusCapture={editable ? handleEditorFocus : undefined}
      onBlurCapture={editable ? handleEditorBlur : undefined}
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
        <section className="commercial-page-shell" key={index}>
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
            {editable ? (
              <EditablePageContent html={pageHtml} onInput={handleInput} />
            ) : (
              <div
                data-commercial-page-content
                className="commercial-rich-editor commercial-a4-page-content"
                dangerouslySetInnerHTML={{ __html: pageHtml }}
              />
            )}
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

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readEditableHtml(root: HTMLDivElement) {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-commercial-page-content]"))
    .map((page) => {
      const clone = page.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("[data-document-decoration]").forEach((node) => node.remove());
      return clone.innerHTML;
    })
    .join("") || "<p></p>";
}

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
  // A altura NAO e fixada de proposito: com height:auto o scrollHeight devolve a altura
  // real do conteudo. Fixar a altura faria o host vazio ja reportar scrollHeight
  // arredondado para cima (ex.: 922 contra um limite de 921,86), quebrando pagina a cada
  // bloco. O overflow:hidden mantem as margens dos filhos contidas na medicao.
  const host = document.createElement("div");
  host.className = "commercial-rich-editor commercial-a4-measure";
  Object.assign(host.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${metrics.width}px`,
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

  const appendNode = (sourceNode: Node) => {
    const node = sourceNode.cloneNode(true);
    host.appendChild(node);
    if (host.scrollHeight <= metrics.height + 1) {
      pageNodes.push(node);
      return;
    }

    host.removeChild(node);
    if (pageNodes.length) {
      const fitted = splitNodeForRemainingSpace(sourceNode, host, metrics.height);
      if (fitted.head && fitted.tail) {
        host.appendChild(fitted.head);
        pageNodes.push(fitted.head);
        commitPage();
        appendNode(fitted.tail);
        return;
      }
      commitPage();
      appendNode(sourceNode);
      return;
    }

    const fragments = splitOversizedNode(sourceNode, host, metrics.height);
    if (fragments.length <= 1) {
      // Imagens ou linhas de tabela indivisiveis continuam juntas, mesmo quando altas.
      const fallback = sourceNode.cloneNode(true);
      host.appendChild(fallback);
      pageNodes.push(fallback);
      commitPage();
      return;
    }
    fragments.forEach((fragment) => {
      appendNode(fragment);
      if (host.scrollHeight >= metrics.height - 2) commitPage();
    });
  };

  try {
    nodes.forEach((node, index) => {
      if (isHeading(node) && pageNodes.length && nodes[index + 1]) {
        const heading = node.cloneNode(true);
        const lead = leadingFragment(nodes[index + 1]);
        host.appendChild(heading);
        if (lead) host.appendChild(lead);
        const wouldOrphan = host.scrollHeight > metrics.height + 1;
        if (lead) host.removeChild(lead);
        host.removeChild(heading);
        if (wouldOrphan) commitPage();
      }
      appendNode(node);
    });
    commitPage();
  } finally {
    host.remove();
  }

  return pages.length ? pages : ["<p></p>"];
}

function splitNodeForRemainingSpace(sourceNode: Node, host: HTMLDivElement, maxHeight: number) {
  if (!(sourceNode instanceof HTMLElement)) return { head: null, tail: null };
  const tag = sourceNode.tagName.toLowerCase();

  if (["ul", "ol"].includes(tag)) {
    return splitChildrenForRemainingSpace(sourceNode, host, maxHeight);
  }
  if (tag === "table") {
    return splitTableForRemainingSpace(sourceNode, host, maxHeight);
  }
  if (["div", "section", "article"].includes(tag) && sourceNode.children.length > 1) {
    return splitChildrenForRemainingSpace(sourceNode, host, maxHeight);
  }
  if (!sourceNode.textContent?.trim() || sourceNode.children.length > 0) {
    return { head: null, tail: null };
  }

  const words = sourceNode.textContent.trim().split(/\s+/).filter(Boolean);
  if (words.length < 8) return { head: null, tail: null };
  let low = 1;
  let high = words.length - 1;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = sourceNode.cloneNode(false) as HTMLElement;
    candidate.textContent = words.slice(0, middle).join(" ");
    host.appendChild(candidate);
    const fits = host.scrollHeight <= maxHeight + 1;
    host.removeChild(candidate);
    if (fits) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best < 4 || words.length - best < 4) return { head: null, tail: null };
  const head = sourceNode.cloneNode(false) as HTMLElement;
  const tail = sourceNode.cloneNode(false) as HTMLElement;
  head.textContent = words.slice(0, best).join(" ");
  tail.textContent = words.slice(best).join(" ");
  return { head, tail };
}

function splitChildrenForRemainingSpace(source: HTMLElement, host: HTMLDivElement, maxHeight: number) {
  const children = Array.from(source.children);
  if (children.length < 2) return { head: null, tail: null };
  const head = source.cloneNode(false) as HTMLElement;
  let splitIndex = 0;
  for (const child of children) {
    const clone = child.cloneNode(true);
    head.appendChild(clone);
    host.appendChild(head);
    const fits = host.scrollHeight <= maxHeight + 1;
    host.removeChild(head);
    if (!fits) {
      head.removeChild(clone);
      break;
    }
    splitIndex += 1;
  }
  if (!splitIndex || splitIndex >= children.length) return { head: null, tail: null };
  const tail = source.cloneNode(false) as HTMLElement;
  children.slice(splitIndex).forEach((child) => tail.appendChild(child.cloneNode(true)));
  return { head, tail };
}

function splitTableForRemainingSpace(source: HTMLElement, host: HTMLDivElement, maxHeight: number) {
  const rows = Array.from(source.querySelectorAll("tr"));
  if (rows.length < 2) return { head: null, tail: null };
  const build = (selected: Element[]) => {
    const table = source.cloneNode(false) as HTMLElement;
    const body = document.createElement("tbody");
    selected.forEach((row) => body.appendChild(row.cloneNode(true)));
    table.appendChild(body);
    return table;
  };
  let splitIndex = 0;
  for (let index = 1; index <= rows.length; index += 1) {
    const candidate = build(rows.slice(0, index));
    host.appendChild(candidate);
    const fits = host.scrollHeight <= maxHeight + 1;
    host.removeChild(candidate);
    if (!fits) break;
    splitIndex = index;
  }
  if (!splitIndex || splitIndex >= rows.length) return { head: null, tail: null };
  return { head: build(rows.slice(0, splitIndex)), tail: build(rows.slice(splitIndex)) };
}

function isHeading(node: Node) {
  return node instanceof HTMLElement && /^H[1-3]$/.test(node.tagName);
}

function leadingFragment(node: Node) {
  if (!(node instanceof HTMLElement)) return null;
  const text = node.textContent?.trim();
  if (!text) return node.cloneNode(true);
  const fragment = node.cloneNode(false) as HTMLElement;
  fragment.textContent = text.split(/\s+/).slice(0, 18).join(" ");
  return fragment;
}

function splitOversizedNode(sourceNode: Node, host: HTMLDivElement, maxHeight: number): Node[] {
  if (!(sourceNode instanceof HTMLElement)) return [sourceNode];

  const tag = sourceNode.tagName.toLowerCase();
  const blockChildren = Array.from(sourceNode.children);
  if (["div", "section", "article"].includes(tag) && blockChildren.length > 1) {
    return blockChildren.map((child) => child.cloneNode(true));
  }

  if (["ul", "ol"].includes(tag) && blockChildren.length > 1) {
    return splitElementChildren(sourceNode, host, maxHeight);
  }

  if (tag === "table") {
    const rows = Array.from(sourceNode.querySelectorAll("tr"));
    if (rows.length > 1) return splitTableRows(sourceNode, rows, host, maxHeight);
  }

  const text = (sourceNode.textContent || "").trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [sourceNode];

  const fragments: Node[] = [];
  let cursor = 0;
  while (cursor < words.length) {
    let low = cursor + 1;
    let high = words.length;
    let best = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = sourceNode.cloneNode(false) as HTMLElement;
      candidate.textContent = words.slice(cursor, middle).join(" ");
      host.innerHTML = "";
      host.appendChild(candidate);
      if (host.scrollHeight <= maxHeight + 1) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const fragment = sourceNode.cloneNode(false) as HTMLElement;
    fragment.textContent = words.slice(cursor, Math.max(best, cursor + 1)).join(" ");
    fragments.push(fragment);
    cursor = Math.max(best, cursor + 1);
  }
  host.innerHTML = "";
  return fragments;
}

function splitElementChildren(source: HTMLElement, host: HTMLDivElement, maxHeight: number): Node[] {
  const result: Node[] = [];
  let current = source.cloneNode(false) as HTMLElement;
  Array.from(source.children).forEach((child) => {
    const candidate = current.cloneNode(true) as HTMLElement;
    candidate.appendChild(child.cloneNode(true));
    host.innerHTML = "";
    host.appendChild(candidate);
    if (host.scrollHeight > maxHeight + 1 && current.children.length) {
      result.push(current);
      current = source.cloneNode(false) as HTMLElement;
    }
    current.appendChild(child.cloneNode(true));
  });
  if (current.children.length) result.push(current);
  host.innerHTML = "";
  return result.length ? result : [source];
}

function splitTableRows(source: HTMLElement, rows: Element[], host: HTMLDivElement, maxHeight: number): Node[] {
  const result: Node[] = [];
  let currentRows: Element[] = [];
  const buildTable = (selectedRows: Element[]) => {
    const table = source.cloneNode(false) as HTMLElement;
    const body = document.createElement("tbody");
    selectedRows.forEach((row) => body.appendChild(row.cloneNode(true)));
    table.appendChild(body);
    return table;
  };
  rows.forEach((row) => {
    const candidateRows = [...currentRows, row];
    host.innerHTML = "";
    host.appendChild(buildTable(candidateRows));
    if (host.scrollHeight > maxHeight + 1 && currentRows.length) {
      result.push(buildTable(currentRows));
      currentRows = [row];
    } else {
      currentRows = candidateRows;
    }
  });
  if (currentRows.length) result.push(buildTable(currentRows));
  host.innerHTML = "";
  return result.length ? result : [source];
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
  normalizeVerboseHeadings(parsed);
  return parsed.body.innerHTML;
}

const COMMERCIAL_SECTION_TITLES = [
  "Equipe e responsabilidades",
  "Premissas e exclusões",
  "Prazo e cronograma",
  "Investimento",
  "Entregáveis",
  "Observações",
  "Objetivo",
  "Escopo",
];

function normalizeVerboseHeadings(documentNode: Document) {
  documentNode.querySelectorAll<HTMLElement>("h1, h2, h3").forEach((heading) => {
    const text = heading.textContent?.replace(/\s+/g, " ").trim() || "";
    if (text.length < 120) return;

    const sectionTitle = COMMERCIAL_SECTION_TITLES.find((title) =>
      text.toLocaleLowerCase("pt-BR").startsWith(title.toLocaleLowerCase("pt-BR")),
    );
    if (!sectionTitle) {
      if (text.length >= 220) {
        const paragraph = documentNode.createElement("p");
        paragraph.textContent = text;
        heading.replaceWith(paragraph);
      }
      return;
    }

    const details = text.slice(sectionTitle.length).replace(/^\s*[:\-–—]\s*/, "").trim();
    heading.textContent = sectionTitle;
    if (!details) return;
    const paragraph = documentNode.createElement("p");
    paragraph.textContent = details;
    heading.insertAdjacentElement("afterend", paragraph);
  });
}

function escapeHtml(value: string) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function roleLabel(role: string) {
  return role === "provider" ? "Contratado" : role === "witness" ? "Testemunha" : role === "approver" ? "Aprovador" : "Contratante";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
