// Contratos do Kanban compartilhados entre projetos, cards e formularios.
export type TaskStatus = "pendente" | "andamento" | "revisao" | "concluida";
export type TaskPriority = "baixa" | "media" | "alta" | "urgente";
export type ProjectCategory = "operacao" | "cliente" | "produto" | "financeiro" | "suporte" | "pessoal";
export type ProjectStatus = "planejamento" | "ativo" | "pausado" | "concluido";
export type ProjectAction = "archive" | "restore" | "delete";

export interface TaskColumn {
  id: TaskStatus;
  title: string;
  limit?: number | null;
}

export interface TaskLabel {
  id: string;
  name: string;
  color: string;
}

export interface TaskAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
}

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface TaskItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  category: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  dueDate?: string | null;
  assigneeId?: string;
  assigneeName?: string;
  createdBy?: string;
  attachments: TaskAttachment[];
  comments: TaskComment[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  order: number;
}

export interface TaskStats {
  total: number;
  ativas: number;
  pendentes: number;
  andamento: number;
  concluidas: number;
  vencidas: number;
}

export interface TaskForm {
  title: string;
  description: string;
  category: string;
  priority: TaskPriority;
  dueDate: string;
  labels: string[];
  assigneeId: string;
}

export interface TaskWorkspace {
  id: string;
  name: string;
  category: ProjectCategory;
  description: string;
  color: string;
  defaultPriority: TaskPriority;
  owner: string;
  ownerUserId?: string;
  responsibleUserId: string;
  responsibleName: string;
  sharedUserIds: string[];
  status: ProjectStatus;
  startDate: string;
  dueDate: string;
  defaultStartTime: string;
  calendarDurationMinutes: number;
  archived: boolean;
  archivedAt?: string | null;
  createdAt: string;
}

export interface WorkspaceForm {
  name: string;
  category: ProjectCategory;
  description: string;
  color: string;
  defaultPriority: TaskPriority;
  owner: string;
  responsibleUserId: string;
  responsibleName: string;
  sharedUserIds: string[];
  status: ProjectStatus;
  startDate: string;
  dueDate: string;
  defaultStartTime: string;
  calendarDurationMinutes: number;
}
