import "@xyflow/react/dist/style.css";
import { Background, Controls, ReactFlow, applyNodeChanges, type Edge, type ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bot, LayoutGrid, Plus, Save, ThumbsUp, Trash2, X } from "lucide-react";
import { ApiError } from "../../core/api/client";
import IdeaCard, { type IdeaNode } from "../brainstorm/StudioIdeaNode";
import { NoraMarkdown } from "../nora/NoraResponseContent";
import { STUDIO_TEMPLATES } from "../brainstorm/studioTemplateCatalog";
import { useTeamApiRequest, useTeamSocketEvents } from "./CallSession";

type StudioNode = IdeaNode & { version: number };
type Studio = { id: string; title: string; active: boolean; revision: number; saveDecision?: string; savedStudioId?: string; noraMessages?: Array<{ requestKey: string; instruction: string; response: string; authorName: string }>; board: { nodes: StudioNode[]; edges: Edge[] } };
type Envelope = { session: Studio | null; canUseNora?: boolean };
type Draft = { id: string; version: number; label: string; description: string; color: string };
type Operation = { kind: string; itemId: string; operationId?: string; [key: string]: unknown };
const nodeTypes = { idea: IdeaCard };
const COLORS = ["#FDE68A", "#BAE6FD", "#BBF7D0", "#FBCFE8", "#DDD6FE", "#FED7AA"];

function draftFrom(node: StudioNode): Draft {
  return { id: node.id, version: node.version, label: node.data.label, description: node.data.description || "", color: node.data.color };
}

