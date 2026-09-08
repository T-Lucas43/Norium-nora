import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Eraser, ImagePlus, PenLine, Type, X } from "lucide-react";
import { imageData } from "./pdfEditorModel";
import "./pdfVisualEditor.css";

const fonts = ["cursive", "'Brush Script MT', cursive", "'Segoe Script', cursive", "Georgia, serif"];
export default function SignatureComposer({ onClose, onApply }: {
  onClose: () => void; onApply: (dataUrl: string, ratio: number) => void;
}) {
  const [tab, setTab] = useState("draw");
  const [text, setText] = useState("");
  const [font, setFont] = useState(fonts[0]);
  const [color, setColor] = useState("#171717");
  const [hasInk, setHasInk] = useState(false);
  const [image, setImage] = useState<{ dataUrl: string; ratio: number } | null>(null);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);
  function draw(event: PointerEvent<HTMLCanvasElement>, start = false) {
    const canvas = event.currentTarget, rect = canvas.getBoundingClientRect(), ctx = canvas.getContext("2d")!;
    const x = (event.clientX - rect.left) * canvas.width / rect.width, y = (event.clientY - rect.top) * canvas.height / rect.height;
    if (start) { drawing.current = true; canvas.setPointerCapture(event.pointerId); ctx.beginPath(); ctx.moveTo(x, y); }
    else if (drawing.current) { ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineTo(x, y); ctx.stroke(); setHasInk(true); }
  }
  async function upload(file?: File) {
    if (!file) return;
    try { setImage(await imageData(file)); setError(""); } catch (err) { setError((err as Error).message); }
  }
  function apply() {
    if (tab === "image" && image) { onApply(image.dataUrl, image.ratio); return; }
    let canvas = canvasRef.current!;
    if (tab === "type") {
      canvas = document.createElement("canvas"); canvas.width = 1000; canvas.height = 240;
      const ctx = canvas.getContext("2d")!; ctx.fillStyle = color; ctx.font = `italic 76px ${font}`;
      ctx.textBaseline = "middle"; ctx.fillText(text.trim(), 24, 120, 950);
    }
    // Crop transparent margins so the draggable box hugs the signature.
    const ctx = canvas.getContext("2d")!, pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let x0 = canvas.width, y0 = canvas.height, x1 = 0, y1 = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (pixels[(y * canvas.width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 <= x0) return;
    const output = document.createElement("canvas"); output.width = x1 - x0 + 12; output.height = y1 - y0 + 12;
    output.getContext("2d")!.drawImage(canvas, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 5, 5, x1 - x0 + 1, y1 - y0 + 1);
    onApply(output.toDataURL("image/png"), output.height / output.width);
  }
  return <div className="pdf-signature-backdrop" onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="pdf-signature-dialog" role="dialog" aria-modal="true" aria-label="Adicionar assinatura" onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select')).filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><div><h2>Adicionar assinatura</h2><p>Crie a assinatura e posicione no documento.</p></div><button onClick={onClose} aria-label="Fechar assinatura"><X size={20}/></button></header>
      <nav aria-label="Tipo de assinatura">{[["draw", "Desenhar", PenLine], ["image", "Imagem", ImagePlus], ["type", "Digitar", Type]].map(([value, label, Icon]) => { const I = Icon as typeof Type; return <button key={String(value)} aria-pressed={tab === value} onClick={() => setTab(String(value))}><I size={16}/>{String(label)}</button>; })}</nav>
      <div className="pdf-signature-body">
        {tab !== "image" && <label className="pdf-ink-color">Cor da assinatura <input aria-label="Cor da assinatura" type="color" value={color} onChange={event => setColor(event.target.value)}/></label>}
        <div hidden={tab !== "draw"}><canvas ref={canvasRef} width={1000} height={320} aria-label="Desenhar assinatura" onPointerDown={event => draw(event, true)} onPointerMove={event => draw(event)} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }}/><button onClick={() => { canvasRef.current?.getContext("2d")?.clearRect(0, 0, 1000, 320); setHasInk(false); }}><Eraser size={15}/>Limpar assinatura</button></div>
        {tab === "type" && <><input autoFocus aria-label="Texto da assinatura" placeholder="Digite seu nome" maxLength={80} value={text} onChange={event => setText(event.target.value)} className="pdf-signature-type" style={{ fontFamily: font, color }}/><div className="pdf-signature-fonts">{fonts.map((value, index) => <button key={value} aria-label={`Estilo de assinatura ${index + 1}`} aria-pressed={font === value} style={{ fontFamily: value }} onClick={() => setFont(value)}>{text || "Assinatura"}</button>)}</div></>}
        {tab === "image" && <div className="pdf-signature-upload" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}><input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void upload(event.target.files?.[0])}/>{image && <img src={image.dataUrl} alt="Assinatura selecionada"/>}<button onClick={() => fileRef.current?.click()}><ImagePlus size={18}/>Selecionar imagem</button><p>Ou arraste uma imagem para cá.</p></div>}
        {error && <p role="alert" className="pdf-editor-error">{error}</p>}
      </div>
      <footer><button onClick={onClose}>Cancelar</button><button className="pdf-primary" disabled={tab === "draw" ? !hasInk : tab === "type" ? !text.trim() : !image} onClick={apply}>Inserir assinatura</button></footer>
    </section>
  </div>;
}
