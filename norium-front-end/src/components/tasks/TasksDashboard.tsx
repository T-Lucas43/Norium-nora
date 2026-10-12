import AvatarImage from "../profile/AvatarImage";
import { ProfilePeople } from "../profile/ProfilePeople";
import "./TasksDashboard.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  Archive,
  ArrowLeft,
  ClipboardList,
  CalendarPlus,
  CalendarClock,
  CheckCircle2,
  Circle,
  DollarSign,
  FileUp,
  FileText,
  Headphones,
  Layers3,
  ListFilter,
  ListTodo,
  ArrowUpRight,
  MoreHorizontal,
  SlidersHorizontal,
  CircleDot,
  ScanEye,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Plus,
  Package,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AuthSession, NoriumUser } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import { openWithAuth } from "../../utils/download";
import { calendarApiRequest, tasksApiRequest } from "../../features/tasks/api";
import type {
  ProjectAction,
  ProjectCategory,
  ProjectStatus,
  ProjectTemplate,
  TaskColumn,
  TaskForm,
  TaskItem,
  TaskLabel,
  TaskPriority,
  TaskStats,
  TaskStatus,
  TaskWorkspace,
  WorkspaceForm,
} from "../../features/tasks/types";

const emptyForm: TaskForm = {
  title: "",
  description: "",
  category: "geral",
  priority: "media",
  dueDate: "",
  labels: [],
  assigneeId: "",
};

const standardWorkflow: TaskColumn[] = [
  { id: "pendente", title: "Pendentes", limit: null },
  { id: "andamento", title: "Em andamento", limit: 5 },
  { id: "revisao", title: "Em revisão", limit: 4 },
  { id: "concluida", title: "Concluídas", limit: null },
];

const emptyWorkspaceForm: WorkspaceForm = {
  name: "",
  category: "operacao",
  description: "",
  color: "#0EA5E9",
  defaultPriority: "media",
  owner: "Operador",
  responsibleUserId: "",
  responsibleName: "",
  sharedUserIds: [],
  status: "ativo",
  startDate: "",
  dueDate: "",
  defaultStartTime: "09:00",
  calendarDurationMinutes: 60,
  templateId: "standard",
  workflowColumns: standardWorkflow,
};

const projectCategoryLabels: Record<ProjectCategory, string> = {
  operacao: "Operação",
  cliente: "Cliente",
  produto: "Produto",
  financeiro: "Financeiro",
  suporte: "Suporte",
  pessoal: "Pessoal",
};

const projectStatusLabels: Record<ProjectStatus, string> = {
  planejamento: "Planejamento",
  ativo: "Ativo",
  pausado: "Pausado",
  concluido: "Concluído",
};

const taskCategoryOptions = [
  { id: "geral", label: "Geral" },
  { id: "operacao", label: "Operação" },
  { id: "cliente", label: "Cliente" },
  { id: "produto", label: "Produto" },
  { id: "briefing", label: "Briefing" },
  { id: "execucao", label: "Execução" },
  { id: "revisao", label: "Revisão" },
  { id: "follow-up", label: "Follow-up" },
  { id: "financeiro", label: "Financeiro" },
  { id: "suporte", label: "Suporte" },
  { id: "pessoal", label: "Pessoal" },
];

const taskCategoryVisual: Record<string, { icon: LucideIcon }> = {
  geral: { icon: ClipboardList },
  operacao: { icon: Wrench },
  cliente: { icon: Users },
  produto: { icon: Package },
  briefing: { icon: FileText },
  execucao: { icon: Wrench },
  revisao: { icon: Search },
  "follow-up": { icon: MessageSquare },
  financeiro: { icon: DollarSign },
  suporte: { icon: Headphones },
  pessoal: { icon: Circle },
};

const priorityLabels: Record<TaskPriority, string> = { baixa: "Baixa", media: "Média", alta: "Alta", urgente: "Urgente" };
const priorityTone: Record<TaskPriority, string> = { baixa: "", media: "", alta: "is-amber", urgente: "is-red" };
const projectStatusTone: Record<ProjectStatus, string> = { planejamento: "is-blue", ativo: "is-green", pausado: "is-amber", concluido: "" };
const statusFilterLabels: Record<string, string> = { ativas: "Ativas", pendente: "Pendentes", andamento: "Em andamento", revisao: "Em revisão", concluida: "Concluídas" };
const dueFilterLabels: Record<string, string> = { vencidas: "Vencidas", hoje: "Hoje", semana: "Próximos 7 dias" };
const avatarColors = ["#2563EB", "#7141b8", "#08728a", "#08754d", "#b45309", "#be2446", "#475569"];

function columnTone(columnId: string) {
  if (columnId === "concluida") return "is-green";
  if (columnId === "revisao") return "is-violet";
  if (columnId === "andamento") return "is-blue";
  return "";
}

function priorityLabel(priority: string) {
  return priorityLabels[priority as TaskPriority] || priority;
}

function countLabel(value: number, singular: string, plural: string) {
  return `${value || 0} ${value === 1 ? singular : plural}`;
}

function avatarColor(name?: string) {
  let hash = 0;
  for (const char of name || "") hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return avatarColors[hash % avatarColors.length];
}

function Avatar({ name, userId, size = 24 }: { name?: string; userId?: string; size?: number }) {
  return <AvatarImage userId={userId} name={name || "Sem responsável"} size={size} label={name || "Sem responsável"} className="nx-av tasks-av" style={{ background: avatarColor(name) }}/>;
}

function dateTimeLabel(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleDateString("pt-BR")} ${date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}

const projectColorOptions = ["#0EA5E9", "#06B6D4", "#2563EB", "#14B8A6", "#22C55E", "#F59E0B", "#F43F5E"];

const statusIcon: Record<string, typeof Circle> = {
  pendente: Circle,
  andamento: CircleDot,
  revisao: ScanEye,
  concluida: CheckCircle2,
};

function dateLabel(value?: string | null) {
  if (!value) return "Sem data";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Sem data";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function projectDateRange(workspace: TaskWorkspace) {
  if (!workspace.startDate && !workspace.dueDate) return "Sem prazo definido";
  if (workspace.startDate && workspace.dueDate) return `${dateLabel(workspace.startDate)} – ${dateLabel(workspace.dueDate)}`;
  if (workspace.dueDate) return `Prazo ${dateLabel(workspace.dueDate)}`;
  return `Início ${dateLabel(workspace.startDate)}`;
}

function projectDeadlineTone(workspace: TaskWorkspace) {
  if (!workspace.dueDate || workspace.status === "concluido") return "";
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return workspace.dueDate < key ? "is-overdue" : "";
}

function isOverdue(task: TaskItem) {
  if (!task.dueDate || task.status === "concluida") return false;
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return task.dueDate < key;
}

function fileSizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function workspaceToForm(workspace: TaskWorkspace): WorkspaceForm {
  return {
    name: workspace.name,
    category: workspace.category,
    description: workspace.description,
    color: workspace.color,
    defaultPriority: workspace.defaultPriority,
    owner: workspace.owner,
    responsibleUserId: workspace.responsibleUserId || workspace.ownerUserId || "",
    responsibleName: workspace.responsibleName || workspace.owner,
    sharedUserIds: workspace.sharedUserIds || [],
    status: workspace.status,
    startDate: workspace.startDate,
    dueDate: workspace.dueDate,
    defaultStartTime: workspace.defaultStartTime,
    calendarDurationMinutes: workspace.calendarDurationMinutes,
    templateId: workspace.templateId || "standard",
    workflowColumns: workspace.workflowColumns?.length ? workspace.workflowColumns : standardWorkflow,
  };
}

