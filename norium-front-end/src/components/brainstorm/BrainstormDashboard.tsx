import AvatarImage from "../profile/AvatarImage";
import { ProfilePeople } from "../profile/ProfilePeople";
import IdeaCard, { type IdeaComment, type IdeaData, type IdeaNode, type IdeaVariant } from "./StudioIdeaNode";
import "../../styles/screens/trabalho-comum.css";
import "../../styles/screens/estudio.css";
import { NoraMarkdown } from "../nora/NoraResponseContent";
import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  Clock3,
  Copy,
  FileSignature,
  FileText,
  FolderOpen,
  Frame,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  LockKeyhole,
  Loader2,
  MessageSquareText,
  MousePointer2,
  PanelRight,
  Plus,
  Save,
  Search,
  Share2,
  Settings2,
  Shapes,
  Sparkles,
  StickyNote,
  TextCursorInput,
  ThumbsUp,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AuthSession, NoriumUser } from "../../types/auth";
import { apiBaseUrl, authenticatedWebSocketUrl, authToken, wsBaseUrl } from "../../utils/api";
import { showConfirm } from "../shared/AppDialogProvider";
import StudioTemplates, { type StudioSessionForm } from "./StudioTemplates";
import { STUDIO_TEMPLATES, studioTemplateTitle } from "./studioTemplateCatalog";


type BrainstormPanel = "ideas" | "session" | "notes" | "participants" | "files" | "templates" | "reports" | "settings";



type BrainstormSession = {
  id: string;
  title: string;
  objective: string;
  template: string;
  status: "ativo" | "encerrado" | "arquivado";
  responsibleId: string;
  responsibleName: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  nodeCount?: number;
  edgeCount?: number;
  timer?: { durationMinutes: number; endsAt?: string | null; running?: boolean; finishedAt?: string | null };
  board?: { nodes: IdeaNode[]; edges: Edge[]; viewport?: { x: number; y: number; zoom: number } };
  history?: Array<{ id: string; action: string; detail: string; actorName: string; timestamp: string }>;
};

type Presence = { id: string; name: string; photoUrl?: string };

const NOTE_COLORS = ["#fef3c7", "#dbeafe", "#dcfce7", "#fce7f3", "#ede9fe", "#ffedd5"];
const EDGE_COLOR = "#8b909b";
const API = apiBaseUrl();

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "agora";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

const nodeTypes = { idea: IdeaCard };

function avatarFallback(name: string) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return initials || "N";
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = String(init?.method || "GET").toUpperCase();
  const attempts = method === "GET" ? 3 : 1;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers || {}) },
      });
      const data = await response.json().catch(() => ({}));
      const transientFailure = [408, 429, 502, 503, 504].includes(response.status);

      if (!response.ok && transientFailure && attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 650 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(data?.detail || "Falha ao acessar o Estúdio.");
      return data as T;
    } catch (requestError) {
      lastError = requestError instanceof Error ? requestError : new Error("Falha ao acessar o Estúdio.");
      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 650 * (attempt + 1)));
        continue;
      }
    }
  }

  throw lastError || new Error("Falha ao acessar o Estúdio.");
}

async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Falha ao ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

