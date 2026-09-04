import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  Check,
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
  PanelLeftClose,
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
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AuthSession, NoriumUser } from "../../types/auth";
import { apiBaseUrl, authenticatedWebSocketUrl, authToken, wsBaseUrl } from "../../utils/api";
import { showConfirm } from "../shared/AppDialogProvider";
import Button from "../shared/Button";
import StudioTemplates, { type StudioSessionForm } from "./StudioTemplates";
import { STUDIO_TEMPLATES, studioTemplateTitle } from "./studioTemplateCatalog";


type IdeaVariant = "sticky" | "text" | "shape" | "frame";

type IdeaComment = {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  timestamp: string;
};

type IdeaData = Record<string, unknown> & {
  label: string;
  description?: string;
  color: string;
  variant: IdeaVariant;
  category?: string;
  completed?: boolean;
  dueDate?: string;
  tags?: string[];
  responsibleId?: string;
  responsibleName?: string;
  comments?: IdeaComment[];
  votes?: string[];
  file?: { name: string; mimeType: string; size: number; dataUrl: string };
};

type BrainstormPanel = "ideas" | "session" | "notes" | "participants" | "files" | "templates" | "reports" | "settings";

type IdeaNode = Node<IdeaData, "idea">;

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

const NOTE_COLORS = ["#FDE68A", "#BAE6FD", "#BBF7D0", "#FBCFE8", "#DDD6FE", "#FED7AA"];
const API = apiBaseUrl();

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "agora";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function IdeaCard({ data, selected }: NodeProps<IdeaNode>) {
  const votes = data.votes?.length || 0;
  const comments = data.comments?.length || 0;
  const frameStyle = data.variant === "frame";
  const textStyle = data.variant === "text";
  return (
    <div
      className={`brainstorm-node relative min-h-[112px] min-w-[190px] max-w-[280px] border p-4 shadow-lg transition ${selected ? "ring-2 ring-cyan-300 ring-offset-2 ring-offset-blue-950" : ""} ${frameStyle ? "border-dashed bg-transparent" : ""}`}
      style={{
        background: frameStyle ? "rgba(8,47,73,.12)" : textStyle ? "rgba(7,24,66,.9)" : data.color,
        borderColor: frameStyle ? data.color : "rgba(255,255,255,.28)",
        color: frameStyle || textStyle ? "white" : "#10204a",
      }}
    >
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-white !bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-white !bg-blue-500" />
      <p className="whitespace-pre-wrap break-words text-sm font-bold leading-5">{data.label || "Nova ideia"}</p>
      {data.description && <p className="mt-2 line-clamp-3 break-words text-xs font-semibold opacity-75">{data.description}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs font-bold uppercase opacity-70">
        {data.completed && <span className="inline-flex items-center gap-1"><Check size={12} /> Concluído</span>}
        {data.dueDate && <span>{new Date(`${data.dueDate}T12:00:00`).toLocaleDateString("pt-BR")}</span>}
        {data.category && <span className="rounded-full border border-current/20 px-2 py-0.5">{data.category}</span>}
        {votes > 0 && <span className="inline-flex items-center gap-1"><ThumbsUp size={11} /> {votes}</span>}
        {comments > 0 && <span className="inline-flex items-center gap-1"><MessageSquareText size={11} /> {comments}</span>}
      </div>
    </div>
  );
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
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
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
      setError("O tempo terminou. Esta sessao esta em modo somente leitura.");
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
      const next = addEdge({ ...connection, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#38BDF8", strokeWidth: 2 } }, current);
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
    if (accepted.length !== files.length) setError("Cada arquivo do Estúdio deve ter no maximo 2 MB; ate cinco arquivos sao aceitos por vez.");
    const created = await Promise.all(accepted.map(async (file, index): Promise<IdeaNode> => ({
      id: `idea_${crypto.randomUUID()}`,
      type: "idea",
      position: { x: 160 + ((nodes.length + index) % 3) * 280, y: 140 + Math.floor((nodes.length + index) / 3) * 190 },
      data: {
        label: file.name,
        description: `${file.type || "Arquivo"} · ${(file.size / 1024).toFixed(1)} KB`,
        color: "#BAE6FD",
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
      setError(requestError instanceof Error ? requestError.message : "Falha ao encerrar a sessao.");
      void loadSession();
    });
  }, [loadSession, remainingSeconds, session?.timer, sessionId]);

  const filteredNodeIds = useMemo(() => {
    const value = search.trim().toLowerCase();
    if (!value) return new Set<string>();
    return new Set(nodes.filter((node) => `${node.data.label} ${node.data.category} ${(node.data.tags || []).join(" ")}`.toLowerCase().includes(value)).map((node) => node.id));
  }, [nodes, search]);

  if (!session) {
    return <div className="grid h-full place-items-center bg-[var(--background)] text-[var(--text)]">{error || <Loader2 className="animate-spin" />}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background)] text-[var(--text)]">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button iconOnly onClick={onBack} title="Voltar às sessões" aria-label="Voltar às sessões"><ArrowLeft size={19} /></Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><span className="text-xs font-bold uppercase text-cyan-300">Estúdio colaborativo</span>{saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} className="text-emerald-400" />}</div>
            <h1 className="truncate text-lg font-black">{session.title}</h1>
            <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">Responsável: {session.responsibleName}{savedAt ? ` · salvo ${formatDate(savedAt)}` : ""}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center -space-x-2 sm:flex">
            {Object.values(presence).slice(0, 5).map((person) => person.photoUrl ? <img key={person.id} src={person.photoUrl} title={`${person.name} online`} className="h-9 w-9 rounded-full border-2 border-blue-950 object-cover" /> : <span key={person.id} title={`${person.name} online`} className="grid h-9 w-9 place-items-center rounded-full border-2 border-blue-950 bg-cyan-600 text-xs font-bold text-white">{avatarFallback(person.name)}</span>)}
          </div>
          <button disabled={boardLocked} onClick={toggleTimer} className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-70 ${boardLocked ? "border-red-300/35 bg-red-400/10 text-red-200" : session.timer?.running ? "border-amber-300/40 bg-amber-300/10 text-amber-200" : "border-[var(--border)]"}`}>
            {boardLocked ? <LockKeyhole size={16} /> : <Clock3 size={16} />} {boardLocked ? "Encerrado" : remainingSeconds === null ? `${session.timer?.durationMinutes || 15} min` : `${String(Math.floor(remainingSeconds / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`}
          </button>
          <Button variant="primary" disabled={boardLocked} onClick={() => void persistBoard(nodes, edges)} className="hover:brightness-110disabled:cursor-not-allowed"><Save size={16} /> Salvar</Button>
        </div>
      </header>

      {error && <div className="shrink-0 border-b border-red-400/25 bg-red-500/10 px-4 py-2 text-xs font-bold text-red-200">{error}</div>}
      {boardLocked && <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-300/25 bg-amber-300/10 px-4 py-3 text-center text-xs font-bold text-amber-100"><LockKeyhole size={16} /> Sessao encerrada. O quadro esta bloqueado para novas ideias, votos, comentarios e alteracoes.</div>}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <aside className={`brainstorm-toolbar flex shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)] py-2 transition-[width] ${toolbarCollapsed ? "w-[56px]" : "w-[82px]"}`}>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { void importFiles(event.target.files); event.currentTarget.value = ""; }} />
          {([
            ["ideas", "Ideias", Lightbulb],
            ["session", "Sessão", Boxes],
            ["notes", "Notas", StickyNote],
            ["participants", "Participantes", UsersRound],
            ["files", "Arquivos", FolderOpen],
            ["templates", "Modelos", BookOpen],
            ["reports", "Relatórios", BarChart3],
            ["settings", "Configurações", Settings2],
          ] as Array<[BrainstormPanel, string, typeof Lightbulb]>).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              onClick={() => openInspector(mode)}
              className={`brainstorm-nav-tool ${inspectorMode === mode && !selectedNode ? "active" : ""} ${toolbarCollapsed ? "collapsed" : ""}`}
              title={label}
              aria-label={label}
            >
              <Icon size={19} />
              {!toolbarCollapsed && <span>{label}</span>}
            </button>
          ))}
          <button type="button" onClick={() => setToolbarCollapsed((value) => !value)} className={`brainstorm-nav-tool mt-auto ${toolbarCollapsed ? "collapsed" : ""}`} title={toolbarCollapsed ? "Expandir barra" : "Recolher barra"} aria-label={toolbarCollapsed ? "Expandir barra" : "Recolher barra"}>
            <PanelLeftClose size={19} className={toolbarCollapsed ? "rotate-180" : ""} />
            {!toolbarCollapsed && <span>Recolher</span>}
          </button>
        </aside>

        <section className="relative min-w-0 flex-1 bg-[#07142f]">
          <div className="pointer-events-none absolute left-4 top-4 z-10 flex max-w-[min(620px,calc(100%-2rem))] gap-2">
            <label className="pointer-events-auto flex h-10 min-w-0 items-center gap-2 rounded-lg border border-white/15 bg-blue-950/85 px-3 shadow-xl backdrop-blur-xl">
              <Search size={15} className="text-cyan-300" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar ideia, categoria ou tag" className="min-w-0 bg-transparent text-xs font-semibold text-white outline-none placeholder:text-white/45" />
            </label>
            <span className="pointer-events-auto hidden items-center rounded-lg border border-white/15 bg-blue-950/85 px-3 text-xs font-bold text-white/70 sm:flex">{nodes.length} itens · {edges.length} conexões</span>
            <div className="pointer-events-auto hidden items-center gap-1 rounded-lg border border-white/15 bg-blue-950/85 p-1 shadow-xl backdrop-blur-xl md:flex">
              <button disabled={boardLocked} onClick={() => addIdea("sticky")} className="brainstorm-canvas-tool" title="Adicionar post-it" aria-label="Adicionar post-it"><StickyNote size={15} /></button>
              <button disabled={boardLocked} onClick={() => addIdea("text")} className="brainstorm-canvas-tool" title="Adicionar texto" aria-label="Adicionar texto"><TextCursorInput size={15} /></button>
              <button disabled={boardLocked} onClick={() => addIdea("shape")} className="brainstorm-canvas-tool" title="Adicionar bloco" aria-label="Adicionar bloco"><Shapes size={15} /></button>
              <button disabled={boardLocked} onClick={() => addIdea("frame")} className="brainstorm-canvas-tool" title="Adicionar seção" aria-label="Adicionar seção"><Frame size={15} /></button>
              <button disabled={boardLocked} onClick={clusterIdeas} className="brainstorm-canvas-tool" title="Agrupar por categoria" aria-label="Agrupar por categoria"><LayoutGrid size={15} /></button>
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
            defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#38BDF8", strokeWidth: 2 } }}
          >
            <Background variant={BackgroundVariant.Dots} color="rgba(125,211,252,.28)" gap={24} size={1.2} />
            <Controls className="!border-white/15 !bg-blue-950/90 !text-white" />
            <MiniMap pannable zoomable className="!border !border-white/15 !bg-blue-950/90" nodeColor={(node) => String((node.data as IdeaData)?.color || "#38BDF8")} />
          </ReactFlow>
        </section>

        {mobileInspectorOpen && <button type="button" aria-label="Fechar propriedades" onClick={() => setMobileInspectorOpen(false)} className="absolute inset-0 z-20 bg-blue-950/55 backdrop-blur-[2px] xl:hidden" />}
        <aside className={`brainstorm-inspector absolute inset-y-0 right-0 z-30 w-[min(340px,calc(100vw-72px))] shrink-0 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] p-4 shadow-2xl transition-transform xl:shadow-none ${mobileInspectorOpen ? "translate-x-0 xl:relative xl:block xl:w-[330px] xl:translate-x-0" : "translate-x-full xl:hidden"}`}>
          <button type="button" onClick={() => setMobileInspectorOpen(false)} className="brainstorm-icon-button absolute right-3 top-3 xl:hidden" title="Fechar propriedades" aria-label="Fechar propriedades"><X size={16} /></button>
          {selectedNode ? (
            <fieldset disabled={boardLocked} className="space-y-5 disabled:opacity-60">
              <header className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase text-cyan-300">Item selecionado</p><h2 className="font-black">Editar ideia</h2></div><div className="flex gap-1"><button onClick={duplicateSelected} className="brainstorm-icon-button" title="Duplicar" aria-label="Duplicar"><Copy size={15} /></button><button onClick={deleteSelected} className="brainstorm-icon-button text-red-300" title="Excluir" aria-label="Excluir"><Trash2 size={15} /></button></div></header>
              <label className="brainstorm-field"><span>Título</span><textarea value={selectedNode.data.label} onChange={(event) => updateSelected({ label: event.target.value })} onBlur={() => void persistBoard(nodes, edges, "Texto da ideia editado")} rows={3} /></label>
              <label className="brainstorm-field"><span>Descrição</span><textarea value={selectedNode.data.description || ""} onChange={(event) => updateSelected({ description: event.target.value })} onBlur={() => void persistBoard(nodes, edges, "Descrição editada")} rows={3} /></label>
              <div><p className="mb-2 text-xs font-bold uppercase text-[var(--text-secondary)]">Cor</p><div className="flex flex-wrap gap-2">{NOTE_COLORS.map((color) => <button key={color} onClick={() => updateSelected({ color }, true)} className={`h-8 w-8 rounded-full border-2 ${selectedNode.data.color === color ? "border-white" : "border-transparent"}`} style={{ background: color }} title={color}  aria-label={color} />)}</div></div>
              <label className="brainstorm-field"><span>Categoria</span><input value={selectedNode.data.category || ""} onChange={(event) => updateSelected({ category: event.target.value })} onBlur={() => void persistBoard(nodes, edges, "Categoria editada")} placeholder="Ex.: produto, marketing" /></label>
              <label className="brainstorm-field"><span>Responsável</span><select value={selectedNode.data.responsibleId || ""} onChange={(event) => { const member = members.find((item) => item.id === event.target.value); updateSelected({ responsibleId: member?.id || "", responsibleName: member?.nome || "" }, true); }}><option value="">A definir</option>{members.map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}</select></label>
              <label className="brainstorm-field"><span>Prazo</span><input type="date" value={selectedNode.data.dueDate || ""} onChange={(event) => updateSelected({ dueDate: event.target.value }, true)} /></label>
              <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={Boolean(selectedNode.data.completed)} onChange={(event) => updateSelected({ completed: event.target.checked }, true)} /> Item concluído</label>
              {selectedNode.data.file && <a href={selectedNode.data.file.dataUrl} download={selectedNode.data.file.name} className="brainstorm-secondary-button"><FolderOpen size={15} /> Baixar {selectedNode.data.file.name}</a>}
              <div className="grid grid-cols-2 gap-2"><button onClick={toggleVote} className="brainstorm-secondary-button"><ThumbsUp size={15} /> Votar ({selectedNode.data.votes?.length || 0})</button><button onClick={() => void convertTask()} className="brainstorm-secondary-button"><ListChecks size={15} /> Virar tarefa</button></div>
              <section className="border-t border-[var(--border)] pt-4"><h3 className="mb-3 flex items-center gap-2 text-sm font-bold"><MessageSquareText size={16} /> Comentários</h3><div className="space-y-2">{(selectedNode.data.comments || []).map((item) => <article key={item.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><div className="flex justify-between gap-2 text-xs font-bold"><span>{item.authorName}</span><time className="text-[var(--text-secondary)]">{formatDate(item.timestamp)}</time></div><p className="mt-1 whitespace-pre-wrap break-words text-xs font-semibold text-[var(--text-secondary)]">{item.text}</p></article>)}</div><div className="mt-2 flex gap-2"><input value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addComment(); }} placeholder="Comentar..." className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs outline-none" /><Button variant="primary" iconOnly onClick={addComment}><Plus size={16} /></Button></div></section>
            </fieldset>
          ) : (
            <div className="space-y-5">
              {(inspectorMode === "session" || inspectorMode === "ideas") && <div><p className="text-xs font-bold uppercase text-cyan-300">Sessão</p><h2 className="text-lg font-black">{session.title}</h2><p className="mt-2 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{session.objective || "Sem objetivo descrito."}</p></div>}

              {inspectorMode === "ideas" && <section><h3 className="text-sm font-black">Ferramentas de ideias</h3><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">Adicione, conecte e organize elementos no quadro.</p><div className="mt-3 grid grid-cols-2 gap-2"><button disabled={boardLocked} onClick={() => addIdea("sticky")} className="brainstorm-secondary-button"><StickyNote size={15} /> Post-it</button><button disabled={boardLocked} onClick={() => addIdea("text")} className="brainstorm-secondary-button"><TextCursorInput size={15} /> Texto</button><button disabled={boardLocked} onClick={() => addIdea("shape")} className="brainstorm-secondary-button"><Shapes size={15} /> Bloco</button><button disabled={boardLocked} onClick={clusterIdeas} className="brainstorm-secondary-button"><LayoutGrid size={15} /> Agrupar</button></div></section>}

              {inspectorMode === "notes" && <section><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase text-cyan-300">Notas</p><h2 className="text-lg font-black">{nodes.filter((node) => node.data.variant === "sticky").length} post-its</h2></div><Button variant="primary" size="sm" disabled={boardLocked} onClick={() => addIdea("sticky")}><Plus size={15} /> Nova</Button></div><div className="mt-4 space-y-2">{nodes.filter((node) => node.data.variant === "sticky").slice(0, 20).map((node) => <button key={node.id} onClick={() => { setSelectedId(node.id); setInspectorMode("notes"); }} className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-left"><strong className="block truncate text-xs">{node.data.label}</strong><small className="mt-1 block text-[var(--text-secondary)]">{node.data.category || "geral"}</small></button>)}</div></section>}

              {inspectorMode === "participants" && <section><p className="text-xs font-bold uppercase text-cyan-300">Participantes</p><h2 className="mt-1 text-lg font-black">Equipe da sessão</h2><div className="mt-4 space-y-2">{members.map((member) => { const online = Boolean(presence[member.id]); return <article key={member.id} className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">{member.fotoUrl ? <img src={member.fotoUrl} className="h-9 w-9 rounded-full object-cover" /> : <span className="grid h-9 w-9 place-items-center rounded-full bg-cyan-600 text-xs font-black text-white">{avatarFallback(member.nome)}</span>}<span className="min-w-0"><strong className="block truncate text-xs">{member.nome}</strong><small className={online ? "text-emerald-300" : "text-[var(--text-secondary)]"}>{online ? "Online no quadro" : "Offline"}</small></span></article>; })}</div></section>}

              {inspectorMode === "files" && <section><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase text-cyan-300">Arquivos</p><h2 className="text-lg font-black">Anexos do quadro</h2></div><Button variant="primary" size="sm" disabled={boardLocked} onClick={() => fileInputRef.current?.click()}><Plus size={15} /> Anexar</Button></div><p className="mt-2 text-xs font-semibold text-[var(--text-secondary)]">Até 2 MB por arquivo. Os anexos ficam vinculados à sessão.</p><div className="mt-4 space-y-2">{nodes.filter((node) => node.data.file).map((node) => <button key={node.id} onClick={() => setSelectedId(node.id)} className="flex w-full items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-left"><FileText size={18} className="shrink-0 text-cyan-300" /><span className="min-w-0"><strong className="block truncate text-xs">{node.data.file?.name}</strong><small className="text-[var(--text-secondary)]">{((node.data.file?.size || 0) / 1024).toFixed(1)} KB</small></span></button>)}</div></section>}

              {inspectorMode === "templates" && <section><p className="text-xs font-bold uppercase text-cyan-300">Modelos</p><h2 className="mt-1 text-lg font-black">Estruturas prontas</h2><p className="mt-2 text-xs font-semibold leading-5 text-[var(--text-secondary)]">Adicione uma estrutura sem apagar as ideias existentes.</p><div className="mt-4 grid gap-2">{([['mapa-mental', 'Mapa mental'], ['swot', 'Análise SWOT'], ['jornada', 'Jornada'], ['retrospectiva', 'Retrospectiva']] as const).map(([id, label]) => <button key={id} disabled={boardLocked} onClick={() => addTemplate(id)} className="brainstorm-secondary-button"><BookOpen size={15} /> {label}</button>)}</div></section>}

              {inspectorMode === "reports" && <section><p className="text-xs font-bold uppercase text-cyan-300">Relatórios</p><h2 className="mt-1 text-lg font-black">Resultado da sessão</h2><div className="mt-4 grid grid-cols-2 gap-2">{[["Ideias", nodes.length], ["Conexões", edges.length], ["Votos", nodes.reduce((total, node) => total + (node.data.votes?.length || 0), 0)], ["Comentários", nodes.reduce((total, node) => total + (node.data.comments?.length || 0), 0)]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><small className="font-bold text-[var(--text-secondary)]">{label}</small><strong className="mt-1 block text-xl">{value}</strong></div>)}</div><Button variant="secondary" className="mt-4 w-full" onClick={downloadBoardReport}><BarChart3 size={15} /> Exportar relatório JSON</Button></section>}

              {inspectorMode === "settings" && <section><p className="text-xs font-bold uppercase text-cyan-300">Configurações</p><h2 className="mt-1 text-lg font-black">Quadro e sessão</h2><div className="mt-4 grid gap-2"><button disabled={boardLocked} onClick={toggleTimer} className="brainstorm-secondary-button"><Clock3 size={15} /> {session.timer?.running ? "Pausar timer" : "Iniciar timer"}</button><button disabled={boardLocked} onClick={clusterIdeas} className="brainstorm-secondary-button"><LayoutGrid size={15} /> Agrupar por categoria</button><button disabled={boardLocked} onClick={() => void persistBoard(nodes, edges)} className="brainstorm-secondary-button"><Save size={15} /> Salvar agora</button></div><div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-semibold text-[var(--text-secondary)]">Status: <strong className="text-[var(--text)]">{session.status}</strong><br />Modelo: <strong className="text-[var(--text)]">{studioTemplateTitle(session.template)}</strong><br />Responsável: <strong className="text-[var(--text)]">{session.responsibleName}</strong></div></section>}

              <section className="rounded-lg border border-cyan-300/20 bg-cyan-400/5 p-4"><h3 className="flex items-center gap-2 font-black"><Sparkles size={17} className="text-cyan-300" /> Nora no quadro</h3><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">Usa somente o conteúdo real da sessão para apoiar a decisão.</p><div className="mt-3 grid gap-2"><button onClick={() => void askNora("resumir")} className="brainstorm-secondary-button"><Bot size={15} /> Resumir ideias</button><button onClick={() => void askNora("gerar_ideias")} className="brainstorm-secondary-button"><Lightbulb size={15} /> Sugerir ideias</button><button onClick={() => void askNora("proximos_passos")} className="brainstorm-secondary-button"><ListChecks size={15} /> Próximos passos</button><button onClick={() => void askNora("analisar_impacto")} className="brainstorm-secondary-button"><BarChart3 size={15} /> Analisar impacto</button></div>{noraLoading && <Loader2 className="mx-auto mt-4 animate-spin text-cyan-300" />}{noraResult && <p className="mt-4 whitespace-pre-wrap break-words rounded-lg bg-[var(--background)] p-3 text-xs font-semibold leading-5 select-text">{noraResult}</p>}</section>

              {inspectorMode === "session" && <section><h3 className="mb-2 text-xs font-bold uppercase text-[var(--text-secondary)]">Histórico</h3><div className="space-y-2">{(session.history || []).slice().reverse().slice(0, 8).map((item) => <div key={item.id} className="rounded-lg border border-[var(--border)] p-3"><p className="text-xs font-bold">{item.detail}</p><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{item.actorName} · {formatDate(item.timestamp)}</p></div>)}</div></section>}
            </div>
          )}
        </aside>
      </div>

      {endAlertOpen && (
        <div className="fixed inset-0 z-[140] grid place-items-center bg-blue-950/80 p-4 backdrop-blur-md">
          <section role="alertdialog" aria-modal="true" aria-labelledby="brainstorm-ended-title" className="w-full max-w-lg rounded-xl border border-amber-200/35 bg-[#071a46] p-7 text-center text-white shadow-2xl shadow-black/45">
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-amber-200/35 bg-amber-300/15 text-amber-200"><AlertTriangle size={30} /></span>
            <p className="mt-5 text-xs font-bold uppercase tracking-wide text-amber-200">Tempo esgotado</p>
            <h2 id="brainstorm-ended-title" className="mt-2 text-2xl font-black">Sessão encerrada</h2>
            <p className="mx-auto mt-3 max-w-md text-sm font-semibold leading-6 text-white/75">O prazo desta sessao terminou. Para preservar o resultado da equipe, o quadro agora esta em modo somente leitura e nenhuma nova alteracao sera aceita.</p>
            <Button variant="ghost" size="lg" onClick={() => setEndAlertOpen(false)} className="mt-6 bg-amber-300 text-blue-950 hover:bg-amber-200"><LockKeyhole size={17} /> Ver resultado final</Button>
          </section>
        </div>
      )}
    </div>
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
      const [sessionData, usersData] = await Promise.all([
        jsonRequest<BrainstormSession[]>("/api/brainstorm/sessions"),
        jsonRequest<{ users: NoriumUser[] }>("/api/auth/users").catch(() => ({ users: [session.user] })),
      ]);
      setSessions(sessionData);
      setMembers(usersData.users || [session.user]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao carregar sessões.");
    } finally {
      setLoading(false);
    }
  }, [session.user]);

  useEffect(() => { void load(); }, [load]);

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
      description: `A sessao "${item.title}" e todos os seus itens serao removidos. Esta acao nao pode ser desfeita.`,
      confirmLabel: "Excluir sessao",
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
      if ((shareError as DOMException)?.name !== "AbortError") setError("Nao foi possivel compartilhar esta sessao.");
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
    <div className="h-full overflow-y-auto bg-[var(--background)] p-4 text-[var(--text)] sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px]">
        <header className="flex flex-col gap-5 border-b border-[var(--border)] pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 items-start gap-4"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-cyan-500/15 text-cyan-300"><Lightbulb size={24} /></span><div><p className="text-xs font-bold uppercase text-cyan-300">Colaboração visual em tempo real</p><h1 className="mt-1 text-2xl font-black sm:text-3xl">Estúdio</h1><p className="mt-2 max-w-2xl text-sm font-semibold text-[var(--text-secondary)]">Organize ideias, conecte hipóteses, vote, comente e transforme decisões em tarefas.</p></div></div>
          <Button variant="ghost" size="lg" onClick={() => setCreating(true)} className="bg-gradient-to-r from-blue-600 to-cyan-500 shadow-lg shadow-blue-950/20"><Plus size={18} /> Nova sessão</Button>
        </header>

        {error && <div className="mt-5 rounded-lg border border-red-400/25 bg-red-500/10 p-3 text-sm font-bold text-red-200">{error}</div>}

        <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Sessoes", sessionStats.total, "Todos os quadros"],
            ["Ativas", sessionStats.active, "Colaboracao em andamento"],
            ["Encerradas", sessionStats.finished, "Resultados bloqueados"],
            ["Ideias", sessionStats.ideas, "Itens registrados"],
          ].map(([label, value, detail]) => (
            <article key={String(label)} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">{label}</p>
              <p className="mt-2 text-2xl font-black">{value}</p>
              <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{detail}</p>
            </article>
          ))}
        </section>

        <section className="mt-4 flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 lg:flex-row lg:items-center">
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3">
            <Search size={16} className="shrink-0 text-[var(--text-secondary)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por sessao, objetivo, modelo ou responsavel"
              className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
            />
          </label>
          <div className="flex max-w-full gap-1 overflow-x-auto">
            {([
              ["todos", "Todas"],
              ["ativo", "Ativas"],
              ["encerrado", "Encerradas"],
              ["arquivado", "Arquivadas"],
            ] as Array<[typeof statusFilter, string]>).map(([status, label]) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`h-10 shrink-0 rounded-lg px-4 text-xs font-bold transition ${
                  statusFilter === status
                    ? "bg-[var(--primary)] text-white"
                    : "border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {loading ? <div className="col-span-full grid min-h-64 place-items-center"><Loader2 className="animate-spin text-cyan-300" /></div> : filteredSessions.map((item) => (
            <article key={item.id} className="group flex min-h-[250px] flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm transition hover:border-cyan-300/45 hover:bg-[var(--surface-hover)]">
              <div className="flex items-start justify-between gap-3"><span className="grid h-11 w-11 place-items-center rounded-lg bg-blue-500/15 text-cyan-300"><Boxes size={21} /></span><span className={`rounded-full border px-2 py-1 text-xs font-bold uppercase ${item.status === "ativo" ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-white/15 text-[var(--text-secondary)]"}`}>{item.status}</span></div>
              <h2 className="mt-4 break-words text-lg font-black">{item.title}</h2><p className="mt-2 line-clamp-3 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{item.objective || "Sessão livre para organizar novas ideias."}</p>
              <div className="mt-auto grid grid-cols-2 gap-2 pt-5 text-xs font-bold text-[var(--text-secondary)]"><span className="inline-flex items-center gap-2"><UsersRound size={14} /> {item.responsibleName}</span><span className="inline-flex items-center justify-end gap-2"><StickyNote size={14} /> {item.nodeCount || 0} itens</span><span className="col-span-2 inline-flex items-center gap-2"><Clock3 size={14} /> Atualizado em {formatDate(item.updatedAt)}</span></div>
              <div className="mt-4 grid grid-cols-[minmax(0,1fr)_40px_40px] gap-2">
                <Button variant="primary" onClick={() => setSelectedSessionId(item.id)} className="min-w-0"><MousePointer2 size={15} /> Abrir quadro</Button>
                <Button iconOnly onClick={() => void shareSession(item)} className="text-cyan-200 hover:bg-cyan-400/10" title="Compartilhar" aria-label="Compartilhar"><Share2 size={16} /></Button>
                <Button variant="danger" iconOnly onClick={() => void deleteSession(item)} className="border-red-400/20 text-red-300 hover:bg-red-500/10" title="Excluir sessao" aria-label="Excluir sessao"><Trash2 size={16} /></Button>
                {item.status === "encerrado" ? (
                  <Button onClick={() => setSelectedSessionId(item.id)} className="col-span-2 border-violet-400/25 bg-violet-400/10 text-violet-200 hover:bg-violet-400/15"><BarChart3 size={15} /> Ver resultado final</Button>
                ) : (
                  <Button onClick={() => createProposalFromSession(item)} className="col-span-2 border-cyan-400/25 bg-cyan-400/10 text-cyan-200 hover:bg-cyan-400/15"><FileSignature size={15} /> Criar proposta desta sessão</Button>
                )}
                <Button iconOnly onClick={() => openSessionProperties(item)} className="text-cyan-200 hover:bg-cyan-400/10" title="Editar propriedades" aria-label="Editar propriedades"><Settings2 size={16} /></Button>
              </div>
            </article>
          ))}
          {!loading && sessions.length === 0 && <div className="col-span-full grid min-h-72 place-items-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center"><div><Lightbulb size={36} className="mx-auto text-cyan-300" /><h2 className="mt-4 text-lg font-black">A primeira ideia começa aqui</h2><p className="mt-2 text-sm font-semibold text-[var(--text-secondary)]">Crie uma sessão, escolha um responsável e convide a equipe para o quadro.</p></div></div>}
          {!loading && sessions.length > 0 && filteredSessions.length === 0 && (
            <div className="col-span-full grid min-h-56 place-items-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
              <div>
                <Search size={32} className="mx-auto text-cyan-300" />
                <h2 className="mt-4 text-base font-black">Nenhuma sessao encontrada</h2>
                <p className="mt-2 text-sm font-semibold text-[var(--text-secondary)]">Ajuste o texto da busca ou o filtro de status.</p>
              </div>
            </div>
          )}
        </section>
      </div>

      {editing && (
        <div className="fixed inset-0 z-[120] grid place-items-center bg-blue-950/75 p-4 backdrop-blur-sm">
          <section className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
            <header className="flex items-center justify-between gap-4 border-b border-[var(--border)] p-5">
              <div><p className="text-xs font-bold uppercase text-cyan-300">Configuracao da sessao</p><h2 className="text-lg font-black">Editar brainstorm</h2></div>
              <Button variant="ghost" size="sm" iconOnly onClick={() => setEditing(null)} aria-label="Fechar propriedades"><X size={18} /></Button>
            </header>
            <div className="grid gap-4 p-5">
              <label className="brainstorm-field"><span>Titulo da sessao</span><input autoFocus value={editForm.title} onChange={(event) => setEditForm((current) => ({ ...current, title: event.target.value }))} /></label>
              <label className="brainstorm-field"><span>Objetivo</span><textarea value={editForm.objective} onChange={(event) => setEditForm((current) => ({ ...current, objective: event.target.value }))} rows={4} /></label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="brainstorm-field"><span>Responsavel</span><select value={editForm.responsibleId} onChange={(event) => setEditForm((current) => ({ ...current, responsibleId: event.target.value }))}>{members.map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}</select></label>
                <label className="brainstorm-field"><span>Modelo</span><select value={editForm.template} onChange={(event) => setEditForm((current) => ({ ...current, template: event.target.value }))}><option value="livre">Quadro livre</option>{STUDIO_TEMPLATES.filter((item) => item.id !== "retrospectiva").map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}<option value="mapa-mental">Mapa mental</option><option value="swot">SWOT</option><option value="jornada">Jornada</option><option value="retrospectiva">Retrospectiva</option></select></label>
                <label className="brainstorm-field"><span>Duracao do timer (minutos)</span><input type="number" min={1} max={240} value={editForm.durationMinutes} onChange={(event) => setEditForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} /></label>
                <label className="brainstorm-field"><span>Status</span><select disabled={Boolean(editing.timer?.finishedAt)} value={editForm.status} onChange={(event) => setEditForm((current) => ({ ...current, status: event.target.value as BrainstormSession["status"] }))}><option value="ativo">Ativo</option><option value="encerrado">Encerrado</option><option value="arquivado">Arquivado</option></select></label>
              </div>
              {editing.timer?.finishedAt && <div className="flex items-center gap-2 rounded-lg border border-amber-300/25 bg-amber-300/10 p-3 text-xs font-bold text-amber-100"><LockKeyhole size={16} /> Esta sessao foi encerrada pelo timer e permanece bloqueada.</div>}
            </div>
            <footer className="flex flex-wrap justify-between gap-2 border-t border-[var(--border)] p-5">
              <Button variant="danger" onClick={() => { void deleteSession(editing).then((deleted) => { if (deleted) setEditing(null); }); }} className="border-red-400/25 text-red-300 hover:bg-red-500/10"><Trash2 size={16} /> Excluir</Button>
              <div className="flex gap-2"><Button onClick={() => setEditing(null)}>Cancelar</Button><Button variant="primary" disabled={savingProperties || !editForm.title.trim()} onClick={() => void saveSessionProperties()}>{savingProperties ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Salvar alteracoes</Button></div>
            </footer>
          </section>
        </div>
      )}

      {creating && <StudioTemplates members={members} userId={session.user.id} onClose={() => setCreating(false)} onCreate={createSession} />}
    </div>
  );
}