export default function TasksDashboard({ session }: { session: AuthSession }) {
  const userId = session.user.id;
  const userName = session.user.nome || "Operador";
  const [workspaces, setWorkspaces] = useState<TaskWorkspace[]>([]);
  const [teamMembers, setTeamMembers] = useState<NoriumUser[]>([session.user]);
  const [projectTemplates, setProjectTemplates] = useState<ProjectTemplate[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<TaskWorkspace | null>(null);
  const [workspaceForm, setWorkspaceForm] = useState<WorkspaceForm>({
    ...emptyWorkspaceForm,
    owner: userName,
    responsibleUserId: userId,
    responsibleName: userName,
  });
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [columns, setColumns] = useState<TaskColumn[]>([]);
  const [labels, setLabels] = useState<TaskLabel[]>([]);
  const [stats, setStats] = useState<TaskStats>({ total: 0, ativas: 0, pendentes: 0, andamento: 0, concluidas: 0, vencidas: 0 });
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showWorkspaceCreate, setShowWorkspaceCreate] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const [pendingProjectAction, setPendingProjectAction] = useState<{ type: ProjectAction; workspace: TaskWorkspace } | null>(null);
  const [form, setForm] = useState<TaskForm>(emptyForm);
  const [settingsForm, setSettingsForm] = useState<WorkspaceForm>(emptyWorkspaceForm);
  const [comment, setComment] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [calendarTaskId, setCalendarTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"board" | "list">("board");
  const [projectQuery, setProjectQuery] = useState("");
  const [projectCategory, setProjectCategory] = useState<"todas" | ProjectCategory>("todas");
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [filters, setFilters] = useState({
    status: "todas",
    category: "todas",
    priority: "todas",
    label: "todas",
    due: "todas",
    q: "",
  });
  const taskRequestVersion = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectMembers = teamMembers.filter((member) => activeWorkspace && (
    member.id === (activeWorkspace.ownerUserId || userId) || (activeWorkspace.sharedUserIds || []).includes(member.id)
  ));
  const activeWorkspaces = useMemo(() => workspaces.filter((workspace) => !workspace.archived), [workspaces]);
  const visibleProjects = activeWorkspaces.filter(workspace => (
    (projectCategory === "todas" || workspace.category === projectCategory)
    && [workspace.name, workspace.description, workspace.responsibleName].join(" ").toLocaleLowerCase("pt-BR").includes(projectQuery.toLocaleLowerCase("pt-BR"))
  ));
  const personalProjects = visibleProjects.filter((workspace) => !workspace.ownerUserId || workspace.ownerUserId === userId);
  const teamProjects = visibleProjects.filter((workspace) => Boolean(workspace.ownerUserId && workspace.ownerUserId !== userId));
  const archivedWorkspaces = useMemo(() => workspaces.filter((workspace) => workspace.archived), [workspaces]);

  function switchProject(workspace: TaskWorkspace | null) {
    taskRequestVersion.current += 1;
    setSelectedTask(null);
    setTasks([]);
    setColumns([]);
    setLabels([]);
    setLoading(Boolean(workspace));
    setShowCreate(false);
    setShowProjectSettings(false);
    setMobileSidebarOpen(false);
    setError("");
    setNotice("");
    setFilters({ status: "todas", category: "todas", priority: "todas", label: "todas", due: "todas", q: "" });
    setActiveWorkspace(workspace);
  }

  const canManageProject = useCallback(
    (workspace: TaskWorkspace | null) => Boolean(workspace && (!workspace.ownerUserId || workspace.ownerUserId === userId)),
    [userId],
  );

  const memberName = useCallback(
    (memberId: string) => teamMembers.find((member) => member.id === memberId)?.nome || userName,
    [teamMembers, userName],
  );

  const loadProjects = useCallback(async () => {
    setError("");
    try {
      const data = await tasksApiRequest<{ projects?: TaskWorkspace[] }>(`/projetos?user_id=${userId}`, {
        cache: "no-store",
      });
      const projects = (data.projects || []) as TaskWorkspace[];
      setWorkspaces(projects);
      setActiveWorkspace((current) => {
        if (!current) return current;
        return projects.find((project) => project.id === current.id) || null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar projetos.");
    } finally { setProjectsLoading(false); }
  }, [userId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    tasksApiRequest<{ templates?: ProjectTemplate[] }>("/modelos-projeto", { cache: "no-store" })
      .then((data) => setProjectTemplates(data.templates || []))
      .catch(() => setProjectTemplates([]));
  }, []);

  useEffect(() => {
    async function loadTeamMembers() {
      try {
        const data = await authJson<{ users: NoriumUser[] }>("/api/auth/users", session.token);
        const users = data.users?.length ? data.users : [session.user];
        setTeamMembers(users);
      } catch {
        setTeamMembers([session.user]);
      }
    }

    void loadTeamMembers();
  }, [session]);

  useEffect(() => {
    setWorkspaceForm((current) => ({
      ...current,
      owner: current.owner || userName,
      responsibleUserId: current.responsibleUserId || userId,
      responsibleName: current.responsibleName || userName,
    }));
  }, [userId, userName]);

  useEffect(() => {
    setSelectedTask(null);
    setShowCreate(false);
    setShowProjectSettings(false);
    setSettingsProjectId(null);
    setComment("");
    setForm(activeWorkspace ? {
      ...emptyForm,
      category: activeWorkspace.category,
      priority: activeWorkspace.defaultPriority,
      assigneeId: activeWorkspace.responsibleUserId || userId,
    } : emptyForm);
    setSettingsForm(activeWorkspace ? workspaceToForm(activeWorkspace) : emptyWorkspaceForm);
  }, [activeWorkspace, userId]);

  async function createWorkspace() {
    const name = workspaceForm.name.trim();
    if (!name) return;
    setError("");
    try {
      const data = await tasksApiRequest<{ project: TaskWorkspace }>("/projetos", {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          ...workspaceForm,
          name,
          description: workspaceForm.description.trim() || "Nova lista de tarefas criada no Norium.",
          owner: workspaceForm.owner.trim() || userName,
          responsibleName: memberName(workspaceForm.responsibleUserId || userId),
        }),
      });
      const workspace = data.project as TaskWorkspace;
      setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
      setActiveWorkspace(workspace);
      setWorkspaceForm({
        ...emptyWorkspaceForm,
        owner: userName,
        responsibleUserId: userId,
        responsibleName: userName,
      });
      setShowWorkspaceCreate(false);
      setNotice(`Projeto "${workspace.name}" criado.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar projeto.");
    }
  }

  function selectProjectTemplate(templateId: string) {
    if (templateId === "custom") {
      setWorkspaceForm((current) => ({
        ...current,
        templateId,
        workflowColumns: [
          { id: "pendente", title: "Primeira etapa", limit: null },
          { id: "etapa_2", title: "Em andamento", limit: null },
          { id: "concluida", title: "Etapa final", limit: null },
        ],
      }));
      return;
    }
    const template = projectTemplates.find((item) => item.id === templateId);
    setWorkspaceForm((current) => ({
      ...current,
      templateId,
      workflowColumns: template?.columns?.map((column) => ({ ...column })) || standardWorkflow,
    }));
  }

  function resizeCustomWorkflow(quantity: number) {
    const size = Math.max(2, Math.min(12, quantity || 2));
    setWorkspaceForm((current) => {
      const workflowColumns = Array.from({ length: size }, (_, index) => {
        const existing = current.workflowColumns[index];
        return existing || {
          id: index === 0 ? "pendente" : index === size - 1 ? "concluida" : `etapa_${index + 1}`,
          title: `Etapa ${index + 1}`,
          limit: null,
        };
      }).map((column, index) => ({
        ...column,
        id: index === 0 ? "pendente" : index === size - 1 ? "concluida" : `etapa_${index + 1}`,
      }));
      return { ...current, workflowColumns };
    });
  }

  function openProjectSettings(workspace: TaskWorkspace) {
    setSettingsProjectId(workspace.id);
    setSettingsForm(workspaceToForm(workspace));
    setShowProjectSettings(true);
  }

  async function saveProjectSettings() {
    const targetId = settingsProjectId || activeWorkspace?.id;
    const target = workspaces.find((workspace) => workspace.id === targetId) || activeWorkspace;
    if (!target) return;
    if (!canManageProject(target)) {
      setError("Somente o usuário principal dono do projeto pode alterar configurações e compartilhamento.");
      return;
    }
    try {
      const data = await tasksApiRequest<{ project: TaskWorkspace }>(`/projetos/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          user_id: userId,
          ...settingsForm,
          name: settingsForm.name.trim() || target.name,
          description: settingsForm.description.trim() || "Lista de tarefas do Norium.",
          owner: settingsForm.owner.trim() || userName,
          responsibleName: memberName(settingsForm.responsibleUserId || userId),
        }),
      });
      const updated = data.project as TaskWorkspace;
      setWorkspaces((current) => current.map((workspace) => (workspace.id === updated.id ? updated : workspace)));
      if (activeWorkspace?.id === updated.id) {
        setActiveWorkspace(updated);
        setForm((current) => ({ ...current, category: updated.category, priority: updated.defaultPriority }));
      }
      setShowProjectSettings(false);
      setSettingsProjectId(null);
      setNotice("Configurações do projeto salvas.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar projeto.");
    }
  }

  async function confirmProjectAction() {
    if (!pendingProjectAction) return;
    const { type, workspace } = pendingProjectAction;
    setPendingProjectAction(null);
    setError("");
    setNotice("");

    if (type === "archive") {
      if (!canManageProject(workspace)) {
        setError("Somente o dono do projeto pode arquivar.");
        return;
      }
      try {
        const data = await tasksApiRequest<{ project: TaskWorkspace }>(`/projetos/${workspace.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            user_id: userId,
            archived: true,
            archivedAt: new Date().toISOString(),
            status: workspace.status === "concluido" ? workspace.status : "pausado",
          }),
        });
        const archivedWorkspace = data.project as TaskWorkspace;
        setWorkspaces((current) => current.map((item) => (item.id === workspace.id ? archivedWorkspace : item)));
        if (activeWorkspace?.id === workspace.id) setActiveWorkspace(null);
        setNotice(`Projeto "${workspace.name}" arquivado.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Não consegui arquivar o projeto.");
        return;
      }
      return;
    }

    if (type === "restore") {
      if (!canManageProject(workspace)) {
        setError("Somente o dono do projeto pode restaurar.");
        return;
      }
      try {
        const data = await tasksApiRequest<{ project: TaskWorkspace }>(`/projetos/${workspace.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            user_id: userId,
            archived: false,
            archivedAt: null,
            status: workspace.status === "pausado" ? "ativo" : workspace.status,
          }),
        });
        const restoredWorkspace = data.project as TaskWorkspace;
        setWorkspaces((current) => current.map((item) => (item.id === workspace.id ? restoredWorkspace : item)));
        setNotice(`Projeto "${workspace.name}" restaurado.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Não consegui restaurar o projeto.");
        return;
      }
      return;
    }

    if (!canManageProject(workspace)) {
      setError("Somente o dono do projeto pode excluir.");
      return;
    }
    try {
      await tasksApiRequest(`/projetos/${workspace.id}?user_id=${userId}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao excluir projeto.");
      return;
    }

    setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
    if (activeWorkspace?.id === workspace.id) setActiveWorkspace(null);
    setNotice(`Projeto "${workspace.name}" excluído.`);
  }

  const loadTasks = useCallback(async () => {
    const version = ++taskRequestVersion.current;
    if (!activeWorkspace) {
      setTasks([]);
      setSelectedTask(null);
      if (version === taskRequestVersion.current) setLoading(false);
      return;
    }
    const params = new URLSearchParams({ user_id: userId, project_id: activeWorkspace.id });
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });

    try {
      setError("");
      setLoading(true);
      const data = await tasksApiRequest<{
        tasks?: TaskItem[];
        columns?: TaskColumn[];
        labels?: TaskLabel[];
        stats?: TaskStats;
      }>(`?${params.toString()}`, { cache: "no-store" });
      if (version !== taskRequestVersion.current) return;
      setTasks(data.tasks || []);
      setColumns(data.columns || []);
      setLabels(data.labels || []);
      setStats(data.stats || { total: 0, ativas: 0, pendentes: 0, andamento: 0, concluidas: 0, vencidas: 0 });
      setSelectedTask((current) => {
        if (!current) return current;
        return (data.tasks || []).find((task: TaskItem) => task.id === current.id) || null;
      });
    } catch (err) {
      if (version === taskRequestVersion.current) setError(err instanceof Error ? err.message : "Falha ao carregar tarefas.");
    } finally {
      if (version === taskRequestVersion.current) setLoading(false);
    }
  }, [activeWorkspace, filters, userId]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const handler = () => void loadTasks();
    window.addEventListener("tasks:changed", handler);
    return () => window.removeEventListener("tasks:changed", handler);
  }, [loadTasks]);

  const tasksByColumn = useMemo(() => {
    const grouped: Record<string, TaskItem[]> = Object.fromEntries(columns.map((column) => [column.id, []]));
    tasks.forEach((task) => (grouped[task.status] ||= []).push(task));
    Object.values(grouped).forEach((items) => items.sort((a, b) => a.order - b.order));
    return grouped;
  }, [tasks]);

  async function createNewTask() {
    if (!activeWorkspace) return;
    try {
      const data = await tasksApiRequest<{ task: TaskItem }>("", {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          projectId: activeWorkspace.id,
          projectName: activeWorkspace.name,
          title: form.title,
          description: form.description,
          category: form.category,
          priority: form.priority,
          dueDate: form.dueDate || null,
          assigneeId: form.assigneeId || activeWorkspace.responsibleUserId || userId,
          assigneeName: memberName(form.assigneeId || activeWorkspace.responsibleUserId || userId),
          labels: form.labels,
          status: columns[0]?.id || "pendente",
        }),
      });
      setForm({
        ...emptyForm,
        category: activeWorkspace.category,
        priority: activeWorkspace.defaultPriority,
        assigneeId: activeWorkspace.responsibleUserId || userId,
      });
      setShowCreate(false);
      setSelectedTask(data.task);
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui criar a tarefa.");
    }
  }

  async function detailTaskDescription() {
    if (!activeWorkspace || !form.title.trim()) return;
    setError("");
    try {
      const response = await tasksApiRequest<{ description: string; comment: string }>("/nora/detalhar-descricao", {
        method: "POST",
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description.trim(),
          category: form.category,
          projectName: activeWorkspace.name,
        }),
      });
      setForm((current) => ({ ...current, description: response.description }));
      setNotice(response.comment || "A Nora detalhou a descrição da tarefa.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "A Nora não conseguiu detalhar a tarefa.");
    }
  }

  async function patchTask(taskId: string, updates: Partial<TaskItem>) {
    try {
      const data = await tasksApiRequest<{ task: TaskItem }>(`/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({
          user_id: userId,
          projectName: activeWorkspace?.name,
          ...updates,
          ...(updates.assigneeId ? { assigneeName: memberName(String(updates.assigneeId)) } : {}),
        }),
      });
      await loadTasks();
      return data.task as TaskItem;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui atualizar a tarefa.");
      return null;
    }
  }

  async function deleteSelectedTask() {
    if (!selectedTask) return;
    const projectId = activeWorkspace?.id || selectedTask.projectId || "default";
    const projectName = activeWorkspace?.name || projectId;
    try {
      await tasksApiRequest(
        `/${selectedTask.id}?user_id=${userId}&project_id=${encodeURIComponent(projectId)}&project_name=${encodeURIComponent(projectName)}`,
        { method: "DELETE" },
      );
      setSelectedTask(null);
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui apagar a tarefa.");
    }
  }

  async function addComment() {
    if (!selectedTask || !comment.trim()) return;
    try {
      await tasksApiRequest(`/${selectedTask.id}/comentarios`, {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          projectId: activeWorkspace?.id || selectedTask.projectId || "default",
          projectName: activeWorkspace?.name,
          author: userName,
          text: comment.trim(),
        }),
      });
      setComment("");
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui comentar.");
    }
  }

  async function uploadAttachment(file: File) {
    if (!selectedTask) return;
    const dataUrl = await readFileAsDataUrl(file);
    try {
      await tasksApiRequest(`/${selectedTask.id}/anexos`, {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          projectId: activeWorkspace?.id || selectedTask.projectId || "default",
          projectName: activeWorkspace?.name,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          data_url: dataUrl,
        }),
      });
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui anexar o arquivo.");
    }
  }

  async function addTaskToGoogleCalendar(task: TaskItem) {
    if (!activeWorkspace) return;
    if (!task.dueDate) {
      setError("Defina uma data de vencimento antes de enviar para o Google Agenda.");
      return;
    }

    setCalendarTaskId(task.id);
    setError("");
    setNotice("");

    const start = new Date(`${task.dueDate}T${activeWorkspace.defaultStartTime || "09:00"}:00`);
    const end = new Date(start.getTime() + (activeWorkspace.calendarDurationMinutes || 60) * 60 * 1000);
    const categoryLabel = taskCategoryOptions.find((category) => category.id === task.category)?.label || task.category;

    try {
      await calendarApiRequest("/eventos", {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          titulo: `[${activeWorkspace.name}] ${task.title}`,
          inicio: start.toISOString(),
          fim: end.toISOString(),
          descricao: [
            task.description || "Tarefa criada no Norium.",
            "",
            `Projeto: ${activeWorkspace.name}`,
            `Categoria: ${categoryLabel}`,
            `Prioridade: ${task.priority}`,
          ].join("\n"),
          local: "",
          participantes: [],
          criar_meet: false,
        }),
      });
      setNotice("Tarefa adicionada ao Google Agenda.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao adicionar tarefa no Google Agenda.");
    } finally {
      setCalendarTaskId(null);
    }
  }

  function handleDrop(status: TaskStatus) {
    if (!draggedId) return;
    const order = (tasksByColumn[status]?.length || 0) + 1;
    void patchTask(draggedId, { status, order } as Partial<TaskItem>);
    setDraggedId(null);
  }

  function toggleFormLabel(labelId: string) {
    setForm((current) => ({
      ...current,
      labels: current.labels.includes(labelId)
        ? current.labels.filter((item) => item !== labelId)
        : [...current.labels, labelId],
    }));
  }

  function openNewTask() {
    setForm({ ...emptyForm, category: activeWorkspace?.category || "geral", priority: activeWorkspace?.defaultPriority || "media", assigneeId: activeWorkspace?.responsibleUserId || userId });
    setShowCreate(true);
  }
  const filterCount = [filters.status !== "todas", filters.priority !== "todas", filters.category !== "todas", filters.due !== "todas", filters.label !== "todas"].filter(Boolean).length;

  useEffect(() => {
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showCreate) setShowCreate(false);
      else if (showWorkspaceCreate) setShowWorkspaceCreate(false);
      else if (showProjectSettings) setShowProjectSettings(false);
      else if (pendingProjectAction) setPendingProjectAction(null);
      else if (mobileSidebarOpen) setMobileSidebarOpen(false);
      else setSelectedTask(null);
    };
    window.addEventListener("keydown", closeOverlay);
    return () => window.removeEventListener("keydown", closeOverlay);
  }, [showCreate, showWorkspaceCreate, showProjectSettings, pendingProjectAction, mobileSidebarOpen]);

  const projectOverlays = (
    <>
      {showProjectSettings && (
        <ProjectSettingsModal
          form={settingsForm}
          setForm={setSettingsForm}
          teamMembers={teamMembers}
          ownerUserId={userId}
          onClose={() => {
            setShowProjectSettings(false);
            setSettingsProjectId(null);
          }}
          onSubmit={() => void saveProjectSettings()}
        />
      )}

      {pendingProjectAction && (
        <ProjectActionConfirmModal
          action={pendingProjectAction.type}
          workspace={pendingProjectAction.workspace}
          onCancel={() => setPendingProjectAction(null)}
          onConfirm={() => void confirmProjectAction()}
        />
      )}
    </>
  );

  const renderProjectCard = (workspace: TaskWorkspace) => {
    const responsible = workspace.responsibleName || workspace.owner;
    return <article key={workspace.id} className="tasks-project-card nx-card" style={{ "--project-color": workspace.color } as React.CSSProperties}>
      <div className="tasks-project-top">
        <span className="tasks-project-dot" aria-hidden="true" />
        <button type="button" className="tasks-project-title" onClick={() => setActiveWorkspace(workspace)}>{workspace.name}</button>
        <details className="tasks-project-menu"><summary aria-label={"Ações de " + workspace.name}><MoreHorizontal size={16} /></summary><div>
          <button type="button" disabled={!canManageProject(workspace)} onClick={() => openProjectSettings(workspace)}><Settings size={15} />Configurações</button>
          <button type="button" disabled={!canManageProject(workspace)} onClick={() => setPendingProjectAction({ type: "archive", workspace })}><Archive size={15} />Arquivar</button>
          <button type="button" className="is-danger" disabled={!canManageProject(workspace)} onClick={() => setPendingProjectAction({ type: "delete", workspace })}><Trash2 size={15} />Excluir projeto</button>
        </div></details>
      </div>
      <div className="tasks-project-badges">
        <span className="nx-badge">{projectCategoryLabels[workspace.category]}</span>
        <span className={`nx-badge ${projectStatusTone[workspace.status] || ""}`}>{projectStatusLabels[workspace.status]}</span>
      </div>
      <p className="tasks-project-description" title={workspace.description || undefined}>{workspace.description || "Organize as próximas entregas deste projeto."}</p>
      <span className={`tasks-project-deadline nx-small ${projectDeadlineTone(workspace)}`}><CalendarClock size={14} />{projectDateRange(workspace)}</span>
      <footer>
        <span className="tasks-project-owner"><Avatar userId={workspace.responsibleUserId || workspace.ownerUserId} name={responsible} size={24} /><span className="nx-ell">{responsible}</span></span>
        <button type="button" className="tasks-project-open" onClick={() => setActiveWorkspace(workspace)}>Abrir projeto <ArrowUpRight size={14} /></button>
      </footer>
    </article>;
  };

  const sharedMembers = teamMembers.filter((member) => member.id !== userId);
  const templateOptions = projectTemplates.length ? projectTemplates : [{ id: "standard", name: "Projeto padrão", description: "", columns: standardWorkflow }];

  const newProjectModal = showWorkspaceCreate && (
    <ModalShell
      title="Novo projeto"
      subtitle="Organize tarefas, prazos e responsáveis"
      label="Novo projeto"
      width={640}
      onClose={() => setShowWorkspaceCreate(false)}
      footer={<>
        <button type="button" className="nx-btn" onClick={() => setShowWorkspaceCreate(false)}>Cancelar</button>
        <button type="button" className="nx-btn is-primary" onClick={() => void createWorkspace()} disabled={!workspaceForm.name.trim()}>Criar projeto</button>
      </>}
    >
      <Field label="Nome do projeto" required>
        <input
          className="tasks-control"
          value={workspaceForm.name}
          onChange={(event) => setWorkspaceForm({ ...workspaceForm, name: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") void createWorkspace();
          }}
          placeholder="Nome do projeto"
          autoFocus
        />
      </Field>
      <Field label="Descrição">
        <textarea
          className="tasks-control"
          value={workspaceForm.description}
          onChange={(event) => setWorkspaceForm({ ...workspaceForm, description: event.target.value })}
          placeholder="Descrição do projeto"
          rows={3}
        />
      </Field>
      <div className="tasks-form-grid">
        <Field label="Categoria">
          <Select value={workspaceForm.category} onChange={(value) => setWorkspaceForm({ ...workspaceForm, category: value as ProjectCategory })}>
            {Object.entries(projectCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={workspaceForm.status} onChange={(value) => setWorkspaceForm({ ...workspaceForm, status: value as ProjectStatus })}>
            {Object.entries(projectStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>
        <Field label="Responsável">
          <Select value={workspaceForm.responsibleUserId} onChange={(value) => setWorkspaceForm({ ...workspaceForm, responsibleUserId: value, responsibleName: memberName(value) })}>
            {teamMembers.map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}
          </Select>
        </Field>
        <Field label="Prioridade padrão">
          <Select value={workspaceForm.defaultPriority} onChange={(value) => setWorkspaceForm({ ...workspaceForm, defaultPriority: value as TaskPriority })}>
            <option value="baixa">Baixa</option>
            <option value="media">Média</option>
            <option value="alta">Alta</option>
            <option value="urgente">Urgente</option>
          </Select>
        </Field>
        <Field label="Início">
          <input type="date" className="tasks-control" value={workspaceForm.startDate} onChange={(event) => setWorkspaceForm({ ...workspaceForm, startDate: event.target.value })} title="Início do projeto" />
        </Field>
        <Field label="Prazo final">
          <input type="date" className="tasks-control" value={workspaceForm.dueDate} onChange={(event) => setWorkspaceForm({ ...workspaceForm, dueDate: event.target.value })} title="Prazo final" />
        </Field>
        <Field label="Horário padrão na agenda">
          <input type="time" className="tasks-control" value={workspaceForm.defaultStartTime} onChange={(event) => setWorkspaceForm({ ...workspaceForm, defaultStartTime: event.target.value })} title="Horário padrão da agenda" />
        </Field>
        <Field label="Duração padrão (min)">
          <input type="number" min={15} step={15} className="tasks-control" value={workspaceForm.calendarDurationMinutes} onChange={(event) => setWorkspaceForm({ ...workspaceForm, calendarDurationMinutes: Number(event.target.value) })} title="Duração padrão em minutos" />
        </Field>
      </div>
      <Field label="Nome exibido do responsável">
        <input className="tasks-control" value={workspaceForm.owner} onChange={(event) => setWorkspaceForm({ ...workspaceForm, owner: event.target.value })} placeholder="Responsável" />
      </Field>
      <FieldGroup label="Modelo do quadro">
        <div className="tasks-template-grid" role="group" aria-label="Modelo do Kanban">
          {templateOptions.map((template) => (
            <button key={template.id} type="button" className="tasks-template" aria-pressed={workspaceForm.templateId === template.id} onClick={() => selectProjectTemplate(template.id)}>
              <b>{template.name}</b>
              <span>{template.columns?.map((column) => column.title).join(" · ") || template.description}</span>
            </button>
          ))}
          <button type="button" className="tasks-template" aria-pressed={workspaceForm.templateId === "custom"} onClick={() => selectProjectTemplate("custom")}>
            <b>Criar do zero</b>
            <span>Crie suas próprias etapas</span>
          </button>
        </div>
        {workspaceForm.templateId === "custom" && (
          <div className="tasks-custom-steps">
            <Field label="Quantidade de etapas">
              <input
                type="number"
                min={2}
                max={12}
                className="tasks-control"
                value={workspaceForm.workflowColumns.length}
                onChange={(event) => resizeCustomWorkflow(Number(event.target.value))}
              />
            </Field>
            {workspaceForm.workflowColumns.map((column, index) => (
              <Field key={`${column.id}-${index}`} label={`Etapa ${index + 1}`}>
                <input
                  className="tasks-control"
                  value={column.title}
                  maxLength={80}
                  onChange={(event) => setWorkspaceForm((current) => ({
                    ...current,
                    workflowColumns: current.workflowColumns.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item),
                  }))}
                  placeholder={`Nome da etapa ${index + 1}`}
                />
              </Field>
            ))}
          </div>
        )}
      </FieldGroup>
      {sharedMembers.length > 0 && (
        <FieldGroup label="Compartilhar com">
          <div className="tasks-chip-list">
            {sharedMembers.map((member) => (
              <label key={member.id} className="tasks-chip">
                <input
                  type="checkbox"
                  checked={workspaceForm.sharedUserIds.includes(member.id)}
                  onChange={() => {
                    const active = workspaceForm.sharedUserIds.includes(member.id);
                    setWorkspaceForm({
                      ...workspaceForm,
                      sharedUserIds: active
                        ? workspaceForm.sharedUserIds.filter((id) => id !== member.id)
                        : [...workspaceForm.sharedUserIds, member.id],
                    });
                  }}
                />
                <span className="nx-ell">{member.nome}</span>
              </label>
            ))}
          </div>
        </FieldGroup>
      )}
      <FieldGroup label="Cor do projeto">
        <ColorPicker value={workspaceForm.color} onChange={(color) => setWorkspaceForm({ ...workspaceForm, color })} />
      </FieldGroup>
    </ModalShell>
  );

  if (!activeWorkspace) {
    return (
      <ProfilePeople people={teamMembers}><div className="tasks-home">
        <div className="tasks-home-inner nx-page">
          <header className="nx-ph">
            <div>
              <h1>Projetos</h1>
              <p>{projectsLoading ? "Carregando projetos…" : `${countLabel(activeWorkspaces.length, "projeto ativo", "projetos ativos")} · ${countLabel(archivedWorkspaces.length, "arquivado", "arquivados")}`}</p>
            </div>
            <div className="nx-ph-actions">
              <label className="nx-input tasks-search"><Search size={16} /><input value={projectQuery} onChange={event => setProjectQuery(event.target.value)} placeholder="Buscar projeto" aria-label="Buscar projetos" />{projectQuery && <button type="button" onClick={() => setProjectQuery("")} aria-label="Limpar busca de projetos"><X size={14} /></button>}</label>
              <button type="button" className="nx-btn is-primary" onClick={() => setShowWorkspaceCreate(true)}><Plus size={16} />Novo projeto</button>
            </div>
          </header>

          {error && <p role="alert" className="tasks-feedback is-error">{error}</p>}
          {notice && <p role="status" className="tasks-feedback">{notice}</p>}

          <div className="tasks-category-row">
            <nav className="tasks-category-tabs" aria-label="Categorias de projetos">
              <button type="button" aria-pressed={projectCategory === "todas"} onClick={() => setProjectCategory("todas")}>Todas</button>
              {(Object.keys(projectCategoryLabels) as ProjectCategory[]).map((category) => <button key={category} type="button" aria-pressed={projectCategory === category} onClick={() => setProjectCategory(category)}>{projectCategoryLabels[category]}</button>)}
            </nav>
            {archivedWorkspaces.length > 0 && (
              <button
                type="button"
                role="switch"
                aria-checked={!showArchivedProjects}
                className="tasks-archived-toggle"
                title={`${countLabel(archivedWorkspaces.length, "projeto arquivado", "projetos arquivados")}`}
                onClick={() => setShowArchivedProjects((current) => !current)}
              >
                <span className="tasks-toggle" aria-hidden="true" />
                Ocultar arquivados
              </button>
            )}
          </div>

          {projectsLoading ? <div className="tasks-empty" role="status"><LoaderCircle className="animate-spin" size={20} /><p>Carregando projetos…</p></div> : (
            <section className="tasks-group" aria-labelledby="my-projects-title">
              <div className="tasks-group-head"><h2 id="my-projects-title" className="tasks-group-title">Meus projetos <span className="nx-badge">{personalProjects.length}</span></h2><span className="tasks-group-hint">Projetos particulares e criados por você.</span></div>
              {personalProjects.length > 0 && <div className="tasks-project-grid">{personalProjects.map(renderProjectCard)}</div>}
            </section>
          )}

          {!projectsLoading && visibleProjects.length === 0 && <div className="tasks-empty"><Layers3 size={28} /><h3>{projectQuery ? "Nenhum projeto encontrado" : "Seu próximo projeto começa aqui"}</h3><p>{projectQuery ? "Tente outro nome ou responsável." : "Crie um projeto e organize as primeiras tarefas da equipe."}</p><button type="button" className="nx-btn" onClick={() => projectQuery ? setProjectQuery("") : setShowWorkspaceCreate(true)}>{projectQuery ? "Limpar busca" : "Criar primeiro projeto"}</button></div>}

          {!projectsLoading && visibleProjects.length > 0 && <section className="tasks-group" aria-labelledby="team-projects-title">
            <div className="tasks-group-head"><h2 id="team-projects-title" className="tasks-group-title">Projetos da equipe <span className="nx-badge">{teamProjects.length}</span></h2><span className="tasks-group-hint">Compartilhados com você por integrantes da sua equipe.</span></div>
            {teamProjects.length > 0 ? <div className="tasks-project-grid">{teamProjects.map(renderProjectCard)}</div> : <div className="tasks-team-empty"><Users size={16} /><span>Nenhum projeto desta categoria foi compartilhado com você.</span></div>}
          </section>}

          {showArchivedProjects && archivedWorkspaces.length > 0 && (
            <section className="tasks-group" aria-labelledby="archived-projects-title">
              <div className="tasks-group-head"><h2 id="archived-projects-title" className="tasks-group-title"><Archive size={13} />Projetos arquivados <span className="nx-badge">{archivedWorkspaces.length}</span></h2></div>
              <div className="tasks-project-grid">
                {archivedWorkspaces.map((workspace) => (
                  <article key={workspace.id} className="tasks-project-card tasks-archived-card nx-card" style={{ "--project-color": workspace.color } as React.CSSProperties}>
                    <div className="tasks-project-top">
                      <span className="tasks-project-dot" aria-hidden="true" />
                      <h3 className="tasks-project-name nx-ell">{workspace.name}</h3>
                      <span className="nx-badge is-amber">Arquivado</span>
                    </div>
                    <p className="tasks-project-description" title={workspace.description || undefined}>{workspace.description}</p>
                    <div className="tasks-archived-actions">
                      <button type="button" className="nx-btn is-sm" onClick={() => openProjectSettings(workspace)}><Settings size={14} />Configurações</button>
                      <button type="button" className="nx-btn is-sm" onClick={() => setPendingProjectAction({ type: "restore", workspace })}><RotateCcw size={14} />Restaurar</button>
                      <button type="button" className="nx-btn is-sm tasks-danger-btn" onClick={() => setPendingProjectAction({ type: "delete", workspace })}><Trash2 size={14} />Excluir</button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
        {newProjectModal}
        {projectOverlays}
      </div></ProfilePeople>
    );
  }

  const columnTitle = (status: string) => columns.find((column) => column.id === status)?.title || status;
  const activeFilterChips = [
    filters.status !== "todas" && { key: "status", label: `Etapa: ${statusFilterLabels[filters.status] || columnTitle(filters.status)}` },
    filters.priority !== "todas" && { key: "priority", label: `Prioridade: ${priorityLabel(filters.priority)}` },
    filters.category !== "todas" && { key: "category", label: `Categoria: ${taskCategoryOptions.find((category) => category.id === filters.category)?.label || filters.category}` },
    filters.due !== "todas" && { key: "due", label: `Prazo: ${dueFilterLabels[filters.due] || filters.due}` },
    filters.label !== "todas" && { key: "label", label: `Etiqueta: ${labels.find((label) => label.id === filters.label)?.name || filters.label}` },
  ].filter(Boolean) as { key: keyof typeof filters; label: string }[];

  return (
    <ProfilePeople people={teamMembers}><div className={`tasks-workspace ${mobileSidebarOpen ? "mobile-sidebar-open" : ""}`}>
      {mobileSidebarOpen && (
        <button
          type="button"
          className="tasks-filter-backdrop"
          aria-label="Fechar filtros pelo fundo"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      {mobileSidebarOpen && <aside className="task-sidebar tasks-filter-panel" aria-label="Filtros do projeto">
        <div className="tasks-filter-head">
          <span><SlidersHorizontal size={16} /> Filtros do projeto</span>
          <button type="button" className="tasks-icon-btn is-plain" onClick={() => setMobileSidebarOpen(false)} aria-label="Fechar filtros do projeto">
            <X size={18} />
          </button>
        </div>
        <button
          type="button"
          className="nx-btn"
          onClick={() => {
            setMobileSidebarOpen(false);
            setActiveWorkspace(null);
          }}
        >
          <ArrowLeft size={15} />
          Trocar projeto
        </button>
        <label className="nx-input tasks-search is-full">
          <Search size={15} />
          <input
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            placeholder="Buscar"
            aria-label="Buscar nos filtros"
          />
        </label>
        <Field label="Etapa">
          <Select label="Filtrar por etapa" value={filters.status} onChange={(value) => setFilters({ ...filters, status: value })}>
            <option value="ativas">Ativas</option>
            <option value="pendente">Pendentes</option>
            <option value="andamento">Em andamento</option>
            <option value="revisao">Em revisão</option>
            <option value="concluida">Concluídas</option>
            <option value="todas">Todas</option>
          </Select>
        </Field>
        <Field label="Prioridade">
          <Select label="Filtrar por prioridade" value={filters.priority} onChange={(value) => setFilters({ ...filters, priority: value })}>
            <option value="todas">Todas prioridades</option>
            <option value="urgente">Urgente</option>
            <option value="alta">Alta</option>
            <option value="media">Média</option>
            <option value="baixa">Baixa</option>
          </Select>
        </Field>
        <Field label="Categoria">
          <Select label="Filtrar por categoria" value={filters.category} onChange={(value) => setFilters({ ...filters, category: value })}>
            <option value="todas">Todas categorias</option>
            {taskCategoryOptions.map((category) => (
              <option key={category.id} value={category.id}>{category.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Prazo">
          <Select label="Filtrar por prazo" value={filters.due} onChange={(value) => setFilters({ ...filters, due: value })}>
            <option value="todas">Todos vencimentos</option>
            <option value="vencidas">Vencidas</option>
            <option value="hoje">Hoje</option>
            <option value="semana">Próximos 7 dias</option>
          </Select>
        </Field>
        <Field label="Etiqueta">
          <Select label="Filtrar por etiqueta" value={filters.label} onChange={(value) => setFilters({ ...filters, label: value })}>
            <option value="todas">Todas etiquetas</option>
            {labels.map((label) => (
              <option key={label.id} value={label.id}>{label.name}</option>
            ))}
          </Select>
        </Field>

        <FieldGroup label="Etiquetas">
          <div className="tasks-chip-list">
            {labels.map((label) => (
              <button
                key={label.id}
                type="button"
                className="tasks-chip"
                aria-pressed={filters.label === label.id}
                onClick={() => setFilters({ ...filters, label: label.id })}
              >
                <span className="tasks-label-dot" style={{ backgroundColor: label.color }} />
                {label.name}
              </button>
            ))}
          </div>
        </FieldGroup>
      </aside>}

      <main className="tasks-board-main">
        <nav className="tasks-project-navigation" aria-label="Navegação entre projetos">
          <button type="button" className="nx-btn is-ghost is-sm" onClick={() => switchProject(null)}><ArrowLeft size={16} />Voltar aos projetos</button>
          <label className="tasks-switch-project"><span>Trocar projeto</span><select className="tasks-control is-sm" value={activeWorkspace.id} onChange={(event) => {
            const workspace = activeWorkspaces.find((item) => item.id === event.target.value);
            if (workspace && workspace.id !== activeWorkspace.id) switchProject(workspace);
          }}>{activeWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
        </nav>

        <header className="nx-ph tasks-board-heading">
          <div className="tasks-board-title">
            <h1><span className="tasks-project-dot is-lg" style={{ background: activeWorkspace.color }} aria-hidden="true" />{activeWorkspace.name}</h1>
            <p className="tasks-board-stats">
              {countLabel(stats.total, "tarefa", "tarefas")} · {countLabel(stats.ativas, "ativa", "ativas")} · {stats.andamento || 0} em andamento · {countLabel(stats.concluidas, "concluída", "concluídas")} · <span className={stats.vencidas > 0 ? "tasks-overdue" : ""}>{countLabel(stats.vencidas, "vencida", "vencidas")}</span>
              {activeWorkspace.dueDate && <> · prazo {dateLabel(activeWorkspace.dueDate)}</>}
            </p>
            <p className="tasks-board-description">{activeWorkspace.description || "Organize as entregas e acompanhe cada etapa."}</p>
          </div>
          <div className="nx-ph-actions">
            <div className="nx-seg" role="group" aria-label="Visualização das tarefas">
              <button type="button" className={view === "board" ? "is-active" : ""} aria-pressed={view === "board"} onClick={() => setView("board")}>Quadro</button>
              <button type="button" className={view === "list" ? "is-active" : ""} aria-pressed={view === "list"} onClick={() => setView("list")}>Lista</button>
            </div>
            <button type="button" className="nx-btn" aria-expanded={mobileSidebarOpen} onClick={() => setMobileSidebarOpen(!mobileSidebarOpen)}><ListFilter size={16} />Filtros{filterCount > 0 && <span className="nx-badge is-blue tasks-filter-count">{filterCount}</span>}</button>
            <button type="button" className="tasks-icon-btn" aria-label="Configurações do projeto" title="Configurações do projeto" disabled={!canManageProject(activeWorkspace)} onClick={() => openProjectSettings(activeWorkspace)}><Settings size={16} /></button>
            <button type="button" className="nx-btn is-primary" onClick={openNewTask}><Plus size={16} />Nova tarefa</button>
          </div>
        </header>

        <div className="tasks-board-toolbar">
          <label className="nx-input tasks-search"><Search size={16} /><input aria-label="Buscar tarefas" placeholder="Buscar tarefas" value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label>
          {activeFilterChips.map((chip) => (
            <button key={chip.key} type="button" className="nx-badge is-blue tasks-filter-chip" aria-label={`Remover filtro ${chip.label}`} onClick={() => setFilters({ ...filters, [chip.key]: "todas" })}>
              {chip.label}<X size={12} />
            </button>
          ))}
          {filterCount > 0 && <button type="button" className="tasks-clear-filters" onClick={() => setFilters({ status: "todas", category: "todas", priority: "todas", label: "todas", due: "todas", q: "" })}>Limpar</button>}
          {loading && <p role="status" className="tasks-loading"><LoaderCircle size={13} className="animate-spin" /> Atualizando tarefas…</p>}
        </div>

        {error && <p role="alert" className="tasks-feedback is-error">{error}</p>}
        {notice && <p role="status" className="tasks-feedback">{notice}</p>}

        {view === "board" ? <div className="tasks-kanban-scroll">
          <div
            className="tasks-kanban-grid"
            style={{ minWidth: `${Math.max(columns.length, 1) * 274}px`, gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(260px, 1fr))` }}
          >
            {columns.map((column) => (
              <KanbanColumn
                key={column.id}
                column={column}
                tasks={tasksByColumn[column.id] || []}
                labels={labels}
                selectedTaskId={selectedTask?.id}
                onSelect={setSelectedTask}
                onDragStart={setDraggedId}
                onDrop={handleDrop}
              />
            ))}
          </div>
        </div> : <div className="tasks-list-scroll nx-card">
          <div className="tasks-list-heading"><span aria-hidden="true" /><span>Tarefa</span><span>Etapa</span><span>Prioridade</span><span>Prazo</span><span>Responsável</span></div>
          {tasks.map(task => (
            <button type="button" className={`tasks-list-row ${selectedTask?.id === task.id ? "is-selected" : ""}`} key={task.id} onClick={() => setSelectedTask(task)}>
              <span className={`tasks-chk ${task.status === "concluida" ? "is-done" : ""}`} aria-hidden="true" />
              <span className="tasks-list-title"><strong>{task.title}</strong></span>
              <span><span className={`nx-badge ${columnTone(task.status)}`}>{columnTitle(task.status)}</span></span>
              <span><span className={`nx-badge ${priorityTone[task.priority] || ""}`}>{priorityLabel(task.priority)}</span></span>
              <span className={isOverdue(task) ? "tasks-overdue" : "nx-muted"}>{dateLabel(task.dueDate)}</span>
              <span className="tasks-list-assignee">{task.assigneeName ? <><Avatar userId={task.assigneeId} name={task.assigneeName} size={26} /><span className="nx-ell">{task.assigneeName}</span></> : "Sem responsável"}</span>
            </button>
          ))}
          {!tasks.length && <div className="tasks-empty is-inline"><ListTodo size={24} /><p>{loading ? "Carregando tarefas…" : "Nenhuma tarefa nesta seleção."}</p></div>}
        </div>}
      </main>

      {selectedTask && (
        <TaskDetails
          task={selectedTask}
          projectName={activeWorkspace.name}
          columns={columns}
          labels={labels}
          teamMembers={projectMembers}
          comment={comment}
          setComment={setComment}
          onClose={() => setSelectedTask(null)}
          onPatch={(updates) => void patchTask(selectedTask.id, updates)}
          onDelete={() => void deleteSelectedTask()}
          onAddComment={() => void addComment()}
          onAddToCalendar={(task) => void addTaskToGoogleCalendar(task)}
          calendarLoading={calendarTaskId === selectedTask.id}
          fileInputRef={fileInputRef}
          onUpload={(file) => void uploadAttachment(file)}
        />
      )}

      {projectOverlays}

      {showCreate && (
        <CreateTaskModal
          form={form}
          projectName={activeWorkspace.name}
          labels={labels}
          teamMembers={projectMembers}
          setForm={setForm}
          toggleLabel={toggleFormLabel}
          onDetailWithNora={detailTaskDescription}
          onClose={() => setShowCreate(false)}
          onSubmit={() => void createNewTask()}
        />
      )}
    </div></ProfilePeople>
  );
}

function Field({ label, required = false, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="tasks-field">
      <span className="tasks-field-label">{label}{required && <span className="tasks-required"> *</span>}</span>
      {children}
    </label>
  );
}

function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tasks-field">
      <span className="tasks-field-label">{label}</span>
      {children}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="tasks-colors">
      {projectColorOptions.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className="tasks-color"
          aria-pressed={value === color}
          style={{ backgroundColor: color }}
          title={color}
          aria-label={color}
        />
      ))}
    </div>
  );
}

function ModalShell({
  title,
  subtitle,
  label,
  width = 600,
  onClose,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  label: string;
  width?: number;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label={label} className="tasks-modal">
      <div className="tasks-modal-box" style={{ maxWidth: width }}>
        <header>
          <div className="nx-grow">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="tasks-icon-btn is-plain" onClick={onClose} aria-label="Fechar painel">
            <X size={18} />
          </button>
        </header>
        <div className="tasks-modal-body">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  );
}

function ProjectActionConfirmModal({
  action,
  workspace,
  onCancel,
  onConfirm,
}: {
  action: ProjectAction;
  workspace: TaskWorkspace;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const config = {
    archive: {
      title: "Arquivar projeto",
      description: "O projeto sai da área ativa, mas continua disponível em Projetos arquivados para restaurar depois.",
      confirm: "Arquivar",
      icon: Archive,
      button: "is-primary",
    },
    restore: {
      title: "Restaurar projeto",
      description: "O projeto volta para a lista principal e pode ser aberto novamente no Kanban.",
      confirm: "Restaurar",
      icon: RotateCcw,
      button: "is-primary",
    },
    delete: {
      title: "Excluir projeto",
      description: "Esta ação remove o projeto da lista e tenta apagar também as tarefas ligadas a ele. Não dá para desfazer pela interface.",
      confirm: "Excluir definitivamente",
      icon: Trash2,
      button: "is-primary tasks-danger-fill",
    },
  }[action];
  const Icon = config.icon;

  return (
    <ModalShell
      title={config.title}
      subtitle={config.description}
      label={config.title}
      width={480}
      onClose={onCancel}
      footer={<>
        <button type="button" className="nx-btn" onClick={onCancel}>Cancelar</button>
        <button type="button" className={`nx-btn ${config.button}`} onClick={onConfirm}>{config.confirm}</button>
      </>}
    >
      <p className="tasks-confirm-target"><Icon size={16} />{workspace.name}</p>
    </ModalShell>
  );
}

function Select({ value, onChange, children, label }: { value: string; onChange: (value: string) => void; children: ReactNode; label?: string }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="tasks-control"
    >
      {children}
    </select>
  );
}

function KanbanColumn({
  column,
  tasks,
  labels,
  selectedTaskId,
  onSelect,
  onDragStart,
  onDrop,
}: {
  column: TaskColumn;
  tasks: TaskItem[];
  labels: TaskLabel[];
  selectedTaskId?: string;
  onSelect: (task: TaskItem) => void;
  onDragStart: (id: string) => void;
  onDrop: (status: TaskStatus) => void;
}) {
  const Icon = statusIcon[column.id] || CircleDot;
  const overLimit = Boolean(column.limit && tasks.length > column.limit);
  return (
    <section
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => onDrop(column.id)}
      className={"tasks-column column-" + column.id}
    >
      <header>
        <h2>{column.title}</h2>
        <span className={`nx-badge ${overLimit ? "is-red" : ""}`} title={column.limit ? `Limite de ${column.limit} tarefas` : undefined}>
          {tasks.length}{column.limit ? `/${column.limit}` : ""}
        </span>
      </header>
      <div className="tasks-column-body">
        {!tasks.length && <div className="tasks-column-empty"><Icon size={18} /><p>Nenhuma tarefa nesta etapa</p><small>Arraste uma tarefa para cá</small></div>}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            labels={labels}
            selected={selectedTaskId === task.id}
            onSelect={() => onSelect(task)}
            onDragStart={() => onDragStart(task.id)}
          />
        ))}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  labels,
  selected,
  onSelect,
  onDragStart,
}: {
  task: TaskItem;
  labels: TaskLabel[];
  selected: boolean;
  onSelect: () => void;
  onDragStart: () => void;
}) {
  const taskLabels = labels.filter((label) => task.labels.includes(label.id));
  const categoryVisual = taskCategoryVisual[task.category] || taskCategoryVisual.geral;
  const CategoryIcon = categoryVisual.icon;
  const overdue = isOverdue(task);
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={onSelect}
      className={`tasks-task-card nx-card ${selected ? "is-selected" : ""}`}
    >
      <h3>{task.title}</h3>

      <span className="tasks-card-badges">
        <span className={`nx-badge ${priorityTone[task.priority] || ""}`}>{priorityLabel(task.priority)}</span>
        {overdue && <span className="nx-badge is-red">Atrasada</span>}
        {task.status === "concluida" && <span className="nx-badge is-green">Concluída</span>}
        <span className="nx-badge tasks-category">
          <CategoryIcon size={12} />
          {taskCategoryOptions.find((category) => category.id === task.category)?.label || task.category}
        </span>
        {taskLabels.map((label) => (
          <span key={label.id} className="nx-badge">
            <span className="tasks-label-dot" style={{ backgroundColor: label.color }} />
            {label.name}
          </span>
        ))}
      </span>

      {task.description && <span className="tasks-card-description">{task.description}</span>}

      <span className="tasks-card-footer">
        <span className={overdue ? "tasks-overdue" : ""}>
          <CalendarClock size={13} />
          {dateLabel(task.dueDate)}
        </span>
        {task.attachments.length > 0 && <span title="Anexos"><Paperclip size={13} />{task.attachments.length}</span>}
        {task.comments.length > 0 && <span title="Comentários"><MessageSquare size={13} />{task.comments.length}</span>}
        {task.assigneeName && <span className="tasks-card-assignee"><Avatar userId={task.assigneeId} name={task.assigneeName} size={22} /><span>{task.assigneeName}</span></span>}
      </span>
    </button>
  );
}

function TaskDetails({
  task,
  projectName,
  columns,
  labels,
  teamMembers,
  comment,
  setComment,
  onClose,
  onPatch,
  onDelete,
  onAddComment,
  onAddToCalendar,
  calendarLoading,
  fileInputRef,
  onUpload,
}: {
  task: TaskItem;
  projectName: string;
  columns: TaskColumn[];
  labels: TaskLabel[];
  teamMembers: NoriumUser[];
  comment: string;
  setComment: (value: string) => void;
  onClose: () => void;
  onPatch: (updates: Partial<TaskItem>) => void;
  onDelete: () => void;
  onAddComment: () => void;
  onAddToCalendar: (task: TaskItem) => void;
  calendarLoading: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onUpload: (file: File) => void;
}) {
  return (
    <aside className="tasks-details" aria-label="Detalhes da tarefa">
      <header>
        <div className="nx-grow">
          <p className="nx-faint nx-small">{projectName} · Detalhes da tarefa</p>
          <h2>{task.title}</h2>
        </div>
        <button type="button" className="tasks-icon-btn is-plain" onClick={onClose} aria-label="Fechar painel">
          <X size={18} />
        </button>
      </header>

      <div className="tasks-details-body">
        <Field label="Título">
          <input
            aria-label="Título da tarefa"
            value={task.title}
            onChange={(event) => onPatch({ title: event.target.value } as Partial<TaskItem>)}
            className="tasks-control"
          />
        </Field>

        <div className="tasks-details-grid">
          <span className="tasks-details-label">Etapa</span>
          <Select label="Etapa" value={task.status} onChange={(value) => onPatch({ status: value as TaskStatus } as Partial<TaskItem>)}>
            {columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}
          </Select>
          <span className="tasks-details-label">Prioridade</span>
          <Select label="Prioridade" value={task.priority} onChange={(value) => onPatch({ priority: value as TaskPriority } as Partial<TaskItem>)}>
            <option value="baixa">Baixa</option>
            <option value="media">Média</option>
            <option value="alta">Alta</option>
            <option value="urgente">Urgente</option>
          </Select>
          <span className="tasks-details-label">Responsável</span>
          <Select label="Responsável" value={task.assigneeId || ""} onChange={(value) => onPatch({ assigneeId: value } as Partial<TaskItem>)}>
            <option value="">Sem responsável</option>
            {teamMembers.map((member) => (
              <option key={member.id} value={member.id}>{member.nome}</option>
            ))}
          </Select>
          <span className="tasks-details-label">Prazo</span>
          <input
            type="date"
            aria-label="Prazo"
            value={task.dueDate || ""}
            onChange={(event) => onPatch({ dueDate: event.target.value || null } as Partial<TaskItem>)}
            className={`tasks-control ${isOverdue(task) ? "is-overdue" : ""}`}
          />
          <span className="tasks-details-label">Categoria</span>
          <Select label="Categoria" value={task.category || "geral"} onChange={(value) => onPatch({ category: value } as Partial<TaskItem>)}>
            {taskCategoryOptions.map((category) => (
              <option key={category.id} value={category.id}>{category.label}</option>
            ))}
          </Select>
          <span className="tasks-details-label">Etiquetas</span>
          <div className="tasks-chip-list">
            {labels.map((label) => {
              const active = task.labels.includes(label.id);
              return (
                <button
                  key={label.id}
                  type="button"
                  className="tasks-chip"
                  aria-pressed={active}
                  onClick={() => onPatch({ labels: active ? task.labels.filter((item) => item !== label.id) : [...task.labels, label.id] } as Partial<TaskItem>)}
                >
                  <span className="tasks-label-dot" style={{ backgroundColor: label.color }} />
                  {label.name}
                </button>
              );
            })}
            {!labels.length && <span className="nx-faint nx-small">Nenhuma etiqueta neste projeto.</span>}
          </div>
        </div>

        <section>
          <h3 className="tasks-section-title">Descrição</h3>
          <textarea
            aria-label="Descrição da tarefa"
            value={task.description}
            onChange={(event) => onPatch({ description: event.target.value } as Partial<TaskItem>)}
            rows={4}
            className="tasks-control"
            placeholder="Descrição"
          />
        </section>

        <section>
          <div className="tasks-section-head">
            <h3 className="tasks-section-title">Anexos {task.attachments.length > 0 && <span className="nx-faint nx-small">{task.attachments.length}</span>}</h3>
            <button type="button" className="nx-btn is-sm" onClick={() => fileInputRef.current?.click()} aria-label="Anexar arquivo">
              <FileUp size={14} />
              Anexar
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload(file);
                event.currentTarget.value = "";
              }}
            />
          </div>
          <div className="tasks-attachments">
            {task.attachments.map((attachment) => (
              <button key={attachment.id} type="button" onClick={() => void openWithAuth(attachment.url)} className="tasks-attachment">
                <FileText size={13} />
                <span className="nx-ell">{attachment.name}</span>
                <span className="nx-faint">{fileSizeLabel(attachment.size)}</span>
              </button>
            ))}
            {!task.attachments.length && <span className="nx-faint nx-small">Nenhum anexo.</span>}
          </div>
        </section>

        <section>
          <h3 className="tasks-section-title">Comentários {task.comments.length > 0 && <span className="nx-faint nx-small">{task.comments.length}</span>}</h3>
          <div className="tasks-comments">
            {task.comments.map((item) => (
              <div key={item.id} className="tasks-comment">
                <Avatar name={item.author} size={28} />
                <div className="nx-grow">
                  <p className="nx-small"><b>{item.author}</b> {dateTimeLabel(item.createdAt) && <span className="nx-faint">{dateTimeLabel(item.createdAt)}</span>}</p>
                  <p className="tasks-comment-text">{item.text}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="tasks-comment-form">
            <input
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Escreva um comentário…"
              aria-label="Adicionar comentário"
              className="tasks-control"
            />
            <button type="button" className="nx-btn is-primary" onClick={onAddComment}>
              Enviar
            </button>
          </div>
        </section>
      </div>

      <footer>
        <button
          type="button"
          className="nx-btn"
          onClick={() => onAddToCalendar(task)}
          disabled={!task.dueDate || calendarLoading}
          title={!task.dueDate ? "Defina uma data de vencimento antes" : "Criar compromisso no Google Agenda"}
          aria-label={!task.dueDate ? "Defina uma data de vencimento antes" : "Criar compromisso no Google Agenda"}
        >
          <CalendarPlus size={14} />
          {calendarLoading ? "Enviando para a agenda…" : "Adicionar ao Google Agenda"}
        </button>
        <button type="button" onClick={onDelete} className="nx-btn tasks-danger-btn">
          <Trash2 size={14} />
          Apagar tarefa
        </button>
      </footer>
    </aside>
  );
}

function ProjectSettingsModal({
  form,
  setForm,
  teamMembers,
  ownerUserId,
  onClose,
  onSubmit,
}: {
  form: WorkspaceForm;
  setForm: (form: WorkspaceForm) => void;
  teamMembers: NoriumUser[];
  ownerUserId: string;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const sharedMembers = teamMembers.filter((member) => member.id !== ownerUserId);
  return (
    <ModalShell
      title="Configurações do projeto"
      subtitle="Prazos, responsável, categoria e padrões para tarefas e agenda."
      label="Configurações do projeto"
      width={680}
      onClose={onClose}
      footer={<>
        <button type="button" className="nx-btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="nx-btn is-primary" disabled={!form.name.trim()} onClick={onSubmit}>Salvar configurações</button>
      </>}
    >
      <Field label="Nome do projeto" required>
        <input className="tasks-control" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Nome do projeto" />
      </Field>
      <Field label="Descrição">
        <textarea className="tasks-control" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Descrição" rows={4} />
      </Field>
      <div className="tasks-form-grid">
        <Field label="Categoria">
          <Select label="Categoria" value={form.category} onChange={(value) => setForm({ ...form, category: value as ProjectCategory })}>
            {Object.entries(projectCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select label="Etapa" value={form.status} onChange={(value) => setForm({ ...form, status: value as ProjectStatus })}>
            {Object.entries(projectStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>
        <Field label="Responsável">
          <Select value={form.responsibleUserId} onChange={(value) => {
            const member = teamMembers.find((item) => item.id === value);
            setForm({ ...form, responsibleUserId: value, responsibleName: member?.nome || form.responsibleName });
          }}>
            {teamMembers.map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}
          </Select>
        </Field>
        <Field label="Prioridade padrão">
          <Select value={form.defaultPriority} onChange={(value) => setForm({ ...form, defaultPriority: value as TaskPriority })}>
            <option value="baixa">Baixa</option>
            <option value="media">Média</option>
            <option value="alta">Alta</option>
            <option value="urgente">Urgente</option>
          </Select>
        </Field>
        <Field label="Início">
          <input type="date" className="tasks-control" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} title="Início do projeto" />
        </Field>
        <Field label="Prazo final">
          <input type="date" className="tasks-control" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} title="Prazo final" />
        </Field>
        <Field label="Horário padrão no Google Agenda">
          <input type="time" className="tasks-control" value={form.defaultStartTime} onChange={(event) => setForm({ ...form, defaultStartTime: event.target.value })} title="Horário padrão para Google Agenda" />
        </Field>
        <Field label="Duração padrão no Google Agenda (min)">
          <input type="number" min={15} step={15} className="tasks-control" value={form.calendarDurationMinutes} onChange={(event) => setForm({ ...form, calendarDurationMinutes: Number(event.target.value) })} />
        </Field>
      </div>
      <Field label="Nome exibido do responsável">
        <input className="tasks-control" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} placeholder="Responsável" />
      </Field>
      {sharedMembers.length > 0 && (
        <FieldGroup label="Compartilhar projeto">
          <div className="tasks-chip-list">
            {sharedMembers.map((member) => (
              <label key={member.id} className="tasks-chip">
                <input
                  type="checkbox"
                  checked={form.sharedUserIds.includes(member.id)}
                  onChange={() => {
                    const active = form.sharedUserIds.includes(member.id);
                    setForm({
                      ...form,
                      sharedUserIds: active
                        ? form.sharedUserIds.filter((id) => id !== member.id)
                        : [...form.sharedUserIds, member.id],
                    });
                  }}
                />
                <span className="nx-ell">{member.nome}</span>
              </label>
            ))}
          </div>
        </FieldGroup>
      )}
      <FieldGroup label="Cor do projeto">
        <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
      </FieldGroup>
    </ModalShell>
  );
}

function CreateTaskModal({
  form,
  projectName,
  labels,
  teamMembers,
  setForm,
  toggleLabel,
  onDetailWithNora,
  onClose,
  onSubmit,
}: {
  form: TaskForm;
  projectName: string;
  labels: TaskLabel[];
  teamMembers: NoriumUser[];
  setForm: (form: TaskForm) => void;
  toggleLabel: (labelId: string) => void;
  onDetailWithNora: () => Promise<void>;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [noraBusy, setNoraBusy] = useState(false);

  async function handleDetailWithNora() {
    setNoraBusy(true);
    try {
      await onDetailWithNora();
    } finally {
      setNoraBusy(false);
    }
  }

  return (
    <ModalShell
      title="Nova tarefa"
      subtitle={`Projeto: ${projectName}`}
      label="Nova tarefa"
      width={600}
      onClose={onClose}
      footer={<>
        <button type="button" className="nx-btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="nx-btn is-primary" disabled={!form.title.trim()} onClick={onSubmit}>Criar tarefa</button>
      </>}
    >
      <Field label="Título" required>
        <input
          className="tasks-control"
          value={form.title}
          onChange={(event) => setForm({ ...form, title: event.target.value })}
          placeholder="Título"
          autoFocus
        />
      </Field>
      <Field label="Descrição">
        <textarea
          className="tasks-control"
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
          placeholder="Descrição"
          rows={4}
        />
      </Field>
      <div className="tasks-form-grid">
        <Field label="Prioridade">
          <Select label="Prioridade" value={form.priority} onChange={(value) => setForm({ ...form, priority: value as TaskPriority })}>
            <option value="baixa">Baixa</option>
            <option value="media">Média</option>
            <option value="alta">Alta</option>
            <option value="urgente">Urgente</option>
          </Select>
        </Field>
        <Field label="Prazo">
          <input type="date" className="tasks-control" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} />
        </Field>
        <Field label="Categoria">
          <Select label="Categoria" value={form.category} onChange={(value) => setForm({ ...form, category: value })}>
            {taskCategoryOptions.map((category) => (
              <option key={category.id} value={category.id}>{category.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Responsável">
          <Select label="Responsável" value={form.assigneeId} onChange={(value) => setForm({ ...form, assigneeId: value })}>
            <option value="">Responsável padrão do projeto</option>
            {teamMembers.map((member) => (
              <option key={member.id} value={member.id}>{member.nome}</option>
            ))}
          </Select>
        </Field>
      </div>
      {labels.length > 0 && (
        <FieldGroup label="Etiquetas">
          <div className="tasks-chip-list">
            {labels.map((label) => (
              <button
                key={label.id}
                type="button"
                className="tasks-chip"
                aria-pressed={form.labels.includes(label.id)}
                onClick={() => toggleLabel(label.id)}
              >
                <span className="tasks-label-dot" style={{ backgroundColor: label.color }} />
                {label.name}
              </button>
            ))}
          </div>
        </FieldGroup>
      )}
      <div className="tasks-nora-hint">
        <span className="tasks-nora-icon" aria-hidden="true"><Sparkles size={14} /></span>
        <span className="nx-muted nx-small nx-grow">{form.title.trim() ? "Quer que a Nora detalhe a descrição desta tarefa?" : "Escreva o título para a Nora detalhar a descrição."}</span>
        <button
          type="button"
          className="nx-btn is-sm"
          aria-busy={noraBusy}
          disabled={noraBusy || !form.title.trim()}
          onClick={() => void handleDetailWithNora()}
        >
          {noraBusy && <LoaderCircle size={14} className="animate-spin" />}
          Detalhar com a Nora
        </button>
      </div>
    </ModalShell>
  );
}
