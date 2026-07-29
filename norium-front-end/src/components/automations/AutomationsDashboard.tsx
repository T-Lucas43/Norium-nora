import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  BarChart3,
  Bell,
  CalendarDays,
  CheckSquare,
  Clock3,
  Copy,
  CreditCard,
  Download,
  FileText,
  Filter,
  FlaskConical,
  GitBranch,
  History,
  Layers,
  ListChecks,
  Mail,
  MessageSquare,
  MousePointer2,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Star,
  Tags,
  Trash2,
  Upload,
  Users,
  Variable,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { automationsApiRequest, fetchActiveTaskProjects } from "../../features/automations/api";
import type {
  Automation,
  AutomationConnection,
  AutomationFlow,
  AutomationFormState,
  AutomationHistoryItem,
  AutomationIntegration,
  AutomationMetrics,
  AutomationNode,
  AutomationResponse,
  AutomationStatus,
  AutomationTemplate,
  FilterKey,
  StepKind,
  TaskProject,
} from "../../features/automations/types";

type AutomationsDashboardProps = {
  onOpenNora?: () => void;
};

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: "todas", label: "Todas" },
  { key: "ativas", label: "Ativas" },
  { key: "desativadas", label: "Desativadas" },
  { key: "ia", label: "IA" },
  { key: "recentes", label: "Recentes" },
];

const triggers = ["WhatsApp", "Chat da Equipe", "E-mail", "Agenda", "Tarefas", "Gastos", "Relatorios", "Webhook", "API", "Agendamento", "Manual"];
const actions = [
  "Enviar WhatsApp",
  "Enviar mensagem no Chat",
  "Enviar e-mail",
  "Agrupar e-mails por categoria",
  "Criar tarefa",
  "Atualizar tarefa",
  "Criar relatorio",
  "Atualizar relatorio",
  "Registrar gasto",
  "Executar IA",
  "Perguntar para Nora",
  "Executar Webhook",
  "Executar API",
  "Mostrar notificacao",
];

const taskCategoryOptions = [
  { value: "geral", label: "Geral" },
  { value: "produto", label: "Produto" },
  { value: "cliente", label: "Cliente" },
  { value: "financeiro", label: "Financeiro" },
  { value: "operacao", label: "Operacao" },
  { value: "suporte", label: "Suporte" },
  { value: "comercial", label: "Comercial" },
  { value: "pessoal", label: "Pessoal" },
];

const emailCategoryOptions = [
  { value: "auto", label: "Detectar automaticamente" },
  { value: "principal", label: "Principal" },
  { value: "financeiro", label: "Financeiro" },
  { value: "trabalho", label: "Trabalho" },
  { value: "promocoes", label: "Promocoes" },
  { value: "social", label: "Social" },
  { value: "atualizacoes", label: "Atualizacoes" },
  { value: "suporte", label: "Suporte" },
];

const noraAbilities = [
  "Resumir textos",
  "Responder mensagens",
  "Traduzir",
  "Classificar prioridade",
  "Criar tarefas automaticamente",
  "Gerar respostas",
  "Gerar relatorios",
  "Resumir e-mails",
  "Analisar conversas",
  "Detectar sentimento",
  "Organizar informacoes",
];

const iconMap: Record<string, LucideIcon> = {
  activity: Activity,
  "bar-chart-3": BarChart3,
  bell: Bell,
  "calendar-days": CalendarDays,
  "check-square": CheckSquare,
  "credit-card": CreditCard,
  "file-text": FileText,
  "git-branch": GitBranch,
  "list-checks": ListChecks,
  mail: Mail,
  "message-square": MessageSquare,
  "messages-square": MessageSquare,
  rocket: Rocket,
  sparkles: Sparkles,
  tags: Tags,
  users: Users,
  webhook: Webhook,
  zap: Zap,
};

const emptyResponse: AutomationResponse = {
  automations: [],
  history: [],
  templates: [],
  integrations: [],
  metrics: { total: 0, active: 0, runsToday: 0, savedMinutes: 0 },
};

const LOCAL_AUTOMATIONS_KEY = "norium:automacoes:local";

const fallbackTemplates: AutomationTemplate[] = [
  { id: "tpl_email_task", title: "E-mail -> Criar tarefa", description: "Converte e-mails importantes em tarefas priorizadas.", icon: "mail" },
  { id: "tpl_whatsapp_ai", title: "WhatsApp -> Responder com IA", description: "Sugere ou envia uma resposta com o tom da Nora.", icon: "message-square" },
  { id: "tpl_whatsapp_task", title: "WhatsApp -> Criar tarefa", description: "Transforma pedidos do WhatsApp em cards.", icon: "check-square" },
  { id: "tpl_agenda_team", title: "Agenda -> Avisar equipe", description: "Notifica o time antes de reuniões e compromissos.", icon: "calendar-days" },
  { id: "tpl_finance_report", title: "Novo gasto -> Atualizar relatório", description: "Atualiza indicadores financeiros automaticamente.", icon: "credit-card" },
  { id: "tpl_weekly_report", title: "Relatório semanal automático", description: "Gera resumo semanal de produtividade.", icon: "bar-chart-3" },
];

const fallbackIntegrations: AutomationIntegration[] = [
  "WhatsApp",
  "Chat da Equipe",
  "Gmail",
  "Google Agenda",
  "Tarefas",
  "Gastos",
  "Relatórios",
].map((name) => ({ name, status: "Conectado" }));

const componentLibrary: Array<{
  group: string;
  items: Array<{ title: string; description: string; icon: string; kind: StepKind; category: string }>;
}> = [
  {
    group: "Gatilhos",
    items: [
      { title: "Novo e-mail", description: "Dispara quando chegar mensagem no Gmail.", icon: "mail", kind: "trigger", category: "E-mail" },
      { title: "Mensagem WhatsApp", description: "Dispara com mensagem recebida no chat.", icon: "message-square", kind: "trigger", category: "WhatsApp" },
      { title: "Evento na agenda", description: "Dispara com evento criado ou próximo.", icon: "calendar-days", kind: "trigger", category: "Agenda" },
      { title: "Tarefa atualizada", description: "Dispara quando um card mudar de status.", icon: "check-square", kind: "trigger", category: "Tarefas" },
      { title: "Novo gasto", description: "Dispara ao registrar lançamento financeiro.", icon: "credit-card", kind: "trigger", category: "Gastos" },
      { title: "Webhook", description: "Recebe dados de sistemas externos.", icon: "webhook", kind: "trigger", category: "Webhook" },
    ],
  },
  {
    group: "Ações",
    items: [
      { title: "Enviar e-mail", description: "Envia ou responde uma mensagem pelo Gmail.", icon: "mail", kind: "action", category: "E-mail" },
      { title: "Agrupar e-mails por categoria", description: "Classifica mensagens recentes por principal, financeiro, trabalho e promocoes.", icon: "tags", kind: "action", category: "E-mail" },
      { title: "Enviar WhatsApp", description: "Envia mensagem para contato ou grupo.", icon: "message-square", kind: "action", category: "WhatsApp" },
      { title: "Criar tarefa", description: "Cria card com prioridade, prazo e etiquetas.", icon: "check-square", kind: "action", category: "Tarefas" },
      { title: "Registrar gasto", description: "Cria lançamento financeiro com categoria.", icon: "credit-card", kind: "action", category: "Gastos" },
      { title: "Atualizar relatório", description: "Atualiza indicadores operacionais.", icon: "bar-chart-3", kind: "action", category: "Relatórios" },
      { title: "Notificar equipe", description: "Envia aviso no chat interno.", icon: "users", kind: "action", category: "Equipe" },
    ],
  },
  {
    group: "Nora IA",
    items: [
      { title: "Nora: resumir", description: "Resume textos, e-mails ou conversas.", icon: "sparkles", kind: "nora", category: "Nora IA" },
      { title: "Nora: classificar", description: "Define prioridade, sentimento e intenção.", icon: "sparkles", kind: "nora", category: "Nora IA" },
      { title: "Nora: traduzir", description: "Traduz conteúdo para outro idioma.", icon: "sparkles", kind: "nora", category: "Nora IA" },
      { title: "Nora: gerar resposta", description: "Cria resposta pronta para revisar ou enviar.", icon: "sparkles", kind: "nora", category: "Nora IA" },
    ],
  },
];

const defaultForm: AutomationFormState = {
  name: "",
  description: "",
  icon: "zap",
  category: "Operacional",
  trigger: "Manual",
  actions: "Executar IA, Mostrar notificacao",
  active: true,
  aiEnabled: true,
  schedule: "",
  taskProjectId: "default",
  taskProjectName: "Operacao Norium",
  taskCategory: "geral",
  emailCategory: "auto",
  retryPolicy: "once",
  failureAction: "notify",
  approvalRequired: false,
  notifyOnSuccess: true,
  notifyOnFailure: true,
};

function IconByName({ name, size = 18, className = "" }: { name: string; size?: number; className?: string }) {
  const Icon = iconMap[name] || Zap;
  return <Icon size={size} className={className} />;
}

function formatDateTime(value?: string | null) {
  if (!value) return "Nunca";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Nunca";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function formatDuration(ms: number) {
  if (!ms) return "0,0s";
  return `${(ms / 1000).toFixed(1).replace(".", ",")}s`;
}

function executionStatusClass(status: string) {
  if (status === "erro") return "bg-rose-400/14 text-rose-200";
  if (status === "simulado") return "bg-cyan-400/14 text-cyan-100";
  if (status === "executando") return "bg-amber-400/14 text-amber-100";
  return "bg-emerald-400/14 text-emerald-200";
}