function BoardEditor({ sessionId, authSession, onBack }: { sessionId: string; authSession: AuthSession; onBack: () => void }) {
  const [session, setSession] = useState<BrainstormSession | null>(null);
  const [nodes, setNodes] = useState<IdeaNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<NoriumUser[]>([authSession.user]);
  const [presence, setPresence] = useState<Record<string, Presence>>({ [authSession.user.id]: { id: authSession.user.id, name: authSession.user.nome, photoUrl: authSession.user.fotoUrl } });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [search, setSearch] = useState("");
  const [comment, setComment] = useState("");
  const [noraResult, setNoraResult] = useState("");
  const [noraLoading, setNoraLoading] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<BrainstormPanel>("session");
  const [timerNow, setTimerNow] = useState(Date.now());
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(() => window.innerWidth >= 1280);
  const [endAlertOpen, setEndAlertOpen] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef(`client_${crypto.randomUUID()}`);
  const remoteUpdateRef = useRef(false);
  const timerEndHandledRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId) || null, [nodes, selectedId]);
  const boardLocked = useMemo(() => {
    if (!session || session.status !== "ativo") return true;
    if (!session.timer?.running || !session.timer.endsAt) return false;
    return new Date(session.timer.endsAt).getTime() <= timerNow;
  }, [session, timerNow]);

  const loadSession = useCallback(async () => {
    setError("");
    try {
      const data = await jsonRequest<BrainstormSession>(`/api/brainstorm/sessions/${sessionId}`);
      setSession(data);
      setNodes(Array.isArray(data.board?.nodes) ? data.board!.nodes : []);
      setEdges(Array.isArray(data.board?.edges) ? data.board!.edges : []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao abrir a sessão.");
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSession();
    void jsonRequest<{ users: NoriumUser[] }>("/api/auth/users")
      .then((data) => setMembers(data.users || [authSession.user]))
      .catch(() => undefined);
  }, [authSession.user, loadSession]);

  useEffect(() => {
    const timer = window.setInterval(() => setTimerNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const token = authToken();
    if (!token) return undefined;
    let cancelled = false;
    let socket: WebSocket | null = null;
    void authenticatedWebSocketUrl(`${wsBaseUrl()}/api/brainstorm/ws/${encodeURIComponent(sessionId)}`, token).then((socketUrl) => {
      if (cancelled) return;
      socket = new WebSocket(socketUrl);
      socketRef.current = socket;
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "BOARD_UPDATED" && message.clientId !== clientIdRef.current && message.session) {
            remoteUpdateRef.current = true;
            setSession(message.session);
            setNodes(message.session.board?.nodes || []);
            setEdges(message.session.board?.edges || []);
            window.setTimeout(() => { remoteUpdateRef.current = false; }, 0);
          }
          if (message.type === "SESSION_UPDATED" && message.session) {
            setSession((current) => {
              if (current?.status === "ativo" && message.session.status === "encerrado") setEndAlertOpen(true);
              return message.session;
            });
          }
          if (message.type === "SESSION_LOCKED") {
            if (message.session) setSession(message.session);
            setError(message.detail || "O tempo terminou e o quadro foi bloqueado.");
            setEndAlertOpen(true);
          }
          if (message.type === "PRESENCE_JOIN" && message.participant) {
            setPresence((current) => ({ ...current, [message.participant.id]: message.participant }));
          }
          if (message.type === "PRESENCE_LEAVE" && message.participant) {
            setPresence((current) => {
              const next = { ...current };
              delete next[message.participant.id];
              return next;
            });
          }
        } catch {
          // Ignore envelopes from older socket clients.
        }
      };
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      socket?.close();
      socketRef.current = null;
    };
  }, [sessionId]);

  const persistBoard = useCallback(async (nextNodes: IdeaNode[], nextEdges: Edge[], detail = "Quadro atualizado") => {
    if (remoteUpdateRef.current) return;
    if (boardLocked) {
      setError("O tempo terminou. Esta sessão está em modo somente leitura.");
      return;
    }
    setSaving(true);
    setError("");
    const board = { nodes: nextNodes, edges: nextEdges, viewport: session?.board?.viewport || { x: 0, y: 0, zoom: 1 } };
    try {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "BOARD_UPDATE", board, clientId: clientIdRef.current, detail }));
        setSavedAt(new Date().toISOString());
      } else {
        const updated = await jsonRequest<BrainstormSession>(`/api/brainstorm/sessions/${sessionId}/board`, {
          method: "PUT",
          body: JSON.stringify({ ...board, clientId: clientIdRef.current }),
        });
        setSession(updated);
        setSavedAt(new Date().toISOString());
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao salvar o quadro.");
    } finally {
      setSaving(false);
    }
  }, [boardLocked, session?.board?.viewport, sessionId]);

  const onNodesChange = useCallback((changes: NodeChange<IdeaNode>[]) => {
    if (boardLocked) return;
    setNodes((current) => applyNodeChanges(changes, current));
  }, [boardLocked]);

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    if (boardLocked) return;
    setEdges((current) => applyEdgeChanges(changes, current));
  }, [boardLocked]);

  const onConnect = useCallback((connection: Connection) => {
    if (boardLocked) return;
    setEdges((current) => {
      const next = addEdge({ ...connection, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: EDGE_COLOR, strokeWidth: 1.5 } }, current);
      void persistBoard(nodes, next, "Conexão criada");
      return next;
    });
  }, [boardLocked, nodes, persistBoard]);

  function addIdea(variant: IdeaVariant) {
    if (boardLocked) return;
    const index = nodes.length;
    const node: IdeaNode = {
      id: `idea_${crypto.randomUUID()}`,
      type: "idea",
      position: { x: 120 + ((index % 4) * 250), y: 100 + (Math.floor(index / 4) * 180) },
      data: {
        label: variant === "frame" ? "Novo agrupamento" : variant === "text" ? "Novo texto" : variant === "shape" ? "Novo bloco" : "Nova ideia",
        color: NOTE_COLORS[index % NOTE_COLORS.length],
        variant,
        category: "geral",
        tags: [],
        comments: [],
        votes: [],
      },
      style: variant === "frame" ? { width: 420, height: 260 } : undefined,
    };
    const next = [...nodes, node];
    setNodes(next);
    setSelectedId(node.id);
    void persistBoard(next, edges, "Ideia adicionada");
  }

  function updateSelected(patch: Partial<IdeaData>, save = false) {
    if (boardLocked) return;
    const next = nodes.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node);
    setNodes(next);
    if (save) void persistBoard(next, edges, "Ideia editada");
  }

  function deleteSelected() {
    if (boardLocked) return;
    if (!selectedId) return;
    const nextNodes = nodes.filter((node) => node.id !== selectedId);
    const nextEdges = edges.filter((edge) => edge.source !== selectedId && edge.target !== selectedId);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedId(null);
    void persistBoard(nextNodes, nextEdges, "Ideia removida");
  }

  function duplicateSelected() {
    if (boardLocked) return;
    if (!selectedNode) return;
    const duplicate: IdeaNode = { ...selectedNode, id: `idea_${crypto.randomUUID()}`, position: { x: selectedNode.position.x + 40, y: selectedNode.position.y + 40 }, selected: false, data: { ...selectedNode.data, votes: [], comments: [] } };
    const next = [...nodes, duplicate];
    setNodes(next);
    setSelectedId(duplicate.id);
    void persistBoard(next, edges, "Ideia duplicada");
  }

  function addComment() {
    if (boardLocked) return;
    if (!selectedNode || !comment.trim()) return;
    const nextComment: IdeaComment = { id: `comment_${crypto.randomUUID()}`, authorId: authSession.user.id, authorName: authSession.user.nome, text: comment.trim(), timestamp: new Date().toISOString() };
    updateSelected({ comments: [...(selectedNode.data.comments || []), nextComment] }, true);
    setComment("");
  }

  function toggleVote() {
    if (boardLocked) return;
    if (!selectedNode) return;
    const current = selectedNode.data.votes || [];
    const nextVotes = current.includes(authSession.user.id) ? current.filter((id) => id !== authSession.user.id) : [...current, authSession.user.id];
    updateSelected({ votes: nextVotes }, true);
  }

  function clusterIdeas() {
    if (boardLocked) return;
    const groups = new Map<string, IdeaNode[]>();
    nodes.filter((node) => node.data.variant !== "frame").forEach((node) => {
      const key = node.data.category || "geral";
      groups.set(key, [...(groups.get(key) || []), node]);
    });
    const next: IdeaNode[] = [];
    let groupIndex = 0;
    groups.forEach((items) => {
      items.forEach((node, itemIndex) => {
        next.push({ ...node, position: { x: 140 + (groupIndex * 340), y: 120 + (itemIndex * 155) } });
      });
      groupIndex += 1;
    });
    const frames = nodes.filter((node) => node.data.variant === "frame");
    const arranged = [...frames, ...next];
    setNodes(arranged);
    void persistBoard(arranged, edges, "Ideias agrupadas por categoria");
  }

  async function convertTask() {
    if (boardLocked) return;
    if (!selectedNode) return;
    try {
      await jsonRequest(`/api/brainstorm/sessions/${sessionId}/convert-task`, { method: "POST", body: JSON.stringify({ nodeId: selectedNode.id, projectId: "default", projectName: "Operação Norium", priority: "media" }) });
      setNoraResult(`A ideia “${selectedNode.data.label}” virou uma tarefa pendente no Kanban.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao criar tarefa.");
    }
  }

  async function askNora(action: "resumir" | "gerar_ideias" | "proximos_passos" | "analisar_impacto") {
    setNoraLoading(true);
    setNoraResult("");
    try {
      const data = await jsonRequest<{ response: string }>(`/api/brainstorm/sessions/${sessionId}/nora`, { method: "POST", body: JSON.stringify({ action, instruction: "" }) });
      setNoraResult(data.response);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao consultar a Nora.");
    } finally {
      setNoraLoading(false);
    }
  }

  function openInspector(mode: BrainstormPanel) {
    setInspectorMode(mode);
    setSelectedId(null);
    setMobileInspectorOpen(true);
  }

  function addTemplate(template: "mapa-mental" | "swot" | "jornada" | "retrospectiva") {
    if (boardLocked) return;
    const presets: Record<typeof template, string[]> = {
      "mapa-mental": ["Tema central", "Hipótese 1", "Hipótese 2", "Hipótese 3"],
      swot: ["Forças", "Fraquezas", "Oportunidades", "Ameaças"],
      jornada: ["Descoberta", "Consideração", "Decisão", "Adoção"],
      retrospectiva: ["Funcionou bem", "Pode melhorar", "Aprendizados", "Próximas ações"],
    };
    const created = presets[template].map<IdeaNode>((label, index) => ({
      id: `idea_${crypto.randomUUID()}`,
      type: "idea",
      position: { x: 150 + ((index % 2) * 330), y: 140 + (Math.floor(index / 2) * 210) },
      data: { label, color: NOTE_COLORS[index % NOTE_COLORS.length], variant: "sticky", category: template, tags: ["modelo"], comments: [], votes: [] },
    }));
    const next = [...nodes, ...created];
    setNodes(next);
    setInspectorMode("ideas");
    setMobileInspectorOpen(false);
    void persistBoard(next, edges, `Modelo ${template} adicionado`);
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length || boardLocked) return;
    const accepted = Array.from(files).filter((file) => file.size <= 2 * 1024 * 1024).slice(0, 5);
    if (accepted.length !== files.length) setError("Cada arquivo do Estúdio deve ter no máximo 2 MB; até cinco arquivos são aceitos por vez.");
    const created = await Promise.all(accepted.map(async (file, index): Promise<IdeaNode> => ({
      id: `idea_${crypto.randomUUID()}`,
      type: "idea",
      position: { x: 160 + ((nodes.length + index) % 3) * 280, y: 140 + Math.floor((nodes.length + index) / 3) * 190 },
      data: {
        label: file.name,
        description: `${file.type || "Arquivo"} · ${(file.size / 1024).toFixed(1)} KB`,
        color: "#dbeafe",
        variant: "sticky",
        category: "arquivo",
        tags: ["anexo"],
        comments: [],
        votes: [],
        file: { name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, dataUrl: await fileToDataUrl(file) },
      },
    })));
    if (!created.length) return;
    const next = [...nodes, ...created];
    setNodes(next);
    setSelectedId(created[0].id);
    setInspectorMode("files");
    void persistBoard(next, edges, `${created.length} arquivo(s) anexado(s)`);
  }

  function downloadBoardReport() {
    const report = {
      session: { title: session?.title, objective: session?.objective, responsible: session?.responsibleName },
      generatedAt: new Date().toISOString(),
      ideas: nodes.map((node) => ({ title: node.data.label, description: node.data.description, category: node.data.category, votes: node.data.votes?.length || 0, comments: node.data.comments?.length || 0, responsible: node.data.responsibleName || null })),
      connections: edges.map((edge) => ({ source: edge.source, target: edge.target })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `brainstorm-${String(session?.title || "sessao").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function toggleTimer() {
    if (!session || boardLocked) return;
    const running = Boolean(session.timer?.running);
    const durationMinutes = session.timer?.durationMinutes || 15;
    const timer = running
      ? { ...session.timer, running: false, endsAt: null }
      : { durationMinutes, running: true, endsAt: new Date(Date.now() + durationMinutes * 60_000).toISOString() };
    const updated = await jsonRequest<BrainstormSession>(`/api/brainstorm/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ timer }) });
    setSession(updated);
  }

  const remainingSeconds = useMemo(() => {
    if (!session?.timer?.running || !session.timer.endsAt) return null;
    return Math.max(0, Math.floor((new Date(session.timer.endsAt).getTime() - timerNow) / 1000));
  }, [session?.timer, timerNow]);

  useEffect(() => {
    if (remainingSeconds !== 0 || !session?.timer?.running || timerEndHandledRef.current) return;
    timerEndHandledRef.current = true;
    const endedTimer = { ...session.timer, running: false, finishedAt: new Date().toISOString() };
    setSession((current) => current ? { ...current, status: "encerrado", timer: endedTimer } : current);
    setEndAlertOpen(true);
    void jsonRequest<BrainstormSession>(`/api/brainstorm/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "encerrado", timer: endedTimer }),
    }).then(setSession).catch((requestError) => {
      setError(requestError instanceof Error ? requestError.message : "Falha ao encerrar a sessão.");
      void loadSession();
    });
  }, [loadSession, remainingSeconds, session?.timer, sessionId]);

  const filteredNodeIds = useMemo(() => {
    const value = search.trim().toLowerCase();
    if (!value) return new Set<string>();
    return new Set(nodes.filter((node) => `${node.data.label} ${node.data.category} ${(node.data.tags || []).join(" ")}`.toLowerCase().includes(value)).map((node) => node.id));
  }, [nodes, search]);

  if (!session) {
    return <div className="nxw-screen nxs-loading">{error ? <div className="nxw-alert is-error"><span>{error}</span></div> : <Loader2 className="nxw-spin" />}</div>;
  }

  const panelModes: Array<[BrainstormPanel, string]> = [
    ["ideas", "Ideias"],
    ["session", "Sessão"],
    ["notes", "Notas"],
    ["participants", "Pessoas"],
    ["files", "Arquivos"],
    ["templates", "Modelos"],
    ["reports", "Relatórios"],
    ["settings", "Configurações"],
  ];
  const rankedIdeas = nodes.filter((node) => node.data.variant !== "frame").slice().sort((a, b) => (b.data.votes?.length || 0) - (a.data.votes?.length || 0));
  const statusLabel = boardLocked ? (session.status === "arquivado" ? "Sessão arquivada" : "Sessão encerrada") : "Sessão ativa";

  return (
    <ProfilePeople people={members}><div className="nxw-screen nxs-editor">
      {error && <div className="nxw-alert is-error nxs-editor-alert"><span>{error}</span></div>}
      {boardLocked && <div className="nxw-alert is-warning nxs-editor-alert"><LockKeyhole size={16} /><span>Sessão encerrada. O quadro está bloqueado para novas ideias, votos, comentários e alterações.</span></div>}

      <div className="nxs-body">
        <section className="nxs-canvas">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { void importFiles(event.target.files); event.currentTarget.value = ""; }} />
          <div className="nxs-floatbar">
            <div className="nxs-floatbar-row">
              <button type="button" className="nxw-icon-btn" onClick={onBack} title="Voltar às sessões" aria-label="Voltar às sessões"><ArrowLeft size={16} /></button>
              <div className="nxs-title">
                <h1>{session.title}</h1>
                <p>Responsável: {session.responsibleName}{savedAt ? ` · salvo ${formatDate(savedAt)}` : ""}</p>
              </div>
              <span className={`nx-badge ${boardLocked ? "is-amber" : "is-green"}`}>{statusLabel}</span>
              <button type="button" disabled={boardLocked} onClick={toggleTimer} className={`nx-badge nxs-timer ${session.timer?.running && !boardLocked ? "is-amber" : ""}`} title={session.timer?.running ? "Pausar timer" : "Iniciar timer"}>
                {boardLocked ? <LockKeyhole size={12} /> : <Timer size={12} />} {boardLocked ? "Encerrado" : remainingSeconds === null ? `${session.timer?.durationMinutes || 15} min` : `${String(Math.floor(remainingSeconds / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`}
              </button>
              <span className="nxs-saving" title={saving ? "Salvando" : "Salvo"}>{saving ? <Loader2 size={13} className="nxw-spin" /> : <Save size={13} />}</span>
              <div className="nxs-presence">
                {Object.values(presence).slice(0, 5).map((person) => person.photoUrl ? <img key={person.id} src={person.photoUrl} title={`${person.name} online`} alt="" /> : <span key={person.id} title={`${person.name} online`}>{avatarFallback(person.name)}</span>)}
              </div>
              <span className="nxs-floatbar-tools">
                <button type="button" disabled={boardLocked} onClick={() => addIdea("sticky")} className="nxw-icon-btn" title="Adicionar post-it" aria-label="Adicionar post-it"><StickyNote size={16} /></button>
                <button type="button" disabled={boardLocked} onClick={() => addIdea("text")} className="nxw-icon-btn" title="Adicionar texto" aria-label="Adicionar texto"><TextCursorInput size={16} /></button>
                <button type="button" disabled={boardLocked} onClick={() => addIdea("shape")} className="nxw-icon-btn" title="Adicionar bloco" aria-label="Adicionar bloco"><Shapes size={16} /></button>
                <button type="button" disabled={boardLocked} onClick={() => addIdea("frame")} className="nxw-icon-btn" title="Adicionar seção" aria-label="Adicionar seção"><Frame size={16} /></button>
                <button type="button" disabled={boardLocked} onClick={clusterIdeas} className="nxw-icon-btn" title="Agrupar por categoria" aria-label="Agrupar por categoria"><LayoutGrid size={16} /></button>
              </span>
              <button type="button" className="nx-btn is-sm" disabled={boardLocked} onClick={() => void persistBoard(nodes, edges)}><Save size={14} /> Salvar</button>
              <button type="button" className="nx-btn is-sm is-primary" onClick={() => { openInspector("ideas"); void askNora("gerar_ideias"); }}><Sparkles size={14} /> Sugerir ideias</button>
              {!mobileInspectorOpen && <button type="button" className="nxw-icon-btn" onClick={() => setMobileInspectorOpen(true)} title="Abrir painel" aria-label="Abrir painel"><PanelRight size={16} /></button>}
            </div>
            <div className="nxs-floatbar-row">
              <label className="nx-input nxs-search">
                <Search size={14} className="nx-faint" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar ideia, categoria ou tag" />
              </label>
              <span className="nx-badge">{nodes.length} itens · {edges.length} conexões</span>
            </div>
          </div>
          <ReactFlow<IdeaNode, Edge>
            nodes={nodes.map((node) => filteredNodeIds.size && filteredNodeIds.has(node.id) ? { ...node, className: "brainstorm-search-hit" } : node)}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
              setSelectedId(node.id);
              setInspectorMode("ideas");
              setMobileInspectorOpen(true);
            }}
            onPaneClick={() => setSelectedId(null)}
            onNodeDragStop={() => void persistBoard(nodes, edges, "Ideia reposicionada")}
            nodesDraggable={!boardLocked}
            nodesConnectable={!boardLocked}
            edgesReconnectable={!boardLocked}
            elevateNodesOnSelect={false}
            fitView
            minZoom={0.15}
            maxZoom={2.5}
            deleteKeyCode={null}
            defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: EDGE_COLOR, strokeWidth: 1.5 } }}
          >
            <Background variant={BackgroundVariant.Dots} color="var(--nx-border-strong)" gap={22} size={1.2} />
            <Controls className="nxs-controls" />
            <MiniMap pannable zoomable className="nxs-minimap" nodeColor={(node) => String((node.data as IdeaData)?.color || "#dbeafe")} />
          </ReactFlow>
        </section>

        {mobileInspectorOpen && <button type="button" aria-label="Fechar propriedades" onClick={() => setMobileInspectorOpen(false)} className="nxs-panel-backdrop" />}
        <aside className={`nxs-panel ${mobileInspectorOpen ? "is-open" : ""}`}>
          <button type="button" onClick={() => setMobileInspectorOpen(false)} className="nxw-icon-btn is-sm is-plain nxs-panel-close" title="Fechar propriedades" aria-label="Fechar propriedades"><X size={16} /></button>
          <nav className="nx-tabs nxs-panel-tabs" aria-label="Painéis do quadro">
            {panelModes.map(([mode, label]) => (
              <button key={mode} type="button" onClick={() => openInspector(mode)} className={`nx-tab ${inspectorMode === mode && !selectedNode ? "is-active" : ""}`} title={label} aria-label={label}>{label}</button>
            ))}
          </nav>
          {selectedNode ? (
            <fieldset disabled={boardLocked} className="nxs-stack nxs-fieldset">
              <header className="nxs-panel-h"><div className="nx-grow"><p className="nxs-eyebrow">Item selecionado</p><h2>Editar ideia</h2></div><button type="button" onClick={duplicateSelected} className="nxw-icon-btn is-sm" title="Duplicar" aria-label="Duplicar"><Copy size={15} /></button><button type="button" onClick={deleteSelected} className="nxw-icon-btn is-sm nxs-danger" title="Excluir" aria-label="Excluir"><Trash2 size={15} /></button></header>
              <label className="nxw-label"><span>Título</span><textarea className="nxw-field" value={selectedNode.data.label} onChange={(event) => updateSelected({ label: event.target.value })} onBlur={() => void persistBoard(nodes, edges, "Texto da ideia editado")} rows={3} /></label>
              <label className="nxw-label"><span>Descrição</span><textarea className="nxw-field" value={selectedNode.data.description || ""} onChange={(event) => updateSelected({ description: event.target.value })} onBlur={() => void persistBoard(nodes, edges, "Descrição editada")} rows={3} /></label>
              <div><p className="nxw-label" style={{ marginBottom: 8 }}>Cor</p><div className="nxs-colors">{NOTE_COLORS.map((color) => <button type="button" key={color} onClick={() => updateSelected({ color }, true)} className={selectedNode.data.color === color ? "is-active" : ""} style={{ background: color }} title={color} aria-label={color} />)}</div></div>
              <label className="nxw-label"><span>Categoria</span><input className="nxw-field" value={selectedNode.data.category || ""} onChange={(event) => updateSelected({ category: event.target.value })} onBlur={() => void persistBoard(nodes, edges, "Categoria editada")} placeholder="Ex.: produto, marketing" /></label>
              <label className="nxw-label"><span>Responsável</span><select className="nxw-field" value={selectedNode.data.responsibleId || ""} onChange={(event) => { const member = members.find((item) => item.id === event.target.value); updateSelected({ responsibleId: member?.id || "", responsibleName: member?.nome || "" }, true); }}><option value="">A definir</option>{members.map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}</select></label>
              <label className="nxw-label"><span>Prazo</span><input className="nxw-field" type="date" value={selectedNode.data.dueDate || ""} onChange={(event) => updateSelected({ dueDate: event.target.value }, true)} /></label>
              <label className="nxs-check"><input type="checkbox" checked={Boolean(selectedNode.data.completed)} onChange={(event) => updateSelected({ completed: event.target.checked }, true)} /> Item concluído</label>
              {selectedNode.data.file && <a href={selectedNode.data.file.dataUrl} download={selectedNode.data.file.name} className="nx-btn is-sm"><FolderOpen size={14} /> Baixar {selectedNode.data.file.name}</a>}
              <div className="nxs-grid-2"><button type="button" onClick={toggleVote} className="nx-btn is-sm"><ThumbsUp size={14} /> Votar ({selectedNode.data.votes?.length || 0})</button><button type="button" onClick={() => void convertTask()} className="nx-btn is-sm"><ListChecks size={14} /> Virar tarefa</button></div>
              <section className="nxs-section"><h3><MessageSquareText size={15} /> Comentários</h3><div className="nxs-stack-sm">{(selectedNode.data.comments || []).map((item) => <article key={item.id} className="nxw-action"><div className="nxs-comment-h"><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><AvatarImage userId={item.authorId} name={item.authorName} size={24}/>{item.authorName}</span><time>{formatDate(item.timestamp)}</time></div><p>{item.text}</p></article>)}</div><div className="nxs-comment-form"><input className="nxw-field" value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addComment(); }} placeholder="Comentar..." /><button type="button" className="nxw-icon-btn nxs-primary-icon" onClick={addComment} aria-label="Adicionar comentário"><Plus size={16} /></button></div></section>
            </fieldset>
          ) : (
            <div className="nxs-stack">
              {(inspectorMode === "session" || inspectorMode === "ideas") && <div><p className="nxs-eyebrow">Sessão</p><h2 className="nxs-h2">{session.title}</h2><p className="nxs-text">{session.objective || "Sem objetivo descrito."}</p></div>}

              {inspectorMode === "ideas" && <section className="nxs-stack-sm">
                {rankedIdeas.length === 0 && <p className="nxs-text">Nenhuma ideia no quadro ainda.</p>}
                {rankedIdeas.slice(0, 12).map((node) => <button type="button" key={node.id} onClick={() => setSelectedId(node.id)} className="nxw-action nxs-idea-row"><span className="nx-grow nx-ell">{node.data.label || "Nova ideia"}</span><span className="nx-badge is-blue"><ThumbsUp size={11} />{node.data.votes?.length || 0}</span></button>)}
                {rankedIdeas.length > 12 && <p className="nx-faint nx-small" style={{ margin: 0 }}>Mais {rankedIdeas.length - 12} ideia(s) no quadro.</p>}
              </section>}

              {inspectorMode === "ideas" && <section><h3 className="nxs-h3">Ferramentas de ideias</h3><p className="nxs-text">Adicione, conecte e organize elementos no quadro.</p><div className="nxs-grid-2" style={{ marginTop: 10 }}><button type="button" disabled={boardLocked} onClick={() => addIdea("sticky")} className="nx-btn is-sm"><StickyNote size={14} /> Post-it</button><button type="button" disabled={boardLocked} onClick={() => addIdea("text")} className="nx-btn is-sm"><TextCursorInput size={14} /> Texto</button><button type="button" disabled={boardLocked} onClick={() => addIdea("shape")} className="nx-btn is-sm"><Shapes size={14} /> Bloco</button><button type="button" disabled={boardLocked} onClick={clusterIdeas} className="nx-btn is-sm"><LayoutGrid size={14} /> Agrupar</button></div></section>}

              {inspectorMode === "notes" && <section><div className="nxs-panel-h"><div className="nx-grow"><p className="nxs-eyebrow">Notas</p><h2 className="nxs-h2">{nodes.filter((node) => node.data.variant === "sticky").length} post-its</h2></div><button type="button" className="nx-btn is-sm is-primary" disabled={boardLocked} onClick={() => addIdea("sticky")}><Plus size={14} /> Nova</button></div><div className="nxs-stack-sm" style={{ marginTop: 12 }}>{nodes.filter((node) => node.data.variant === "sticky").slice(0, 20).map((node) => <button type="button" key={node.id} onClick={() => { setSelectedId(node.id); setInspectorMode("notes"); }} className="nxw-action nxs-list-btn"><strong className="nx-ell">{node.data.label}</strong><small>{node.data.category || "geral"}</small></button>)}</div></section>}

              {inspectorMode === "participants" && <section><p className="nxs-eyebrow">Pessoas</p><h2 className="nxs-h2">Equipe da sessão</h2><div className="nxs-stack-sm" style={{ marginTop: 12 }}>{members.map((member) => { const online = Boolean(presence[member.id]); return <article key={member.id} className="nxw-action nxs-person"><AvatarImage src={member.fotoUrl} userId={member.id} name={member.nome} size={32}/><span className="nx-grow"><strong className="nx-ell" style={{ display: "block" }}>{member.nome}</strong><small className={online ? "nxs-online" : "nx-faint"}>{online ? "Online no quadro" : "Offline"}</small></span></article>; })}</div></section>}

              {inspectorMode === "files" && <section><div className="nxs-panel-h"><div className="nx-grow"><p className="nxs-eyebrow">Arquivos</p><h2 className="nxs-h2">Anexos do quadro</h2></div><button type="button" className="nx-btn is-sm is-primary" disabled={boardLocked} onClick={() => fileInputRef.current?.click()}><Plus size={14} /> Anexar</button></div><p className="nxs-text">Até 2 MB por arquivo. Os anexos ficam vinculados à sessão.</p><div className="nxs-stack-sm" style={{ marginTop: 12 }}>{nodes.filter((node) => node.data.file).map((node) => <button type="button" key={node.id} onClick={() => setSelectedId(node.id)} className="nxw-action nxs-person"><span className="nxw-icon is-sm"><FileText size={16} /></span><span className="nx-grow"><strong className="nx-ell" style={{ display: "block" }}>{node.data.file?.name}</strong><small className="nx-faint">{((node.data.file?.size || 0) / 1024).toFixed(1).replace(".", ",")} KB</small></span></button>)}</div></section>}

              {inspectorMode === "templates" && <section><p className="nxs-eyebrow">Modelos</p><h2 className="nxs-h2">Estruturas prontas</h2><p className="nxs-text">Adicione uma estrutura sem apagar as ideias existentes.</p><div className="nxs-stack-sm" style={{ marginTop: 12 }}>{([['mapa-mental', 'Mapa mental'], ['swot', 'Análise SWOT'], ['jornada', 'Jornada'], ['retrospectiva', 'Retrospectiva']] as const).map(([id, label]) => <button type="button" key={id} disabled={boardLocked} onClick={() => addTemplate(id)} className="nx-btn is-sm nxs-full"><BookOpen size={14} /> {label}</button>)}</div></section>}

              {inspectorMode === "reports" && <section><p className="nxs-eyebrow">Relatórios</p><h2 className="nxs-h2">Resultado da sessão</h2><div className="nxs-grid-2" style={{ marginTop: 12 }}>{[["Ideias", nodes.length], ["Conexões", edges.length], ["Votos", nodes.reduce((total, node) => total + (node.data.votes?.length || 0), 0)], ["Comentários", nodes.reduce((total, node) => total + (node.data.comments?.length || 0), 0)]].map(([label, value]) => <div key={String(label)} className="nxw-action"><small className="nx-muted nx-small">{label}</small><strong className="nxs-stat">{value}</strong></div>)}</div><button type="button" className="nx-btn is-sm nxs-full" style={{ marginTop: 12 }} onClick={downloadBoardReport}><BarChart3 size={14} /> Exportar relatório JSON</button></section>}

              {inspectorMode === "settings" && <section><p className="nxs-eyebrow">Configurações</p><h2 className="nxs-h2">Quadro e sessão</h2><div className="nxs-stack-sm" style={{ marginTop: 12 }}><button type="button" disabled={boardLocked} onClick={toggleTimer} className="nx-btn is-sm nxs-full"><Clock3 size={14} /> {session.timer?.running ? "Pausar timer" : "Iniciar timer"}</button><button type="button" disabled={boardLocked} onClick={clusterIdeas} className="nx-btn is-sm nxs-full"><LayoutGrid size={14} /> Agrupar por categoria</button><button type="button" disabled={boardLocked} onClick={() => void persistBoard(nodes, edges)} className="nx-btn is-sm nxs-full"><Save size={14} /> Salvar agora</button></div><div className="nxw-action nxs-text" style={{ marginTop: 12 }}>Status: <strong>{session.status}</strong><br />Modelo: <strong>{studioTemplateTitle(session.template)}</strong><br />Responsável: <strong>{session.responsibleName}</strong></div></section>}

              <section className="nx-card nxs-nora"><div className="nxs-nora-h"><span className="nxw-icon is-sm"><Sparkles size={15} /></span><b>Nora no quadro</b></div><p className="nxs-text">Usa somente o conteúdo real da sessão para apoiar a decisão.</p><div className="nxs-nora-actions"><button type="button" onClick={() => void askNora("resumir")} className="nx-btn is-sm"><Bot size={14} /> Resumir</button><button type="button" onClick={() => void askNora("gerar_ideias")} className="nx-btn is-sm"><Lightbulb size={14} /> Sugerir ideias</button><button type="button" onClick={() => void askNora("proximos_passos")} className="nx-btn is-sm"><ListChecks size={14} /> Próximos passos</button><button type="button" onClick={() => void askNora("analisar_impacto")} className="nx-btn is-sm"><BarChart3 size={14} /> Analisar impacto</button></div>{noraLoading && <Loader2 className="nxw-spin nxs-nora-loader" />}{noraResult && <div className="nxs-nora-result"><NoraMarkdown text={noraResult} /></div>}</section>

              {inspectorMode === "session" && <section><h3 className="nxs-h3">Histórico</h3><div className="nxs-stack-sm" style={{ marginTop: 8 }}>{(session.history || []).slice().reverse().slice(0, 8).map((item) => <div key={item.id} className="nxw-action"><p className="nxs-hist-t">{item.detail}</p><p className="nx-faint nx-small" style={{ margin: "2px 0 0" }}>{item.actorName} · {formatDate(item.timestamp)}</p></div>)}</div></section>}
            </div>
          )}
        </aside>
      </div>

      {endAlertOpen && (
        <div className="nxs-modal-backdrop">
          <section role="alertdialog" aria-modal="true" aria-labelledby="brainstorm-ended-title" className="nx-card nxs-ended">
            <span className="nxw-icon is-amber nxs-ended-icon"><AlertTriangle size={22} /></span>
            <p className="nxs-eyebrow" style={{ color: "var(--nx-warning)", marginTop: 14 }}>Tempo esgotado</p>
            <h2 id="brainstorm-ended-title" className="nxs-h2" style={{ fontSize: 20 }}>Sessão encerrada</h2>
            <p className="nxs-text">O prazo desta sessão terminou. Para preservar o resultado da equipe, o quadro agora está em modo somente leitura e nenhuma nova alteração será aceita.</p>
            <button type="button" className="nx-btn is-primary" style={{ marginTop: 18 }} onClick={() => setEndAlertOpen(false)}><LockKeyhole size={16} /> Ver resultado final</button>
          </section>
        </div>
      )}
    </div></ProfilePeople>
  );
}

