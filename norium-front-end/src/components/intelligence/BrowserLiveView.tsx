import { useEffect, useRef, useState } from "react";
import { Globe2, Maximize2, Radio, RefreshCw } from "lucide-react";
import { authenticatedWebSocketUrl } from "../../core/api/client";
import { wsBaseUrl } from "../../core/api/config";
import Button from "../shared/Button";

export default function BrowserLiveView({ runId, status, url }: { runId: string; status: string; url: string }) {
  const socketRef = useRef<WebSocket | null>(null);
  const [inputError, setInputError] = useState("");
  const [loginText, setLoginText] = useState("");
  const interactive = status === "awaiting_login";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState("waiting");
  const [hasFrame, setHasFrame] = useState(false);
  const [retry, setRetry] = useState(0);
  const active = ["queued", "running", "paused", "awaiting_approval", "awaiting_login", "cancelling"].includes(status);
  useEffect(() => { setLoginText(""); setInputError(""); }, [interactive]);
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
      socketRef.current = socket;
      socket.binaryType = "blob";
      socket.onmessage = (event) => {
        if (event.data instanceof Blob) { void paint(event.data); return; }
        try { const data = JSON.parse(String(event.data)); if (data.type === "input_error") setInputError(data.message); if (data.type === "ended") { serverEnded = true; setConnection("ended"); setHasFrame(false); socket?.close(); } } catch { setConnection("error"); }
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
    return () => { disposed = true; pending = undefined; window.clearTimeout(retryTimer); socket?.close(); socketRef.current = null; };
  }, [runId, active, retry]);

  function send(payload: Record<string, unknown>) {
    if (!interactive || socketRef.current?.readyState !== WebSocket.OPEN) { setInputError("Aguarde o navegador se conectar."); return; }
    setInputError(""); socketRef.current.send(JSON.stringify(payload));
  }
  const label = !active ? status === "planned" ? "Pronto para iniciar" : "Sessão encerrada" : interactive ? "Faça login no site para continuar" : status === "paused" ? "Navegador pausado" : status === "awaiting_approval" ? "Aguardando sua confirmação" : connection === "live" ? "Ao vivo" : connection === "error" ? "Transmissão indisponível" : connection === "reconnecting" ? "Reconectando…" : "Conectando ao navegador…";
  return <div ref={containerRef} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)]">
    <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-3 py-2">
      <span className={`flex items-center gap-2 text-xs font-semibold ${active && connection === "live" ? "text-emerald-400" : "text-[var(--text-secondary)]"}`}><Radio size={15} />{label}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]" title={url}>{url}</span>
      {connection === "error" && <Button iconOnly aria-label="Reconectar transmissão" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={15} /></Button>}
      <Button iconOnly aria-label="Ampliar navegador" onClick={() => { void containerRef.current?.requestFullscreen().catch(() => undefined); }}><Maximize2 size={15} /></Button>
    </div>
    {interactive && <div className="space-y-2 border-b border-[var(--border)] p-3 text-sm">
      <p className="text-amber-400">Clique na página abaixo para fazer login ou concluir a verificação. O agente está aguardando você.</p>
      <p className="text-xs text-[var(--text-secondary)]">Use o teclado após clicar no campo. No celular, use o campo protegido abaixo para enviar o texto ao campo selecionado no site. Senhas não entram no relatório.</p>
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (loginText) { send({ type: "text", text: loginText }); setLoginText(""); } }}>
        <input aria-label="Texto para o campo selecionado no site" type="password" autoComplete="off" maxLength={2000} value={loginText} onChange={event => setLoginText(event.target.value)} className="intelligence-field min-w-0 flex-1" placeholder="Digite para o campo selecionado" />
        <Button type="submit" disabled={!loginText}>Inserir no site</Button><Button type="button" onClick={() => send({ type: "key", key: "Tab" })}>Próximo campo</Button><Button type="button" onClick={() => send({ type: "key", key: "Enter" })}>Enter</Button>
      </form>
      {inputError && <p role="alert" className="text-xs text-rose-400">{inputError}</p>}
    </div>}
    <div className="relative aspect-[16/10] bg-[#09090b]">
      <canvas ref={canvasRef} aria-label="Navegação do agente em tempo real" tabIndex={interactive ? 0 : -1}
        onClick={event => {
          if (!interactive) return;
          event.currentTarget.focus();
          const rect = event.currentTarget.getBoundingClientRect();
          const scale = Math.min(rect.width / event.currentTarget.width, rect.height / event.currentTarget.height);
          const width = event.currentTarget.width * scale, height = event.currentTarget.height * scale;
          const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
          const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1) send({ type: "click", x, y });
        }}
        onKeyDown={event => {
          if (!interactive) return;
          if (event.key === "Escape") { event.currentTarget.blur(); return; }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
          event.preventDefault();
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") send({ type: "key", key: "ControlOrMeta+A" });
          else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) send({ type: "text", text: event.key });
          else if (["Tab", "Enter", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) send({ type: "key", key: event.key === "Tab" && event.shiftKey ? "Shift+Tab" : event.key });
        }}
        onPaste={event => { if (interactive) { event.preventDefault(); const text = event.clipboardData.getData("text").slice(0, 2000); if (text) send({ type: "text", text }); } }}
        onWheel={event => { if (interactive) send({ type: "scroll", delta: Math.max(-1000, Math.min(1000, event.deltaY)) }); }}
        className={`h-full w-full object-contain ${hasFrame ? "" : "invisible"}`} />
      {!hasFrame && <div className="absolute inset-0 grid place-content-center gap-3 p-8 text-center text-zinc-400"><Globe2 className="mx-auto" size={36} /><p className="text-sm">{active ? label : status === "planned" ? "Revise o plano e inicie para acompanhar a navegação aqui." : "A navegação terminou. O resultado está disponível abaixo."}</p></div>}
    </div>
  </div>;
}