function formatSavedTime(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix = "auto") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function createNode(item: { title: string; description: string; icon: string; kind: StepKind }, index: number): AutomationNode {
  return {
    id: newId("node"),
    kind: item.kind,
    icon: item.icon,
    title: item.title,
    description: item.description,
    x: 80 + index * 260,
    y: index % 2 === 0 ? 130 : 245,
  };
}

function connectNodes(nodes: AutomationNode[]): AutomationConnection[] {
  return nodes.slice(0, -1).map((nodeItem, index) => ({
    source: nodeItem.id,
    target: nodes[index + 1].id,
  }));
}

function flowFromParts(parts: Array<{ title: string; description: string; icon: string; kind: StepKind }>): AutomationFlow {
  const nodes = parts.map((part, index) => createNode(part, index));
  return { nodes, connections: connectNodes(nodes) };
}

function flowFromFormState(formState: AutomationFormState): AutomationFlow {
  const actionParts = formState.actions
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((title) => ({
      title,
      description: title.toLowerCase().includes("ia") ? "Nora analisa o contexto antes da próxima etapa." : `Executa: ${title}.`,
      icon: title.toLowerCase().includes("ia") || title.toLowerCase().includes("nora") ? "sparkles" : "zap",
      kind: title.toLowerCase().includes("ia") || title.toLowerCase().includes("nora") ? ("nora" as StepKind) : ("action" as StepKind),
    }));

  return flowFromParts([
    {
      title: formState.trigger || "Manual",
      description: `Gatilho: ${formState.trigger || "Manual"}.`,
      icon: formState.icon || "zap",
      kind: "trigger",
    },
    ...actionParts,
  ]);
}

function actionsFromFlow(flowValue: AutomationFlow) {
  return flowValue.nodes.filter((item) => item.kind !== "trigger").map((item) => item.title);
}

function automationFromForm(formState: AutomationFormState, flowValue: AutomationFlow, existing?: Automation | null): Automation {
  const createdAt = existing?.createdAt || nowIso();
  const active = formState.active;
  return {
    id: existing?.id || newId("auto"),
    name: formState.name || "Nova automação",
    description: formState.description || "Fluxo visual criado no Norium.",
    icon: formState.icon || flowValue.nodes[0]?.icon || "zap",
    category: formState.category || flowValue.nodes[0]?.title || "Operacional",
    trigger: formState.trigger || flowValue.nodes.find((item) => item.kind === "trigger")?.title || "Manual",
    actions: actionsFromFlow(flowValue),
    status: active ? "ativa" : "desativada",
    active,
    aiEnabled: formState.aiEnabled || flowValue.nodes.some((item) => item.kind === "nora"),
    favorite: existing?.favorite || false,
    lastRunAt: existing?.lastRunAt || null,
    executions: existing?.executions || 0,
    savedMinutes: existing?.savedMinutes || 0,
    savedMinutesPerRun: existing?.savedMinutesPerRun || (formState.aiEnabled ? 12 : 7),
    createdAt,
    updatedAt: nowIso(),
    version: (existing?.version || 0) + 1,
    variables: {
      ...(existing?.variables || {}),
      taskProjectId: formState.taskProjectId || "default",
      taskProjectName: formState.taskProjectName || "Operacao Norium",
      taskCategory: formState.taskCategory || "geral",
      emailCategory: formState.emailCategory || "auto",
      retryPolicy: formState.retryPolicy || "once",
      failureAction: formState.failureAction || "notify",
      approvalRequired: String(formState.approvalRequired),
      notifyOnSuccess: String(formState.notifyOnSuccess),
      notifyOnFailure: String(formState.notifyOnFailure),
    },
    schedule: formState.schedule,
    flow: flowValue,
    logs: existing?.logs || [],
  };
}

function calculateMetrics(automations: Automation[], history: AutomationHistoryItem[]): AutomationMetrics {
  const today = new Date().toISOString().slice(0, 10);
  return {
    total: automations.length,
    active: automations.filter((item) => item.active).length,
    runsToday: history.filter((item) => item.timestamp.startsWith(today)).length,
    savedMinutes: automations.reduce((sum, item) => sum + Number(item.savedMinutes || 0), 0),
  };
}

function normalizeAutomationResponse(value: Partial<AutomationResponse>): AutomationResponse {
  const automations = value.automations || [];
  const history = value.history || [];
  return {
    automations,
    history,
    templates: value.templates?.length ? value.templates : fallbackTemplates,
    integrations: value.integrations?.length ? value.integrations : fallbackIntegrations,
    metrics: value.metrics || calculateMetrics(automations, history),
    updatedAt: value.updatedAt || nowIso(),
  };
}

function defaultLocalAutomations(): Automation[] {
  const templates = [
    {
      form: {
        ...defaultForm,
        name: "Novo e-mail recebido",
        description: "Executa IA, cria uma tarefa e envia aviso no WhatsApp.",
        icon: "mail",
        category: "E-mail",
        trigger: "Novo e-mail",
        actions: "Nora: resumir, Criar tarefa, Enviar WhatsApp",
        aiEnabled: true,
      },
    },
    {
      form: {
        ...defaultForm,
        name: "Nova mensagem WhatsApp",
        description: "Classifica a mensagem, cria tarefa e notifica a equipe.",
        icon: "message-square",
        category: "WhatsApp",
        trigger: "Mensagem WhatsApp",
        actions: "Nora: classificar, Criar tarefa, Notificar equipe",
        aiEnabled: true,
      },
    },
    {
      form: {
        ...defaultForm,
        name: "Novo gasto registrado",
        description: "Atualiza relatório e gera resumo financeiro.",
        icon: "credit-card",
        category: "Gastos",
        trigger: "Novo gasto",
        actions: "Atualizar relatório, Nora: resumir",
        aiEnabled: true,
      },
    },
  ];
  return templates.map(({ form }) => automationFromForm(form, flowFromFormState(form), null));
}

function readLocalAutomations(): AutomationResponse {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_AUTOMATIONS_KEY) || "{}") as Partial<AutomationResponse>;
    if (parsed.automations?.length) return normalizeAutomationResponse(parsed);
  } catch {
    // Fallback abaixo.
  }
  const automations = defaultLocalAutomations();
  return normalizeAutomationResponse({ automations, history: [] });
}

function writeLocalAutomations(response: AutomationResponse) {
  localStorage.setItem(LOCAL_AUTOMATIONS_KEY, JSON.stringify(response));
}

async function apiJson<T>(path = "", init?: RequestInit): Promise<T> {
  return automationsApiRequest<T>(path, init);
}

