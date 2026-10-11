import AutomaticEventHistory from "./AutomaticEventHistory";
import EventTriggerFields, { eventTriggers } from "./EventTriggerFields";
import IntegrationLogo from "../shared/IntegrationLogo";
import MessageActionFields, { messageIssues } from "./MessageActionFields";
import "./automationBuilder.css";
import AutomationFlowPreview from "./AutomationFlowPreview";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  ArrowDown,
  Workflow,
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
  Globe2,
  History,
  Layers,
  ListChecks,
  Mail,
  MessageSquare,
  MousePointer2,
  Network,
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
import { showConfirm } from "../shared/AppDialogProvider";
import type { LucideIcon } from "lucide-react";
import { automationsApiRequest, fetchActiveTaskProjects } from "../../features/automations/api";
import LoadingState from "../shared/LoadingState";
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
  userId: string;
};

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: "todas", label: "Todas" },
  { key: "ativas", label: "Ativas" },
  { key: "desativadas", label: "Desativadas" },
  { key: "ia", label: "IA" },
  { key: "recentes", label: "Recentes" },
];

const triggers = ["Manual", ...eventTriggers.map(item => item.title)];
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
  globe: Globe2,
  network: Network,
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
].map((name) => ({ name, status: "Disponível" }));

const componentLibrary: Array<{
  group: string;
  items: Array<{ title: string; description: string; icon: string; kind: StepKind; category: string }>;
}> = [
  {
    group: "Gatilhos",
    items: [
      { title: "Manual", description: "Executa quando você clicar em Executar.", icon: "manual", kind: "trigger", category: "Manual" },
      ...eventTriggers.map(item => ({ ...item, kind: "trigger" as const })),
    ],
  },
  {
    group: "Ações",
    items: [
      { title: "Enviar e-mail", description: "Envia ou responde uma mensagem pelo Gmail.", icon: "mail", kind: "action", category: "E-mail" },
      { title: "Agrupar e-mails por categoria", description: "Classifica mensagens recentes por principal, financeiro, trabalho e promocoes.", icon: "tags", kind: "action", category: "E-mail" },
      { title: "Preparar leitura paginada de e-mails", description: "Cria trabalho revisável em E-mails: últimos 1 dia, limite de 100 mensagens. A leitura começa ao continuar; nenhum envio automático.", icon: "mail", kind: "action", category: "E-mail" },
      { title: "Enviar WhatsApp", description: "Envia mensagem para contato ou grupo.", icon: "message-square", kind: "action", category: "WhatsApp" },
      { title: "Criar tarefa", description: "Cria card com prioridade, prazo e etiquetas.", icon: "check-square", kind: "action", category: "Tarefas" },
      { title: "Registrar gasto", description: "Cria lançamento financeiro com categoria.", icon: "credit-card", kind: "action", category: "Gastos" },
      { title: "Atualizar relatório", description: "Atualiza indicadores operacionais.", icon: "bar-chart-3", kind: "action", category: "Relatórios" },
      { title: "Enviar mensagem no Chat", description: "Escolha toda a equipe, um membro ou uma subequipe.", icon: "users", kind: "action", category: "Equipe" },
      { title: "Executar tarefa no navegador", description: "Opera um Chromium real com cliques, formulários, arquivos, aprovações e evidências.", icon: "globe", kind: "action", category: "Navegador" },
      { title: "Executar IA com roteamento", description: "Seleciona provedor por política de custo, capacidade e privacidade.", icon: "network", kind: "nora", category: "IA e Modelos" },
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
  if (/mail|message|calendar|users|webhook|clock|manual/.test(name)) return <IntegrationLogo name={name} size={size} className={className} />;
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
  if (status === "erro") return "is-red";
  if (status === "simulado") return "is-blue";
  if (status === "executando") return "is-amber";
  return "is-green";
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
    integrations: value.integrations ?? fallbackIntegrations,
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

function localAutomationsKey(userId: string) {
  return `${LOCAL_AUTOMATIONS_KEY}:${userId}`;
}

function readLocalAutomations(userId: string): AutomationResponse {
  try {
    const parsed = JSON.parse(localStorage.getItem(localAutomationsKey(userId)) || "{}") as Partial<AutomationResponse>;
    if (parsed.automations?.length) return normalizeAutomationResponse(parsed);
  } catch {
    // Fallback abaixo.
  }
  const automations = defaultLocalAutomations();
  return normalizeAutomationResponse({ automations, history: [] });
}

function writeLocalAutomations(userId: string, response: AutomationResponse) {
  localStorage.setItem(localAutomationsKey(userId), JSON.stringify(response));
}

async function apiJson<T>(path = "", init?: RequestInit): Promise<T> {
  return automationsApiRequest<T>(path, init);
}

function StatCard({ title, value, icon: Icon, detail }: { title: string; value: string | number; icon: LucideIcon; detail: string }) {
  return (
    <article className="nx-card nx-kpi">
      <div className="nx-kpi-l"><Icon size={16} />{title}</div>
      <strong className="nx-kpi-v" style={{ display: "block" }}>{value}</strong>
      <span className="nx-kpi-s" style={{ display: "block" }}>{detail}</span>
    </article>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`automation-toggle auto-switch ${checked ? "is-on" : ""}`}
      aria-label={checked ? "Desativar automação" : "Ativar automação"}
    >
      <span />
    </button>
  );
}

export default function AutomationsDashboard({ onOpenNora, userId }: AutomationsDashboardProps) {
  const [data, setData] = useState<AutomationResponse>(emptyResponse);
  const [query, setQuery] = useState("");
  const [dashboardView, setDashboardView] = useState<"flows" | "templates" | "history" | "preview">("flows");
  const [filter, setFilter] = useState<FilterKey>("todas");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [localMode, setLocalMode] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [inspectorTab, setInspectorTab] = useState<"block" | "settings">("block");
  const [builderPreview, setBuilderPreview] = useState(false);
  const [builderEditingId, setBuilderEditingId] = useState<string | null>(null);
  const [builderFlow, setBuilderFlow] = useState<AutomationFlow>(() => flowFromFormState(defaultForm));
  const [builderZoom, setBuilderZoom] = useState(0.86);
  const [selectedBuilderNodeId, setSelectedBuilderNodeId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [builderValidation, setBuilderValidation] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [form, setForm] = useState<AutomationFormState>(defaultForm);
  const [logAutomation, setLogAutomation] = useState<Automation | null>(null);
  const [taskProjects, setTaskProjects] = useState<TaskProject[]>([
    { id: "default", name: "Operacao Norium", category: "operacao" },
  ]);
  const importRef = useRef<HTMLInputElement>(null);
  const builderDraggingRef = useRef<{ id: string; startX: number; startY: number; originalX: number; originalY: number } | null>(null);

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
  }, [userId]);

  useEffect(() => {
    if (!builderOpen) return;
    setLibraryQuery(""); setInspectorTab("block"); setBuilderPreview(false);
    setBuilderZoom(window.innerWidth <= 720 ? 0.62 : window.innerWidth <= 1200 ? 0.74 : 0.86);
  }, [builderOpen]);

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
            ? { ...nodeItem, x: Math.max(40, nextX), y: Math.max(40, nextY) }
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
      const fallback = readLocalAutomations(userId);
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
      writeLocalAutomations(userId, next);
      return;
    }
    const response = await apiJson<AutomationResponse>(`/${id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    setData(normalizeAutomationResponse(response));
  }



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
        writeLocalAutomations(userId, next);
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
        writeLocalAutomations(userId, next);
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
      writeLocalAutomations(userId, next);
      setStatusMessage("Automação duplicada.");
      return;
    }
    const response = await apiJson<AutomationResponse>(`/${automation.id}/duplicar`, { method: "POST" });
    setData(normalizeAutomationResponse(response));
    setStatusMessage("Automação duplicada.");
  }

  async function deleteAutomation(automation: Automation) {
    const confirmed = await showConfirm({
      title: "Excluir automação?",
      description: `"${automation.name}" e sua configuração serão removidos.`,
      confirmLabel: "Excluir automação",
      tone: "danger",
    });
    if (!confirmed) return;
    if (localMode) {
      const next = normalizeAutomationResponse({
        ...data,
        automations: data.automations.filter((item) => item.id !== automation.id),
      });
      setData(next);
      writeLocalAutomations(userId, next);
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

  function moveBuilderNode(index: number, direction: number) {
    const nodes = [...builderFlow.nodes];
    const target = index + direction;
    if (index < 1 || target < 1 || target >= nodes.length) return;
    [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
    const arranged = nodes.map((node, position) => ({ ...node, x: 40 + position * 290, y: 100 }));
    setBuilderFlow({ nodes: arranged, connections: connectNodes(arranged) });
    setForm((current) => ({ ...current, actions: actionsFromFlow({ nodes: arranged, connections: [] }).join(", ") }));
  }

  function validateBuilderFlow() {
    const issues: string[] = messageIssues(builderFlow.nodes);
    const eventConfig = builderFlow.nodes.find(node => node.kind === "trigger")?.config;
    if (eventConfig?.automatic === "true" && !eventTriggers.some(item => item.value === eventConfig.eventType)) issues.push("Selecione um evento válido para o gatilho automático.");
    if (eventConfig?.automatic === "true" && form.approvalRequired) issues.push("Desative a execução automática ou a aprovação obrigatória para salvar este fluxo.");
    if (eventConfig?.automatic === "true" && localMode) issues.push("Conecte ao servidor para ativar gatilhos automáticos. O modo local permite apenas simulações.");
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
        writeLocalAutomations(userId, next);
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
      writeLocalAutomations(userId, next);
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
      writeLocalAutomations(userId, next);
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

  const selectedBuilderNode = builderFlow.nodes.find((nodeItem) => nodeItem.id === selectedBuilderNodeId) || builderFlow.nodes[0] || null;

  if (builderOpen) {
    const canvasWidth = Math.max(900, ...builderFlow.nodes.map((node) => node.x + 280));
    const canvasHeight = Math.max(600, ...builderFlow.nodes.map((node) => node.y + 230));
    return (
      <main className="automation-builder professional-automation-builder auto-v2">
        <div className="auto-builder-shell">
          <header className="auto-builder-head">
            <div className="auto-builder-title">
              <button type="button" className="auto-icon-btn" onClick={() => setBuilderOpen(false)} title="Voltar" aria-label="Voltar">
                <X size={16} />
              </button>
              <div className="nx-grow">
                <p>Construtor visual</p>
                <input
                  aria-label="Nome da automação"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="Nome da automação"
                />
              </div>
            </div>

            <div className="auto-builder-actions">
              <span className="builder-help"><MousePointer2 size={14} />Clique para inserir, arraste para posicionar</span>
              <span className="builder-status-label">{form.active ? "Ativa ao salvar" : "Desativada"}</span><Toggle checked={form.active} onChange={(next) => setForm({ ...form, active: next })} />
              <button type="button" className="nx-btn is-sm" onClick={() => setBuilderPreview((current) => !current)}><Network size={14} />{builderPreview ? "Voltar ao editor" : "Pré-visualizar"}</button>
              <button type="button" className="nx-btn is-sm" onClick={validateBuilderFlow}><Play size={14} />Validar fluxo</button>
              <button type="button" className="nx-btn is-sm" onClick={() => setBuilderOpen(false)}>Cancelar</button>
              <button type="button" className="nx-btn is-sm is-primary" onClick={() => void saveBuilderAutomation()} disabled={saving || !form.name.trim()}>
                <Save size={14} />
                {saving ? "Salvando..." : "Salvar fluxo"}
              </button>
            </div>
          </header>

          {error && <div role="alert" className="builder-error">{error}</div>}
          <section className="automation-builder-grid auto-builder-grid">
            <aside className="auto-library">
              <p className="auto-library-intro">Insira gatilhos, ações e blocos da Nora no fluxo.</p>
              <label className="builder-library-search nx-input"><Search size={15} /><input aria-label="Buscar componentes" placeholder="Buscar bloco" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} /></label>
              <div>
                {componentLibrary.map((group) => ({ ...group, items: group.items.filter((item) => `${item.title} ${item.description}`.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").includes(libraryQuery.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").trim())) })).filter((group) => group.items.length > 0).map((group) => (
                  <section key={group.group}>
                    <h2 className="auto-library-group">{group.group}</h2>
                    <div className="auto-library-items">
                      {group.items.map((item) => (
                        <button
                          key={`${group.group}-${item.title}`}
                          type="button"
                          onClick={() => addBuilderComponent(item)}
                          className="auto-library-item"
                        >
                          <IconByName name={item.icon} size={16} />
                          <span className="nx-grow">
                            <strong>{item.title}</strong>
                            <small>{item.description}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </aside>

            <div className={`builder-work-area auto-canvas ${builderPreview ? "is-preview" : ""}`}>
              {builderPreview ? <AutomationFlowPreview flow={builderFlow} /> : <>
              <div className="auto-canvas-bar">
                <span className="nx-badge">{builderFlow.nodes.length} bloco(s) · {builderFlow.connections.length} conexões</span>
                {builderValidation.length > 0 ? <span className="nx-badge is-amber">{builderValidation.length} item(ns) para revisar</span> : statusMessage === "Fluxo validado e pronto para executar." ? <span className="nx-badge is-green"><CheckSquare size={12} />Sem erros</span> : null}
                <span className="nx-seg auto-zoom" style={{ marginLeft: "auto" }}>
                  <button type="button" aria-label="Diminuir zoom" onClick={() => setBuilderZoom((current) => Math.max(0.62, current - 0.08))}>−</button>
                  <span className="auto-zoom-value" aria-label="Zoom do editor">{Math.round(builderZoom * 100)}%</span>
                  <button type="button" aria-label="Aumentar zoom" onClick={() => setBuilderZoom((current) => Math.min(1.28, current + 0.08))}>+</button>
                </span>
              </div>

              <div className="builder-canvas-scroll" style={{ position: "relative", width: canvasWidth * builderZoom, height: canvasHeight * builderZoom }}>
                <div style={{ position: "absolute", inset: 0, transformOrigin: "top left", transform: `scale(${builderZoom})`, width: canvasWidth, height: canvasHeight }}>
                  <svg className="auto-canvas-lines" aria-hidden="true">
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
                          stroke="currentColor"
                          strokeWidth="1.5"
                        />
                      );
                    })}
                  </svg>

                  {builderFlow.nodes.map((nodeItem) => (
                    <div
                      key={nodeItem.id}
                      onClick={() => { setSelectedBuilderNodeId(nodeItem.id); setInspectorTab("block"); }}
                      role="button" tabIndex={0} aria-label={`Selecionar bloco ${nodeItem.title}`} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedBuilderNodeId(nodeItem.id); setInspectorTab("block"); } }}
                      onPointerDown={(event) => {
                        builderDraggingRef.current = {
                          id: nodeItem.id,
                          startX: event.clientX,
                          startY: event.clientY,
                          originalX: nodeItem.x,
                          originalY: nodeItem.y,
                        };
                      }}
                      className={`auto-node ${selectedBuilderNodeId === nodeItem.id ? "is-selected" : ""}`}
                      style={{ left: nodeItem.x, top: nodeItem.y }}
                    >
                      {nodeItem.kind !== "trigger" && <span className="automation-node-port is-input" aria-hidden="true" />}
                      <span className="automation-node-port is-output" aria-hidden="true" />
                      <KindBadge kind={nodeItem.kind} icon={nodeItem.icon} />
                      <h3>{nodeItem.title}</h3>
                      {nodeItem.kind === "trigger" && <span className="auto-node-trigger">{nodeItem.config?.automatic === "true" ? "Disparo automático ativado" : "Execução manual"}</span>}
                      <p>{nodeItem.description}</p>
                      <div className="automation-node-footer"><span><i /> Configurado</span><small>{nodeItem.kind === "nora" ? "IA supervisionada" : nodeItem.kind === "trigger" ? "Entrada" : "Ação"}</small></div>
                    </div>
                  ))}
                </div>
              </div></>}
            </div>

            <aside className="builder-inspector auto-inspector">
              <nav className="builder-inspector-tabs nx-seg" aria-label="Configurações do editor"><button type="button" className={inspectorTab === "block" ? "is-active" : ""} aria-pressed={inspectorTab === "block"} onClick={() => setInspectorTab("block")}>Bloco</button><button type="button" className={inspectorTab === "settings" ? "is-active" : ""} aria-pressed={inspectorTab === "settings"} onClick={() => setInspectorTab("settings")}>Automação</button></nav>
              <section hidden={inspectorTab !== "settings"} className="auto-inspector-section">
                <h2>Configuração do fluxo</h2>
                <label className="auto-label">
                  <span>Descrição</span>
                  <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={3} className="auto-field" />
                </label>
                <label className="auto-label">
                  <span>Categoria</span>
                  <input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} className="auto-field" />
                </label>
                <label className="auto-label">
                  <span>Projeto para tarefas</span>
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
                    className="auto-field"
                  >
                    {taskProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="auto-label">
                  <span>Categoria da tarefa</span>
                  <select value={form.taskCategory} onChange={(event) => setForm({ ...form, taskCategory: event.target.value })} className="auto-field">
                    {taskCategoryOptions.map((category) => (
                      <option key={category.value} value={category.value}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="auto-label">
                  <span>Categoria de e-mail</span>
                  <select value={form.emailCategory} onChange={(event) => setForm({ ...form, emailCategory: event.target.value })} className="auto-field">
                    {emailCategoryOptions.map((category) => (
                      <option key={category.value} value={category.value}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="auto-label">
                  <span>Agendamento</span>
                  <select value={form.schedule} onChange={(event) => setForm({ ...form, schedule: event.target.value })} className="auto-field">
                    <option value="">Manual</option>
                    <option value="A cada hora">A cada hora</option>
                    <option value="Diariamente as 09:00">Diariamente às 09:00</option>
                    <option value="Dias uteis as 09:00">Dias úteis às 09:00</option>
                    <option value="Semanalmente, segunda as 09:00">Semanalmente</option>
                    <option value="Mensalmente, dia 1 as 09:00">Mensalmente</option>
                  </select>
                </label>
                <div className="auto-two">
                  <label className="auto-label">
                    <span>Tentativas após falha</span>
                    <select value={form.retryPolicy} onChange={(event) => setForm({ ...form, retryPolicy: event.target.value as AutomationFormState["retryPolicy"] })} className="auto-field">
                      <option value="none">Não repetir</option>
                      <option value="once">Repetir uma vez</option>
                      <option value="three_times">Repetir três vezes</option>
                    </select>
                  </label>
                  <label className="auto-label">
                    <span>Se ainda falhar</span>
                    <select value={form.failureAction} onChange={(event) => setForm({ ...form, failureAction: event.target.value as AutomationFormState["failureAction"] })} className="auto-field">
                      <option value="notify">Notificar responsável</option>
                      <option value="pause">Pausar automação</option>
                      <option value="continue">Continuar fluxo</option>
                    </select>
                  </label>
                </div>
                <div className="auto-switches">
                  <label>
                    <span>Exigir aprovação para ações sensíveis</span>
                    <input type="checkbox" checked={form.approvalRequired} onChange={(event) => setForm({ ...form, approvalRequired: event.target.checked })} />
                  </label>
                  <label>
                    <span>Notificar quando concluir</span>
                    <input type="checkbox" checked={form.notifyOnSuccess} onChange={(event) => setForm({ ...form, notifyOnSuccess: event.target.checked })} />
                  </label>
                  <label>
                    <span>Notificar quando falhar</span>
                    <input type="checkbox" checked={form.notifyOnFailure} onChange={(event) => setForm({ ...form, notifyOnFailure: event.target.checked })} />
                  </label>
                </div>
              </section>

              <section hidden={inspectorTab !== "block"} className="auto-inspector-section">
                <h2 className="nx-faint" style={{ fontWeight: 500, fontSize: 12.5 }}>Bloco selecionado</h2>
                {selectedBuilderNode ? (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <KindBadge kind={selectedBuilderNode.kind} icon={selectedBuilderNode.icon} />
                      <b className="nx-ell" style={{ fontSize: 14 }}>{selectedBuilderNode.title}</b>
                    </div>
                    <MessageActionFields key={selectedBuilderNode.id} node={selectedBuilderNode} onChange={(config) => updateBuilderNode(selectedBuilderNode.id, { config })} />
                    {selectedBuilderNode.kind === "trigger" && <EventTriggerFields key={`event-${selectedBuilderNode.id}`} node={selectedBuilderNode} onChange={(config) => { const event = eventTriggers.find(item => item.value === config.eventType); updateBuilderNode(selectedBuilderNode.id, { config, ...(event ? { title: event.title, icon: event.icon } : {}) }); }} />}
                    <label className="auto-label">
                      <span>Nome do bloco</span>
                      <input value={selectedBuilderNode.title} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { title: event.target.value })} className="auto-field" />
                    </label>
                    <label className="auto-label">
                      <span>Instrução do bloco</span>
                      <textarea value={selectedBuilderNode.description} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { description: event.target.value })} rows={4} className="auto-field" />
                    </label>

                    {selectedBuilderNode.title.toLowerCase().includes("navegador") && (
                      <>
                        <label className="auto-label">
                          <span>URL pública autorizada</span>
                          <input type="url" value={selectedBuilderNode.config?.targetUrl || ""} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), targetUrl: event.target.value } })} placeholder="https://exemplo.com/pagina" className="auto-field" />
                        </label>
                        <label className="auto-label">
                          <span>Objetivo da tarefa</span>
                          <textarea value={selectedBuilderNode.config?.objective || ""} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), objective: event.target.value } })} rows={3} placeholder="Pesquisar, preencher o formulário e baixar o comprovante" className="auto-field" />
                        </label>
                        <div className="auto-two">
                          <label className="auto-label">
                            <span>Modo</span>
                            <select value={selectedBuilderNode.config?.executionMode || "automatic"} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), executionMode: event.target.value } })} className="auto-field"><option value="automatic">Automático</option><option value="assisted">Assistido por etapa</option></select>
                          </label>
                          <label className="auto-label">
                            <span>Resultado</span>
                            <select value={selectedBuilderNode.config?.expectedResult || "structured"} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), expectedResult: event.target.value } })} className="auto-field"><option value="structured">Dados estruturados</option><option value="summary">Resumo</option><option value="files">Arquivos</option></select>
                          </label>
                          <label className="auto-label">
                            <span>Máximo de etapas</span>
                            <input type="number" min="1" max="40" value={selectedBuilderNode.config?.maxSteps || "20"} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), maxSteps: event.target.value } })} className="auto-field" />
                          </label>
                          <label className="auto-label">
                            <span>Tempo limite (s)</span>
                            <input type="number" min="30" max="900" value={selectedBuilderNode.config?.timeoutSeconds || "300"} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), timeoutSeconds: event.target.value } })} className="auto-field" />
                          </label>
                        </div>
                        <label className="auto-label">
                          <span>ID do perfil seguro (opcional)</span>
                          <input value={selectedBuilderNode.config?.profileId || ""} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), profileId: event.target.value } })} placeholder="browser-profile-..." className="auto-field" />
                        </label>
                      </>
                    )}
                    {selectedBuilderNode.title.toLowerCase().includes("roteamento") && selectedBuilderNode.title.toLowerCase().includes("ia") && (
                      <>
                        <label className="auto-label">
                          <span>ID da política (opcional)</span>
                          <input value={selectedBuilderNode.config?.policyId || ""} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), policyId: event.target.value } })} placeholder="policy_..." className="auto-field" />
                        </label>
                        <label className="auto-label">
                          <span>Privacidade mínima</span>
                          <select value={selectedBuilderNode.config?.privacy || "any"} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), privacy: event.target.value } })} className="auto-field">
                            <option value="any">Qualquer provedor permitido</option><option value="private">Privado ou local</option><option value="local">Somente local</option>
                          </select>
                        </label>
                        <label className="auto-label">
                          <span>Prompt executado pelo modelo</span>
                          <textarea value={selectedBuilderNode.config?.prompt || ""} onChange={(event) => updateBuilderNode(selectedBuilderNode.id, { config: { ...(selectedBuilderNode.config || {}), prompt: event.target.value } })} rows={3} placeholder="Resuma os dados recebidos e devolva próximos passos." className="auto-field" />
                        </label>
                      </>
                    )}
                    <button type="button" className="nx-btn auto-danger" style={{ width: "100%" }} onClick={() => removeBuilderNode(selectedBuilderNode.id)}>
                      <Trash2 size={15} />
                      Remover bloco
                    </button>
                  </>
                ) : (
                  <p className="nx-muted nx-small">Selecione um bloco no canvas.</p>
                )}
              </section>

              {builderValidation.length > 0 && (
                <section className="auto-note is-warn">
                  <h2>Itens para revisar</h2>
                  <ul>
                    {builderValidation.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                </section>
              )}

              {builderValidation.length === 0 && statusMessage === "Fluxo validado e pronto para executar." && (
                <section className="auto-note is-ok">
                  {statusMessage}
                </section>
              )}

              <section className="builder-sequence auto-inspector-section">
                <h2>Ordem de execução</h2><ol>{builderFlow.nodes.map((node, index) => <li key={node.id}><button type="button" onClick={() => { setSelectedBuilderNodeId(node.id); setInspectorTab("block"); }}><span>{index + 1}</span>{node.title}</button><button type="button" className="auto-icon-btn is-sm" disabled={node.kind === "trigger" || index < 2} aria-label={`Mover ${node.title} para cima`} onClick={() => moveBuilderNode(index, -1)}><ArrowUp size={14} /></button><button type="button" className="auto-icon-btn is-sm" disabled={node.kind === "trigger" || index === builderFlow.nodes.length - 1} aria-label={`Mover ${node.title} para baixo`} onClick={() => moveBuilderNode(index, 1)}><ArrowDown size={14} /></button></li>)}</ol>
              </section>
            </aside>
          </section>
        </div>
      </main>
    );
  }

  const failedRuns = data.history.filter((item) => item.status === "erro").length;

  return (
    <main className="nx-page automations-workspace auto-v2">
      <div className="nx-ph">
        <div>
          <h1>Automações</h1>
          <p>{data.metrics.active} ativa(s) · {data.metrics.runsToday} execução(ões) hoje</p>
        </div>
        <div className="nx-ph-actions">
          <button type="button" className="nx-btn" onClick={onOpenNora}><Sparkles size={16} />Descrever para a Nora</button>
          <button type="button" className="nx-btn is-primary" onClick={() => openCreateModal()}><Plus size={16} />Nova automação</button>
        </div>
      </div>

      <section className="nx-kpis" aria-label="Indicadores das automações">
        <StatCard title="Total de automações" value={data.metrics.total} icon={GitBranch} detail="Fluxos configurados" />
        <StatCard title="Ativas" value={data.metrics.active} icon={Zap} detail="Prontas para executar" />
        <StatCard title="Execuções hoje" value={data.metrics.runsToday} icon={Activity} detail="Disparos registrados" />
        <StatCard title="Tempo economizado" value={formatSavedTime(data.metrics.savedMinutes)} icon={Clock3} detail="Estimativa operacional" />
      </section>

      <nav className="nx-tabs" aria-label="Áreas de automações">
        {([
          ["flows", "Meus fluxos", Workflow], ["templates", "Modelos", Layers], ["history", "Histórico e dados", History], ["preview", "Visão do fluxo", Network],
        ] as const).map(([view, label, Icon]) => <button key={view} type="button" className={`nx-tab auto-tab ${dashboardView === view ? "is-active" : ""}`} aria-pressed={dashboardView === view} onClick={() => setDashboardView(view)}><Icon size={15} />{label}{view === "flows" && <span className="nx-badge">{data.automations.length}</span>}</button>)}
      </nav>

      {dashboardView === "flows" && <section className="auto-toolbar">
        <label className="nx-input auto-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Pesquisar automações" placeholder="Pesquisar automações..."
          />
        </label>
        <div className="nx-seg auto-filters" role="group" aria-label="Filtrar automações">
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={filter === item.key}
              className={filter === item.key ? "is-active" : ""}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>}

      <AnimatePresence>
        {(error || statusMessage) && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`auto-alert ${error ? "is-error" : "is-ok"}`}
          >
            {error || statusMessage}
          </motion.div>
        )}
      </AnimatePresence>

      {dashboardView === "flows" && (loading ? (
        <div className="nx-card">
          <LoadingState label="Carregando automações..." />
        </div>
      ) : filteredAutomations.length === 0 ? (
        <div className="auto-empty"><Workflow size={28} /><strong>{data.automations.length ? "Nenhum fluxo neste filtro" : "Sua primeira automação começa aqui"}</strong><p>{data.automations.length ? "Ajuste a busca ou mostre todos os fluxos." : "Crie um fluxo ou comece com um modelo pronto."}</p><button type="button" className="nx-btn is-sm" onClick={() => { if (data.automations.length) { setQuery(""); setFilter("todas"); } else { setDashboardView("templates"); } }}>{data.automations.length ? "Limpar filtros" : "Explorar modelos"}</button></div>
      ) : (
        <div className="auto-flows-grid">
          <div className="nx-card auto-table-card">
            <div className="auto-table-wrap">
              <table className="nx-table">
                <thead>
                  <tr><th>Automação</th><th>Gatilho</th><th>Execuções</th><th>Última</th><th>Status</th><th className="auto-num">Ações</th></tr>
                </thead>
                <tbody>
                  {filteredAutomations.map((automation) => (
                    <tr key={automation.id} className={selectedAutomation?.id === automation.id ? "is-selected" : ""} onClick={() => setSelectedId(automation.id)}>
                      <td>
                        <div className="auto-name-cell">
                          <button type="button" className="automation-card-select" title={`Ver fluxo ${automation.name}`} onClick={(event) => { event.stopPropagation(); setSelectedId(automation.id); setDashboardView("preview"); }}>{automation.name}</button>
                          {automation.favorite && <Star size={13} className="auto-star" aria-label="Favorita" />}
                        </div>
                        <div className="auto-cell-tags">
                          <span className={`nx-badge ${automation.active ? "is-green" : ""}`}>{automation.active ? "Ativa" : "Desativada"}</span>
                          <span className="nx-badge">{automation.category}</span>
                          {automation.aiEnabled && <span className="nx-badge is-violet">Nora IA</span>}
                        </div>
                      </td>
                      <td className="nx-muted">{automation.trigger}</td>
                      <td className="nx-muted">{automation.executions}</td>
                      <td className="nx-muted">{formatDateTime(automation.lastRunAt)}</td>
                      <td onClick={(event) => event.stopPropagation()}><Toggle checked={automation.active} onChange={(next) => void updateAutomation(automation.id, { active: next, status: next ? "ativa" : "desativada" } as Partial<Automation>)} /></td>
                      <td onClick={(event) => event.stopPropagation()}>
                        <div className="auto-row-actions">
                          <button type="button" className="auto-icon-btn" disabled={saving || !automation.active} onClick={() => void executeAutomation(automation)} title="Executar" aria-label={`Executar ${automation.name}`}><Play size={15} /></button>
                          <button type="button" className="auto-icon-btn" disabled={saving} onClick={() => void simulateAutomation(automation)} title="Testar fluxo" aria-label={`Testar fluxo ${automation.name}`}><FlaskConical size={15} /></button>
                          <button type="button" className="auto-icon-btn" onClick={() => openEditModal(automation)} title="Editar" aria-label={`Editar ${automation.name}`}><Settings2 size={15} /></button>
                          <button type="button" className="auto-icon-btn" onClick={() => void duplicateAutomation(automation)} title="Duplicar" aria-label={`Duplicar ${automation.name}`}><Copy size={15} /></button>
                          <button type="button" className={`auto-icon-btn ${automation.favorite ? "is-fav" : ""}`} aria-pressed={automation.favorite} onClick={() => void updateAutomation(automation.id, { favorite: !automation.favorite } as Partial<Automation>)} title="Favorito" aria-label={`Favorito ${automation.name}`}><Star size={15} /></button>
                          <button type="button" className="auto-icon-btn" onClick={() => setLogAutomation(automation)} title="Logs e versões" aria-label={`Logs e versões de ${automation.name}`}><History size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {selectedAutomation && (
            <aside className="nx-card auto-flow-card" aria-label="Fluxo selecionado">
              <div style={{ fontWeight: 600 }}>{selectedAutomation.name}</div>
              <div className="nx-faint nx-small" style={{ marginTop: 2 }}>{selectedAutomation.description || "Fluxo"}</div>
              <ol className="auto-steps">
                {(selectedAutomation.flow?.nodes || []).map((nodeItem) => (
                  <li key={nodeItem.id}>
                    <span className={`auto-step-icon is-${nodeItem.kind}`}><IconByName name={nodeItem.icon} size={16} /></span>
                    <div>
                      <b>{nodeItem.kind === "trigger" ? "Quando" : nodeItem.title}</b>
                      <span>{nodeItem.kind === "trigger" ? nodeItem.title : nodeItem.description}</span>
                    </div>
                  </li>
                ))}
                {!(selectedAutomation.flow?.nodes || []).length && <li className="nx-muted nx-small">Este fluxo ainda não tem blocos.</li>}
              </ol>
              <div className="auto-flow-actions">
                <button type="button" className="nx-btn is-sm" onClick={() => openEditModal(selectedAutomation)}><Plus size={14} />Adicionar etapa</button>
                <button type="button" className="nx-btn is-sm" onClick={() => setDashboardView("preview")}><Network size={14} />Pré-visualizar fluxo</button>
                <button type="button" className="nx-btn is-sm is-primary" disabled={saving || !selectedAutomation.active} onClick={() => void executeAutomation(selectedAutomation)}><Play size={14} />Executar</button>
              </div>
              <div className="auto-flow-stats">
                <span><b>{selectedAutomation.executions}</b>execuções</span>
                <span><b>{formatSavedTime(selectedAutomation.savedMinutes)}</b>economizados</span>
                <span><b>{formatDateTime(selectedAutomation.lastRunAt)}</b>última execução</span>
              </div>
            </aside>
          )}
        </div>
      ))}

      {dashboardView === "templates" && <section className="auto-templates-section">
        <div className="auto-section-head">
          <div>
            <h2>Comece com um modelo</h2>
            <p>Fluxos prontos para criar em um clique.</p>
          </div>
        </div>
        <div className="automation-templates auto-templates">
          {data.templates.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => openCreateModal(template)}
              className="nx-card auto-template"
            >
              <span className="auto-template-head">
                <span className="auto-template-icon"><IconByName name={template.icon} size={16} /></span>
                <strong>{template.title}</strong>
              </span>
              <span className="nx-muted nx-small">{template.description}</span>
              <span className="auto-template-use">Usar modelo</span>
            </button>
          ))}
        </div>
      </section>}

      {dashboardView === "preview" && <div className="automation-preview auto-preview">
        <section className="nx-card" style={{ overflow: "hidden" }}>
          <header className="auto-card-head">
            <div className="nx-grow">
              <h2>Visão do fluxo</h2>
              <select className="auto-field" style={{ marginTop: 6, maxWidth: 360 }} aria-label="Automação para pré-visualizar" value={selectedAutomation?.id || ""} onChange={(event) => setSelectedId(event.target.value)}>{!data.automations.length && <option value="">Selecione uma automação</option>}{data.automations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            </div>
            <button type="button" className="nx-btn is-sm" disabled={!selectedAutomation} onClick={() => selectedAutomation && openEditModal(selectedAutomation)}><Settings2 size={14} />Editar fluxo</button>
          </header>

          {!selectedAutomation && <div className="auto-empty is-flat"><Workflow size={28} /><strong>Selecione um fluxo para visualizar</strong><button type="button" className="nx-btn is-sm" onClick={() => setDashboardView("flows")}>Ver meus fluxos</button></div>}
          {selectedAutomation && <AutomationFlowPreview key={selectedAutomation.id} flow={selectedAutomation.flow} />}
        </section>

        <section className="nx-card auto-nora-card">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div className="nx-grow">
              <span className="nx-badge is-violet"><Sparkles size={12} />Bloco especial</span>
              <h2>Nora IA</h2>
              <p className="nx-muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>
                Use a Nora dentro dos fluxos para raciocinar sobre textos, conversas, e-mails, gastos e tarefas.
              </p>
            </div>
            <button type="button" className="nx-btn is-primary" style={{ width: 36, padding: 0 }} onClick={onOpenNora} title="Abrir Nora" aria-label="Abrir Nora">
              <Sparkles size={16} />
            </button>
          </div>
          <div className="auto-cell-tags" style={{ marginTop: 14 }}>
            {noraAbilities.map((ability) => (
              <span key={ability} className="nx-badge">{ability}</span>
            ))}
          </div>
        </section>
      </div>}

      {dashboardView === "history" && <section className="auto-history-grid">
        <div className="nx-card" style={{ overflow: "hidden", minWidth: 0 }}>
          <header className="auto-card-head">
            <div className="nx-grow">
              <h2>Histórico de execuções</h2>
              <p>{data.history.length} execução(ões) registradas{failedRuns ? ` · ${failedRuns} falha(s)` : ""}</p>
            </div>
          </header>
          <div className="auto-table-wrap" style={{ maxHeight: 520 }}>
            <table className="nx-table" style={{ minWidth: 780 }}>
              <thead>
                <tr>
                  <th>Automação</th>
                  <th>Horário</th>
                  <th>Status</th>
                  <th>Duração</th>
                  <th>Resultado</th>
                  <th>Executada por</th>
                </tr>
              </thead>
              <tbody>
                {data.history.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="nx-muted" style={{ padding: "32px 18px", textAlign: "center" }}>
                      Nenhuma execução registrada ainda.
                    </td>
                  </tr>
                ) : (
                  data.history.map((item) => (
                    <tr key={item.id} className={item.status === "erro" ? "is-failed" : ""}>
                      <td style={{ fontWeight: 500 }}>{item.automationName}</td>
                      <td className="nx-muted">{formatDateTime(item.timestamp)}</td>
                      <td><span className={`nx-badge ${executionStatusClass(item.status)}`}>{item.status}</span></td>
                      <td className="nx-muted">{formatDuration(item.durationMs)}</td>
                      <td className="nx-muted" style={{ maxWidth: 300 }}>
                        <span className="auto-clamp">{item.result}</span>
                      </td>
                      <td className="nx-muted">{item.executedBy}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="auto-history-aside">
          {!localMode && <AutomaticEventHistory automations={data.automations} />}
          <section className="nx-card auto-side-card">
            <h2>Integrações disponíveis</h2>
            <div className="auto-side-list">
              {!data.integrations.length && <p className="nx-muted nx-small">Nenhuma integração informada para os fluxos.</p>}
              {data.integrations.map((integration) => (
                <div key={integration.name} className="nx-row">
                  <span className="nx-grow" style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 500 }}><IntegrationLogo name={integration.name} />{integration.name}</span>
                  <span className="nx-badge">{integration.status}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="nx-card auto-side-card">
            <h2>Importação e registros</h2>
            <div className="auto-side-buttons">
              <button type="button" className="nx-btn" onClick={exportAutomations}>
                <Download size={15} />
                Exportar
              </button>
              <button type="button" className="nx-btn" onClick={() => importRef.current?.click()}>
                <Upload size={15} />
                Importar
              </button>
              <button type="button" className="nx-btn" disabled={!selectedAutomation} onClick={() => setLogAutomation(selectedAutomation)}>
                <History size={15} />
                Logs
              </button>
              <button type="button" className="nx-btn" disabled={!selectedAutomation} onClick={() => setLogAutomation(selectedAutomation)}>
                <GitBranch size={15} />
                Versões
              </button>
              <button type="button" className="nx-btn" onClick={() => { setFilter("ia"); setDashboardView("flows"); }}>
                <Filter size={15} />
                Fluxos com IA
              </button>
              <button type="button" className="nx-btn" onClick={onOpenNora}>
                <Variable size={15} />
                Consultar Nora
              </button>
            </div>
            <input
              ref={importRef}
              type="file"
              accept="application/json"
              className="hidden"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void importAutomations(file).catch((err) => setError(err instanceof Error ? err.message : "Falha ao importar."));
                event.target.value = "";
              }}
            />
          </section>
        </aside>
      </section>}

      <AnimatePresence>
        {modal && (
          <motion.div className="auto-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              initial={{ scale: 0.98, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.98, y: 8 }}
              className="auto-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="auto-modal-title"
            >
              <header className="auto-modal-h">
                <div className="nx-grow">
                  <h2 id="auto-modal-title">{modal === "edit" ? "Editar automação" : "Nova automação"}</h2>
                  <p>Configure gatilho, ações e participação da Nora.</p>
                </div>
                <button type="button" className="auto-icon-btn" onClick={() => setModal(null)} aria-label="Fechar" title="Fechar">
                  <X size={16} />
                </button>
              </header>
              <div className="auto-modal-b auto-two">
                <label className="auto-label">
                  <span>Nome</span>
                  <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="auto-field" />
                </label>
                <label className="auto-label">
                  <span>Gatilho</span>
                  <select value={form.trigger} onChange={(event) => setForm({ ...form, trigger: event.target.value })} className="auto-field">
                    {triggers.map((trigger) => (
                      <option key={trigger}>{trigger}</option>
                    ))}
                  </select>
                </label>
                <label className="auto-label is-full">
                  <span>Descrição</span>
                  <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={3} className="auto-field" />
                </label>
                <label className="auto-label">
                  <span>Categoria</span>
                  <input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} className="auto-field" />
                </label>
                <label className="auto-label">
                  <span>Agendamento</span>
                  <input value={form.schedule} onChange={(event) => setForm({ ...form, schedule: event.target.value })} placeholder="Manual, diário, semanal..." className="auto-field" />
                </label>
                <label className="auto-label is-full">
                  <span>Ações</span>
                  <input value={form.actions} onChange={(event) => setForm({ ...form, actions: event.target.value })} placeholder={actions.slice(0, 4).join(", ")} className="auto-field" />
                </label>
                <div className="auto-switch-box">
                  <span className="nx-grow">
                    <strong>Ativa</strong>
                    <small>Permite execução manual e agendada.</small>
                  </span>
                  <span className="builder-status-label">{form.active ? "Ativa ao salvar" : "Desativada"}</span><Toggle checked={form.active} onChange={(next) => setForm({ ...form, active: next })} />
                </div>
                <div className="auto-switch-box">
                  <span className="nx-grow">
                    <strong>Nora IA</strong>
                    <small>Inclui raciocínio, resumo ou classificação.</small>
                  </span>
                  <Toggle checked={form.aiEnabled} onChange={(next) => setForm({ ...form, aiEnabled: next })} />
                </div>
              </div>
              <footer className="auto-modal-f">
                <button type="button" className="nx-btn" onClick={() => setModal(null)}>Cancelar</button>
                <button type="button" className="nx-btn is-primary" onClick={() => void submitForm()} disabled={saving || !form.name.trim()}>
                  {saving ? "Salvando..." : "Salvar automação"}
                </button>
              </footer>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {logAutomation && (
          <motion.div className="auto-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              initial={{ scale: 0.98, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.98, y: 8 }}
              className="auto-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="auto-log-title"
            >
              <header className="auto-modal-h">
                <div className="nx-grow">
                  <h2 id="auto-log-title">Logs e versões</h2>
                  <p>{logAutomation.name} · versão {logAutomation.version}</p>
                </div>
                <button type="button" className="auto-icon-btn" onClick={() => setLogAutomation(null)} aria-label="Fechar" title="Fechar">
                  <X size={16} />
                </button>
              </header>
              <div className="auto-modal-b" style={{ maxHeight: 460 }}>
                <div className="auto-log-kpis">
                  <div><span>Versão</span><strong>{logAutomation.version}</strong></div>
                  <div><span>Execuções</span><strong>{logAutomation.executions}</strong></div>
                  <div><span>Tempo salvo</span><strong>{formatSavedTime(logAutomation.savedMinutes)}</strong></div>
                </div>
                <div className="auto-log-list">
                  {(logAutomation.logs || []).length === 0 ? (
                    <p className="auto-log-empty">
                      Nenhum log específico desta automação ainda.
                    </p>
                  ) : (
                    logAutomation.logs.map((log) => (
                      <article key={log.id} className="auto-log">
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                          <strong>{formatDateTime(log.timestamp)}</strong>
                          <span className={`nx-badge ${executionStatusClass(log.status)}`}>
                            {log.status}
                          </span>
                        </div>
                        <p className="nx-muted" style={{ margin: "8px 0 0", fontSize: 13.5 }}>{log.result}</p>
                        <div className="auto-log-meta">
                          <span>{formatDuration(log.durationMs)}</span>
                          <span>Tentativa {log.attempt || 1}</span>
                          <span>{log.sideEffects === false ? "Sem efeitos reais" : "Execução real"}</span>
                        </div>
                        {log.steps && log.steps.length > 0 && (
                          <div className="auto-log-steps">
                            {log.steps.map((step, index) => (
                              <div key={`${log.id}-${step.id}`} className="auto-log-step">
                                <span className="auto-log-step-n">{index + 1}</span>
                                <span style={{ minWidth: 0 }}>
                                  <strong className="nx-ell" style={{ display: "block", fontSize: 12.5 }}>{step.title}</strong>
                                  {(step.preview || step.error) && (
                                    <span className={step.error ? "nx-down" : "nx-muted"} style={{ display: "block", marginTop: 2, fontSize: 12 }}>
                                      {step.error || step.preview}
                                    </span>
                                  )}
                                </span>
                                <span className={`nx-badge ${executionStatusClass(step.status)}`}>
                                  {step.status}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {log.status === "erro" && (
                          <button type="button" className="nx-btn is-sm" style={{ marginTop: 12 }} disabled={saving} onClick={() => void retryAutomation(logAutomation, log.id)}>
                            <RotateCcw size={14} />
                            Reexecutar da falha
                          </button>
                        )}
                      </article>
                    ))
                  )}
                </div>
              </div>
              <footer className="auto-modal-f" style={{ justifyContent: "space-between" }}>
                <button type="button" className="nx-btn auto-danger" onClick={() => void deleteAutomation(logAutomation).then(() => setLogAutomation(null))}>
                  <Trash2 size={15} />
                  Excluir
                </button>
                <button type="button" className="nx-btn is-primary" onClick={() => setLogAutomation(null)}>
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

function KindBadge({ kind, icon }: { kind: StepKind; icon: string }) {
  const label = kind === "trigger" ? "Gatilho" : kind === "nora" ? "Nora IA" : "Ação";
  const tone = kind === "trigger" ? "is-amber" : kind === "nora" ? "is-violet" : "is-blue";
  return <span className={`nx-badge ${tone} auto-kind`}>{kind === "nora" ? <Sparkles size={12} /> : <IconByName name={icon} size={12} />}{label}</span>;
}
