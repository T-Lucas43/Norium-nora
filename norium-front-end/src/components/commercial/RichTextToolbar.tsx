import { useEffect, useRef, type RefObject } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Eraser,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  Redo2,
  Rows3,
  Sparkles,
  Strikethrough,
  Table2,
  Underline,
  Undo2,
  PanelRight,
} from "lucide-react";
import { showPrompt } from "../shared/AppDialogProvider";
import Button from "../shared/Button";

type RichTextToolbarProps = {
  editorRef: RefObject<HTMLDivElement | null>;
  onChange: () => void;
  onWriteWithNora: () => void;
  onUndoNora?: () => void;
  canUndoNora?: boolean;
  writingWithNora?: boolean;
  orientation?: "top" | "right";
  onOrientationChange?: (orientation: "top" | "right") => void;
};

type CommandButton = {
  command: string;
  label: string;
  icon: typeof Bold;
  value?: string;
};

const commands: CommandButton[] = [
  { command: "undo", label: "Desfazer", icon: Undo2 },
  { command: "redo", label: "Refazer", icon: Redo2 },
  { command: "bold", label: "Negrito", icon: Bold },
  { command: "italic", label: "Italico", icon: Italic },
  { command: "underline", label: "Sublinhado", icon: Underline },
  { command: "strikeThrough", label: "Tachado", icon: Strikethrough },
  { command: "insertUnorderedList", label: "Lista", icon: List },
  { command: "insertOrderedList", label: "Lista numerada", icon: ListOrdered },
  { command: "justifyLeft", label: "Alinhar a esquerda", icon: AlignLeft },
  { command: "justifyCenter", label: "Centralizar", icon: AlignCenter },
  { command: "justifyRight", label: "Alinhar a direita", icon: AlignRight },
  { command: "justifyFull", label: "Justificar", icon: AlignJustify },
  { command: "removeFormat", label: "Limpar formatacao", icon: Eraser },
];

