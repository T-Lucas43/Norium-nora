import "@xyflow/react/dist/style.css";
import { Background, Controls, ReactFlow, applyNodeChanges, type Edge, type ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid, Plus, Save, ThumbsUp, Trash2, X } from "lucide-react";
import { ApiError } from "../../core/api/client";
import IdeaCard, { type IdeaNode } from "../brainstorm/StudioIdeaNode";
import { STUDIO_TEMPLATES } from "../brainstorm/studioTemplateCatalog";
import { useTeamApiRequest, useTeamSocketEvents } from "./CallSession";

type StudioNode = IdeaNode & { version: number };
type Studio = { id: string; title: string; active: boolean; revision: number; board: { nodes: StudioNode[]; edges: Edge[] } };
type Envelope = { session: Studio | null };
type Draft = { id: string; version: number; label: string; description: string; color: string };
type Operation = { kind: string; itemId: string; operationId?: string; [key: string]: unknown };
const nodeTypes = { idea: IdeaCard };
const COLORS = ["#FDE68A", "#BAE6FD", "#BBF7D0", "#FBCFE8", "#DDD6FE", "#FED7AA"];

function draftFrom(node: StudioNode): Draft {
  return { id: node.id, version: node.version, label: node.data.label, description: node.data.description || "", color: node.data.color };
}