function StatCard({ title, value, icon: Icon, detail }: { title: string; value: string | number; icon: LucideIcon; detail: string }) {
  return (
    <motion.article
      whileHover={{ y: -3, scale: 1.01 }}
      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--glass-shadow)] backdrop-blur-2xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.14em] text-[var(--text-secondary)]">{title}</p>
          <strong className="mt-3 block text-3xl font-black text-[var(--text)]">{value}</strong>
          <span className="mt-1 block text-xs font-semibold text-[var(--text-secondary)]">{detail}</span>
        </div>
        <span className="grid h-11 w-11 place-items-center rounded-lg bg-blue-500/14 text-cyan-200">
          <Icon size={21} />
        </span>
      </div>
    </motion.article>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 rounded-full border transition ${
        checked ? "border-emerald-300/40 bg-emerald-400/45" : "border-[var(--border)] bg-[var(--background)]"
      }`}
      aria-label={checked ? "Desativar automacao" : "Ativar automacao"}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-lg transition ${
          checked ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}

export default function AutomationsDashboard({ onOpenNora }: AutomationsDashboardProps) {
  const [data, setData] = useState<AutomationResponse>(emptyResponse);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("todas");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [localMode, setLocalMode] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderEditingId, setBuilderEditingId] = useState<string | null>(null);
  const [builderFlow, setBuilderFlow] = useState<AutomationFlow>(() => flowFromFormState(defaultForm));
  const [builderZoom, setBuilderZoom] = useState(0.86);
  const [selectedBuilderNodeId, setSelectedBuilderNodeId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [builderValidation, setBuilderValidation] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flow, setFlow] = useState<AutomationFlow | null>(null);
  const [zoom, setZoom] = useState(0.9);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [form, setForm] = useState<AutomationFormState>(defaultForm);
  const [logAutomation, setLogAutomation] = useState<Automation | null>(null);
  const [taskProjects, setTaskProjects] = useState<TaskProject[]>([
    { id: "default", name: "Operacao Norium", category: "operacao" },
  ]);
  const importRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef<{ id: string; startX: number; startY: number; originalX: number; originalY: number } | null>(null);
  const builderDraggingRef = useRef<{ id: string; startX: number; startY: number; originalX: number; originalY: number } | null>(null);
  const saveFlowRef = useRef<() => Promise<void>>(async () => undefined);

  const selectedAutomation = useMemo(
    () => data.automations.find((automation) => automation.id === selectedId) || data.automations[0] || null,
    [data.automations, selectedId],
  );

  const filteredAutomations = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return data.automations.filter((automation) => {
      const matchesQuery =
        !normalized ||
        `${automation.name} ${automation.description} ${automation.trigger} ${automation.category} ${automation.actions.join(" ")}`
          .toLowerCase()
          .includes(normalized);
      const matchesFilter =
        filter === "todas" ||
        (filter === "ativas" && automation.active) ||
        (filter === "desativadas" && !automation.active) ||
        (filter === "ia" && automation.aiEnabled) ||
        (filter === "recentes" && Boolean(automation.lastRunAt || automation.updatedAt));
      return matchesQuery && matchesFilter;
    });
  }, [data.automations, filter, query]);

  useEffect(() => {
    void loadAutomations();
    void loadTaskProjects();
  }, []);

  useEffect(() => {
    if (!builderOpen) return;
    setBuilderZoom(window.innerWidth <= 720 ? 0.62 : window.innerWidth <= 1200 ? 0.74 : 0.86);
  }, [builderOpen]);

  useEffect(() => {
    if (!selectedAutomation) {
      setFlow(null);
      return;
    }
    setFlow(selectedAutomation.flow);
  }, [selectedAutomation]);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const dragging = draggingRef.current;
      if (!dragging) return;
      const nextX = dragging.originalX + (event.clientX - dragging.startX) / zoom;
      const nextY = dragging.originalY + (event.clientY - dragging.startY) / zoom;
      setFlow((current) =>
        current
          ? {
              ...current,
              nodes: current.nodes.map((nodeItem) =>
                nodeItem.id === dragging.id
                  ? { ...nodeItem, x: Math.max(20, Math.min(980, nextX)), y: Math.max(30, Math.min(320, nextY)) }
                  : nodeItem,
              ),
            }
          : current,
      );
    }

    function onUp() {
      const wasDragging = Boolean(draggingRef.current);
      draggingRef.current = null;
      if (wasDragging) {
        window.setTimeout(() => {
          void saveFlowRef.current();
        }, 0);
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [zoom, flow, selectedAutomation?.id]);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const dragging = builderDraggingRef.current;
      if (!dragging) return;
      const nextX = dragging.originalX + (event.clientX - dragging.startX) / builderZoom;
      const nextY = dragging.originalY + (event.clientY - dragging.startY) / builderZoom;
      setBuilderFlow((current) => ({
        ...current,
        nodes: current.nodes.map((nodeItem) =>
          nodeItem.id === dragging.id
            ? { ...nodeItem, x: Math.max(40, Math.min(1320, nextX)), y: Math.max(40, Math.min(560, nextY)) }
            : nodeItem,
        ),
      }));
    }

    function onUp() {
      builderDraggingRef.current = null;
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [builderZoom]);

  async function loadAutomations() {
    setLoading(true);
    setError("");
    try {
      const response = await apiJson<AutomationResponse>();
      const normalized = normalizeAutomationResponse(response);
      setLocalMode(false);
      setData(normalized);
      setSelectedId((current) => current || response.automations[0]?.id || null);
    } catch (err) {
      const fallback = readLocalAutomations();
      setLocalMode(true);
      setData(fallback);
      setSelectedId((current) => current || fallback.automations[0]?.id || null);
      const reason = err instanceof Error ? err.message : "O backend de automações não respondeu.";
      setStatusMessage(`${reason} Usando modo local temporário.`);
    } finally {
      setLoading(false);
    }
  }

  async function loadTaskProjects() {
    try {
      const activeProjects = await fetchActiveTaskProjects();
      if (activeProjects.length) setTaskProjects(activeProjects);
    } catch {
      setTaskProjects([{ id: "default", name: "Operacao Norium", category: "operacao" }]);
    }
  }

  async function updateAutomation(id: string, updates: Partial<Automation>) {
    if (localMode) {
      const next = normalizeAutomationResponse({
        ...data,
        automations: data.automations.map((automation) =>
          automation.id === id
            ? {
                ...automation,
                ...updates,
                status: (updates.status || (updates.active === false ? "desativada" : updates.active === true ? "ativa" : automation.status)) as AutomationStatus,
                updatedAt: nowIso(),
              }
            : automation,
        ),
      });
      setData(next);
      writeLocalAutomations(next);
      return;
    }
    const response = await apiJson<AutomationResponse>(`/${id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    setData(normalizeAutomationResponse(response));
  }

  async function saveFlow() {
    if (!selectedAutomation || !flow) return;
    try {
      await updateAutomation(selectedAutomation.id, { flow } as Partial<Automation>);
      setStatusMessage("Fluxo salvo.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar o fluxo.");
    }
  }
  saveFlowRef.current = saveFlow;

  async function executeAutomation(automation: Automation) {
    setSaving(true);
    setError("");
    try {
      if (localMode) {
        const timestamp = nowIso();
        const historyItem: AutomationHistoryItem = {
          id: newId("log"),
          automationId: automation.id,
          automationName: automation.name,
          timestamp,
          status: "sucesso",
          durationMs: 980,
          result: `${automation.name} executada em modo local.`,
          executedBy: "Operador",
          savedMinutes: automation.savedMinutesPerRun,
        };
        const nextAutomations = data.automations.map((item) =>
          item.id === automation.id
            ? {
                ...item,
                executions: item.executions + 1,
                savedMinutes: item.savedMinutes + item.savedMinutesPerRun,
                lastRunAt: timestamp,
                logs: [historyItem, ...(item.logs || [])].slice(0, 20),
              }
            : item,
        );
        const next = normalizeAutomationResponse({ ...data, automations: nextAutomations, history: [historyItem, ...data.history] });
        setData(next);
        writeLocalAutomations(next);
        setSelectedId(automation.id);
        setStatusMessage(`${automation.name} executada com sucesso.`);
        return;
      }
      const response = await apiJson<AutomationResponse>(`/${automation.id}/executar`, { method: "POST" });
      setData(normalizeAutomationResponse(response));
      setSelectedId(automation.id);
      setStatusMessage(`${automation.name} executada com sucesso.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível executar a automação.");
    } finally {
      setSaving(false);
    }
  }

  async function simulateAutomation(automation: Automation) {
    setSaving(true);
    setError("");
    try {
      if (localMode) {
        const timestamp = nowIso();
        const historyItem: AutomationHistoryItem = {
          id: newId("log"),
          automationId: automation.id,
          automationName: automation.name,
          timestamp,
          status: "simulado",
          durationMs: 0,
          result: "Simulacao concluida. Nenhuma mensagem foi enviada e nenhum dado real foi alterado.",
          executedBy: "Operador",
          savedMinutes: 0,
          attempt: 1,
          input: { trigger: automation.trigger, variables: automation.variables },
          sideEffects: false,
          steps: automation.flow.nodes.map((node) => ({
            id: node.id,
            title: node.title,
            kind: node.kind,
            status: "simulado",
            attempt: 1,
            startedAt: timestamp,
            finishedAt: timestamp,
            preview:
              node.kind === "trigger"
                ? "Gatilho validado sem consumir dados reais."
                : `Executaria "${node.title}" sem alterar dados.`,
          })),
        };
        const nextAutomations = data.automations.map((item) =>
          item.id === automation.id
            ? { ...item, logs: [historyItem, ...(item.logs || [])].slice(0, 50) }
            : item,
        );
        const next = normalizeAutomationResponse({
          ...data,
          automations: nextAutomations,
          history: [historyItem, ...data.history].slice(0, 250),
        });
        setData(next);
        writeLocalAutomations(next);
        setLogAutomation(next.automations.find((item) => item.id === automation.id) || null);
        setStatusMessage("Simulacao concluida sem efeitos reais.");
        return;
      }

      const response = await apiJson<AutomationResponse>(`/${automation.id}/simular`, { method: "POST" });
      const next = normalizeAutomationResponse(response);
      setData(next);
      setLogAutomation(next.automations.find((item) => item.id === automation.id) || null);
      setStatusMessage("Simulacao concluida sem efeitos reais.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao foi possivel simular a automacao.");
    } finally {
      setSaving(false);
    }
  }

  async function retryAutomation(automation: Automation, logId: string) {
    setSaving(true);
    setError("");
    try {
      if (localMode) {
        await executeAutomation(automation);
        return;
      }
      const response = await apiJson<AutomationResponse>(
        `/${automation.id}/reexecutar/${logId}`,
        { method: "POST" },
      );
      const next = normalizeAutomationResponse(response);
      setData(next);
      setLogAutomation(next.automations.find((item) => item.id === automation.id) || null);
      setStatusMessage("Fluxo retomado e nova execucao registrada.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao foi possivel retomar a automacao.");
    } finally {
      setSaving(false);
    }
  }

  async function duplicateAutomation(automation: Automation) {
    if (localMode) {
      const clone: Automation = {
        ...automation,
        id: newId("auto"),
        name: `${automation.name} (cópia)`,
        executions: 0,
        savedMinutes: 0,
        lastRunAt: null,
        favorite: false,
        logs: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const next = normalizeAutomationResponse({ ...data, automations: [clone, ...data.automations] });
      setData(next);
      writeLocalAutomations(next);
      setStatusMessage("Automação duplicada.");
      return;
    }
    const response = await apiJson<AutomationResponse>(`/${automation.id}/duplicar`, { method: "POST" });
    setData(normalizeAutomationResponse(response));
    setStatusMessage("Automação duplicada.");
  }

  async function deleteAutomation(automation: Automation) {
    if (!window.confirm(`Excluir a automacao "${automation.name}"?`)) return;
    if (localMode) {
      const next = normalizeAutomationResponse({
        ...data,
        automations: data.automations.filter((item) => item.id !== automation.id),
      });
      setData(next);
      writeLocalAutomations(next);
      setSelectedId(next.automations[0]?.id || null);
      setStatusMessage("Automação excluída.");
      return;
    }
    const response = await apiJson<AutomationResponse>(`/${automation.id}`, { method: "DELETE" });
    setData(normalizeAutomationResponse(response));
    setSelectedId(response.automations[0]?.id || null);
    setStatusMessage("Automação excluída.");
  }

  function openCreateModal(template?: AutomationTemplate) {
    const nextForm = template
      ? {
          ...defaultForm,
          name: template.title,
          description: template.description,
          icon: template.icon,
          category: template.title.includes("gasto") ? "Gastos" : template.title.includes("Agenda") ? "Agenda" : "Operacional",
          trigger: template.title.split("->")[0]?.trim() || "Manual",
          actions: template.title.split("->")[1]?.trim() || defaultForm.actions,
          aiEnabled: template.title.toLowerCase().includes("ia") || template.title.toLowerCase().includes("resum"),
        }
      : { ...defaultForm, name: "Nova automação inteligente" };
    const selectedProject = taskProjects[0] || { id: "default", name: "Operacao Norium" };
    nextForm.taskProjectId = selectedProject.id;
    nextForm.taskProjectName = selectedProject.name;
    setForm(nextForm);
    setBuilderFlow(flowFromFormState(nextForm));
    setBuilderEditingId(null);
    setSelectedBuilderNodeId(null);
    setBuilderOpen(true);
  }

  function openEditModal(automation: Automation) {
    const nextForm = {
      name: automation.name,
      description: automation.description,
      icon: automation.icon,
      category: automation.category,
      trigger: automation.trigger,
      actions: automation.actions.join(", "),
      active: automation.active,
      aiEnabled: automation.aiEnabled,
      schedule: automation.schedule || "",
      taskProjectId: automation.variables?.taskProjectId || "default",
      taskProjectName: automation.variables?.taskProjectName || "Operacao Norium",
      taskCategory: automation.variables?.taskCategory || "geral",
      emailCategory: automation.variables?.emailCategory || "auto",
      retryPolicy: (automation.variables?.retryPolicy as AutomationFormState["retryPolicy"]) || "once",
      failureAction: (automation.variables?.failureAction as AutomationFormState["failureAction"]) || "notify",
      approvalRequired: automation.variables?.approvalRequired === "true",
      notifyOnSuccess: automation.variables?.notifyOnSuccess !== "false",
      notifyOnFailure: automation.variables?.notifyOnFailure !== "false",
    };
    setForm(nextForm);
    setBuilderFlow(automation.flow || flowFromFormState(nextForm));
    setBuilderEditingId(automation.id);
    setSelectedBuilderNodeId(automation.flow?.nodes?.[0]?.id || null);
    setSelectedId(automation.id);
    setBuilderOpen(true);
  }

  async function submitForm() {
    setSaving(true);
    setError("");
    const payload = {
      name: form.name,
      description: form.description,
      icon: form.icon,
      category: form.category,
      trigger: form.trigger,
      actions: form.actions
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      active: form.active,
      status: form.active ? "ativa" : "desativada",
      aiEnabled: form.aiEnabled,
      schedule: form.schedule,
      savedMinutesPerRun: form.aiEnabled ? 12 : 7,
      variables: {
        taskProjectId: form.taskProjectId,
        taskProjectName: form.taskProjectName,
        taskCategory: form.taskCategory,
        emailCategory: form.emailCategory,
        retryPolicy: form.retryPolicy,
        failureAction: form.failureAction,
        approvalRequired: String(form.approvalRequired),
        notifyOnSuccess: String(form.notifyOnSuccess),
        notifyOnFailure: String(form.notifyOnFailure),
      },
    };
    try {
      const response =
        modal === "edit" && selectedAutomation
          ? await apiJson<AutomationResponse>(`/${selectedAutomation.id}`, { method: "PATCH", body: JSON.stringify(payload) })
          : await apiJson<AutomationResponse>("", { method: "POST", body: JSON.stringify(payload) });
      setData(response);
      setSelectedId(response.automations[0]?.id || selectedAutomation?.id || null);
      setModal(null);
      setStatusMessage(modal === "edit" ? "Automação atualizada." : "Automação criada.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar a automação.");
    } finally {
      setSaving(false);
    }
  }

  function addBuilderComponent(item: { title: string; description: string; icon: string; kind: StepKind; category: string }) {
    setBuilderFlow((current) => {
      const nextNode = createNode(item, current.nodes.length);
      const nodes = item.kind === "trigger" && current.nodes.some((nodeItem) => nodeItem.kind === "trigger")
        ? [nextNode, ...current.nodes.filter((nodeItem) => nodeItem.kind !== "trigger")]
        : [...current.nodes, nextNode];
      const nextFlow = { nodes, connections: connectNodes(nodes) };
      setSelectedBuilderNodeId(nextNode.id);
      setForm((currentForm) => ({
        ...currentForm,
        icon: nodes[0]?.icon || currentForm.icon,
        trigger: nodes.find((nodeItem) => nodeItem.kind === "trigger")?.title || currentForm.trigger,
        category: item.kind === "trigger" ? item.category : currentForm.category,
        actions: actionsFromFlow(nextFlow).join(", "),
        aiEnabled: currentForm.aiEnabled || item.kind === "nora",
      }));
      return nextFlow;
    });
  }

  function removeBuilderNode(nodeId: string) {
    setBuilderFlow((current) => {
      const nodes = current.nodes.filter((nodeItem) => nodeItem.id !== nodeId);
      const safeNodes = nodes.length ? nodes : flowFromFormState(defaultForm).nodes;
      const nextFlow = { nodes: safeNodes, connections: connectNodes(safeNodes) };
      setSelectedBuilderNodeId(safeNodes[0]?.id || null);
      setForm((currentForm) => ({
        ...currentForm,
        trigger: safeNodes.find((nodeItem) => nodeItem.kind === "trigger")?.title || "Manual",
        actions: actionsFromFlow(nextFlow).join(", "),
        aiEnabled: safeNodes.some((nodeItem) => nodeItem.kind === "nora"),
      }));
      return nextFlow;
    });
  }

  function updateBuilderNode(nodeId: string, updates: Partial<AutomationNode>) {
    setBuilderFlow((current) => {
      const nodes = current.nodes.map((nodeItem) => (nodeItem.id === nodeId ? { ...nodeItem, ...updates } : nodeItem));
      const nextFlow = { ...current, nodes };
      setForm((currentForm) => ({
        ...currentForm,
        trigger: nodes.find((nodeItem) => nodeItem.kind === "trigger")?.title || "Manual",
        actions: actionsFromFlow(nextFlow).join(", "),
      }));
      return nextFlow;
    });
  }

  function validateBuilderFlow() {
    const issues: string[] = [];
    const triggersInFlow = builderFlow.nodes.filter((nodeItem) => nodeItem.kind === "trigger");
    const actionsInFlow = builderFlow.nodes.filter((nodeItem) => nodeItem.kind !== "trigger");
    if (!form.name.trim()) issues.push("Informe um nome para a automacao.");
    if (triggersInFlow.length !== 1) issues.push("O fluxo precisa ter exatamente um gatilho.");
    if (!actionsInFlow.length) issues.push("Adicione ao menos uma acao ou bloco da Nora.");
    if (builderFlow.nodes.some((nodeItem) => !nodeItem.title.trim())) issues.push("Todos os blocos precisam de um titulo.");
    if (actionsInFlow.some((nodeItem) => /criar tarefa/i.test(nodeItem.title)) && !form.taskProjectId) {
      issues.push("Selecione o projeto que recebera as tarefas.");
    }
    if (/agendamento/i.test(triggersInFlow[0]?.title || "") && !form.schedule.trim()) {
      issues.push("Defina a frequencia do agendamento.");
    }
    setBuilderValidation(issues);
    setError(issues.length ? "Revise os itens indicados antes de salvar." : "");
    setStatusMessage(issues.length ? "" : "Fluxo validado e pronto para executar.");
    return issues.length === 0;
  }

  async function saveBuilderAutomation() {
    if (!validateBuilderFlow()) return;
    setSaving(true);
    setError("");
    const existing = data.automations.find((automation) => automation.id === builderEditingId) || null;
    const automation = automationFromForm(form, builderFlow, existing);
    const payload = {
      name: automation.name,
      description: automation.description,
      icon: automation.icon,
      category: automation.category,
      trigger: automation.trigger,
      actions: automation.actions,
      active: automation.active,
      status: automation.status,
      aiEnabled: automation.aiEnabled,
      schedule: automation.schedule,
      savedMinutesPerRun: automation.savedMinutesPerRun,
      flow: automation.flow,
      variables: automation.variables,
    };

    try {
      if (localMode) {
        const nextAutomations = existing
          ? data.automations.map((item) => (item.id === existing.id ? automation : item))
          : [automation, ...data.automations];
        const next = normalizeAutomationResponse({ ...data, automations: nextAutomations });
        setData(next);
        writeLocalAutomations(next);
        setSelectedId(automation.id);
        setBuilderOpen(false);
        setStatusMessage(existing ? "Automação atualizada." : "Automação criada.");
        return;
      }

      const response =
        existing
          ? await apiJson<AutomationResponse>(`/${existing.id}`, { method: "PATCH", body: JSON.stringify(payload) })
          : await apiJson<AutomationResponse>("", { method: "POST", body: JSON.stringify(payload) });
      const normalized = normalizeAutomationResponse(response);
      setData(normalized);
      setSelectedId(existing?.id || normalized.automations[0]?.id || null);
      setBuilderOpen(false);
      setStatusMessage(existing ? "Automação atualizada." : "Automação criada.");
    } catch {
      setLocalMode(true);
      const nextAutomations = existing
        ? data.automations.map((item) => (item.id === existing.id ? automation : item))
        : [automation, ...data.automations];
      const next = normalizeAutomationResponse({ ...data, automations: nextAutomations });
      setData(next);
      writeLocalAutomations(next);
      setSelectedId(automation.id);
      setBuilderOpen(false);
      setStatusMessage("Backend indisponível. Automação salva em modo local.");
    } finally {
      setSaving(false);
    }
  }

  function exportAutomations() {
    const blob = new Blob([JSON.stringify(data.automations, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "norium-automacoes.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importAutomations(file: File) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const automations = Array.isArray(parsed) ? parsed : parsed.automations;
    if (!Array.isArray(automations)) throw new Error("Arquivo sem automações válidas.");
    if (localMode) {
      const safeAutomations = automations.map((item) => {
        const itemForm: AutomationFormState = {
          ...defaultForm,
          name: item.name || item.title || "Automação importada",
          description: item.description || "",
          icon: item.icon || "zap",
          category: item.category || "Operacional",
          trigger: item.trigger || "Manual",
          actions: Array.isArray(item.actions) ? item.actions.join(", ") : defaultForm.actions,
          active: item.active ?? item.status !== "desativada",
          aiEnabled: Boolean(item.aiEnabled),
          schedule: item.schedule || "",
        };
        return automationFromForm(itemForm, item.flow || flowFromFormState(itemForm), null);
      });
      const next = normalizeAutomationResponse({ ...data, automations: [...safeAutomations, ...data.automations] });
      setData(next);
      writeLocalAutomations(next);
      setStatusMessage(`${safeAutomations.length} automação(ões) importada(s).`);
      return;
    }
    const response = await apiJson<AutomationResponse>("/importar", {
      method: "POST",
      body: JSON.stringify({ automations }),
    });
    setData(normalizeAutomationResponse(response));
    setStatusMessage(`${response.imported || automations.length} automação(ões) importada(s).`);
  }

  const editorNodes = flow?.nodes || [];
  const editorConnections = flow?.connections || [];
  const selectedBuilderNode = builderFlow.nodes.find((nodeItem) => nodeItem.id === selectedBuilderNodeId) || builderFlow.nodes[0] || null;

  if (builderOpen) {
    return (
      <main className="automation-builder h-full min-h-[calc(100dvh-78px)] overflow-hidden bg-[var(--background)] text-[var(--text)]">
        <div className="flex h-full min-h-[calc(100dvh-78px)] flex-col">
          <header className="flex shrink-0 flex-col gap-4 border-b border-[var(--border)] bg-[var(--surface)]/92 p-4 backdrop-blur-2xl xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <button
                onClick={() => setBuilderOpen(false)}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[var(--border)] bg-[var(--background)]"
                title="Voltar"
              >
                <X size={18} />
              </button>
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-blue-500/18 text-cyan-100">
                <GitBranch size={23} />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--text-secondary)]">
                  Construtor visual
                </p>
                <input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  className="mt-1 w-full max-w-xl bg-transparent text-2xl font-black outline-none"
                  placeholder="Nome da automação"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-10 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-black text-[var(--text-secondary)]">
                <MousePointer2 size={14} />
                Clique para inserir, arraste para posicionar
              </span>
              <Toggle checked={form.active} onChange={(next) => setForm({ ...form, active: next })} />
              <button
                onClick={validateBuilderFlow}
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 text-sm font-black text-cyan-100"
              >
                <CheckSquare size={17} />
                Validar fluxo
              </button>
              <button
                onClick={() => setBuilderOpen(false)}
                className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm font-black"
              >
                Cancelar
              </button>
              <button
                onClick={() => void saveBuilderAutomation()}
                disabled={saving || !form.name.trim()}
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-black text-white shadow-lg shadow-blue-950/20 disabled:opacity-50"
              >
                <Save size={17} />
                {saving ? "Salvando..." : "Salvar fluxo"}
              </button>
            </div>
          </header>

          <section className="automation-builder-grid grid min-h-0 flex-1 grid-cols-[290px_minmax(0,1fr)_320px] overflow-hidden max-xl:grid-cols-1">
            <aside className="min-h-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)]/82 p-4 backdrop-blur-2xl max-xl:max-h-[320px] max-xl:border-b max-xl:border-r-0">
              <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
                <p className="text-sm font-black">Componentes</p>
                <p className="mt-1 text-xs font-semibold leading-5 text-[var(--text-secondary)]">
                  Insira gatilhos, ações e blocos da Nora no fluxo.
                </p>
              </div>
              <div className="space-y-4">
                {componentLibrary.map((group) => (
                  <section key={group.group}>
                    <h2 className="mb-2 text-xs font-black uppercase tracking-[0.16em] text-[var(--text-secondary)]">{group.group}</h2>
                    <div className="space-y-2">
                      {group.items.map((item) => (
                        <button
                          key={`${group.group}-${item.title}`}
                          type="button"
                          onClick={() => addBuilderComponent(item)}
                          className="flex w-full items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3 text-left transition hover:border-cyan-300/50 hover:bg-[var(--surface-hover)]"
                        >
                          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-500/16 text-cyan-100">
                            <IconByName name={item.icon} size={18} />
                          </span>
                          <span className="min-w-0">
                            <strong className="block truncate text-sm font-black">{item.title}</strong>
                            <span className="mt-0.5 line-clamp-2 block text-xs font-semibold leading-5 text-[var(--text-secondary)]">{item.description}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </aside>

            <div className="relative min-h-[620px] min-w-0 overflow-auto bg-[#101316]">
              <div className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 bg-[#17191c]/92 px-4 py-3 text-white backdrop-blur-xl">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/8 px-3 py-1.5 text-xs font-black">
                    <Layers size={14} />
                    Editor
                  </span>
                  <span className="rounded-lg border border-emerald-400/25 bg-emerald-400/12 px-3 py-1.5 text-xs font-black text-emerald-200">
                    {builderFlow.nodes.length} bloco(s)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setBuilderZoom((current) => Math.max(0.62, current - 0.08))} className="grid h-9 w-9 place-items-center rounded-lg border border-white/12 bg-white/8">-</button>
                  <span className="w-14 text-center text-xs font-black">{Math.round(builderZoom * 100)}%</span>
                  <button onClick={() => setBuilderZoom((current) => Math.min(1.28, current + 0.08))} className="grid h-9 w-9 place-items-center rounded-lg border border-white/12 bg-white/8">+</button>
                </div>
              </div>

              <div className="relative h-[720px] min-w-[1280px] bg-[radial-gradient(circle_at_1px_1px,rgba(148,163,184,.24)_1px,transparent_0)] [background-size:22px_22px]">
                <div className="absolute inset-0 origin-top-left" style={{ transform: `scale(${builderZoom})`, width: 1500, height: 760 }}>
                  <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                    {builderFlow.connections.map((connection) => {
                      const source = builderFlow.nodes.find((item) => item.id === connection.source);
                      const target = builderFlow.nodes.find((item) => item.id === connection.target);
                      if (!source || !target) return null;
                      const x1 = source.x + 220;
                      const y1 = source.y + 55;
                      const x2 = target.x;
                      const y2 = target.y + 55;
                      return (
                        <path
                          key={`${connection.source}-${connection.target}`}
                          d={`M ${x1} ${y1} C ${x1 + 90} ${y1}, ${x2 - 90} ${y2}, ${x2} ${y2}`}
                          fill="none"
                          stroke="rgba(16,185,129,.76)"
                          strokeWidth="3"
                        />
                      );
                    })}
                  </svg>

                  {builderFlow.nodes.map((nodeItem) => (
                    <motion.div
                      key={nodeItem.id}
                      whileHover={{ scale: 1.02 }}
                      onClick={() => setSelectedBuilderNodeId(nodeItem.id)}
                      onPointerDown={(event) => {
                        builderDraggingRef.current = {
                          id: nodeItem.id,
                          startX: event.clientX,
                          startY: event.clientY,
                          originalX: nodeItem.x,
                          originalY: nodeItem.y,
                        };
                      }}
                      className={`absolute w-[220px] cursor-grab rounded-xl border p-4 text-white shadow-2xl active:cursor-grabbing ${
                        selectedBuilderNodeId === nodeItem.id ? "border-cyan-300 bg-[#1f2937]" : "border-white/16 bg-[#1a1d21]"
                      }`}
                      style={{ left: nodeItem.x, top: nodeItem.y }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg ${nodeItem.kind === "nora" ? "bg-cyan-400/18 text-cyan-100" : nodeItem.kind === "trigger" ? "bg-emerald-400/18 text-emerald-100" : "bg-blue-400/18 text-blue-100"}`}>
                          <IconByName name={nodeItem.icon} size={20} />
                        </span>
                        <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] font-black uppercase text-white/60">{nodeItem.kind}</span>
                      </div>
                      <h3 className="mt-3 text-sm font-black">{nodeItem.title}</h3>
                      <p className="mt-1 line-clamp-2 text-xs font-semibold leading-5 text-white/62">{nodeItem.description}</p>
                    </motion.div>
                  ))}
                </div>
              </div>
            </div>

            <aside className="min-h-0 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)]/86 p-4 backdrop-blur-2xl max-xl:border-l-0 max-xl:border-t">
              <section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
                <h2 className="text-sm font-black">Configuração do fluxo</h2>
                <div className="mt-4 space-y-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-black text-[var(--text-secondary)]">Descrição</span>
                    <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={3} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold outline-none" />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-black text-[var(--text-secondary)]">Categoria</span>
                    <input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold outline-none" />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-black text-[var(--text-secondary)]">Projeto para tarefas</span>
                    <select
                      value={form.taskProjectId}
                      onChange={(event) => {
                        const project = taskProjects.find((item) => item.id === event.target.value);
                        setForm({
                          ...form,
                          taskProjectId: event.target.value,
                          taskProjectName: project?.name || event.target.value,
                        });
                      }}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold outline-none"
                    >
                      {taskProjects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-black text-[var(--text-secondary)]">Categoria da tarefa</span>
                    <select
                      value={form.taskCategory}
                      onChange={(event) => setForm({ ...form, taskCategory: event.target.value })}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold outline-none"
                    >
                      {taskCategoryOptions.map((category) => (
                        <option key={category.value} value={category.value}>
                          {category.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-black text-[var(--text-secondary)]">Categoria de e-mail</span>
                    <select
                      value={form.emailCategory}
                      onChange={(event) => setForm({ ...form, emailCategory: event.target.value })}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold outline-none"
                    >
                      {emailCategoryOptions.map((category) => (
                        <option key={category.value} value={category.value}>
                          {category.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-black text-[var(--text-secondary)]">Agendamento</span>
                    <select value={form.schedule} onChange={(event) => setForm({ ...form, schedule: event.target.value })} className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold outline-none">
                      <option value="">Manual</option>
                      <option value="A cada hora">A cada hora</option>
                      <option value="Diariamente as 09:00">Diariamente as 09:00</option>
                      <option value="Dias uteis as 09:00">Dias uteis as 09:00</option>
                      <option value="Semanalmente, segunda as 09:00">Semanalmente</option>
                      <option value="Mensalmente, dia 1 as 09:00">Mensalmente</option>
                    </select>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block space-y-1.5">
                      <span className="text-xs font-black text-[var(--text-secondary)]">Tentativas após falha</span>
                      <select value={form.retryPolicy} onChange={(event) => setForm({ ...form, retryPolicy: event.target.value as AutomationFormState["retryPolicy"] })} className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold outline-none">
                        <option value="none">Não repetir</option>
                        <option value="once">Repetir uma vez</option>
                        <option value="three_times">Repetir três vezes</option>
                      </select>
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-black text-[var(--text-secondary)]">Se ainda falhar</span>
                      <select value={form.failureAction} onChange={(event) => setForm({ ...form, failureAction: event.target.value as AutomationFormState["failureAction"] })} className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold outline-none">
                        <option value="notify">Notificar responsável</option>
                        <option value="pause">Pausar automação</option>
                        <option value="continue">Continuar fluxo</option>
                      </select>
                    </label>
                  </div>
                  <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                    <label className="flex items-center justify-between gap-3 text-xs font-black">
                      <span>Exigir aprovação para ações sensíveis</span>
                      <input type="checkbox" checked={form.approvalRequired} onChange={(event) => setForm({ ...form, approvalRequired: event.target.checked })} />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-xs font-black">
                      <span>Notificar quando concluir</span>
                      <input type="checkbox" checked={form.notifyOnSuccess} onChange={(event) => setForm({ ...form, notifyOnSuccess: event.target.checked })} />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-xs font-black">
                      <span>Notificar quando falhar</span>
                      <input type="checkbox" checked={form.notifyOnFailure} onChange={(event) => setForm({ ...form, notifyOnFailure: event.target.checked })} />
                    </label>
                  </div>
                </div>
              </section>

              <section className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
                <h2 className="text-sm font-black">Bloco selecionado</h2>
                {selectedBuilderNode ? (
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-11 w-11 place-items-center rounded-lg bg-blue-500/16 text-cyan-100">
                        <IconByName name={selectedBuilderNode.icon} size={20} />
                      </span>
                      <div className="min-w-0">
                        <strong className="block truncate text-sm font-black">{selectedBuilderNode.title}</strong>
                        <span className="text-xs font-semibold text-[var(--text-secondary)]">{selectedBuilderNode.kind}</span>
                      </div>
                    </div>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-black text-[var(--text-secondary)]">Nome do bloco</span>
                      <input
                        value={selectedBuilderNode.title}
                        onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { title: event.target.value })}
                        className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold outline-none"
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-black text-[var(--text-secondary)]">Instrução do bloco</span>
                      <textarea
                        value={selectedBuilderNode.description}
                        onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { description: event.target.value })}
                        rows={4}
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold outline-none"
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-black text-[var(--text-secondary)]">Condição opcional</span>
                      <input
                        value={selectedBuilderNode.config?.condition || ""}
                        onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), condition: event.target.value } })}
                        placeholder="Ex.: prioridade alta ou valor acima de 500"
                        className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold outline-none"
                      />
                    </label>
                    <button
                      onClick={() => removeBuilderNode(selectedBuilderNode.id)}
                      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-rose-300/30 text-xs font-black text-rose-200"
                    >
                      <Trash2 size={15} />
                      Remover bloco
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 text-xs font-semibold text-[var(--text-secondary)]">Selecione um bloco no canvas.</p>
                )}
              </section>

              {builderValidation.length > 0 && (
                <section className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4">
                  <h2 className="text-sm font-black text-amber-100">Itens para revisar</h2>
                  <ul className="mt-2 space-y-1 text-xs font-semibold text-amber-100/85">
                    {builderValidation.map((issue) => <li key={issue}>• {issue}</li>)}
                  </ul>
                </section>
              )}

              {builderValidation.length === 0 && statusMessage === "Fluxo validado e pronto para executar." && (
                <section className="mt-4 rounded-xl border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm font-bold text-emerald-100">
                  {statusMessage}
                </section>
              )}

              <section className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
                <h2 className="text-sm font-black">Ações do fluxo</h2>
                <div className="mt-3 space-y-2">
                  {actionsFromFlow(builderFlow).length ? (
                    actionsFromFlow(builderFlow).map((action) => (
                      <span key={action} className="block rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-black">
                        {action}
                      </span>
                    ))
                  ) : (
                    <p className="text-xs font-semibold text-[var(--text-secondary)]">Adicione ações pela biblioteca.</p>
                  )}
                </div>
              </section>
            </aside>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1700px] space-y-5 p-5 text-[var(--text)]">
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="overflow-hidden rounded-lg border border-[var(--dashboard-panel-border)] bg-[var(--dashboard-hero-bg)] p-6 shadow-[var(--dashboard-panel-shadow)] backdrop-blur-2xl"
      >
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-blue-500/20 text-cyan-100 shadow-lg shadow-blue-950/20">
              <GitBranch size={26} />
            </span>
            <div className="min-w-0">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/12 px-3 py-1 text-xs font-black text-[var(--text)]">
                <Sparkles size={14} />
                Nora pronta para automatizar
              </span>
              <h1 className="mt-4 text-3xl font-black tracking-tight md:text-4xl">Automações Inteligentes</h1>
              <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-[var(--text-secondary)]">
                Automatize processos repetitivos e deixe a Nora executar tarefas por você.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => openCreateModal()}
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-700 via-sky-600 to-cyan-500 px-5 text-sm font-black text-white shadow-lg shadow-blue-950/25 transition hover:scale-[1.02]"
            >
              <Plus size={18} />
              Nova Automação
            </button>
            <button
              type="button"
              onClick={onOpenNora}
              className="inline-flex h-12 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 text-sm font-black text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
            >
              <Sparkles size={18} />
              Pedir para Nora
            </button>
          </div>
        </div>
      </motion.header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total de automações" value={data.metrics.total} icon={GitBranch} detail="Fluxos configurados" />
        <StatCard title="Ativas" value={data.metrics.active} icon={Zap} detail="Prontas para executar" />
        <StatCard title="Execuções hoje" value={data.metrics.runsToday} icon={Activity} detail="Disparos registrados" />
        <StatCard title="Tempo economizado" value={formatSavedTime(data.metrics.savedMinutes)} icon={Clock3} detail="Estimativa operacional" />
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--glass-shadow)] backdrop-blur-2xl">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <label className="flex h-12 min-w-0 flex-1 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4">
            <Search size={18} className="text-[var(--text-secondary)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Pesquisar automações..."
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
            />
          </label>
          <div className="flex gap-2 overflow-x-auto">
            {filters.map((item) => (
              <button
                key={item.key}
                onClick={() => setFilter(item.key)}
                className={`h-10 shrink-0 rounded-full border px-4 text-xs font-black transition ${
                  filter === item.key
                    ? "border-blue-300/50 bg-blue-500/24 text-[var(--text)]"
                    : "border-[var(--border)] bg-[var(--background)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <AnimatePresence>
        {(error || statusMessage) && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`rounded-lg border px-4 py-3 text-sm font-black ${
              error
                ? "border-rose-400/35 bg-rose-500/12 text-rose-100"
                : "border-emerald-300/35 bg-emerald-500/12 text-emerald-100"
            }`}
          >
            {error || statusMessage}
          </motion.div>
        )}
      </AnimatePresence>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(440px,0.85fr)]">
        <div className="min-w-0 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {loading ? (
              <div className="col-span-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm font-black">
                Carregando automações...
              </div>
            ) : (
              filteredAutomations.map((automation, index) => (
                <motion.article
                  key={automation.id}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index * 0.035, 0.24) }}
                  whileHover={{ y: -3 }}
                  onClick={() => setSelectedId(automation.id)}
                  className={`min-w-0 rounded-lg border bg-[var(--surface)] p-5 shadow-[var(--glass-shadow)] backdrop-blur-2xl transition ${
                    selectedAutomation?.id === automation.id ? "border-cyan-300/55" : "border-[var(--border)]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-blue-500/14 text-cyan-200">
                        <IconByName name={automation.icon} size={22} />
                      </span>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <h2 className="truncate text-base font-black">{automation.name}</h2>
                          {automation.favorite && <Star size={14} className="shrink-0 fill-amber-300 text-amber-300" />}
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{automation.description}</p>
                      </div>
                    </div>
                    <Toggle checked={automation.active} onChange={(next) => void updateAutomation(automation.id, { active: next, status: next ? "ativa" : "desativada" } as Partial<Automation>)} />
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${automation.active ? "bg-emerald-400/14 text-emerald-200" : "bg-slate-400/14 text-[var(--text-secondary)]"}`}>
                      {automation.active ? "Ativa" : "Desativada"}
                    </span>
                    <span className="rounded-full bg-blue-500/12 px-2.5 py-1 text-[11px] font-black text-cyan-100">{automation.category}</span>
                    {automation.aiEnabled && <span className="rounded-full bg-cyan-400/14 px-2.5 py-1 text-[11px] font-black text-cyan-100">Nora IA</span>}
                  </div>

                  <div className="mt-4 grid gap-3 text-xs font-semibold text-[var(--text-secondary)] sm:grid-cols-3">
                    <span>
                      <strong className="block text-[var(--text)]">Ultima execucao</strong>
                      {formatDateTime(automation.lastRunAt)}
                    </span>
                    <span>
                      <strong className="block text-[var(--text)]">{automation.executions}</strong>
                      execuções
                    </span>
                    <span>
                      <strong className="block text-[var(--text)]">{formatSavedTime(automation.savedMinutes)}</strong>
                      economizados
                    </span>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={saving || !automation.active}
                      onClick={(event) => {
                        event.stopPropagation();
                        void executeAutomation(automation);
                      }}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-black text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Play size={15} />
                      Executar
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={(event) => {
                        event.stopPropagation();
                        void simulateAutomation(automation);
                      }}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-500/8 px-4 text-xs font-black text-cyan-100 transition hover:bg-cyan-500/14 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <FlaskConical size={15} />
                      Testar fluxo
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        openEditModal(automation);
                      }}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-xs font-black"
                    >
                      <Settings2 size={15} />
                      Editar
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void duplicateAutomation(automation);
                      }}
                      className="grid h-10 w-10 place-items-center rounded-xl border border-[var(--border)] bg-[var(--background)]"
                      title="Duplicar"
                    >
                      <Copy size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void updateAutomation(automation.id, { favorite: !automation.favorite } as Partial<Automation>);
                      }}
                      className="grid h-10 w-10 place-items-center rounded-xl border border-[var(--border)] bg-[var(--background)]"
                      title="Favorito"
                    >
                      <Star size={15} className={automation.favorite ? "fill-amber-300 text-amber-300" : ""} />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setLogAutomation(automation);
                      }}
                      className="grid h-10 w-10 place-items-center rounded-xl border border-[var(--border)] bg-[var(--background)]"
                      title="Logs e versoes"
                    >
                      <History size={15} />
                    </button>
                  </div>
                </motion.article>
              ))
            )}
          </div>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--glass-shadow)] backdrop-blur-2xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-black">Templates</h2>
                <p className="text-sm font-semibold text-[var(--text-secondary)]">Fluxos prontos para criar em um clique.</p>
              </div>
              <Rocket size={22} className="text-cyan-200" />
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {data.templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => openCreateModal(template)}
                  className="flex min-h-24 items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 text-left transition hover:bg-[var(--surface-hover)]"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-500/14 text-cyan-200">
                    <IconByName name={template.icon} size={19} />
                  </span>
                  <span className="min-w-0">
                    <strong className="block text-sm font-black">{template.title}</strong>
                    <span className="mt-1 line-clamp-2 text-xs font-semibold leading-5 text-[var(--text-secondary)]">{template.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="min-w-0 space-y-4">
          <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-[var(--glass-shadow)] backdrop-blur-2xl">
            <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] p-4">
              <div>
                <h2 className="text-lg font-black">Editor visual de fluxos</h2>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">
                  {selectedAutomation ? selectedAutomation.name : "Selecione uma automacao"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setZoom((current) => Math.max(0.65, current - 0.1))} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] bg-[var(--background)]">-</button>
                <span className="min-w-14 text-center text-xs font-black">{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom((current) => Math.min(1.25, current + 0.1))} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] bg-[var(--background)]">+</button>
              </div>
            </header>

            <div className="relative h-[430px] overflow-hidden bg-[radial-gradient(circle_at_1px_1px,rgba(125,211,252,.24)_1px,transparent_0)] [background-size:22px_22px]">
              <div className="absolute inset-0 origin-top-left" style={{ transform: `scale(${zoom})`, width: 1120, height: 420 }}>
                <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                  {editorConnections.map((connection) => {
                    const source = editorNodes.find((item) => item.id === connection.source);
                    const target = editorNodes.find((item) => item.id === connection.target);
                    if (!source || !target) return null;
                    const x1 = source.x + 190;
                    const y1 = source.y + 45;
                    const x2 = target.x;
                    const y2 = target.y + 45;
                    return (
                      <path
                        key={`${connection.source}-${connection.target}`}
                        d={`M ${x1} ${y1} C ${x1 + 70} ${y1}, ${x2 - 70} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke="rgba(125,211,252,.72)"
                        strokeWidth="3"
                      />
                    );
                  })}
                </svg>

                {editorNodes.map((nodeItem) => (
                  <motion.div
                    key={nodeItem.id}
                    whileHover={{ scale: 1.03 }}
                    onPointerDown={(event) => {
                      draggingRef.current = {
                        id: nodeItem.id,
                        startX: event.clientX,
                        startY: event.clientY,
                        originalX: nodeItem.x,
                        originalY: nodeItem.y,
                      };
                    }}
                    className={`absolute w-[190px] cursor-grab rounded-lg border p-4 shadow-xl backdrop-blur-xl active:cursor-grabbing ${
                      nodeItem.kind === "nora"
                        ? "border-cyan-200/45 bg-cyan-400/18"
                        : nodeItem.kind === "trigger"
                          ? "border-blue-200/45 bg-blue-500/18"
                          : "border-[var(--border)] bg-[var(--surface)]"
                    }`}
                    style={{ left: nodeItem.x, top: nodeItem.y }}
                  >
                    <span className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-blue-500/16 text-cyan-100">
                      <IconByName name={nodeItem.icon} size={19} />
                    </span>
                    <h3 className="text-sm font-black">{nodeItem.title}</h3>
                    <p className="mt-1 line-clamp-2 text-xs font-semibold leading-5 text-[var(--text-secondary)]">{nodeItem.description}</p>
                    <span className="mt-3 inline-flex rounded-full border border-[var(--border)] px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                      {nodeItem.kind}
                    </span>
                  </motion.div>
                ))}
              </div>

              <div className="absolute bottom-4 right-4 h-24 w-36 rounded-lg border border-[var(--border)] bg-[var(--surface)]/90 p-2 shadow-xl backdrop-blur-xl">
                <div className="relative h-full w-full overflow-hidden rounded-md bg-[var(--background)]">
                  {editorNodes.map((nodeItem) => (
                    <span
                      key={nodeItem.id}
                      className="absolute h-3 w-5 rounded-sm bg-cyan-300"
                      style={{ left: `${Math.min(88, nodeItem.x / 11)}%`, top: `${Math.min(82, nodeItem.y / 4)}%` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-cyan-200/24 bg-[var(--dashboard-nora-bg)] p-5 shadow-[var(--glass-shadow)] backdrop-blur-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/12 px-3 py-1 text-xs font-black">
                  <Sparkles size={14} />
                  Bloco especial
                </span>
                <h2 className="mt-3 text-2xl font-black">Nora IA</h2>
                <p className="mt-1 text-sm font-semibold leading-6 text-[var(--text-secondary)]">
                  Use a Nora dentro dos fluxos para raciocinar sobre textos, conversas, e-mails, gastos e tarefas.
                </p>
              </div>
              <button onClick={onOpenNora} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-blue-600 text-white">
                <Sparkles size={20} />
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {noraAbilities.map((ability) => (
                <span key={ability} className="rounded-full border border-white/18 bg-white/12 px-3 py-1 text-xs font-black">
                  {ability}
                </span>
              ))}
            </div>
          </section>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-[var(--glass-shadow)] backdrop-blur-2xl">
          <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <div>
              <h2 className="text-lg font-black">Historico de execucoes</h2>
              <p className="text-xs font-semibold text-[var(--text-secondary)]">Auditoria das últimas automações disparadas.</p>
            </div>
            <History size={20} className="text-cyan-200" />
          </header>
          <div className="max-h-[360px] overflow-auto">
            <table className="w-full min-w-[780px] text-left text-sm">
              <thead className="sticky top-0 bg-[var(--surface)] text-xs uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                <tr>
                  <th className="px-5 py-3">Automacao</th>
                  <th className="px-5 py-3">Horario</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Tempo</th>
                  <th className="px-5 py-3">Resultado</th>
                  <th className="px-5 py-3">Executada por</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {data.history.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center font-semibold text-[var(--text-secondary)]">
                      Nenhuma execução registrada ainda.
                    </td>
                  </tr>
                ) : (
                  data.history.map((item) => (
                    <tr key={item.id} className="transition hover:bg-[var(--surface-hover)]">
                      <td className="px-5 py-3 font-black">{item.automationName}</td>
                      <td className="px-5 py-3 text-[var(--text-secondary)]">{formatDateTime(item.timestamp)}</td>
                      <td className="px-5 py-3">
                        <span className="rounded-full bg-emerald-400/14 px-2 py-1 text-xs font-black text-emerald-200">{item.status}</span>
                      </td>
                      <td className="px-5 py-3 text-[var(--text-secondary)]">{formatDuration(item.durationMs)}</td>
                      <td className="max-w-[300px] px-5 py-3 text-[var(--text-secondary)]">
                        <span className="line-clamp-2">{item.result}</span>
                      </td>
                      <td className="px-5 py-3 text-[var(--text-secondary)]">{item.executedBy}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="space-y-4">
          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--glass-shadow)] backdrop-blur-2xl">
            <h2 className="text-lg font-black">Integracoes Disponiveis</h2>
            <div className="mt-4 space-y-2">
              {data.integrations.map((integration) => (
                <div key={integration.name} className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--background)] px-4 py-3">
                  <span className="font-black">{integration.name}</span>
                  <span className="rounded-full bg-emerald-400/14 px-2 py-1 text-[11px] font-black text-emerald-200">Conectado</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--glass-shadow)] backdrop-blur-2xl">
            <h2 className="text-lg font-black">Ferramentas extras</h2>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={exportAutomations} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] text-xs font-black">
                <Download size={15} />
                Exportar
              </button>
              <button onClick={() => importRef.current?.click()} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] text-xs font-black">
                <Upload size={15} />
                Importar
              </button>
              <button onClick={() => setLogAutomation(selectedAutomation)} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] text-xs font-black">
                <History size={15} />
                Logs
              </button>
              <button onClick={() => setLogAutomation(selectedAutomation)} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] text-xs font-black">
                <GitBranch size={15} />
                Versoes
              </button>
              <button onClick={() => setFilter("ia")} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] text-xs font-black">
                <Filter size={15} />
                Categorias
              </button>
              <button onClick={onOpenNora} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] text-xs font-black">
                <Variable size={15} />
                Variaveis
              </button>
            </div>
            <input
              ref={importRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void importAutomations(file).catch((err) => setError(err instanceof Error ? err.message : "Falha ao importar."));
                event.target.value = "";
              }}
            />
          </section>
        </aside>
      </section>

      <AnimatePresence>
        {modal && (
          <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              initial={{ scale: 0.96, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 12 }}
              className="w-full max-w-2xl overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl backdrop-blur-2xl"
            >
              <header className="flex items-center justify-between border-b border-[var(--border)] p-5">
                <div>
                  <h2 className="text-lg font-black">{modal === "edit" ? "Editar automacao" : "Nova automacao"}</h2>
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">Configure gatilho, ações e participação da Nora.</p>
                </div>
                <button onClick={() => setModal(null)} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--surface-hover)]">
                  <X size={18} />
                </button>
              </header>
              <div className="grid gap-4 p-5 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--text-secondary)]">Nome</span>
                  <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm font-semibold outline-none" />
                </label>
                <label className="space-y-2">
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--text-secondary)]">Gatilho</span>
                  <select value={form.trigger} onChange={(event) => setForm({ ...form, trigger: event.target.value })} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm font-semibold outline-none">
                    {triggers.map((trigger) => (
                      <option key={trigger}>{trigger}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--text-secondary)]">Descrição</span>
                  <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={3} className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-3 text-sm font-semibold outline-none" />
                </label>
                <label className="space-y-2">
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--text-secondary)]">Categoria</span>
                  <input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm font-semibold outline-none" />
                </label>
                <label className="space-y-2">
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--text-secondary)]">Agendamento</span>
                  <input value={form.schedule} onChange={(event) => setForm({ ...form, schedule: event.target.value })} placeholder="Manual, diario, semanal..." className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm font-semibold outline-none" />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--text-secondary)]">Ações</span>
                  <input value={form.actions} onChange={(event) => setForm({ ...form, actions: event.target.value })} placeholder={actions.slice(0, 4).join(", ")} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm font-semibold outline-none" />
                </label>
                <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
                  <span>
                    <strong className="block text-sm font-black">Ativa</strong>
                    <span className="text-xs font-semibold text-[var(--text-secondary)]">Permite execução manual e agendada.</span>
                  </span>
                  <Toggle checked={form.active} onChange={(next) => setForm({ ...form, active: next })} />
                </div>
                <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
                  <span>
                    <strong className="block text-sm font-black">Nora IA</strong>
                    <span className="text-xs font-semibold text-[var(--text-secondary)]">Inclui raciocinio, resumo ou classificacao.</span>
                  </span>
                  <Toggle checked={form.aiEnabled} onChange={(next) => setForm({ ...form, aiEnabled: next })} />
                </div>
              </div>
              <footer className="flex justify-end gap-3 border-t border-[var(--border)] p-5">
                <button onClick={() => setModal(null)} className="h-11 rounded-xl border border-[var(--border)] px-5 text-sm font-black">Cancelar</button>
                <button onClick={() => void submitForm()} disabled={saving || !form.name.trim()} className="h-11 rounded-xl bg-blue-600 px-5 text-sm font-black text-white disabled:opacity-50">
                  {saving ? "Salvando..." : "Salvar automação"}
                </button>
              </footer>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {logAutomation && (
          <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              initial={{ scale: 0.96, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 12 }}
              className="w-full max-w-2xl overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl backdrop-blur-2xl"
            >
              <header className="flex items-center justify-between border-b border-[var(--border)] p-5">
                <div>
                  <h2 className="text-lg font-black">Logs e versoes</h2>
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">
                    {logAutomation.name} - versao {logAutomation.version}
                  </p>
                </div>
                <button onClick={() => setLogAutomation(null)} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--surface-hover)]">
                  <X size={18} />
                </button>
              </header>
              <div className="max-h-[420px] overflow-y-auto p-5">
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
                    <span className="text-xs font-black text-[var(--text-secondary)]">Versao</span>
                    <strong className="block text-2xl font-black">{logAutomation.version}</strong>
                  </div>
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
                    <span className="text-xs font-black text-[var(--text-secondary)]">Execuções</span>
                    <strong className="block text-2xl font-black">{logAutomation.executions}</strong>
                  </div>
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
                    <span className="text-xs font-black text-[var(--text-secondary)]">Tempo salvo</span>
                    <strong className="block text-2xl font-black">{formatSavedTime(logAutomation.savedMinutes)}</strong>
                  </div>
                </div>
                <div className="space-y-3">
                  {(logAutomation.logs || []).length === 0 ? (
                    <p className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-5 text-sm font-semibold text-[var(--text-secondary)]">
                      Nenhum log específico desta automação ainda.
                    </p>
                  ) : (
                    logAutomation.logs.map((log) => (
                      <article key={log.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <strong className="font-black">{formatDateTime(log.timestamp)}</strong>
                          <span className={`rounded-full px-2 py-1 text-xs font-black ${executionStatusClass(log.status)}`}>
                            {log.status}
                          </span>
                        </div>
                        <p className="mt-2 text-sm font-semibold text-[var(--text-secondary)]">{log.result}</p>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-[var(--text-secondary)]">
                          <span>{formatDuration(log.durationMs)}</span>
                          <span>Tentativa {log.attempt || 1}</span>
                          <span>{log.sideEffects === false ? "Sem efeitos reais" : "Execucao real"}</span>
                        </div>
                        {log.steps && log.steps.length > 0 && (
                          <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-3">
                            {log.steps.map((step, index) => (
                              <div
                                key={`${log.id}-${step.id}`}
                                className="grid gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 sm:grid-cols-[28px_minmax(0,1fr)_auto]"
                              >
                                <span className="grid h-7 w-7 place-items-center rounded-lg bg-blue-500/10 text-[11px] font-black text-blue-200">
                                  {index + 1}
                                </span>
                                <span className="min-w-0">
                                  <strong className="block truncate text-xs font-black">{step.title}</strong>
                                  {(step.preview || step.error) && (
                                    <span className={`mt-0.5 block text-[11px] font-semibold ${step.error ? "text-rose-200" : "text-[var(--text-secondary)]"}`}>
                                      {step.error || step.preview}
                                    </span>
                                  )}
                                </span>
                                <span className={`self-start rounded-full px-2 py-1 text-[10px] font-black ${executionStatusClass(step.status)}`}>
                                  {step.status}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {log.status === "erro" && (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void retryAutomation(logAutomation, log.id)}
                            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-amber-400/30 px-3 text-xs font-black text-amber-100 hover:bg-amber-500/10 disabled:opacity-50"
                          >
                            <RotateCcw size={14} />
                            Reexecutar da falha
                          </button>
                        )}
                      </article>
                    ))
                  )}
                </div>
              </div>
              <footer className="flex justify-between gap-3 border-t border-[var(--border)] p-5">
                <button onClick={() => void deleteAutomation(logAutomation).then(() => setLogAutomation(null))} className="inline-flex h-11 items-center gap-2 rounded-xl border border-rose-300/30 px-4 text-sm font-black text-rose-200">
                  <Trash2 size={16} />
                  Excluir
                </button>
                <button onClick={() => setLogAutomation(null)} className="h-11 rounded-xl bg-blue-600 px-5 text-sm font-black text-white">
                  Fechar
                </button>
              </footer>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