export default function RichTextToolbar({
  editorRef,
  onChange,
  onWriteWithNora,
  onUndoNora,
  canUndoNora = false,
  writingWithNora = false,
  orientation = "top",
  onOrientationChange,
}: RichTextToolbarProps) {
  const savedRangeRef = useRef<Range | null>(null);

  function rangeInsideEditor(range: Range | null) {
    if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected || !editorRef.current) return false;
    return editorRef.current.contains(range.commonAncestorContainer);
  }

  function captureSelection() {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    if (rangeInsideEditor(range)) savedRangeRef.current = range;
    return rangeInsideEditor(range) ? range : savedRangeRef.current;
  }

  useEffect(() => {
    const rememberSelection = () => {
      captureSelection();
    };
    document.addEventListener("selectionchange", rememberSelection);
    return () => document.removeEventListener("selectionchange", rememberSelection);
  }, [editorRef]);

  function execute(command: string, value?: string) {
    focusSelection(savedRangeRef.current);
    if (document.queryCommandSupported(command)) {
      document.execCommand(command, false, value);
    }
    captureSelection();
    onChange();
  }

  function restoreSelection(range: Range | null) {
    if (!range) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function focusSelection(range: Range | null) {
    const usableRange = rangeInsideEditor(range) ? range : null;
    const owner = usableRange?.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? usableRange.commonAncestorContainer as Element
      : usableRange?.commonAncestorContainer.parentElement;
    const editablePage = owner?.closest<HTMLElement>('[data-commercial-page-content][contenteditable="true"]')
      || editorRef.current?.querySelector<HTMLElement>('[data-commercial-page-content][contenteditable="true"]');
    editablePage?.focus({ preventScroll: true });
    restoreSelection(usableRange);
  }

  function currentSelection() {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    return rangeInsideEditor(range) ? range : savedRangeRef.current;
  }

  async function insertLink() {
    const range = currentSelection();
    const url = await showPrompt({
      title: "Inserir link",
      description: "Informe o endereco completo que sera aplicado ao texto selecionado.",
      placeholder: "https://exemplo.com",
      confirmLabel: "Inserir",
      required: true,
    });
    restoreSelection(range);
    if (!url?.trim()) return;
    if (range?.collapsed) {
      const safeUrl = url.trim().replace(/"/g, "&quot;");
      execute("insertHTML", `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`);
    } else {
      execute("createLink", url.trim());
    }
  }

  async function insertImage() {
    const range = currentSelection();
    const url = await showPrompt({
      title: "Inserir imagem",
      description: "Informe uma URL publica HTTPS para incluir a imagem no documento.",
      placeholder: "https://exemplo.com/imagem.png",
      confirmLabel: "Inserir",
      required: true,
    });
    restoreSelection(range);
    if (url?.trim()) execute("insertImage", url.trim());
  }

  async function insertTable() {
    const range = currentSelection();
    const rowValue = await showPrompt({
      title: "Linhas da tabela",
      description: "Escolha entre 1 e 12 linhas.",
      defaultValue: "3",
      confirmLabel: "Continuar",
      required: true,
    });
    if (rowValue === null) return;
    const columnValue = await showPrompt({
      title: "Colunas da tabela",
      description: "Escolha entre 1 e 8 colunas.",
      defaultValue: "3",
      confirmLabel: "Inserir tabela",
      required: true,
    });
    if (columnValue === null) return;
    const rows = Math.min(12, Math.max(1, Number(rowValue) || 1));
    const columns = Math.min(8, Math.max(1, Number(columnValue) || 1));
    const body = Array.from({ length: rows }, () => (
      `<tr>${Array.from({ length: columns }, () => "<td><br></td>").join("")}</tr>`
    )).join("");
    restoreSelection(range);
    execute("insertHTML", `<table><tbody>${body}</tbody></table><p><br></p>`);
  }

  return (
    <div className={orientation === "right"
      ? "commercial-rich-toolbar flex h-full min-h-0 flex-col items-stretch gap-2 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] p-3"
      : "commercial-rich-toolbar sticky top-0 z-30 flex min-h-12 flex-wrap items-center gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-sm"}>
      {onOrientationChange && (
        <Button
          variant="ghost"
          size="sm"
          iconOnly={orientation === "top"}
          onClick={() => onOrientationChange(orientation === "top" ? "right" : "top")}
          title={orientation === "top" ? "Mover barra para a lateral direita" : "Mover barra para o topo"}
          aria-label={orientation === "top" ? "Mover barra para a lateral direita" : "Mover barra para o topo"}
          className={orientation === "right" ? "w-full justify-start" : ""}
        >
          {orientation === "top" ? <PanelRight size={15} /> : <Rows3 size={15} />}
          {orientation === "right" && "Mover para o topo"}
        </Button>
      )}
      <Button size="sm"
       
        onClick={onWriteWithNora}
        disabled={writingWithNora}
        className={`${orientation === "right" ? "w-full justify-start" : "mr-1"} border-cyan-400/35 bg-cyan-400/10 text-cyan-300 hover:bg-cyan-400/16`}
        title="Descrever uma ideia para a Nora desenvolver no documento"
       aria-label="Descrever uma ideia para a Nora desenvolver no documento">
        <Sparkles size={14} />
        {writingWithNora ? "Escrevendo..." : "Escrever com a Nora"}
      </Button>
      {canUndoNora && onUndoNora && (
        <button
          type="button"
          onClick={onUndoNora}
          className={`${orientation === "right" ? "w-full" : "mr-1"} inline-flex h-8 items-center gap-2 rounded-md border border-blue-400/30 bg-blue-500/10 px-3 text-xs font-bold text-blue-300 hover:bg-blue-500/16`}
          title="Restaurar o documento para antes da última sugestão aceita"
         aria-label="Restaurar o documento para antes da última sugestão aceita">
          <Undo2 size={14} />
          Desfazer Nora
        </button>
      )}
      <select
        aria-label="Estilo do paragrafo"
        defaultValue="p"
        onPointerDown={captureSelection}
        onChange={(event) => execute("formatBlock", event.target.value)}
        className={`${orientation === "right" ? "w-full" : ""} h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs font-bold text-[var(--text)]`}
      >
        <option value="p">Texto normal</option>
        <option value="h1">Titulo 1</option>
        <option value="h2">Titulo 2</option>
        <option value="h3">Titulo 3</option>
        <option value="blockquote">Citacao</option>
      </select>
      <select
        aria-label="Fonte"
        defaultValue="Arial"
        onPointerDown={captureSelection}
        onChange={(event) => execute("fontName", event.target.value)}
        className={`${orientation === "right" ? "w-full max-w-none" : "max-w-32"} h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs font-bold text-[var(--text)]`}
      >
        <option>Arial</option>
        <option>Calibri</option>
        <option>Georgia</option>
        <option>Times New Roman</option>
      </select>
      <select
        aria-label="Tamanho da fonte"
        defaultValue="3"
        onPointerDown={captureSelection}
        onChange={(event) => execute("fontSize", event.target.value)}
        className={`${orientation === "right" ? "w-full" : ""} h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs font-bold text-[var(--text)]`}
      >
        <option value="2">10</option>
        <option value="3">12</option>
        <option value="4">14</option>
        <option value="5">18</option>
        <option value="6">24</option>
      </select>
      <label className="grid h-8 w-8 cursor-pointer place-items-center rounded-md border border-[var(--border)]" title="Cor do texto">
        <span className="h-3 w-3 rounded-full bg-[var(--text)]" />
        <input
          type="color"
          className="sr-only"
          onPointerDown={captureSelection}
          onChange={(event) => execute("foreColor", event.target.value)}
        />
      </label>
      <span className={orientation === "right" ? "my-1 h-px w-full bg-[var(--border)]" : "mx-1 h-6 w-px bg-[var(--border)]"} />
      {commands.map(({ command, label, icon: Icon, value }) => (
        <Button variant="ghost" size="sm" iconOnly
          key={command}
         
          aria-label={label}
          title={label}
          onMouseDown={(event) => {
            captureSelection();
            event.preventDefault();
          }}
          onClick={() => execute(command, value)}
          className={`${orientation === "right" ? "w-full justify-start" : ""} text-[var(--text-secondary)] hover:text-[var(--text)]`}
        >
          <Icon size={15} />
        </Button>
      ))}
      <span className={orientation === "right" ? "my-1 h-px w-full bg-[var(--border)]" : "mx-1 h-6 w-px bg-[var(--border)]"} />
      <Button variant="ghost" size="sm" iconOnly onClick={() => void insertLink()} title="Inserir link" aria-label="Inserir link"><Link size={15} /></Button>
      <Button variant="ghost" size="sm" iconOnly onClick={() => void insertImage()} title="Inserir imagem" aria-label="Inserir imagem"><Image size={15} /></Button>
      <Button variant="ghost" size="sm" iconOnly onClick={() => void insertTable()} title="Inserir tabela" aria-label="Inserir tabela"><Table2 size={15} /></Button>
      <Button variant="ghost" size="sm" iconOnly onClick={() => execute("insertHorizontalRule")} title="Inserir linha" aria-label="Inserir linha"><Minus size={15} /></Button>
    </div>
  );
}