export default function TeamCallStudio({ callId, clientId, currentUserId, isHost, visible, onOpen, onClose }: {
  callId: string; clientId: string; currentUserId: string; isHost: boolean; visible: boolean;
  onOpen: () => void; onClose: () => void;
}) {
  const request = useTeamApiRequest();
  const [session, setSession] = useState<Studio | null>(null);
  const [nodes, setNodes] = useState<StudioNode[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [comment, setComment] = useState("");
  const [title, setTitle] = useState("Estúdio da reunião");
  const [template, setTemplate] = useState("livre");
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<Operation | null>(null);
  const [mobileInspector, setMobileInspector] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance<StudioNode> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const sessionRef = useRef<Studio | null>(null);
  const busyRef = useRef(false);
  const draggingRef = useRef(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const path = `/api/team-chat/calls/${encodeURIComponent(callId)}/studio`;

  const accept = useCallback(({ session: next }: Envelope) => {
    if (!mountedRef.current) return;
    const current = sessionRef.current;
    if (next && (!current || next.revision > current.revision)) {
      if (next.active && !current?.active) openRef.current();
      sessionRef.current = next;
      setSession(next);
      if (!draggingRef.current) setNodes(next.board.nodes);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || !flow || !visible) return;
    let frame = 0;
    const fit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (element.clientWidth && element.clientHeight) void flow.fitView({ padding: 0.2, maxZoom: 1.15 });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element); fit();
    return () => { observer.disconnect(); window.cancelAnimationFrame(frame); };
  }, [flow, nodes.length, visible, mobileInspector]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await request<Envelope>(`${path}?clientId=${encodeURIComponent(clientId)}`, { signal, timeoutMs: 8000 });
      if (!signal?.aborted) { accept(data); setSyncError(""); }
    } catch (reason) {
      if (!signal?.aborted) setSyncError(reason instanceof Error ? reason.message : "Sem conexão com o estúdio. Tentando novamente…");
    }
  }, [accept, clientId, path, request]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [refresh]);

  useTeamSocketEvents((event) => {
    if (event.type === "CALL_STUDIO_UPDATED" && event.callId === callId) void refresh();
  });

  const selected = session?.board.nodes.find((node) => node.id === draft?.id);
  useEffect(() => {
    if (selected && !dirty) setDraft(draftFrom(selected));
  }, [selected, dirty]);

  async function start(active: boolean) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      accept(await request<Envelope>(path, { method: "POST", body: JSON.stringify({ clientId, title, template, active }) }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível abrir o estúdio."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function operate(input: Operation): Promise<boolean> {
    if (busyRef.current) return false;
    const operation = { ...input, operationId: input.operationId || crypto.randomUUID() };
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await request<Envelope>(`${path}/operations`, { method: "POST", body: JSON.stringify({ ...operation, clientId }) });
      accept(result); setRetry(null);
      if (operation.kind === "edit") setDirty(false);
      if (operation.kind === "comment") setComment("");
      if (operation.kind === "delete") setDraft(null);
      // Restore the authoritative position even when an event delivered this revision first.
      if (sessionRef.current) setNodes(sessionRef.current.board.nodes);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível salvar. Seu rascunho foi mantido.");
      if (!(reason instanceof ApiError) || reason.status >= 500 || reason.status === 408) setRetry(operation);
      else setRetry(null);
      if (sessionRef.current) setNodes(sessionRef.current.board.nodes);
      void refresh();
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }

  const locked = !session?.active || busy || !!retry || !!syncError;
  const editDraft = (change: Partial<Draft>) => { setDraft((current) => current ? { ...current, ...change } : current); setDirty(true); };
  const chooseNode = (node: StudioNode) => {
    if (dirty && draft?.id !== node.id) { setError("Salve ou descarte seu rascunho antes de selecionar outro cartão."); return; }
    if (draft?.id !== node.id) { setDraft(draftFrom(node)); setDirty(false); setComment(""); setError(""); }
    setMobileInspector(true);
  };

  return <section className="team-call-studio" style={{ display: visible ? undefined : "none" }} aria-label="Estúdio da chamada">
    <header className="team-call-studio-header">
      <div><h2><LayoutGrid size={18} /> {session?.title || "Estúdio da chamada"}</h2><p>{session ? session.active ? "Quadro compartilhado · todos na chamada podem editar" : "Sessão encerrada · quadro somente para leitura" : "O organizador abre a sessão para todos na chamada."}</p></div>
      <button type="button" onClick={onClose} aria-label="Voltar aos vídeos" title="Voltar aos vídeos"><X size={20} /></button>
    </header>
    {(error || syncError) && <div className="team-call-studio-error" role="alert">{error || syncError}{retry && <button type="button" disabled={busy} onClick={() => void operate(retry)}>Tentar envio novamente</button>}</div>}
    {!session ? <div className="team-call-studio-start">
      {!loaded ? <p role="status">Carregando estúdio…</p> : isHost ? <form onSubmit={(event) => { event.preventDefault(); void start(true); }}>
        <h3>Abra um espaço para construir juntos</h3><p>Os participantes receberão o mesmo quadro dentro da própria ligação.</p>
        <label>Nome da sessão<input maxLength={160} required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Quadro inicial<select value={template} onChange={(event) => setTemplate(event.target.value)}><option value="livre">Quadro livre</option>{STUDIO_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <button type="submit" disabled={busy || !!syncError}>{busy ? "Abrindo…" : "Abrir sessão para todos"}</button>
      </form> : <p role="status">Aguardando o organizador abrir o estúdio. A sessão aparecerá aqui automaticamente.</p>}
    </div> : <>
      <div className="team-call-studio-tools">
        <button type="button" disabled={locked || dirty} onClick={() => { void operate({ kind: "add", itemId: `idea_${crypto.randomUUID()}`, label: "Nova ideia", x: (nodes.length % 4) * 310, y: Math.floor(nodes.length / 4) * 210 }).then((ok) => { if (ok) { const last = sessionRef.current?.board.nodes.at(-1); if (last) chooseNode(last); } }); }}><Plus size={16} /> Cartão</button>
        <span role="status">{busy ? "Salvando…" : retry ? "Envio pendente" : dirty ? "Rascunho não salvo" : `Sincronizado · ${session.board.nodes.length} cartões`}</span>
        {isHost && <button type="button" disabled={busy || !!retry || dirty || !!syncError} onClick={() => void start(!session.active)}>{session.active ? "Encerrar estúdio" : "Reabrir estúdio"}</button>}
      </div>
      <div className="team-call-studio-mobile-tabs"><button type="button" aria-pressed={!mobileInspector} onClick={() => setMobileInspector(false)}>Quadro</button><button type="button" aria-pressed={mobileInspector} disabled={!draft} onClick={() => setMobileInspector(true)}>Editar cartão</button></div>
      <div className={`team-call-studio-body ${mobileInspector ? "is-editing" : ""}`}>
        <div ref={canvasRef} className="team-call-studio-canvas">
          <ReactFlow nodes={nodes.map((node) => ({ ...node, selected: node.id === draft?.id }))} edges={session.board.edges} nodeTypes={nodeTypes} onInit={setFlow} fitView fitViewOptions={{ maxZoom: 1.15, padding: 0.2 }} minZoom={0.15} maxZoom={2} nodesDraggable={!locked} nodesConnectable={!locked} deleteKeyCode={null}
            onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
            onNodeClick={(_event, node) => chooseNode(node)}
            onNodeDragStart={() => { draggingRef.current = true; }}
            onNodeDragStop={(_event, node) => { draggingRef.current = false; void operate({ kind: "move", itemId: node.id, x: node.position.x, y: node.position.y }); }}
            onConnect={(connection) => { if (!locked && connection.source && connection.target) void operate({ kind: "connect", itemId: connection.source, target: connection.target }); }}
            onEdgeDoubleClick={(_event, edge) => { if (!locked) void operate({ kind: "disconnect", itemId: edge.id }); }}>
            <Background /><Controls showInteractive={false} />
          </ReactFlow>
          {!nodes.length && <p className="team-call-studio-empty">Adicione o primeiro cartão para começar.</p>}
        </div>
        <aside className="team-call-studio-inspector" aria-label="Editar cartão">
          {draft ? <>
            <h3>Cartão selecionado</h3>
            {(!selected || selected.version !== draft.version) && <p role="status">{selected ? "Este cartão recebeu uma edição. Seu rascunho foi preservado." : "Este cartão foi excluído. Copie seu rascunho antes de fechar."}</p>}
            <form onSubmit={(event) => { event.preventDefault(); void operate({ kind: "edit", itemId: draft.id, version: draft.version, label: draft.label, description: draft.description, color: draft.color }).then((ok) => { if (ok) setDirty(false); }); }}>
              <label>Título do cartão<input maxLength={500} value={draft.label} disabled={!session.active} onChange={(event) => editDraft({ label: event.target.value })} /></label>
              <label>Descrição<textarea aria-label="Descrição" rows={4} maxLength={8000} value={draft.description} disabled={!session.active} onChange={(event) => editDraft({ description: event.target.value })} /></label>
              <div className="team-call-studio-colors" aria-label="Cor do cartão">{COLORS.map((color, index) => <button key={color} type="button" disabled={locked} aria-label={`Cor ${index + 1}`} aria-pressed={draft.color.toLowerCase() === color.toLowerCase()} style={{ background: color }} onClick={() => editDraft({ color })} />)}</div>
              <button type="submit" disabled={locked || !selected || !dirty}><Save size={15} /> Salvar cartão</button>
              <button type="button" disabled={busy} onClick={() => { setDraft(selected ? draftFrom(selected) : null); setDirty(false); setError(""); }}>Descartar rascunho</button>
            </form>
            {selected && <>
              <div className="team-call-studio-tools"><button type="button" disabled={locked} aria-pressed={selected.data.votes?.includes(currentUserId) || false} onClick={() => void operate({ kind: "vote", itemId: selected.id })}><ThumbsUp size={15} /> {selected.data.votes?.includes(currentUserId) ? "Retirar voto" : "Votar"} ({selected.data.votes?.length || 0})</button><button type="button" disabled={locked || dirty} aria-label="Excluir cartão" onClick={() => void operate({ kind: "delete", itemId: selected.id, version: selected.version }).then((ok) => { if (ok) setDraft(null); })}><Trash2 size={15} /></button></div>
              <h3>Comentários</h3>{selected.data.comments?.map((item) => <div key={item.id} className="team-call-studio-comment"><strong>{item.authorName}</strong><p>{item.text}</p></div>)}
              <form onSubmit={(event) => { event.preventDefault(); void operate({ kind: "comment", itemId: selected.id, text: comment }).then((ok) => { if (ok) setComment(""); }); }}><label>Novo comentário<textarea aria-label="Novo comentário" rows={2} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} /></label><button type="submit" disabled={locked || !comment.trim()}>Comentar</button></form>
            </>}
          </> : <><h3>Construa com a equipe</h3><p>Selecione um cartão para editar, comentar ou votar. Arraste os cartões para organizar o quadro.</p><p>Ligue os pontos nas laterais dos cartões para conectá-los. Dê dois cliques em uma conexão para removê-la.</p></>}
        </aside>
      </div>
    </>}
  </section>;
}
