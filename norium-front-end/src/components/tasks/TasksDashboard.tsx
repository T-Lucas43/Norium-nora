import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Briefcase,
  ClipboardList,
  CalendarPlus,
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock3,
  DollarSign,
  FileUp,
  FileText,
  Filter,
  FolderPlus,
  Headphones,
  Layers3,
  Menu,
  MessageSquare,
  Paperclip,
  Plus,
  Package,
  RotateCcw,
  Search,
  Settings,
  Tag,
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

const emptyWorkspaceForm: WorkspaceForm = {
  name: "",
  category: "operacao",
  description: "",
  color: "#0EA5E9",
  defaultPriority: "media",
  owner: "Tarcisio",
  responsibleUserId: "",
  responsibleName: "",
  sharedUserIds: [],
  status: "ativo",
  startDate: "",
  dueDate: "",
  defaultStartTime: "09:00",
  calendarDurationMinutes: 60,
};

const projectCategoryLabels: Record<ProjectCategory, string> = {
  operacao: "Operacao",
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
  concluido: "Concluido",
};

const projectStatusStyle: Record<ProjectStatus, string> = {
  planejamento: "bg-sky-500/12 text-sky-200 border-sky-400/25",
  ativo: "bg-emerald-500/12 text-emerald-200 border-emerald-400/25",
  pausado: "bg-amber-500/12 text-amber-200 border-amber-400/25",
  concluido: "bg-blue-500/12 text-blue-200 border-blue-400/25",
};

const taskCategoryOptions = [
  { id: "geral", label: "Geral" },
  { id: "operacao", label: "Operacao" },
  { id: "cliente", label: "Cliente" },
  { id: "produto", label: "Produto" },
  { id: "briefing", label: "Briefing" },
  { id: "execucao", label: "Execucao" },
  { id: "revisao", label: "Revisao" },
  { id: "follow-up", label: "Follow-up" },
  { id: "financeiro", label: "Financeiro" },
  { id: "suporte", label: "Suporte" },
  { id: "pessoal", label: "Pessoal" },
];

const taskCategoryVisual: Record<string, { icon: LucideIcon; className: string }> = {
  geral: { icon: ClipboardList, className: "bg-blue-500/10 text-blue-200" },
  operacao: { icon: Wrench, className: "bg-cyan-500/10 text-cyan-200" },
  cliente: { icon: Users, className: "bg-emerald-500/10 text-emerald-200" },
  produto: { icon: Package, className: "bg-sky-500/10 text-sky-200" },
  briefing: { icon: FileText, className: "bg-blue-500/10 text-blue-200" },
  execucao: { icon: Wrench, className: "bg-cyan-500/10 text-cyan-200" },
  revisao: { icon: Search, className: "bg-amber-500/10 text-amber-200" },
  "follow-up": { icon: MessageSquare, className: "bg-teal-500/10 text-teal-200" },
  financeiro: { icon: DollarSign, className: "bg-emerald-500/10 text-emerald-200" },
  suporte: { icon: Headphones, className: "bg-sky-500/10 text-sky-200" },
  pessoal: { icon: Circle, className: "bg-slate-500/10 text-slate-200" },
};

const projectColorOptions = ["#0EA5E9", "#06B6D4", "#2563EB", "#14B8A6", "#22C55E", "#F59E0B", "#F43F5E"];

const priorityStyle: Record<TaskPriority, string> = {
  baixa: "bg-slate-500/12 text-slate-300 border-slate-400/25",
  media: "bg-sky-500/12 text-sky-300 border-sky-400/25",
  alta: "bg-amber-500/12 text-amber-300 border-amber-400/25",
  urgente: "bg-rose-500/12 text-rose-300 border-rose-400/25",
};

const statusIcon: Record<TaskStatus, typeof Circle> = {
  pendente: Circle,
  andamento: Clock3,
  revisao: AlertTriangle,
  concluida: CheckCircle2,
};

function dateLabel(value?: string | null) {
  if (!value) return "Sem data";
  return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

function projectDateRange(workspace: TaskWorkspace) {
  if (!workspace.startDate && !workspace.dueDate) return "Sem prazo definido";
  if (workspace.startDate && workspace.dueDate) return `${dateLabel(workspace.startDate)} - ${dateLabel(workspace.dueDate)}`;
  if (workspace.dueDate) return `Entrega ${dateLabel(workspace.dueDate)}`;
  return `Inicio ${dateLabel(workspace.startDate)}`;
}

function projectDeadlineTone(workspace: TaskWorkspace) {
  if (!workspace.dueDate || workspace.status === "concluido") return "text-[var(--text-secondary)]";
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return workspace.dueDate < key ? "text-rose-300" : "text-blue-200";
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
  };
}

