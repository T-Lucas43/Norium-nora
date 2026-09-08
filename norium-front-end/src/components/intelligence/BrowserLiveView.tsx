import { useEffect, useRef, useState } from "react";
import { Globe2, Maximize2, Radio, RefreshCw } from "lucide-react";
import { authenticatedWebSocketUrl } from "../../core/api/client";
import { wsBaseUrl } from "../../core/api/config";
import Button from "../shared/Button";

export default function BrowserLiveView({ runId, status, url }: { runId: string; status: string; url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState("waiting");
  const [hasFrame, setHasFrame] = useState(false);
  const [retry, setRetry] = useState(0);
  const active = ["queued", "running", "paused", "awaiting_approval", "cancelling"].includes(status);
  useEffect(() => {
    setHasFrame(false);
    setConnection(active ? "waiting" : "ended");
    if (!active) return;
    let disposed = false, socket: WebSocket | undefined, retryTimer: number | undefined;
    let serverEnded = false;
    let decoding = false;
    let pending: Blob | undefined;
    async function paint(blob: Blob) {
      if (decoding) { pending = blob; return; }
      decoding = true;
      try {
        const bitmap = await createImageBitmap(blob);
        const canvas = canvasRef.current;
        if (!disposed && canvas) {
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          setHasFrame(true); setConnection("live");
        }
        bitmap.close();
      } catch { if (!disposed) setConnection("error"); }
      finally { decoding = false; if (pending && !disposed) { const next = pending; pending = undefined; void paint(next); } }
    }
    void (async () => {
      const workspace = window.localStorage.getItem("norium-workspace-id") || "primary";
      const address = await authenticatedWebSocketUrl(`${wsBaseUrl()}/api/navegador/runs/${encodeURIComponent(runId)}/live?workspace=${encodeURIComponent(workspace)}`);
      if (disposed) return;
      socket = new WebSocket(address);
      socket.binaryType = "blob";
      socket.onmessage = (event) => {
        if (event.data instanceof Blob) { void paint(event.data); return; }
        try { const data = JSON.parse(String(event.data)); if (data.type === "ended") { serverEnded = true; setConnection("ended"); setHasFrame(false); socket?.close(); } } catch { setConnection("error"); }
      };
      socket.onerror = () => { if (!disposed) setConnection("error"); };
      socket.onclose = (event) => {
        if (disposed) return;
        setHasFrame(false);
        if ([4401, 4429].includes(event.code)) { setConnection("error"); return; }
        if (!serverEnded) {
          setConnection("reconnecting");
          retryTimer = window.setTimeout(() => setRetry((value) => value + 1), 5000);
        }
      };
    })().catch(() => { if (!disposed) setConnection("error"); });
    return () => { disposed = true; pending = undefined; window.clearTimeout(retryTimer); socket?.close(); };
  }, [runId, active, retry]);

  const label = !active ? status === "planned" ? "Pronto para iniciar" : "Sessão encerrada" : status === "paused" ? "Navegador pausado" : status === "awaiting_approval" ? "Aguardando sua confirmação" : connection === "live" ? "Ao vivo" : connection === "error" ? "Transmissão indisponível" : connection === "reconnecting" ? "Reconectando…" : "Conectando ao navegador…";
  return <div ref={containerRef} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)]">
    <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-3 py-2">
      <span className={`flex items-center gap-2 text-xs font-semibold ${active && connection === "live" ? "text-emerald-400" : "text-[var(--text-secondary)]"}`}><Radio size={15} />{label}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]" title={url}>{url}</span>
      {connection === "error" && <Button iconOnly aria-label="Reconectar transmissão" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={15} /></Button>}
      <Button iconOnly aria-label="Ampliar navegador" onClick={() => { void containerRef.current?.requestFullscreen().catch(() => undefined); }}><Maximize2 size={15} /></Button>
    </div>
    <div className="relative aspect-[16/10] bg-[#09090b]">
      <canvas ref={canvasRef} aria-label="Navegação do agente em tempo real" className={`h-full w-full object-contain ${hasFrame ? "" : "invisible"}`} />
      {!hasFrame && <div className="absolute inset-0 grid place-content-center gap-3 p-8 text-center text-zinc-400"><Globe2 className="mx-auto" size={36} /><p className="text-sm">{active ? label : status === "planned" ? "Revise o plano e inicie para acompanhar a navegação aqui." : "A navegação terminou. O resultado está disponível abaixo."}</p></div>}
    </div>
  </div>;
}