export default function TeamCallStudio({ callId, clientId, currentUserId, isHost, visible, onOpen, onClose, beforeEndRef }: {
  callId: string; clientId: string; currentUserId: string; isHost: boolean; visible: boolean;
  onOpen: () => void; onClose: () => void;
  beforeEndRef?: RefObject<(() => Promise<boolean>) | null>;
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
  const [canUseNora, setCanUseNora] = useState(false);
  const [noraOpen, setNoraOpen] = useState(false);
  const [noraPrompt, setNoraPrompt] = useState("");
  const [noraAction, setNoraAction] = useState("perguntar");
  const [noraBusy, setNoraBusy] = useState(false);
  const [noraRetry, setNoraRetry] = useState<{ requestId: string; action: string; instruction: string } | null>(null);
  const [finishPrompt, setFinishPrompt] = useState(false);
  const [finishError, setFinishError] = useState("");
  const finishResolver = useRef<((result: boolean) => void) | null>(null);
  const finishDialogRef = useRef<HTMLDivElement>(null);
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

  const accept = useCallback(({ session: next, canUseNora: allowed }: Envelope) => {
    if (!mountedRef.current) return;
    if (allowed !== undefined) setCanUseNora(allowed);
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
    return () => { mountedRef.current = false; finishResolver.current?.(false); };
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

  const askFinish = useCallback(() => new Promise<boolean>((resolve) => {
    if (finishResolver.current) { resolve(false); return; }
    finishResolver.current = resolve; setFinishError(""); setFinishPrompt(true);
  }), []);

  useEffect(() => {
    if (!beforeEndRef) return;
    const guard = async () => {
      if (!isHost) return true;
      try {
        const data = await request<Envelope>(`${path}?clientId=${encodeURIComponent(clientId)}`);
        accept(data);
        if (!data.session || (!data.session.active && data.session.saveDecision)) return true;
        return await askFinish();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Não foi possível conferir o salvamento do estúdio.");
        openRef.current(); return false;
      }
    };
    beforeEndRef.current = guard;
    return () => { if (beforeEndRef.current === guard) beforeEndRef.current = null; };
  }, [accept, askFinish, beforeEndRef, clientId, isHost, path, request]);

  useEffect(() => { if (finishPrompt) finishDialogRef.current?.focus(); }, [finishPrompt]);

  function resolveFinish(value: boolean) {
    setFinishPrompt(false); finishResolver.current?.(value); finishResolver.current = null;
  }

  async function finish(save: boolean) {
    if (busyRef.current || noraBusy) return;
    busyRef.current = true; setBusy(true); setFinishError("");
    try {
      accept(await request<Envelope>(`${path}/finish`, { method: "POST", body: JSON.stringify({ clientId, save }) }));
      resolveFinish(true);
    } catch (reason) { setFinishError(reason instanceof Error ? reason.message : "Não foi possível salvar. A reunião continua aberta."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function askNora(repeated?: { requestId: string; action: string; instruction: string }) {
    if (noraBusy || busyRef.current) return;
    const payload = repeated || { requestId: crypto.randomUUID(), action: noraAction, instruction: noraPrompt };
    setNoraBusy(true); setError("");
    try {
      accept(await request<Envelope>(`${path}/nora`, { method: "POST", timeoutMs: 90000, body: JSON.stringify({ ...payload, clientId }) }));
      setNoraRetry(null); setNoraPrompt("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível consultar a Nora.");
      setNoraRetry(reason instanceof ApiError && [402, 403, 422].includes(reason.status) ? null : payload);
    } finally { setNoraBusy(false); }
  }

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

  const locked = !session?.active || busy || !!retry || !!syncError || finishPrompt;
  const editDraft = (change: Partial<Draft>) => { setDraft((current) => current ? { ...current, ...change } : current); setDirty(true); };
  const chooseNode = (node: StudioNode) => {
    if (dirty && draft?.id !== node.id) { setError("Salve ou descarte seu rascunho antes de selecionar outro cartão."); return; }
    if (draft?.id !== node.id) { setDraft(draftFrom(node)); setDirty(false); setComment(""); setError(""); }
    setMobileInspector(true);
    setNoraOpen(false);
  };

  return <><section className="team-call-studio" style={{ display: visible ? undefined : "none" }} aria-label="Estúdio da chamada">
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
        <button type="button" aria-pressed={noraOpen} onClick={() => { setNoraOpen((open) => !open); setMobileInspector(true); }}><Bot size={16} /> Nora</button>
        {isHost && <button type="button" disabled={busy || !!retry || !!syncError || noraBusy} onClick={() => session.active ? void askFinish() : void start(true)}>{session.active ? "Encerrar estúdio" : "Reabrir estúdio"}</button>}
      </div>
      {session.saveDecision === "saved" && <p className="px-3" role="status">Sessão salva no Estúdio da equipe, incluindo as contribuições da Nora.</p>}
      <div className="team-call-studio-mobile-tabs"><button type="button" aria-pressed={!mobileInspector} onClick={() => setMobileInspector(false)}>Quadro</button><button type="button" aria-pressed={mobileInspector && !noraOpen} disabled={!draft} onClick={() => { setMobileInspector(true); setNoraOpen(false); }}>Editar cartão</button></div>
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
          <div style={{ display: noraOpen ? undefined : "none" }}>
            <h3>Nora na reunião</h3><p>A Nora usa o conteúdo do quadro. Os pedidos e respostas ficam visíveis para os participantes, e cada resposta entra como um cartão.</p>
            {!canUseNora && <p>Sua conta pode acompanhar as respostas. Para fazer pedidos, o administrador precisa liberar a Nora.</p>}
            {session.noraMessages?.map((message) => <article key={message.requestKey} className="team-call-studio-comment"><strong>{message.authorName}</strong><p>{message.instruction}</p><strong>Nora</strong><NoraMarkdown text={message.response} /></article>)}
            <form onSubmit={(event) => { event.preventDefault(); void askNora(); }}>
              <label>Ação da Nora<select value={noraAction} disabled={noraBusy || !!noraRetry} onChange={(event) => setNoraAction(event.target.value)}><option value="perguntar">Fazer um pedido</option><option value="resumir">Resumir o quadro</option><option value="gerar_ideias">Gerar ideias</option><option value="proximos_passos">Definir próximos passos</option></select></label>
              <label>Pedido para a Nora<textarea aria-label="Pedido para a Nora" rows={3} maxLength={2000} value={noraPrompt} disabled={noraBusy || !!noraRetry} onChange={(event) => setNoraPrompt(event.target.value)} /></label>
              <p>O consumo utiliza o saldo de IA de quem fizer o pedido.</p>
              <button type="submit" disabled={locked || !canUseNora || noraBusy || !!noraRetry || (noraAction === "perguntar" && !noraPrompt.trim())}>{noraBusy ? "Nora está preparando a resposta…" : "Pedir à Nora"}</button>
              {noraRetry && <button type="button" disabled={locked || noraBusy} onClick={() => void askNora(noraRetry)}>Tentar Nora novamente</button>}
              {noraRetry && <button type="button" disabled={noraBusy} onClick={() => setNoraRetry(null)}>Editar pedido</button>}
            </form>
          </div>
          <div style={{ display: noraOpen ? "none" : undefined }}>
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
          </div>
        </aside>
      </div>
    </>}
  </section>{finishPrompt && createPortal(<div className="team-call-studio-finish-backdrop"><div ref={finishDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="call-studio-save-title" className="team-call-studio team-call-studio-finish" onKeyDown={(event) => {
    if (event.key === "Escape" && !busy) resolveFinish(false);
    if (event.key === "Tab") { const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")); const first = buttons[0], last = buttons.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}><h2 id="call-studio-save-title">Salvar esta sessão no Estúdio?</h2><p>O quadro, os comentários, os votos e as contribuições da Nora ficarão disponíveis no Estúdio para os membros da equipe com acesso a ele.</p><p>Sem salvar, a sessão não será adicionada à biblioteca do Estúdio.</p>{dirty && <p role="alert">Você tem um rascunho não salvo. Cancele para salvar o cartão antes de guardar a sessão.</p>}{noraBusy && <p role="status">Aguarde a Nora concluir a resposta.</p>}{finishError && <p role="alert">{finishError}</p>}<div className="team-call-studio-tools"><button type="button" disabled={busy || dirty || !!retry || noraBusy} onClick={() => void finish(true)}>Salvar no Estúdio e encerrar</button><button type="button" disabled={busy || noraBusy} onClick={() => void finish(false)}>Encerrar sem salvar</button><button type="button" disabled={busy} onClick={() => resolveFinish(false)}>Cancelar</button></div></div></div>, document.body)}</>;
}