export default function BrainstormDashboard({
  session,
  onNavigate,
}: {
  session: AuthSession;
  onNavigate: (tab: string) => void;
}) {
  const [sessions, setSessions] = useState<BrainstormSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [members, setMembers] = useState<NoriumUser[]>([session.user]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BrainstormSession | null>(null);
  const [savingProperties, setSavingProperties] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"todos" | BrainstormSession["status"]>("todos");

  const [editForm, setEditForm] = useState({ title: "", objective: "", responsibleId: session.user.id, template: "livre", durationMinutes: 15, status: "ativo" as BrainstormSession["status"] });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const sessionData = await jsonRequest<BrainstormSession[]>("/api/brainstorm/sessions");
      setSessions(sessionData);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao carregar sessões.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    void jsonRequest<{ users: NoriumUser[] }>("/api/auth/users")
      .then((payload) => { if (active) setMembers(payload.users || [session.user]); })
      .catch(() => { if (active) setMembers([session.user]); });
    return () => { active = false; };
  }, [session.user]);

  async function createSession(form: StudioSessionForm) {
    if (!form.title.trim()) return;
    setError("");
    const responsible = members.find((member) => member.id === form.responsibleId) || session.user;
    const created = await jsonRequest<BrainstormSession>("/api/brainstorm/sessions", { method: "POST", body: JSON.stringify({ ...form, responsibleName: responsible.nome, title: form.title.trim(), objective: form.objective.trim(), durationMinutes: Number(form.durationMinutes) }) });
    setSessions((current) => [created, ...current]);
    setCreating(false);
    setSelectedSessionId(created.id);
  }

  async function deleteSession(item: BrainstormSession) {
    const confirmed = await showConfirm({
      title: "Excluir sessão?",
      description: `A sessão "${item.title}" e todos os seus itens serão removidos. Esta ação não pode ser desfeita.`,
      confirmLabel: "Excluir sessão",
      tone: "danger",
    });
    if (!confirmed) return false;
    try {
      await jsonRequest(`/api/brainstorm/sessions/${item.id}`, { method: "DELETE" });
      setSessions((current) => current.filter((sessionItem) => sessionItem.id !== item.id));
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao excluir sessão.");
      return false;
    }
  }

  function createProposalFromSession(item: BrainstormSession) {
    window.localStorage.setItem("norium:commercial-brainstorm-id", item.id);
    window.dispatchEvent(new CustomEvent("norium:commercial-create", { detail: { brainstormId: item.id } }));
    onNavigate("Documentos");
  }

  async function shareSession(item: BrainstormSession) {
    const shareData = { title: `Estúdio: ${item.title}`, text: item.objective || "Estúdio colaborativo no Norium", url: window.location.href };
    try {
      if (navigator.share) await navigator.share(shareData);
      else await navigator.clipboard.writeText(`${shareData.title}\n${shareData.text}\n${shareData.url}`);
    } catch (shareError) {
      if ((shareError as DOMException)?.name !== "AbortError") setError("Não foi possível compartilhar esta sessão.");
    }
  }

  function openSessionProperties(item: BrainstormSession) {
    setEditing(item);
    setEditForm({
      title: item.title,
      objective: item.objective || "",
      responsibleId: item.responsibleId || session.user.id,
      template: item.template || "livre",
      durationMinutes: item.timer?.durationMinutes || 15,
      status: item.status,
    });
  }

  async function saveSessionProperties() {
    if (!editing || !editForm.title.trim()) return;
    setSavingProperties(true);
    setError("");
    try {
      const responsible = members.find((member) => member.id === editForm.responsibleId) || session.user;
      const status = editing.timer?.finishedAt ? "encerrado" : editForm.status;
      const timer = status === "ativo"
        ? { ...(editing.timer || {}), durationMinutes: Number(editForm.durationMinutes) }
        : { ...(editing.timer || {}), durationMinutes: Number(editForm.durationMinutes), running: false, endsAt: null };
      const updated = await jsonRequest<BrainstormSession>(`/api/brainstorm/sessions/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: editForm.title.trim(),
          objective: editForm.objective.trim(),
          responsibleId: responsible.id,
          responsibleName: responsible.nome,
          template: editForm.template,
          status,
          timer,
        }),
      });
      setSessions((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
      setEditing(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao atualizar as propriedades.");
    } finally {
      setSavingProperties(false);
    }
  }

  const sessionStats = useMemo(() => ({
    total: sessions.length,
    active: sessions.filter((item) => item.status === "ativo").length,
    finished: sessions.filter((item) => item.status === "encerrado").length,
    ideas: sessions.reduce((total, item) => total + Number(item.nodeCount || 0), 0),
  }), [sessions]);

  const filteredSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return sessions.filter((item) => {
      if (statusFilter !== "todos" && item.status !== statusFilter) return false;
      if (!normalized) return true;
      return [item.title, item.objective, item.responsibleName, item.template]
        .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(normalized));
    });
  }, [query, sessions, statusFilter]);

  if (selectedSessionId) return <BoardEditor sessionId={selectedSessionId} authSession={session} onBack={() => { setSelectedSessionId(null); void load(); }} />;

  return (
    <ProfilePeople people={members}><div className="nx-page nxw-screen nxs-page h-full overflow-y-auto">
      <header className="nx-ph">
        <div><h1>Estúdio</h1><p>Um espaço para organizar ideias e transformar decisões em entregas</p></div>
        <div className="nx-ph-actions"><button type="button" className="nx-btn is-primary" onClick={() => setCreating(true)}><Plus size={16} />Nova sessão</button></div>
      </header>

      {error && <div className="nxw-alert is-error"><span>{error}</span></div>}

      <section className="nx-kpis" aria-label="Resumo do Estúdio">
        {[
          ["Sessões", sessionStats.total, "Todos os quadros"],
          ["Ativas", sessionStats.active, "Colaboração em andamento"],
          ["Encerradas", sessionStats.finished, "Resultados bloqueados"],
          ["Ideias", sessionStats.ideas, "Itens registrados"],
        ].map(([label, value, detail]) => (
          <article key={String(label)} className="nx-card nx-kpi">
            <div className="nx-kpi-l">{label}</div>
            <div className="nx-kpi-v">{value}</div>
            <div className="nx-kpi-s">{detail}</div>
          </article>
        ))}
      </section>

      <section className="nxs-toolbar">
        <label className="nx-input nxs-list-search">
          <Search size={16} className="nx-faint" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Buscar sessões" placeholder="Buscar sessões..." />
        </label>
        <div className="nx-seg" aria-label="Filtrar sessões">
          {([
            ["todos", "Todas"],
            ["ativo", "Ativas"],
            ["encerrado", "Encerradas"],
            ["arquivado", "Arquivadas"],
          ] as Array<[typeof statusFilter, string]>).map(([status, label]) => (
            <button key={status} type="button" aria-pressed={statusFilter === status} onClick={() => setStatusFilter(status)} className={statusFilter === status ? "is-active" : ""}>{label}</button>
          ))}
        </div>
      </section>

      <div className="nxs-section-title"><h2>Seus quadros</h2><span>{filteredSessions.length} sessão(ões)</span></div>
      <section className="nxs-cards">
        {loading ? <div className="nxw-empty" style={{ gridColumn: "1 / -1" }}><Loader2 className="nxw-spin" /></div> : filteredSessions.map((item) => (
          <article key={item.id} className="nx-card nxs-card">
            <div className="nxs-card-top"><span className="nxw-icon"><Boxes size={16} /></span><span className={`nx-badge ${item.status === "ativo" ? "is-green" : item.status === "encerrado" ? "is-violet" : ""}`}>{item.status === "ativo" ? "Ativa" : item.status === "encerrado" ? "Encerrada" : "Arquivada"}</span></div>
            <h2 className="nxs-card-title">{item.title}</h2>
            <p className="nxs-text nxs-clamp-3">{item.objective || "Sessão livre para organizar novas ideias."}</p>
            <div className="nxs-card-meta"><span><AvatarImage userId={item.responsibleId} name={item.responsibleName} size={24}/> {item.responsibleName}</span><span><StickyNote size={14} /> {item.nodeCount || 0} itens</span><span className="nxs-span-2"><Clock3 size={14} /> Atualizado em {formatDate(item.updatedAt)}</span></div>
            <div className="nxs-card-actions">
              <button type="button" className="nx-btn is-sm is-primary" onClick={() => setSelectedSessionId(item.id)}><MousePointer2 size={14} /> Abrir quadro</button>
              <button type="button" className="nxw-icon-btn is-sm" onClick={() => void shareSession(item)} title="Compartilhar" aria-label="Compartilhar"><Share2 size={15} /></button>
              <button type="button" className="nxw-icon-btn is-sm nxs-danger" onClick={() => void deleteSession(item)} title="Excluir sessão" aria-label="Excluir sessao"><Trash2 size={15} /></button>
              {item.status === "encerrado" ? (
                <button type="button" className="nx-btn is-sm nxs-span-2" onClick={() => setSelectedSessionId(item.id)}><BarChart3 size={14} /> Ver resultado final</button>
              ) : (
                <button type="button" className="nx-btn is-sm nxs-span-2" onClick={() => createProposalFromSession(item)}><FileSignature size={14} /> Criar proposta desta sessão</button>
              )}
              <button type="button" className="nxw-icon-btn is-sm" onClick={() => openSessionProperties(item)} title="Editar propriedades" aria-label="Editar propriedades"><Settings2 size={15} /></button>
            </div>
          </article>
        ))}
        {!loading && sessions.length === 0 && <div className="nx-card nxw-empty nxs-dashed"><span className="nxw-icon"><Lightbulb size={18} /></span><strong>A primeira ideia começa aqui</strong><span>Crie uma sessão, escolha um responsável e convide a equipe para o quadro.</span></div>}
        {!loading && sessions.length > 0 && filteredSessions.length === 0 && (
          <div className="nx-card nxw-empty nxs-dashed"><span className="nxw-icon is-gray"><Search size={18} /></span><strong>Nenhuma sessão encontrada</strong><span>Ajuste o texto da busca ou o filtro de status.</span></div>
        )}
      </section>

      {editing && (
        <div className="nxs-modal-backdrop">
          <section className="nx-card nxs-modal" role="dialog" aria-modal="true" aria-label="Editar brainstorm">
            <header className="nxs-modal-h">
              <div className="nx-grow"><p className="nxs-eyebrow">Configuração da sessão</p><h2 className="nxs-h2">Editar brainstorm</h2></div>
              <button type="button" className="nxw-icon-btn is-sm is-plain" onClick={() => setEditing(null)} aria-label="Fechar propriedades"><X size={18} /></button>
            </header>
            <div className="nxs-modal-b">
              <label className="nxw-label"><span>Título da sessão</span><input className="nxw-field" autoFocus value={editForm.title} onChange={(event) => setEditForm((current) => ({ ...current, title: event.target.value }))} /></label>
              <label className="nxw-label"><span>Objetivo</span><textarea className="nxw-field" value={editForm.objective} onChange={(event) => setEditForm((current) => ({ ...current, objective: event.target.value }))} rows={4} /></label>
              <div className="nxs-grid-2">
                <label className="nxw-label"><span>Responsável</span><select className="nxw-field" value={editForm.responsibleId} onChange={(event) => setEditForm((current) => ({ ...current, responsibleId: event.target.value }))}>{members.map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}</select></label>
                <label className="nxw-label"><span>Modelo</span><select className="nxw-field" value={editForm.template} onChange={(event) => setEditForm((current) => ({ ...current, template: event.target.value }))}><option value="livre">Quadro livre</option>{STUDIO_TEMPLATES.filter((item) => item.id !== "retrospectiva").map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}<option value="mapa-mental">Mapa mental</option><option value="swot">SWOT</option><option value="jornada">Jornada</option><option value="retrospectiva">Retrospectiva</option></select></label>
                <label className="nxw-label"><span>Duração do timer (minutos)</span><input className="nxw-field" type="number" min={1} max={240} value={editForm.durationMinutes} onChange={(event) => setEditForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} /></label>
                <label className="nxw-label"><span>Status</span><select className="nxw-field" disabled={Boolean(editing.timer?.finishedAt)} value={editForm.status} onChange={(event) => setEditForm((current) => ({ ...current, status: event.target.value as BrainstormSession["status"] }))}><option value="ativo">Ativo</option><option value="encerrado">Encerrado</option><option value="arquivado">Arquivado</option></select></label>
              </div>
              {editing.timer?.finishedAt && <div className="nxw-alert is-warning"><LockKeyhole size={16} /><span>Esta sessão foi encerrada pelo timer e permanece bloqueada.</span></div>}
            </div>
            <footer className="nxs-modal-f">
              <button type="button" className="nx-btn nxs-danger-btn" onClick={() => { void deleteSession(editing).then((deleted) => { if (deleted) setEditing(null); }); }}><Trash2 size={16} /> Excluir</button>
              <div style={{ display: "flex", gap: 8 }}><button type="button" className="nx-btn" onClick={() => setEditing(null)}>Cancelar</button><button type="button" className="nx-btn is-primary" disabled={savingProperties || !editForm.title.trim()} onClick={() => void saveSessionProperties()}>{savingProperties ? <Loader2 size={16} className="nxw-spin" /> : <Save size={16} />} Salvar alterações</button></div>
            </footer>
          </section>
        </div>
      )}

      {creating && <StudioTemplates members={members} userId={session.user.id} onClose={() => setCreating(false)} onCreate={createSession} />}
    </div></ProfilePeople>
  );
}
