import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ArrowLeft, ArrowDown, ArrowUp, Check, Circle, Copy, Download, FilePenLine, Highlighter, ImagePlus, Minus, MousePointer2, PenLine, Plus, Redo2, RotateCw, Save, Signature, Square, Trash2, Type, Undo2, X } from "lucide-react";
import PdfPageCanvas, { type TextBox } from "./PdfPageCanvas";
import SignatureComposer from "./SignatureComposer";
import { clamp, emptyEdits, imageData, moveLayer, newLayer, resizeLayer, type PdfEdits, type PdfLayer, type PdfLayerType } from "./pdfEditorModel";
import { showConfirm } from "../shared/AppDialogProvider";
import "./pdfVisualEditor.css";

type Tool = "select" | "editText" | "draw" | "rectangle" | "ellipse" | "highlight" | "cover";
export default function PdfVisualEditor({ blob, title, initialEdits, onClose, onSave, allowPageChanges = true }: {
  blob: Blob; title: string; initialEdits?: PdfEdits; allowPageChanges?: boolean; onClose: () => void;
  onSave: (edits: PdfEdits) => Promise<Blob>;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [edits, setEdits] = useState<PdfEdits>(() => initialEdits ? { layers: initialEdits.layers || [], pages: initialEdits.pages || [] } : emptyEdits());
  const [history, setHistory] = useState<PdfEdits[]>([]), [future, setFuture] = useState<PdfEdits[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [currentPage, setCurrentPage] = useState(initialEdits?.pages?.[0]?.source || 0);
  const [zoom, setZoom] = useState(.9);
  const [tool, setTool] = useState<Tool>("select");
  const [size, setSize] = useState({ width: 595, height: 842 });
  const [textBoxes, setTextBoxes] = useState<TextBox[]>([]);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [resultUrl, setResultUrl] = useState("");
  const [viewResult, setViewResult] = useState(false);
  const [dirty, setDirty] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null), pageRef = useRef<HTMLDivElement>(null), imageRef = useRef<HTMLInputElement>(null);
  const editsRef = useRef(edits); editsRef.current = edits;
  const drag = useRef<{ id: string; startX: number; startY: number; base: PdfEdits; layer: PdfLayer; resize: boolean } | null>(null);
  const gesture = useRef<{ x: number; y: number; points: Array<{ x: number; y: number }>; base: PdfEdits; id: string } | null>(null);
  const selected = edits.layers.find(layer => layer.id === selectedId);
  const pageLayout = edits.pages.find(page => page.source === currentPage);
  const updateSize = useCallback((value: { width: number; height: number }) => setSize(current => current.width === value.width && current.height === value.height ? current : value), []);
  useEffect(() => {
    let cancelled = false; let destroy: (() => void) | undefined;
    void (async () => {
      const engine = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      engine.GlobalWorkerOptions.workerSrc = worker.default;
      const task = engine.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
      destroy = () => { void task.destroy(); };
      const loaded = await task.promise;
      if (cancelled) { destroy(); return; }
      setPdf(loaded);
      setEdits(current => current.pages.length ? current : { ...current, pages: Array.from({ length: loaded.numPages }, (_, source) => ({ source, rotation: 0 })) });
      setZoom(Math.min(.95, Math.max(.25, ((viewportRef.current?.clientWidth || 720) - 64) / 595)));
    })().catch((reason: Error) => { if (!cancelled) setError(reason.name === "PasswordException" ? "Este PDF está protegido. Use Desbloquear PDF antes de editar." : "Não foi possível abrir o PDF. Confira o arquivo e tente novamente."); });
    return () => { cancelled = true; destroy?.(); };
  }, [blob]);
  useEffect(() => () => { if (resultUrl) URL.revokeObjectURL(resultUrl); }, [resultUrl]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function commit(next: PdfEdits, previous = editsRef.current) {
    if (saving) return;
    setHistory(current => [...current.slice(-29), previous]); setFuture([]); setEdits(next); setDirty(true); setResultUrl("");
  }
  function undo() { const previous = history.at(-1); if (!previous) return; setFuture(items => [edits, ...items]); setHistory(items => items.slice(0, -1)); setEdits(previous); setDirty(true); setSelectedId(""); setResultUrl(""); if (!previous.pages.some(page => page.source === currentPage)) setCurrentPage(previous.pages[0]?.source || 0); }
  function redo() { const next = future[0]; if (!next) return; setHistory(items => [...items, edits]); setFuture(items => items.slice(1)); setEdits(next); setDirty(true); setResultUrl(""); if (!next.pages.some(page => page.source === currentPage)) setCurrentPage(next.pages[0]?.source || 0); }
  function patchLayer(patch: Partial<PdfLayer>) { if (selected) commit({ ...edits, layers: edits.layers.map(layer => layer.id === selected.id ? { ...layer, ...patch } : layer) }); }
  function add(type: PdfLayerType, patch: Partial<PdfLayer> = {}) { const layer = newLayer(type, currentPage, patch); commit({ ...edits, layers: [...edits.layers, layer] }); setSelectedId(layer.id); setTool("select"); }
  function position(event: PointerEvent) {
    const rect = pageRef.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
  }
  function startLayer(event: PointerEvent, layer: PdfLayer, resize = false) {
    if (tool !== "select" || saving) return;
    event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(layer.id); drag.current = { id: layer.id, startX: event.clientX, startY: event.clientY, base: edits, layer, resize };
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (saving) return;
    if (["select", "editText"].includes(tool)) { setSelectedId(""); return; }
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const point = position(event), layer = newLayer(tool as PdfLayerType, currentPage, { ...point, width: .001, height: .001 });
    gesture.current = { ...point, points: [point], base: edits, id: layer.id };
    setEdits({ ...edits, layers: [...edits.layers, layer] }); setSelectedId(layer.id);
  }
  function pointerMove(event: PointerEvent) {
    const moving = drag.current;
    if (moving) {
      const rect = pageRef.current!.getBoundingClientRect();
      const next = (moving.resize ? resizeLayer : moveLayer)(moving.layer, (event.clientX - moving.startX) / rect.width, (event.clientY - moving.startY) / rect.height);
      setEdits({ ...moving.base, layers: moving.base.layers.map(layer => layer.id === moving.id ? next : layer) }); return;
    }
    const drawing = gesture.current; if (!drawing) return;
    const point = position(event); if (drawing.points.length < 2000) drawing.points.push(point);
    const points = tool === "draw" ? drawing.points : [{ x: drawing.x, y: drawing.y }, point];
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    const width = Math.max(.001, Math.max(...points.map(p => p.x)) - x), height = Math.max(.001, Math.max(...points.map(p => p.y)) - y);
    const layer = newLayer(tool as PdfLayerType, currentPage, { id: drawing.id, x: Math.min(x, 1 - width), y: Math.min(y, 1 - height), width, height, points: tool === "draw" ? points.map(p => ({ x: (p.x - x) / width, y: (p.y - y) / height })) : [] });
    setEdits({ ...drawing.base, layers: [...drawing.base.layers, layer] });
  }
  function pointerUp() {
    const active = drag.current || gesture.current; if (!active) return;
    const next = editsRef.current;
    if (JSON.stringify(next) !== JSON.stringify(active.base)) {
      const layer = next.layers.find(layer => layer.id === active.id);
      if (gesture.current && layer && (layer.width < .003 || (layer.type === "draw" && layer.points.length < 2))) setEdits(active.base);
      else commit(next, active.base);
    }
    drag.current = null; gesture.current = null; setTool("select");
  }
  async function save() { setSaving(true); setError(""); try { const output = await onSave(edits); setResultUrl(URL.createObjectURL(output)); setDirty(false); setViewResult(true); } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível salvar o PDF."); } finally { setSaving(false); } }
  async function close() { if (saving) return; if (dirty && !await showConfirm({ title: "Sair do editor?", description: "Há alterações que ainda não foram salvas.", confirmLabel: "Sair sem salvar", tone: "danger" })) return; onClose(); }
  async function upload(file?: File) { if (!file) return; try { const image = await imageData(file); const width = .35, height = Math.min(.65, width * size.width / size.height * image.ratio); add("image", { dataUrl: image.dataUrl, width, height }); } catch (reason) { setError((reason as Error).message); } }
  function reorder(direction: number) { const pages = [...edits.pages], index = pages.findIndex(page => page.source === currentPage), target = index + direction; if (target < 0 || target >= pages.length) return; [pages[index], pages[target]] = [pages[target], pages[index]]; commit({ ...edits, pages }); }
  const tools = [["select", "Selecionar", MousePointer2], ["editText", "Editar texto", FilePenLine], ["draw", "Lápis", PenLine], ["highlight", "Destacar", Highlighter], ["rectangle", "Retângulo", Square], ["ellipse", "Elipse", Circle], ["cover", "Cobrir", Square]] as const;
  return <main aria-busy={saving} className="clean-workspace pdf-visual-editor" onKeyDown={event => {
    if ((event.target as HTMLElement).matches("input,textarea,select")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    if (event.key === "Delete" && selected) { event.preventDefault(); commit({ ...edits, layers: edits.layers.filter(layer => layer.id !== selected.id) }); setSelectedId(""); }
  }}>
    <header inert={signatureOpen} className="pdf-editor-header"><div><button onClick={() => void close()} disabled={saving} aria-label="Voltar às ferramentas"><ArrowLeft size={18}/></button><span className="pdf-editor-brand"><FilePenLine size={20}/></span><div><small>EDITOR DE PDF</small><h1 title={title}>{title}</h1></div></div><div><span className="pdf-save-status">{dirty ? "Alterações não salvas" : "Documento pronto"}</span>{resultUrl && <a className="pdf-editor-button" href={resultUrl} download={title.toLowerCase().endsWith(".pdf") ? title : `${title}.pdf`}><Download size={16}/>Baixar PDF</a>}<button className="pdf-primary" onClick={() => void save()} disabled={saving || !pdf || Boolean(error && !pdf)}><Save size={16}/>{saving ? "Preparando PDF…" : "Concluir e salvar"}</button></div></header>
    {error && <div className="pdf-editor-error" role="alert">{error}</div>}
    {viewResult && resultUrl ? <section className="pdf-editor-result"><header><div><Check size={18}/><strong>Seu PDF está pronto</strong><span>As alterações foram salvas.</span></div><button onClick={() => setViewResult(false)}><FilePenLine size={16}/>Continuar editando</button></header><iframe title="Visualizar PDF editado" src={resultUrl}/></section> : <>
    <nav inert={saving || signatureOpen} className="pdf-editor-toolbar" aria-label="Ferramentas do editor"><button onClick={undo} disabled={!history.length} title="Desfazer (Ctrl+Z)"><Undo2 size={18}/>Desfazer</button><button onClick={redo} disabled={!future.length} title="Refazer (Ctrl+Shift+Z)"><Redo2 size={18}/>Refazer</button><span className="pdf-toolbar-divider"/>{tools.slice(0, 1).map(([value, label, Icon]) => <button key={value} aria-pressed={tool === value} onClick={() => setTool(value)}><Icon size={18}/>{label}</button>)}<button onClick={() => add("text")}><Type size={18}/>Adicionar texto</button><button onClick={() => setSignatureOpen(true)}><Signature size={18}/>Assinar</button><button onClick={() => imageRef.current?.click()}><ImagePlus size={18}/>Imagem</button>{tools.slice(1).map(([value, label, Icon]) => <button key={value} aria-pressed={tool === value} onClick={() => setTool(value)}><Icon size={18}/>{label}</button>)}<input ref={imageRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }}/></nav>
    <section className="pdf-editor-grid" inert={saving || signatureOpen}>
      <aside className="pdf-editor-pages"><header><strong>Páginas</strong><span>{edits.pages.length}</span></header><div className="pdf-page-list">{pdf && edits.pages.map((page, index) => <button key={page.source} aria-label={`Selecionar página ${index + 1}`} aria-pressed={currentPage === page.source} onClick={() => { setCurrentPage(page.source); setSelectedId(""); setTextBoxes([]); }}><PdfPageCanvas pdf={pdf} page={page.source} rotation={page.rotation} width={110}/><span>{index + 1}</span></button>)}</div><div className="pdf-page-actions" hidden={!allowPageChanges}><button aria-label="Mover página para cima" disabled={edits.pages[0]?.source === currentPage} onClick={() => reorder(-1)}><ArrowUp size={16}/></button><button aria-label="Mover página para baixo" disabled={edits.pages.at(-1)?.source === currentPage} onClick={() => reorder(1)}><ArrowDown size={16}/></button><button aria-label="Girar página" title="Gire a página antes de inserir elementos" disabled={edits.layers.some(layer => layer.page === currentPage)} onClick={() => commit({ ...edits, pages: edits.pages.map(page => page.source === currentPage ? { ...page, rotation: ((page.rotation + 90) % 360) as 0 | 90 | 180 | 270 } : page) })}><RotateCw size={16}/></button><button aria-label="Excluir página" disabled={edits.pages.length < 2} onClick={() => { const pages = edits.pages.filter(page => page.source !== currentPage); commit({ pages, layers: edits.layers.filter(layer => layer.page !== currentPage) }); setCurrentPage(pages[0].source); setSelectedId(""); }}><Trash2 size={16}/></button></div></aside>
      <section className="pdf-editor-workspace"><div className="pdf-editor-zoom"><span>Página {edits.pages.findIndex(page => page.source === currentPage) + 1} de {edits.pages.length}</span><div><button aria-label="Diminuir zoom" onClick={() => setZoom(value => Math.max(.25, value - .1))}><Minus size={15}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label="Aumentar zoom" onClick={() => setZoom(value => Math.min(2, value + .1))}><Plus size={15}/></button><button onClick={() => setZoom(clamp(((viewportRef.current?.clientWidth || 720) - 64) / size.width, .25, 2))}>Ajustar à tela</button></div></div><div className="pdf-editor-canvas-scroll" ref={viewportRef}>
        {!pdf ? <p role="status">Carregando páginas do PDF…</p> : <div ref={pageRef} className={`pdf-editor-page tool-${tool}`} style={{ width: size.width * zoom, height: size.height * zoom }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { const active = drag.current || gesture.current; if (active) setEdits(active.base); drag.current = null; gesture.current = null; }}>
          <PdfPageCanvas pdf={pdf} page={currentPage} rotation={pageLayout?.rotation || 0} width={size.width * zoom} onSize={updateSize} onText={setTextBoxes} onError={setError}/>
          {tool === "editText" && textBoxes.map((box, index) => <button className="pdf-source-text" key={index} aria-label={`Editar: ${box.text}`} style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} onPointerDown={event => event.stopPropagation()} onClick={() => {
            const x = clamp(box.x, 0, .98), y = clamp(box.y, 0, .98), width = clamp(box.width, .02, 1 - x), height = clamp(box.height, .012, 1 - y);
            const cover = newLayer("cover", currentPage, { x, y, width, height }), text = newLayer("text", currentPage, { x, y, width, height: Math.min(height * 2, 1 - y), text: box.text, fontSize: clamp(box.fontSize, 6, 144) });
            commit({ ...edits, layers: [...edits.layers, cover, text] }); setSelectedId(text.id); setTool("select");
          }}/>) }
          {edits.layers.filter(layer => layer.page === currentPage).map(layer => <div key={layer.id} tabIndex={0} role="button" aria-label={`${layer.type === "signature" ? "Assinatura" : layer.type === "text" ? "Texto" : "Elemento"}: ${layer.type === "text" ? layer.text : layer.id.slice(0, 5)}`} aria-pressed={selectedId === layer.id} className={`pdf-edit-layer ${selectedId === layer.id ? "is-selected" : ""}`} style={{ left: `${layer.x * 100}%`, top: `${layer.y * 100}%`, width: `${layer.width * 100}%`, height: `${layer.height * 100}%`, pointerEvents: tool === "select" ? "auto" : "none" }} onPointerDown={event => startLayer(event, layer)} onKeyDown={event => { if (event.key === "Enter") setSelectedId(layer.id); if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); const next = moveLayer(layer, event.key === "ArrowLeft" ? -.005 : event.key === "ArrowRight" ? .005 : 0, event.key === "ArrowUp" ? -.005 : event.key === "ArrowDown" ? .005 : 0); commit({ ...edits, layers: edits.layers.map(item => item.id === layer.id ? next : item) }); } }}>
            <div className="pdf-layer-content" style={{ opacity: layer.opacity, color: layer.color, fontSize: layer.fontSize * zoom, fontFamily: layer.fontFamily === "Times" ? "'Times New Roman',serif" : layer.fontFamily === "Courier" ? "'Courier New',monospace" : "Arial,sans-serif", fontWeight: layer.bold ? 700 : 400, fontStyle: layer.italic ? "italic" : "normal", background: layer.type === "highlight" ? layer.color : layer.type === "cover" ? layer.fill : undefined, border: ["rectangle", "ellipse"].includes(layer.type) ? `${layer.strokeWidth * zoom}px solid ${layer.color}` : undefined, borderRadius: layer.type === "ellipse" ? "50%" : undefined }}>{layer.type === "text" ? layer.text : ["image", "signature"].includes(layer.type) ? <img src={layer.dataUrl} alt={layer.type === "signature" ? "Assinatura" : "Imagem inserida"} draggable={false}/> : layer.type === "draw" ? <svg viewBox={`0 0 ${layer.width * size.width} ${layer.height * size.height}`} preserveAspectRatio="none"><polyline points={layer.points.map(point => `${point.x * layer.width * size.width},${point.y * layer.height * size.height}`).join(" ")} fill="none" stroke={layer.color} strokeWidth={layer.strokeWidth} strokeLinecap="round" strokeLinejoin="round"/></svg> : null}</div>
            {selectedId === layer.id && <button className="pdf-resize-handle" aria-label="Redimensionar elemento" onPointerDown={event => startLayer(event, layer, true)}/>}
          </div>)}
        </div>}
      </div><p className="pdf-editor-hint">{tool === "editText" ? "Clique em um texto para corrigir sua aparência. A correção visual cobre o texto original; não remove dados confidenciais." : tool === "cover" ? "Arraste para cobrir uma área. O conteúdo original permanece no arquivo." : tool === "select" ? "Arraste para posicionar. Use a alça no canto para redimensionar." : "Arraste na página para desenhar o elemento."}</p></section>
      <aside className="pdf-editor-properties"><header><strong>{selected ? "Propriedades" : "Personalize seu PDF"}</strong>{selected && <button onClick={() => setSelectedId("")} aria-label="Desmarcar elemento"><X size={15}/></button>}</header>{selected ? <>
        {selected.type === "text" && <><label>Texto<textarea aria-label="Conteúdo do texto" value={selected.text} maxLength={5000} onChange={event => patchLayer({ text: event.target.value })}/></label><label>Fonte<select value={selected.fontFamily} onChange={event => patchLayer({ fontFamily: event.target.value as PdfLayer["fontFamily"] })}><option value="Helvetica">Arial / Helvetica</option><option value="Times">Times</option><option value="Courier">Courier</option></select></label><label>Tamanho<input type="number" min={6} max={144} value={selected.fontSize} onChange={event => patchLayer({ fontSize: clamp(Number(event.target.value), 6, 144) })}/></label><div className="pdf-property-row"><button aria-pressed={selected.bold} onClick={() => patchLayer({ bold: !selected.bold })}><b>Negrito</b></button><button aria-pressed={selected.italic} onClick={() => patchLayer({ italic: !selected.italic })}><i>Itálico</i></button></div></>}
        {!["image", "signature"].includes(selected.type) && <label>Cor<input aria-label="Cor do elemento" type="color" value={selected.type === "cover" ? selected.fill : selected.color} onChange={event => patchLayer(selected.type === "cover" ? { fill: event.target.value } : { color: event.target.value })}/></label>}
        <label>Opacidade: {Math.round(selected.opacity * 100)}%<input aria-label="Opacidade" type="range" min={5} max={100} value={selected.opacity * 100} onChange={event => patchLayer({ opacity: Number(event.target.value) / 100 })}/></label>
        <div className="pdf-property-row">{([['x','Horizontal'],['y','Vertical']] as const).map(([key,label]) => <label key={key}>{label}<input aria-label={`Posição ${label.toLowerCase()}`} type="number" min={0} max={100} step={.5} value={Math.round(selected[key] * 1000) / 10} onChange={event => patchLayer({ [key]: clamp(Number(event.target.value) / 100, 0, 1 - selected[key === "x" ? "width" : "height"]) })}/></label>)}</div>
        <label>Largura: {Math.round(selected.width * 100)}%<input aria-label="Largura do elemento" type="range" min={2} max={Math.floor((1 - selected.x) * 100)} value={selected.width * 100} onChange={event => { const resized = resizeLayer(selected, Number(event.target.value) / 100 - selected.width, 0); patchLayer(resized); }}/></label>
        {!["image", "signature"].includes(selected.type) && <label>Altura: {Math.round(selected.height * 100)}%<input aria-label="Altura do elemento" type="range" min={1} max={Math.floor((1 - selected.y) * 100)} value={selected.height * 100} onChange={event => patchLayer({ height: clamp(Number(event.target.value) / 100, .01, 1 - selected.y) })}/></label>}
        <div className="pdf-property-row"><button onClick={() => { const copy = moveLayer({ ...selected, id: crypto.randomUUID() }, .02, .02); commit({ ...edits, layers: [...edits.layers, copy] }); setSelectedId(copy.id); }}><Copy size={15}/>Duplicar</button><button className="pdf-danger" onClick={() => { commit({ ...edits, layers: edits.layers.filter(layer => layer.id !== selected.id) }); setSelectedId(""); }}><Trash2 size={15}/>Excluir</button></div>
        <button onClick={() => commit({ ...edits, layers: [...edits.layers.filter(layer => layer.id !== selected.id), selected] })}>Trazer para frente</button>
      </> : <div className="pdf-editor-help"><MousePointer2 size={28}/><p>Selecione um elemento para ajustar texto, tamanho, cor e posição.</p><button onClick={() => setSignatureOpen(true)}><Signature size={17}/>Adicionar assinatura</button></div>}<div className="pdf-editor-layer-list"><strong>Elementos da página</strong>{edits.layers.filter(layer => layer.page === currentPage).map((layer, index) => <button key={layer.id} aria-pressed={selectedId === layer.id} onClick={() => { setSelectedId(layer.id); setTool("select"); }}>{index + 1}. {layer.type === "text" ? layer.text : ({ signature: "Assinatura", image: "Imagem", draw: "Desenho", highlight: "Destaque", cover: "Cobertura", rectangle: "Retângulo", ellipse: "Elipse" } as Record<string,string>)[layer.type]}</button>)}</div></aside>
    </section></>}
    {signatureOpen && <SignatureComposer onClose={() => setSignatureOpen(false)} onApply={(dataUrl, ratio) => { add("signature", { dataUrl, width: .32, height: Math.min(.5, .32 * size.width / size.height * ratio) }); setSignatureOpen(false); }}/>} 
  </main>;
}