export default function TasksDashboard({ session }: { session: AuthSession }) {
  const userId = session.user.id;
  const userName = session.user.nome || "Tarcisio";
  const [workspaces, setWorkspaces] = useState<TaskWorkspace[]>([]);
  const [teamMembers, setTeamMembers] = useState<NoriumUser[]>([session.user]);
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [filters, setFilters] = useState({
    status: "ativas",
    category: "todas",
    priority: "todas",
    label: "todas",
    due: "todas",
    q: "",
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeWorkspaces = useMemo(() => workspaces.filter((workspace) => !workspace.archived), [workspaces]);
  const archivedWorkspaces = useMemo(() => workspaces.filter((workspace) => workspace.archived), [workspaces]);

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
    }
  }, [userId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

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
      setError("Somente o usuario principal dono do projeto pode alterar configuracoes e compartilhamento.");
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
      setNotice("Configuracoes do projeto salvas.");
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
        setError(err instanceof Error ? err.message : "Nao consegui arquivar o projeto.");
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
        setError(err instanceof Error ? err.message : "Nao consegui restaurar o projeto.");
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
    setNotice(`Projeto "${workspace.name}" excluido.`);
  }

  const loadTasks = useCallback(async () => {
    if (!activeWorkspace) {
      setTasks([]);
      setSelectedTask(null);
      setLoading(false);
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
      setTasks(data.tasks || []);
      setColumns(data.columns || []);
      setLabels(data.labels || []);
      setStats(data.stats || { total: 0, ativas: 0, pendentes: 0, andamento: 0, concluidas: 0, vencidas: 0 });
      setSelectedTask((current) => {
        if (!current) return current;
        return (data.tasks || []).find((task: TaskItem) => task.id === current.id) || null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar tarefas.");
    } finally {
      setLoading(false);
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
    const grouped: Record<TaskStatus, TaskItem[]> = {
      pendente: [],
      andamento: [],
      revisao: [],
      concluida: [],
    };
    tasks.forEach((task) => grouped[task.status]?.push(task));
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
          status: "pendente",
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

  if (!activeWorkspace) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-[var(--background)] text-[var(--text)]">
        <header className="border-b border-[var(--border)] bg-[var(--surface)] px-8 py-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-lg bg-blue-500/12 text-blue-300">
              <Briefcase size={23} />
            </span>
            <div>
              <h1 className="text-xl font-black">Projetos e listas de tarefas</h1>
              <p className="text-sm font-semibold text-[var(--text-secondary)]">
                Escolha um projeto para abrir o Kanban ou crie uma nova lista.
              </p>
            </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {archivedWorkspaces.length > 0 && (
                <button
                  onClick={() => setShowArchivedProjects((current) => !current)}
                  className="flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] px-4 text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                >
                  <Archive size={15} />
                  {showArchivedProjects ? "Ocultar arquivados" : `Arquivados (${archivedWorkspaces.length})`}
                </button>
              )}
              <button
                onClick={() => setShowWorkspaceCreate((current) => !current)}
                className="flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-bold text-white hover:bg-blue-500"
              >
                {showWorkspaceCreate ? <X size={16} /> : <FolderPlus size={16} />}
                {showWorkspaceCreate ? "Fechar formulario" : "Novo projeto"}
              </button>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-8">
          <section className={`grid gap-5 ${showWorkspaceCreate ? "xl:grid-cols-[minmax(0,1fr)_360px]" : ""}`}>
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {activeWorkspaces.map((workspace) => (
                <article
                  key={workspace.id}
                  className="min-h-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition hover:border-blue-400 hover:bg-[var(--surface-hover)]"
                >
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <span
                      className="grid h-11 w-11 place-items-center rounded-lg text-white shadow-sm"
                      style={{ backgroundColor: workspace.color }}
                    >
                      <Briefcase size={20} />
                    </span>
                    <span className="rounded-full border border-blue-400/20 bg-blue-500/10 px-2 py-1 text-xs font-bold text-blue-200">
                      {projectCategoryLabels[workspace.category]}
                    </span>
                  </div>
                  <h2 className="text-base font-black">{workspace.name}</h2>
                  <p className="mt-2 line-clamp-2 text-sm font-semibold text-[var(--text-secondary)]">{workspace.description}</p>
                  <div className="mt-4 space-y-2 text-xs font-bold">
                    <p className={projectDeadlineTone(workspace)}>
                      <CalendarClock size={13} className="mr-1 inline" />
                      {projectDateRange(workspace)}
                    </p>
                    <p className="text-[var(--text-secondary)]">Responsavel: {workspace.responsibleName || workspace.owner}</p>
                    <p className="text-[var(--text-secondary)]">
                      {workspace.ownerUserId === userId
                        ? `Compartilhado com ${workspace.sharedUserIds?.length || 0} membro(s)`
                        : "Compartilhado comigo"}
                    </p>
                  </div>
                  <div className="mt-5 flex items-center justify-between gap-3 text-xs font-bold">
                    <span className="text-blue-300">Abrir Kanban</span>
                    <span className={`rounded-full border px-2 py-0.5 ${projectStatusStyle[workspace.status]}`}>
                      {projectStatusLabels[workspace.status]}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-[1fr_auto_auto] gap-2">
                    <button
                      onClick={() => setActiveWorkspace(workspace)}
                      className="h-10 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white transition hover:bg-blue-500"
                    >
                      Abrir Kanban
                    </button>
                    <button
                      onClick={() => openProjectSettings(workspace)}
                      disabled={!canManageProject(workspace)}
                      className="grid h-10 w-10 place-items-center rounded-lg border border-[var(--border)] text-[var(--text-secondary)] transition hover:bg-[var(--background)] hover:text-blue-300"
                      title="Configuracoes do projeto"
                     aria-label="Configuracoes do projeto">
                      <Settings size={16} />
                    </button>
                    <button
                      onClick={() => setPendingProjectAction({ type: "archive", workspace })}
                      disabled={!canManageProject(workspace)}
                      className="grid h-10 w-10 place-items-center rounded-lg border border-amber-400/25 text-amber-200 transition hover:bg-amber-500/10"
                      title="Arquivar projeto"
                     aria-label="Arquivar projeto">
                      <Archive size={16} />
                    </button>
                  </div>
                  <button
                    onClick={() => setPendingProjectAction({ type: "delete", workspace })}
                    disabled={!canManageProject(workspace)}
                    className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-rose-400/25 text-xs font-bold text-rose-200 transition hover:bg-rose-500/10"
                  >
                    <Trash2 size={14} />
                    Excluir projeto
                  </button>
                </article>
              ))}
              </div>

              {activeWorkspaces.length === 0 && (
                <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
                  <h2 className="text-base font-black">Nenhum projeto ativo</h2>
                  <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">
                    Crie uma nova lista ou restaure um projeto arquivado.
                  </p>
                </div>
              )}

              {showArchivedProjects && archivedWorkspaces.length > 0 && (
                <section className="space-y-3">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
                    <Archive size={15} />
                    Projetos arquivados
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {archivedWorkspaces.map((workspace) => (
                      <article key={workspace.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 opacity-80">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="truncate text-sm font-bold">{workspace.name}</h3>
                            <p className="mt-1 line-clamp-2 text-xs font-semibold text-[var(--text-secondary)]">{workspace.description}</p>
                          </div>
                          <span className="rounded-full border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-xs font-bold text-amber-200">
                            Arquivado
                          </span>
                        </div>
                        <div className="mt-4 grid grid-cols-3 gap-2">
                          <button
                            onClick={() => openProjectSettings(workspace)}
                            className="flex h-9 items-center justify-center gap-1 rounded-lg border border-[var(--border)] text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--background)]"
                          >
                            <Settings size={14} />
                            Config
                          </button>
                          <button
                            onClick={() => setPendingProjectAction({ type: "restore", workspace })}
                            className="flex h-9 items-center justify-center gap-1 rounded-lg border border-emerald-400/25 text-xs font-bold text-emerald-200 hover:bg-emerald-500/10"
                          >
                            <RotateCcw size={14} />
                            Restaurar
                          </button>
                          <button
                            onClick={() => setPendingProjectAction({ type: "delete", workspace })}
                            className="flex h-9 items-center justify-center gap-1 rounded-lg border border-rose-400/25 text-xs font-bold text-rose-200 hover:bg-rose-500/10"
                          >
                            <Trash2 size={14} />
                            Excluir
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </div>

            {showWorkspaceCreate && (
            <aside className="rounded-lg border border-blue-400/30 bg-[var(--surface)] p-5 shadow-xl shadow-black/10">
              <span className="grid h-11 w-11 place-items-center rounded-lg bg-blue-500/12 text-blue-300">
                <FolderPlus size={21} />
              </span>
              <h2 className="mt-4 text-base font-black">Nova lista</h2>
              <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">
                Crie um agrupamento para separar tarefas por projeto, operacao ou cliente.
              </p>
              <div className="mt-5 space-y-3">
                <input
                  value={workspaceForm.name}
                  onChange={(event) => setWorkspaceForm({ ...workspaceForm, name: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createWorkspace();
                  }}
                  placeholder="Nome do projeto"
                  className="h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
                />
                <textarea
                  value={workspaceForm.description}
                  onChange={(event) => setWorkspaceForm({ ...workspaceForm, description: event.target.value })}
                  placeholder="Descricao do projeto"
                  rows={3}
                  className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-semibold outline-none focus:border-blue-400"
                />
                <Select value={workspaceForm.category} onChange={(value) => setWorkspaceForm({ ...workspaceForm, category: value as ProjectCategory })}>
                  {Object.entries(projectCategoryLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
                <Select value={workspaceForm.defaultPriority} onChange={(value) => setWorkspaceForm({ ...workspaceForm, defaultPriority: value as TaskPriority })}>
                  <option value="baixa">Prioridade baixa</option>
                  <option value="media">Prioridade media</option>
                  <option value="alta">Prioridade alta</option>
                  <option value="urgente">Prioridade urgente</option>
                </Select>
                <Select value={workspaceForm.status} onChange={(value) => setWorkspaceForm({ ...workspaceForm, status: value as ProjectStatus })}>
                  {Object.entries(projectStatusLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
                <input
                  value={workspaceForm.owner}
                  onChange={(event) => setWorkspaceForm({ ...workspaceForm, owner: event.target.value })}
                  placeholder="Responsavel"
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
                />
                <Select
                  value={workspaceForm.responsibleUserId}
                  onChange={(value) => setWorkspaceForm({ ...workspaceForm, responsibleUserId: value, responsibleName: memberName(value) })}
                >
                  {teamMembers.map((member) => (
                    <option key={member.id} value={member.id}>{member.nome}</option>
                  ))}
                </Select>
                {teamMembers.length > 1 && (
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                    <p className="mb-2 text-xs font-bold uppercase text-[var(--text-secondary)]">Compartilhar com</p>
                    <div className="max-h-32 space-y-2 overflow-y-auto pr-1">
                      {teamMembers.filter((member) => member.id !== userId).map((member) => (
                        <label key={member.id} className="flex items-center justify-between gap-3 text-xs font-bold">
                          <span className="truncate">{member.nome}</span>
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
                            className="h-4 w-4 accent-cyan-400"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="date"
                    value={workspaceForm.startDate}
                    onChange={(event) => setWorkspaceForm({ ...workspaceForm, startDate: event.target.value })}
                    className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
                    title="Inicio do projeto"
                  />
                  <input
                    type="date"
                    value={workspaceForm.dueDate}
                    onChange={(event) => setWorkspaceForm({ ...workspaceForm, dueDate: event.target.value })}
                    className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
                    title="Prazo final"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="time"
                    value={workspaceForm.defaultStartTime}
                    onChange={(event) => setWorkspaceForm({ ...workspaceForm, defaultStartTime: event.target.value })}
                    className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
                    title="Horario padrao da agenda"
                  />
                  <input
                    type="number"
                    min={15}
                    step={15}
                    value={workspaceForm.calendarDurationMinutes}
                    onChange={(event) => setWorkspaceForm({ ...workspaceForm, calendarDurationMinutes: Number(event.target.value) })}
                    className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
                    title="Duracao padrao em minutos"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {projectColorOptions.map((color) => (
                    <button
                      key={color}
                      onClick={() => setWorkspaceForm({ ...workspaceForm, color })}
                      className={`h-8 w-8 rounded-full border-2 transition ${
                        workspaceForm.color === color ? "border-white scale-105" : "border-transparent"
                      }`}
                      style={{ backgroundColor: color }}
                      title={color}
                     aria-label={color} />
                  ))}
                </div>
              </div>
              <button
                onClick={() => void createWorkspace()}
                disabled={!workspaceForm.name.trim()}
                className="mt-3 h-11 w-full rounded-lg bg-blue-600 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Criar e abrir
              </button>
            </aside>
            )}
          </section>
        </main>
        {projectOverlays}
      </div>
    );
  }

  return (
    <div className={`norium-tasks ${mobileSidebarOpen ? "mobile-sidebar-open" : ""} flex h-full min-h-0 w-full overflow-hidden bg-[var(--background)] text-[var(--text)]`}>
      <button
        type="button"
        className="mobile-sidebar-toggle mobile-screen-fab"
        aria-label="Abrir filtros do projeto"
        onClick={() => setMobileSidebarOpen(true)}
      >
        <Menu size={18} />
      </button>
      {mobileSidebarOpen && (
        <button
          type="button"
          className="mobile-sidebar-backdrop"
          aria-label="Fechar filtros do projeto"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <aside className="flex h-full w-72 shrink-0 flex-col gap-4 border-r border-[var(--border)] bg-[var(--surface)] p-4">
        <button
          onClick={() => {
            setMobileSidebarOpen(false);
            setActiveWorkspace(null);
          }}
          className="flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] px-3 text-xs font-bold text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <ArrowLeft size={15} />
          Trocar projeto
        </button>
        <div className="rounded-lg border border-blue-400/20 bg-blue-500/10 p-3">
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white"
              style={{ backgroundColor: activeWorkspace.color }}
            >
              <Layers3 size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase text-blue-200/80">Projeto atual</p>
              <h2 className="mt-1 truncate text-sm font-bold text-blue-100">{activeWorkspace.name}</h2>
              <p className="mt-1 line-clamp-2 text-xs font-semibold text-blue-100/70">{activeWorkspace.description}</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="rounded-full border border-blue-300/20 bg-blue-950/35 px-2 py-1 text-xs font-bold text-blue-100">
              {projectCategoryLabels[activeWorkspace.category]}
            </span>
            <span className={`rounded-full border px-2 py-1 text-xs font-bold ${projectStatusStyle[activeWorkspace.status]}`}>
              {projectStatusLabels[activeWorkspace.status]}
            </span>
          </div>
          <p className={`mt-3 text-xs font-bold ${projectDeadlineTone(activeWorkspace)}`}>
            <CalendarClock size={13} className="mr-1 inline" />
            {projectDateRange(activeWorkspace)}
          </p>
          <p className="mt-2 text-xs font-bold text-blue-100/80">
            Responsavel: {activeWorkspace.responsibleName || activeWorkspace.owner}
          </p>
          <p className="mt-1 text-xs font-bold text-blue-100/70">
            {activeWorkspace.ownerUserId === userId
              ? `Compartilhado com ${activeWorkspace.sharedUserIds?.length || 0} membro(s)`
              : "Projeto compartilhado com voce"}
          </p>
        </div>
        <button
          onClick={() => {
            setMobileSidebarOpen(false);
            openProjectSettings(activeWorkspace);
          }}
          disabled={!canManageProject(activeWorkspace)}
          className="flex h-10 items-center justify-center gap-2 rounded-lg border border-[var(--border)] px-3 text-xs font-bold text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <Settings size={15} />
          Configuracoes do projeto
        </button>
        <button
          onClick={() => {
            setMobileSidebarOpen(false);
            setForm({
              ...emptyForm,
              category: activeWorkspace.category,
              priority: activeWorkspace.defaultPriority,
              assigneeId: activeWorkspace.responsibleUserId || userId,
            });
            setShowCreate(true);
          }}
          className="flex h-11 items-center justify-center gap-2 rounded-lg bg-[var(--primary)] text-sm font-bold text-white shadow-sm"
        >
          <Plus size={17} />
          Nova tarefa
        </button>

        <div className="grid grid-cols-2 gap-2">
          <Metric label="Ativas" value={stats.ativas} />
          <Metric label="Vencidas" value={stats.vencidas} alert />
          <Metric label="Andamento" value={stats.andamento} />
          <Metric label="Concluídas" value={stats.concluidas} />
        </div>

        <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
          <div className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
            <Filter size={14} />
            Filtros
          </div>
          <div className="flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3">
            <Search size={15} className="text-[var(--text-secondary)]" />
            <input
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
              placeholder="Buscar"
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none placeholder:text-[var(--text-secondary)]"
            />
          </div>
          <Select value={filters.status} onChange={(value) => setFilters({ ...filters, status: value })}>
            <option value="ativas">Ativas</option>
            <option value="pendente">Pendentes</option>
            <option value="andamento">Em andamento</option>
            <option value="revisao">Em revisão</option>
            <option value="concluida">Concluídas</option>
            <option value="todas">Todas</option>
          </Select>
          <Select value={filters.priority} onChange={(value) => setFilters({ ...filters, priority: value })}>
            <option value="todas">Todas prioridades</option>
            <option value="urgente">Urgente</option>
            <option value="alta">Alta</option>
            <option value="media">Média</option>
            <option value="baixa">Baixa</option>
          </Select>
          <Select value={filters.category} onChange={(value) => setFilters({ ...filters, category: value })}>
            <option value="todas">Todas categorias</option>
            {taskCategoryOptions.map((category) => (
              <option key={category.id} value={category.id}>{category.label}</option>
            ))}
          </Select>
          <Select value={filters.due} onChange={(value) => setFilters({ ...filters, due: value })}>
            <option value="todas">Todos vencimentos</option>
            <option value="vencidas">Vencidas</option>
            <option value="hoje">Hoje</option>
            <option value="semana">Próximos 7 dias</option>
          </Select>
          <Select value={filters.label} onChange={(value) => setFilters({ ...filters, label: value })}>
            <option value="todas">Todas etiquetas</option>
            {labels.map((label) => (
              <option key={label.id} value={label.id}>{label.name}</option>
            ))}
          </Select>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase text-[var(--text-secondary)]">Etiquetas</h3>
          <div className="flex flex-wrap gap-2">
            {labels.map((label) => (
              <button
                key={label.id}
                onClick={() => setFilters({ ...filters, label: label.id })}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-1 text-xs font-bold"
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} />
                {label.name}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4">
          <div>
            <h1 className="text-lg font-bold">{activeWorkspace.name}</h1>
            <p className="text-xs font-semibold text-[var(--text-secondary)]">
              {stats.total} tarefas neste projeto
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-secondary)]">
            <Clock3 size={15} />
            {loading ? "Sincronizando" : "Atualização local"}
          </div>
        </header>

        {error && (
          <div className="border-b border-amber-500/20 bg-amber-500/10 px-5 py-2 text-xs font-bold text-amber-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="border-b border-emerald-500/20 bg-emerald-500/10 px-5 py-2 text-xs font-bold text-emerald-300">
            {notice}
          </div>
        )}

        <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
          <div className="grid h-full min-w-[1060px] grid-cols-4 gap-4">
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
        </div>
      </main>

      {selectedTask && (
        <TaskDetails
          task={selectedTask}
          labels={labels}
          teamMembers={teamMembers}
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
          labels={labels}
          teamMembers={teamMembers}
          setForm={setForm}
          toggleLabel={toggleFormLabel}
          onClose={() => setShowCreate(false)}
          onSubmit={() => void createNewTask()}
        />
      )}
    </div>
  );
}

function Metric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
      <p className={`text-lg font-bold ${alert && value > 0 ? "text-rose-300" : ""}`}>{value || 0}</p>
      <p className="text-xs font-bold text-[var(--text-secondary)]">{label}</p>
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
      description: "O projeto sai da area ativa, mas continua disponivel em Projetos arquivados para restaurar depois.",
      confirm: "Arquivar",
      icon: Archive,
      button: "bg-amber-600 hover:bg-amber-500",
    },
    restore: {
      title: "Restaurar projeto",
      description: "O projeto volta para a lista principal e pode ser aberto novamente no Kanban.",
      confirm: "Restaurar",
      icon: RotateCcw,
      button: "bg-emerald-600 hover:bg-emerald-500",
    },
    delete: {
      title: "Excluir projeto",
      description: "Esta acao remove o projeto da lista e tenta apagar tambem as tarefas ligadas a ele. Nao da para desfazer pela interface.",
      confirm: "Excluir definitivamente",
      icon: Trash2,
      button: "bg-rose-600 hover:bg-rose-500",
    },
  }[action];
  const Icon = config.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header className="flex items-start gap-3 border-b border-[var(--border)] p-5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-[var(--background)] text-[var(--primary)]">
            <Icon size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-black">{config.title}</h2>
            <p className="mt-1 text-sm font-semibold leading-6 text-[var(--text-secondary)]">
              {config.description}
            </p>
          </div>
        </header>

        <div className="p-5">
          <p className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-bold">
            {workspace.name}
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
          <button onClick={onCancel} className="h-10 rounded-lg border border-[var(--border)] px-4 text-sm font-bold hover:bg-[var(--surface-hover)]">
            Cancelar
          </button>
          <button onClick={onConfirm} className={`h-10 rounded-lg px-4 text-sm font-bold text-white transition ${config.button}`}>
            {config.confirm}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-bold outline-none"
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
  const Icon = statusIcon[column.id];
  return (
    <section
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => onDrop(column.id)}
      className="flex min-h-0 flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)]"
    >
      <header className="flex items-center justify-between border-b border-[var(--border)] px-3 py-3">
        <div className="flex items-center gap-2">
          <Icon size={16} className="text-[var(--primary)]" />
          <h2 className="text-sm font-bold">{column.title}</h2>
        </div>
        <span className="rounded-full bg-[var(--background)] px-2 py-1 text-xs font-bold text-[var(--text-secondary)]">
          {tasks.length}{column.limit ? `/${column.limit}` : ""}
        </span>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
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
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onClick={onSelect}
      className={`w-full rounded-lg border bg-[var(--background)] p-3 text-left shadow-sm transition hover:border-[var(--primary)] ${
        selected ? "border-[var(--primary)]" : "border-[var(--border)]"
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-sm font-bold leading-snug">{task.title}</h3>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${priorityStyle[task.priority]}`}>
          {task.priority}
        </span>
      </div>

      <span className={`mb-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold uppercase ${categoryVisual.className}`}>
        <CategoryIcon size={11} />
        {taskCategoryOptions.find((category) => category.id === task.category)?.label || task.category}
      </span>

      {task.description && <p className="mb-3 line-clamp-2 text-xs font-medium text-[var(--text-secondary)]">{task.description}</p>}

      {task.assigneeName && (
        <p className="mb-3 inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-1 text-xs font-bold text-[var(--text-secondary)]">
          <Users size={12} />
          {task.assigneeName}
        </p>
      )}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {taskLabels.map((label) => (
          <span key={label.id} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-bold">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: label.color }} />
            {label.name}
          </span>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 text-xs font-bold text-[var(--text-secondary)]">
        <span className={`inline-flex items-center gap-1 ${isOverdue(task) ? "text-rose-300" : ""}`}>
          <CalendarClock size={13} />
          {dateLabel(task.dueDate)}
        </span>
        <span className="inline-flex items-center gap-2">
          {task.attachments.length > 0 && <span className="inline-flex items-center gap-1"><Paperclip size={13} />{task.attachments.length}</span>}
          {task.comments.length > 0 && <span className="inline-flex items-center gap-1"><MessageSquare size={13} />{task.comments.length}</span>}
        </span>
      </div>
    </button>
  );
}

function TaskDetails({
  task,
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
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between border-b border-[var(--border)] p-4">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Detalhes</p>
          <h2 className="truncate text-base font-bold">{task.title}</h2>
        </div>
        <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--surface-hover)]">
          <X size={18} />
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <section className="space-y-3">
          <input
            value={task.title}
            onChange={(event) => onPatch({ title: event.target.value } as Partial<TaskItem>)}
            className="h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none"
          />
          <textarea
            value={task.description}
            onChange={(event) => onPatch({ description: event.target.value } as Partial<TaskItem>)}
            rows={4}
            className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-semibold outline-none"
            placeholder="Descrição"
          />
          <div className="grid grid-cols-2 gap-2">
            <Select value={task.status} onChange={(value) => onPatch({ status: value as TaskStatus } as Partial<TaskItem>)}>
              <option value="pendente">Pendente</option>
              <option value="andamento">Em andamento</option>
              <option value="revisao">Em revisão</option>
              <option value="concluida">Concluída</option>
            </Select>
            <Select value={task.priority} onChange={(value) => onPatch({ priority: value as TaskPriority } as Partial<TaskItem>)}>
              <option value="baixa">Baixa</option>
              <option value="media">Média</option>
              <option value="alta">Alta</option>
              <option value="urgente">Urgente</option>
            </Select>
          </div>
          <Select value={task.category || "geral"} onChange={(value) => onPatch({ category: value } as Partial<TaskItem>)}>
            {taskCategoryOptions.map((category) => (
              <option key={category.id} value={category.id}>{category.label}</option>
            ))}
          </Select>
          <Select value={task.assigneeId || ""} onChange={(value) => onPatch({ assigneeId: value } as Partial<TaskItem>)}>
            <option value="">Sem responsavel</option>
            {teamMembers.map((member) => (
              <option key={member.id} value={member.id}>{member.nome}</option>
            ))}
          </Select>
          <input
            type="date"
            value={task.dueDate || ""}
            onChange={(event) => onPatch({ dueDate: event.target.value || null } as Partial<TaskItem>)}
            className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none"
          />
          <button
            onClick={() => onAddToCalendar(task)}
            disabled={!task.dueDate || calendarLoading}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 text-xs font-bold text-blue-200 transition hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-45"
            title={!task.dueDate ? "Defina uma data de vencimento antes" : "Criar compromisso no Google Agenda"}
           aria-label={!task.dueDate ? "Defina uma data de vencimento antes" : "Criar compromisso no Google Agenda"}>
            <CalendarPlus size={15} />
            {calendarLoading ? "Enviando para Agenda..." : "Adicionar ao Google Agenda"}
          </button>
        </section>

        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
            <Tag size={14} />
            Etiquetas
          </h3>
          <div className="flex flex-wrap gap-2">
            {labels.map((label) => {
              const active = task.labels.includes(label.id);
              return (
                <button
                  key={label.id}
                  onClick={() => onPatch({ labels: active ? task.labels.filter((item) => item !== label.id) : [...task.labels, label.id] } as Partial<TaskItem>)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-bold ${
                    active ? "border-[var(--primary)] bg-[var(--primary)]/10" : "border-[var(--border)]"
                  }`}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} />
                  {label.name}
                </button>
              );
            })}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
              <Paperclip size={14} />
              Anexos
            </h3>
            <button onClick={() => fileInputRef.current?.click()} className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--border)] hover:bg-[var(--surface-hover)]">
              <FileUp size={14} />
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
          <div className="space-y-2">
            {task.attachments.map((attachment) => (
              <button key={attachment.id} type="button" onClick={() => void openWithAuth(attachment.url)} className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-left text-xs font-bold hover:border-[var(--primary)]">
                <span className="truncate">{attachment.name}</span>
                <span className="shrink-0 text-[var(--text-secondary)]">{fileSizeLabel(attachment.size)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
            <MessageSquare size={14} />
            Comentários
          </h3>
          <div className="space-y-2">
            {task.comments.map((item) => (
              <div key={item.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                <p className="text-xs font-bold">{item.author}</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-secondary)]">{item.text}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Adicionar comentário"
              className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-semibold outline-none"
            />
            <button onClick={onAddComment} className="h-10 rounded-lg bg-[var(--primary)] px-3 text-xs font-bold text-white">
              Enviar
            </button>
          </div>
        </section>
      </div>

      <footer className="border-t border-[var(--border)] p-4">
        <button onClick={onDelete} className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-rose-500/30 text-sm font-bold text-rose-300 hover:bg-rose-500/10">
          <Trash2 size={15} />
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-base font-bold">Configuracoes do projeto</h2>
            <p className="text-xs font-semibold text-[var(--text-secondary)]">
              Prazos, responsavel, categoria e padroes para tarefas e agenda.
            </p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--surface-hover)]">
            <X size={18} />
          </button>
        </header>

        <div className="grid gap-4 p-5 md:grid-cols-2">
          <section className="space-y-3">
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Nome do projeto"
              className="h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
            />
            <textarea
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Descricao"
              rows={5}
              className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-semibold outline-none focus:border-blue-400"
            />
            <input
              value={form.owner}
              onChange={(event) => setForm({ ...form, owner: event.target.value })}
              placeholder="Responsavel"
              className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
            />
            <Select value={form.responsibleUserId} onChange={(value) => {
              const member = teamMembers.find((item) => item.id === value);
              setForm({ ...form, responsibleUserId: value, responsibleName: member?.nome || form.responsibleName });
            }}>
              {teamMembers.map((member) => (
                <option key={member.id} value={member.id}>{member.nome}</option>
              ))}
            </Select>
            {teamMembers.length > 1 && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                <p className="mb-2 text-xs font-bold uppercase text-[var(--text-secondary)]">Compartilhar projeto</p>
                <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
                  {teamMembers.filter((member) => member.id !== ownerUserId).map((member) => (
                    <label key={member.id} className="flex items-center justify-between gap-3 text-xs font-bold">
                      <span className="truncate">{member.nome}</span>
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
                        className="h-4 w-4 accent-cyan-400"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Select value={form.category} onChange={(value) => setForm({ ...form, category: value as ProjectCategory })}>
                {Object.entries(projectCategoryLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Select>
              <Select value={form.status} onChange={(value) => setForm({ ...form, status: value as ProjectStatus })}>
                {Object.entries(projectStatusLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="date"
                value={form.startDate}
                onChange={(event) => setForm({ ...form, startDate: event.target.value })}
                className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
                title="Inicio do projeto"
              />
              <input
                type="date"
                value={form.dueDate}
                onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
                className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
                title="Prazo final"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select value={form.defaultPriority} onChange={(value) => setForm({ ...form, defaultPriority: value as TaskPriority })}>
                <option value="baixa">Prioridade baixa</option>
                <option value="media">Prioridade media</option>
                <option value="alta">Prioridade alta</option>
                <option value="urgente">Prioridade urgente</option>
              </Select>
              <input
                type="time"
                value={form.defaultStartTime}
                onChange={(event) => setForm({ ...form, defaultStartTime: event.target.value })}
                className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
                title="Horario padrao para Google Agenda"
              />
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase text-[var(--text-secondary)]">
                Duracao padrao no Google Agenda (min)
              </span>
              <input
                type="number"
                min={15}
                step={15}
                value={form.calendarDurationMinutes}
                onChange={(event) => setForm({ ...form, calendarDurationMinutes: Number(event.target.value) })}
                className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-blue-400"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {projectColorOptions.map((color) => (
                <button
                  key={color}
                  onClick={() => setForm({ ...form, color })}
                  className={`h-8 w-8 rounded-full border-2 transition ${
                    form.color === color ? "border-white scale-105" : "border-transparent"
                  }`}
                  style={{ backgroundColor: color }}
                  title={color}
                 aria-label={color} />
              ))}
            </div>
          </section>
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
          <button onClick={onClose} className="h-10 rounded-lg border border-[var(--border)] px-4 text-sm font-bold hover:bg-[var(--surface-hover)]">
            Cancelar
          </button>
          <button disabled={!form.name.trim()} onClick={onSubmit} className="h-10 rounded-lg bg-[var(--primary)] px-4 text-sm font-bold text-white disabled:opacity-40">
            Salvar configuracoes
          </button>
        </footer>
      </div>
    </div>
  );
}

function CreateTaskModal({
  form,
  labels,
  teamMembers,
  setForm,
  toggleLabel,
  onClose,
  onSubmit,
}: {
  form: TaskForm;
  labels: TaskLabel[];
  teamMembers: NoriumUser[];
  setForm: (form: TaskForm) => void;
  toggleLabel: (labelId: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-base font-bold">Nova tarefa</h2>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--surface-hover)]">
            <X size={18} />
          </button>
        </header>
        <div className="space-y-3 p-5">
          <input
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            placeholder="Título"
            className="h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none"
          />
          <textarea
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            placeholder="Descrição"
            rows={4}
            className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-semibold outline-none"
          />
          <div className="grid grid-cols-2 gap-3">
            <Select value={form.priority} onChange={(value) => setForm({ ...form, priority: value as TaskPriority })}>
              <option value="baixa">Baixa</option>
              <option value="media">Média</option>
              <option value="alta">Alta</option>
              <option value="urgente">Urgente</option>
            </Select>
            <input
              type="date"
              value={form.dueDate}
              onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
              className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none"
            />
          </div>
          <Select value={form.category} onChange={(value) => setForm({ ...form, category: value })}>
            {taskCategoryOptions.map((category) => (
              <option key={category.id} value={category.id}>{category.label}</option>
            ))}
          </Select>
          <Select value={form.assigneeId} onChange={(value) => setForm({ ...form, assigneeId: value })}>
            <option value="">Responsavel padrao do projeto</option>
            {teamMembers.map((member) => (
              <option key={member.id} value={member.id}>{member.nome}</option>
            ))}
          </Select>
          <div className="flex flex-wrap gap-2">
            {labels.map((label) => (
              <button
                key={label.id}
                onClick={() => toggleLabel(label.id)}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-bold ${
                  form.labels.includes(label.id) ? "border-[var(--primary)] bg-[var(--primary)]/10" : "border-[var(--border)]"
                }`}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} />
                {label.name}
              </button>
            ))}
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
          <button onClick={onClose} className="h-10 rounded-lg border border-[var(--border)] px-4 text-sm font-bold hover:bg-[var(--surface-hover)]">
            Cancelar
          </button>
          <button disabled={!form.title.trim()} onClick={onSubmit} className="h-10 rounded-lg bg-[var(--primary)] px-4 text-sm font-bold text-white disabled:opacity-40">
            Criar
          </button>
        </footer>
      </div>
    </div>
  );
}
