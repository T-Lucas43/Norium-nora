import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Archive,
  Building2,
  CheckCircle2,
  Crown,
  FileClock,
  Gauge,
  LayoutDashboard,
  Link2,
  ListChecks,
  LockKeyhole,
  Mail,
  MonitorCheck,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  UsersRound,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import type { AuthSession, NoriumTeam, NoriumUser, PermissionKey, PermissionMap, PlanInfo, UserPlan } from "../../types/auth";
import { defaultMemberPermissions, permissionGroups, permissionLabels } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import AvatarImage from "../profile/AvatarImage";
import AdminSidebar, { type AdminNavGroup } from "./layout/AdminSidebar";
import AdminTopbar from "./layout/AdminTopbar";
import AdminOverlay from "./layout/AdminOverlay";
import AdminActivityTable from "./layout/AdminActivityTable";
import { AdminSearchContext, matchesAdminSearch } from "./layout/AdminSearch";
import "../../styles/screens/admin.css";
import LocalThemeToggle from "../layout/LocalThemeToggle";
import { showConfirm } from "../shared/AppDialogProvider";
import Button from "../shared/Button";
import AdminFinanceDashboard from "./finance/AdminFinanceDashboard";
import SystemEmailSettings from "./SystemEmailSettings";
import ManualEmailSender from "./ManualEmailSender";
import AiCostsDashboard from "./AiCostsDashboard";

interface AdminDashboardProps {
  session: AuthSession;
  onUseSystem: () => void;
  onSessionUpdate: (session: AuthSession) => void;
}

interface AdminOverview {
  totalUsers: number;
  activeUsers: number;
  teamUsers: number;
  adminUsers: number;
  planCounts: Record<string, number>;
  plans: PlanInfo[];
}

interface AdminAuditItem {
  id: string;
  action: string;
  detail: string;
  actorId: string;
  actorName: string;
  targetId: string;
  targetName: string;
  createdAt: string;
}

interface SystemLogItem {
  id: string;
  event: string;
  level: "info" | "warning" | "error";
  message: string;
  userId: string;
  workspaceId: string;
  metadata?: { durationMs?: number; requestId?: string };
  createdAt: string;
}

interface AdminMonitoring {
  status: string;
  checkedAt: string;
  userStore: string;
  totalUsers: number;
  activeUsers: number;
  adminUsers: number;
  gmailConfigured: boolean;
  googleCalendarConfigured: boolean;
  gmailRedirectUri: string;
  googleRedirectUri: string;
}

type AdminSection = "overview" | "users" | "plans" | "teams" | "permissions" | "integrations" | "settings" | "emails" | "logs" | "monitoring" | "backup" | "audit" | "ai-costs" | "ai-tariffs" | "system-emails";

const integrationKeys: PermissionKey[] = ["integracao_gmail", "integracao_whatsapp", "integracao_agenda", "integracao_financeiro"];

const emptyCreateForm = {
  nome: "",
  email: "",
  password: "",
  plan: "individual" as UserPlan,
  permissions: defaultMemberPermissions,
  teamOwnerId: "",
};

function mergePermissions(value?: Partial<PermissionMap>) {
  return { ...defaultMemberPermissions, ...(value || {}) };
}

function formatDate(value?: string | null) {
  if (!value) return "Nunca";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Não informado";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(parsed);
}

function adminLabel(user: NoriumUser) {
  if (user.systemAdminRole === "owner") return "Proprietário";
  if (user.systemAdminRole === "assistant") return "Admin auxiliar";
  return user.role === "owner" ? "Principal" : "Membro";
}

export default function AdminDashboard({ session, onUseSystem, onSessionUpdate }: AdminDashboardProps) {
  const [users, setUsers] = useState<NoriumUser[]>([]);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [teams, setTeams] = useState<NoriumTeam[]>([]);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [audit, setAudit] = useState<AdminAuditItem[]>([]);
  const [systemLogs, setSystemLogs] = useState<SystemLogItem[]>([]);
  const [monitoring, setMonitoring] = useState<AdminMonitoring | null>(null);
  const [selectedUserId, setSelectedUserId] = useState(session.user.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(()=>{document.body.classList.add("norium-admin-active");return()=>document.body.classList.remove("norium-admin-active");},[]);
  const [activeArea, setActiveArea] = useState<"users" | "finance">("users");
  const [activeSection, setActiveSection] = useState<AdminSection>("overview");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [userDrawerOpen, setUserDrawerOpen] = useState(false);
  const [userDrawerTab, setUserDrawerTab] = useState<"dados" | "acesso" | "historico">("dados");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [integrationDetail,setIntegrationDetail]=useState<PermissionKey|null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [emailComposerOpen, setEmailComposerOpen] = useState(false);
  const [userPlanFilter, setUserPlanFilter] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState("");
  const [userTeamFilter, setUserTeamFilter] = useState("");
  const [userPage, setUserPage] = useState(1);

  function openUser(id: string) { setSelectedUserId(id); setUserDrawerTab("dados"); setUserDrawerOpen(true); }
  function navigate(id: string) { setQuery(""); setMobileNavigationOpen(false); if(id === "finance") setActiveArea("finance"); else openSection(id as AdminSection); }
  const groups: AdminNavGroup[] = [
    { label: "", items: [{id:"overview",label:"Visão geral",icon:LayoutDashboard}] },
    { label:"Contas",items:[{id:"users",label:"Usuários",icon:UsersRound,count:users.length},{id:"teams",label:"Equipes",icon:Building2,count:teams.length},{id:"plans",label:"Planos",icon:ListChecks},{id:"permissions",label:"Permissões",icon:ShieldCheck}] },
    { label:"Financeiro",items:[{id:"finance",label:"Financeiro",icon:WalletCards}] },
    { label:"Inteligência",items:[{id:"ai-costs",label:"Custos de IA",icon:WalletCards},{id:"ai-tariffs",label:"Provedores e tarifas",icon:SlidersHorizontal}] },
    { label:"Comunicação",items:[{id:"emails",label:"E-mails",icon:Mail},{id:"system-emails",label:"E-mails do sistema",icon:Mail}] },
    { label:"Operação",items:[{id:"monitoring",label:"Monitoramento",icon:Gauge},{id:"logs",label:"Logs do sistema",icon:FileClock},{id:"integrations",label:"Integrações",icon:Link2}] },
    { label:"Segurança e LGPD",items:[{id:"audit",label:"Auditoria",icon:ListChecks},{id:"backup",label:"Backup",icon:Archive}] },
  ];
  const location = groups.flatMap(group=>group.items.map(item=>({...item,group:group.label}))).find(item=>item.id===(activeArea === "finance" ? "finance" : activeSection));
  const alerts = systemLogs.filter(item=>item.level === "error" || item.level === "warning");
  const visibleUsers = useMemo(()=>users.filter(user=>matchesAdminSearch(query,user.nome,user.email,user.plan,adminLabel(user))&&(!userPlanFilter||user.plan===userPlanFilter)&&(!userStatusFilter||user.status===userStatusFilter)&&(!userRoleFilter||adminLabel(user)===userRoleFilter)&&(!userTeamFilter||(user.teamOwnerId||user.id)===userTeamFilter)),[users,query,userPlanFilter,userStatusFilter,userRoleFilter,userTeamFilter]);
  const userPages = Math.max(1,Math.ceil(visibleUsers.length/12));
  const currentUserPage = Math.min(userPage,userPages);
  const openedTeam = teams.find(team=>team.id===selectedTeamId);


  const selectedUser = useMemo(() => users.find((user) => user.id === selectedUserId) || users[0] || session.user, [selectedUserId, session.user, users]);
  const recentUsers = useMemo(() => users.slice(0, 6), [users]);
  const tableUsers = activeSection === "overview" ? recentUsers : visibleUsers.slice((currentUserPage-1)*12,currentUserPage*12);
  const selectedPermissions = useMemo(() => mergePermissions(selectedUser.permissions), [selectedUser.permissions]);
  const selectedIsProtectedOwner = selectedUser.systemAdminRole === "owner" && selectedUser.id !== session.user.id;
  const selectedIsPrimaryOwner = selectedUser.systemAdminRole === "owner";
  const canEditSelected = !selectedIsProtectedOwner;
  const selectedTeam = teams.find((team) => team.id === (selectedUser.teamOwnerId || selectedUser.id));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const results = await Promise.allSettled([
        authJson<AdminOverview>("/api/auth/admin/overview", session.token),
        authJson<{ users: NoriumUser[] }>("/api/auth/admin/users", session.token),
        authJson<{ plans: PlanInfo[] }>("/api/auth/plans", session.token),
        authJson<{ teams: NoriumTeam[] }>("/api/auth/teams", session.token),
        authJson<{ items: AdminAuditItem[] }>("/api/auth/admin/audit", session.token),
        authJson<AdminMonitoring>("/api/auth/admin/monitoring", session.token),
        authJson<{ items: SystemLogItem[] }>("/api/auth/admin/system-logs?limit=300", session.token),
      ]);
      const [overviewResult, usersResult, plansResult, teamsResult, auditResult, monitoringResult, systemLogsResult] = results;
      if (overviewResult.status === "fulfilled") setOverview(overviewResult.value);
      if (plansResult.status === "fulfilled") setPlans(plansResult.value.plans);
      if (teamsResult.status === "fulfilled") setTeams(teamsResult.value.teams);
      if (auditResult.status === "fulfilled") setAudit(auditResult.value.items);
      if (monitoringResult.status === "fulfilled") setMonitoring(monitoringResult.value);
      if (systemLogsResult.status === "fulfilled") setSystemLogs(systemLogsResult.value.items);
      if (usersResult.status === "fulfilled") {
        const loadedUsers = [...usersResult.value.users].sort((left, right) => (Date.parse(right.createdAt || "") || 0) - (Date.parse(left.createdAt || "") || 0));
        setUsers(loadedUsers);
        setSelectedUserId((current) => loadedUsers.some((user) => user.id === current) ? current : loadedUsers[0]?.id || session.user.id);
      }
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o painel Admin.");
    } finally {
      setLoading(false);
    }
  }, [session.token, session.user.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function patchUser(userId: string, payload: Record<string, unknown>, message = "Usuário atualizado.") {
    setSaving(userId);
    setError("");
    setNotice("");
    try {
      const result = await authJson<{ user: NoriumUser }>(`/api/auth/users/${userId}`, session.token, { method: "PATCH", body: JSON.stringify(payload) });
      setUsers((current) => current.map((user) => user.id === userId ? result.user : user));
      if (result.user.id === session.user.id) {
        onSessionUpdate({ ...session, user: result.user, availableModes: result.user.systemAdmin ? ["app", "admin"] : ["app"] });
      }
      setNotice(message);
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar usuário.");
    } finally {
      setSaving("");
    }
  }

  async function createUser() {
    setSaving("create");
    setError("");
    setNotice("");
    try {
      const result = await authJson<{ user: NoriumUser }>("/api/auth/users", session.token, { method: "POST", body: JSON.stringify(createForm) });
      setUsers((current) => [result.user, ...current]);
      setSelectedUserId(result.user.id);
      setCreateForm(emptyCreateForm);
      setCreateOpen(false);
      setActiveSection("users");
      setNotice("Usuário criado com acesso controlado.");
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao criar usuário.");
    } finally {
      setSaving("");
    }
  }

  async function deactivateUser(userId: string) {
    const confirmed = await showConfirm({ title: "Desativar usuário?", description: "O acesso será bloqueado até que um administrador reative esta conta.", confirmLabel: "Desativar usuário", tone: "danger" });
    if (!confirmed) return;
    setSaving(userId);
    try {
      const result = await authJson<{ user: NoriumUser }>(`/api/auth/users/${userId}`, session.token, { method: "DELETE" });
      setUsers((current) => current.map((user) => user.id === userId ? result.user : user));
      setNotice("Usuário desativado.");
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao desativar usuário.");
    } finally {
      setSaving("");
    }
  }

  function toggleCreatePermission(key: PermissionKey) {
    setCreateForm((current) => ({ ...current, permissions: { ...current.permissions, [key]: !current.permissions[key] } }));
  }

  function toggleUserPermission(user: NoriumUser, key: PermissionKey) {
    const permissions = mergePermissions(user.permissions);
    void patchUser(user.id, { permissions: { ...permissions, [key]: !permissions[key] } }, "Permissão atualizada.");
  }

  function toggleAllUserPermissions(keys: PermissionKey[]) {
    const shouldEnable = keys.some((key) => !selectedPermissions[key]);
    const permissions = { ...selectedPermissions };
    keys.forEach((key) => { permissions[key] = shouldEnable; });
    void patchUser(selectedUser.id, { permissions }, shouldEnable ? "Permissões liberadas." : "Permissões removidas.");
  }

  async function downloadBackup() {
    setSaving("backup");
    setError("");
    try {
      const backup = await authJson<Record<string, unknown>>("/api/auth/admin/backup", session.token);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `norium-admin-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Backup administrativo gerado sem senhas ou segredos.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao gerar backup.");
    } finally {
      setSaving("");
    }
  }

  function openSection(section: AdminSection) {
    setActiveArea("users");
    setActiveSection(section);
    setMobileNavigationOpen(false);
  }

  const stats = [
    { label: "Usuários", value: overview?.totalUsers ?? users.length, icon: UsersRound, tone: "text-[var(--primary)]" },
    { label: "Ativos", value: overview?.activeUsers ?? users.filter((user) => user.status === "ativo").length, icon: Activity, tone: "text-emerald-400" },
    { label: "Equipes", value: teams.length, icon: Building2, tone: "text-fuchsia-400" },
    { label: "Admins", value: overview?.adminUsers ?? users.filter((user) => user.systemAdmin).length, icon: ShieldCheck, tone: "text-amber-400" },
  ];

  const userList = (
    <section className="nxa-card">
      <div className="nxa-card-heading"><h2>{activeSection === "overview" ? "Usuários recentes" : "Todos os usuários"}</h2><Button size="sm" variant="primary" onClick={()=>setCreateOpen(true)} aria-label="Criar novo usuário"><UserPlus size={16}/>Novo usuário</Button></div>
      <div className="nxa-table-scroll"><table className="nxa-table"><thead><tr><th>Usuário</th><th>Plano</th><th>Equipe</th><th>Perfil</th><th>Status</th><th>Último acesso</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{tableUsers.map(user=><tr key={user.id}><td><button type="button" className="nxa-person-button" onClick={()=>openUser(user.id)}><AvatarImage src={user.fotoUrl} userId={user.id} name={user.nome} className="nx-av"/><span><strong>{user.nome}</strong><small>{user.email}</small></span></button></td><td><UserBadge accent={user.plan==='enterprise'}>{plans.find(plan=>plan.code===user.plan)?.name||user.plan}</UserBadge></td><td>{teams.find(team=>team.id===(user.teamOwnerId||user.id))?.name||'Sem equipe'}</td><td>{adminLabel(user)}{user.systemAdmin&&<small>Admin do sistema</small>}</td><td><span className={`nx-badge ${user.status==='ativo'?'is-green':'is-red'}`}>{user.status==='ativo'?'Ativo':'Inativo'}</span></td><td>{formatDate(user.lastLoginAt)}</td><td><button type="button" className="nxa-icon-button" aria-label={`Abrir ficha de ${user.nome}`} onClick={()=>openUser(user.id)}>…</button></td></tr>)}</tbody></table></div>
      {!tableUsers.length&&!loading&&<EmptyState title="Nenhum usuário encontrado" description="Revise os filtros ou crie um novo cadastro."/>}
      {activeSection==='users'&&<footer className="nxa-pagination"><span>{visibleUsers.length?`Mostrando ${(currentUserPage-1)*12+1}–${Math.min(currentUserPage*12,visibleUsers.length)} de ${visibleUsers.length}`:'Nenhum registro'}</span><button type="button" onClick={()=>setUserPage(currentUserPage-1)} disabled={currentUserPage===1}>Anterior</button><button type="button" onClick={()=>setUserPage(currentUserPage+1)} disabled={currentUserPage===userPages}>Próxima</button></footer>}
      {activeSection==='overview'&&users.length>recentUsers.length&&<div className="nxa-card-body"><button type="button" className="nx-btn is-ghost is-sm" onClick={()=>openSection('users')}>Ver todos os usuários →</button></div>}
    </section>
  );

  const selectedUserPanel = (
    <section className="nxa-selected-user">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3"><AvatarImage src={selectedUser.fotoUrl} userId={selectedUser.id} name={selectedUser.nome} size={48} className="nx-av"/><div className="min-w-0"><p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Usuário selecionado</p><h2 className="truncate text-lg font-semibold">{selectedUser.nome}</h2><p className="truncate text-[11px] font-semibold text-[var(--text-secondary)]">{selectedUser.email}</p></div></div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Plano do usuário selecionado" value={selectedUser.plan} onChange={(event) => void patchUser(selectedUser.id, { plan: event.target.value }, "Plano atualizado.")} disabled={!canEditSelected || saving === selectedUser.id} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-[11px] font-medium outline-none disabled:opacity-50">{plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}</select>
          <Button size="sm" onClick={() => void patchUser(selectedUser.id, { status: selectedUser.status === "ativo" ? "inativo" : "ativo" }, "Status atualizado.")} disabled={!canEditSelected || selectedIsPrimaryOwner || saving === selectedUser.id} className="bg-[var(--background)]"><LockKeyhole size={14} /> {selectedUser.status === "ativo" ? "Bloquear" : "Ativar"}</Button>
          <Button size="sm" variant="danger" onClick={() => void deactivateUser(selectedUser.id)} disabled={!canEditSelected || selectedIsPrimaryOwner || saving === selectedUser.id} className="border-red-500/30 bg-red-500/10 text-red-400">Desativar</Button>
        </div>
      </div>
      {selectedIsProtectedOwner && <ProtectedOwnerNotice />}
      <nav className="nxa-form-tabs" aria-label="Ficha do usuário">{([['dados','Dados'],['acesso','Acesso'],['historico','Histórico']] as const).map(([id,label])=><button key={id} type="button" role="tab" aria-selected={userDrawerTab===id} onClick={()=>setUserDrawerTab(id)}>{label}</button>)}</nav>
      {userDrawerTab === "dados" && <>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><InfoTile label="Perfil" value={adminLabel(selectedUser)} /><InfoTile label="Plano" value={selectedUser.plan} /><InfoTile label="Sistema Admin" value={selectedUser.systemAdmin ? "Sim" : "Não"} /><InfoTile label="Equipe" value={selectedTeam?.name || "Sem equipe"} /></div>
      <label className="mt-4 grid gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><span className="flex items-center gap-2 text-xs font-semibold"><Building2 size={15} className="text-[var(--primary)]" /> Vínculo com empresa/equipe</span><span className="text-[10px] font-semibold text-[var(--text-secondary)]">Escolha a equipe cujos recursos colaborativos este usuário poderá acessar.</span><select aria-label="Equipe do usuário selecionado" value={selectedUser.teamOwnerId || ""} onChange={(event) => void patchUser(selectedUser.id, { teamOwnerId: event.target.value || null }, "Vínculo de equipe atualizado.")} disabled={!canEditSelected || saving === selectedUser.id} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[11px] font-medium outline-none disabled:opacity-50"><option value="">{selectedUser.role === "owner" ? "Equipe própria" : "Sem equipe"}</option>{teams.filter((team) => team.id !== selectedUser.id).map((team) => <option key={team.id} value={team.id}>{team.name} · principal: {team.ownerName} · {team.memberCount} membro(s)</option>)}</select></label>
      <div className="mt-4 grid gap-2 sm:grid-cols-2"><InfoTile label="Último acesso" value={formatDate(selectedUser.lastLoginAt)}/><InfoTile label="Cadastro" value={formatDate(selectedUser.createdAt)}/></div>
      </>}
      {userDrawerTab === "acesso" && <>
      <div className={`mt-4 rounded-lg border p-3 ${selectedUser.systemAdmin ? "border-[var(--primary)]/30 bg-[var(--primary)]/10" : "border-[var(--border)] bg-[var(--background)]"}`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--primary)]/16 text-[var(--primary)]"><ShieldCheck size={18} /></span><span><strong className="block text-xs">{selectedUser.systemAdminRole === "owner" ? "Proprietário do sistema" : selectedUser.systemAdminRole === "assistant" ? "Administrador auxiliar" : "Acesso administrativo opcional"}</strong><small className="mt-1 block max-w-2xl text-[10px] font-semibold leading-5 text-[var(--text-secondary)]">{selectedUser.systemAdminRole === "owner" ? "Conta principal protegida. Administradores auxiliares não podem alterá-la." : selectedUser.systemAdminRole === "assistant" ? "Possui todos os recursos administrativos, exceto alterar a conta do proprietário." : "Torne este usuário administrador auxiliar para liberar o painel ADMIN e a administração global."}</small></span></div>{!selectedIsPrimaryOwner && <Button size="sm" variant={selectedUser.systemAdminRole === "assistant" ? "danger" : "primary"} disabled={!canEditSelected || saving === selectedUser.id} onClick={() => void patchUser(selectedUser.id, { systemAdmin: selectedUser.systemAdminRole !== "assistant" }, selectedUser.systemAdminRole === "assistant" ? "Acesso de admin auxiliar removido." : "Administrador auxiliar definido.")}><ShieldCheck size={14} />{selectedUser.systemAdminRole === "assistant" ? "Remover admin auxiliar" : "Tornar admin auxiliar"}</Button>}</div>
      </div>
      <PermissionEditor permissions={selectedPermissions} onToggle={(key) => toggleUserPermission(selectedUser, key)} onToggleAll={toggleAllUserPermissions} disabled={!canEditSelected || saving === selectedUser.id || selectedUser.systemAdmin} />
      </>}
      {userDrawerTab === "historico" && <AuditTimeline items={audit.filter(item=>item.targetId===selectedUser.id || item.actorId===selectedUser.id)}/>}
    </section>
  );

  const planCards = (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {plans.filter(plan=>matchesAdminSearch(query,plan.name,plan.description,plan.code)).map((plan) => <article key={plan.code} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-black/10"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{plan.name}</h3><span className="rounded-full bg-[var(--primary)]/12 px-2 py-1 text-[9px] font-semibold text-[var(--primary)]">{overview?.planCounts?.[plan.code] || 0} usuários</span></div><p className="mt-3 min-h-12 text-[10px] font-semibold leading-5 text-[var(--text-secondary)]">{plan.description}</p><p className="mt-3 text-xs text-[var(--text-secondary)]">{plan.teamSeats} assento(s)</p><ul className="mt-3 space-y-1 text-xs text-[var(--text-secondary)]">{plan.features.map(feature=><li key={feature}>{feature}</li>)}</ul><p className="mt-3 text-xl font-semibold">{new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(plan.monthlyPrice)}<span className="text-[10px] text-[var(--text-secondary)]">/mês</span></p>{activeSection === "plans" && <button type="button" disabled={!canEditSelected} onClick={() => void patchUser(selectedUser.id, { plan: plan.code }, `Plano ${plan.name} aplicado.`)} className="mt-3 text-[10px] font-semibold text-[var(--primary)] disabled:opacity-50">Aplicar a {selectedUser.nome.split(" ")[0]} →</button>}</article>)}
    </div>
  );

  return (
    <AdminSearchContext value={query}>
    <main className="norium-admin-shell nxa nxa-shell">
      <aside className="nxa-sidebar"><AdminSidebar groups={groups} active={activeArea === "finance" ? "finance" : activeSection} onNavigate={navigate} onUseSystem={onUseSystem} onSettings={()=>navigate('settings')}/></aside>
      <div className="nxa-main">
        <AdminTopbar group={location?.group||''} title={location?.label||'Configurações'} user={session.user} query={query} onQuery={value=>{setQuery(value);setUserPage(1);}} onMenu={()=>setMobileNavigationOpen(true)} onRefresh={()=>void refresh()} onAlerts={()=>setAlertsOpen(true)} onNora={()=>setEmailComposerOpen(true)} alertCount={alerts.length} loading={loading} health={monitoring?.status||null}/>
        <div className="nxa-content">
        {activeArea === "finance" ? <AdminFinanceDashboard session={session}/> : <div>
          {(notice||error)&&<div role={error?'alert':'status'} className={`nx-card mb-4 p-4 ${error?'text-[var(--nx-danger)]':'text-[var(--nx-success)]'}`}>{error||notice}</div>}
          {loading&&<p role="status" className="mb-4 text-[var(--nx-text-2)]">Atualizando dados do painel…</p>}
          {(activeSection==='overview'||activeSection==='users')&&<>
            <header className="nxa-page-heading"><div><h1>{activeSection==='overview'?'Gerenciamento do sistema':'Usuários'}</h1><p>{activeSection==='overview'?new Intl.DateTimeFormat('pt-BR',{dateStyle:'full',timeZone:'America/Sao_Paulo'}).format(new Date()):`${users.length} usuários · ${users.filter(user=>user.status==='ativo').length} ativos`}</p></div><div className="nxa-page-actions">{activeSection==='overview'&&<Button onClick={()=>void downloadBackup()} disabled={saving==='backup'}><Archive size={16}/>Exportar snapshot</Button>}<Button variant="primary" onClick={()=>setCreateOpen(true)}><UserPlus size={16}/>Novo usuário</Button></div></header>
            <div className="nxa-metrics">{stats.map(stat=>{const Icon=stat.icon;return <article key={stat.label} className="nxa-metric"><span className="nxa-metric-label"><Icon size={16}/>{stat.label}</span><strong>{stat.value}</strong><small>{stat.label==='Admins'?'Hierarquia protegida':'No sistema'}</small></article>})}</div>
            {activeSection==='users'&&<div className="nxa-filter-row"><input aria-label="Buscar usuários" placeholder="Buscar nome ou e-mail" value={query} onChange={event=>{setQuery(event.target.value);setUserPage(1);}}/><select aria-label="Filtrar plano" value={userPlanFilter} onChange={event=>{setUserPlanFilter(event.target.value);setUserPage(1);}}><option value="">Todos os planos</option>{plans.map(plan=><option key={plan.code} value={plan.code}>{plan.name}</option>)}</select><select aria-label="Filtrar status" value={userStatusFilter} onChange={event=>{setUserStatusFilter(event.target.value);setUserPage(1);}}><option value="">Todos os status</option><option value="ativo">Ativos</option><option value="inativo">Inativos</option></select><select aria-label="Filtrar perfil" value={userRoleFilter} onChange={event=>{setUserRoleFilter(event.target.value);setUserPage(1);}}><option value="">Todos os perfis</option>{Array.from(new Set(users.map(adminLabel))).map(role=><option key={role}>{role}</option>)}</select><select aria-label="Filtrar equipe" value={userTeamFilter} onChange={event=>{setUserTeamFilter(event.target.value);setUserPage(1);}}><option value="">Todas as equipes</option>{teams.map(team=><option key={team.id} value={team.id}>{team.name}</option>)}</select></div>}
            {activeSection==='overview'&&<div className="nxa-overview-grid"><section className="nxa-card"><div className="nxa-card-heading"><h2>Receita e custo de IA</h2></div><div className="nxa-chart-empty"><Activity size={24}/><strong>Sem série histórica neste resumo</strong><p>Consulte o Financeiro e os Custos de IA para os valores disponíveis.</p><div className="flex flex-wrap justify-center gap-2"><Button size="sm" onClick={()=>navigate('finance')}>Abrir financeiro</Button><Button size="sm" onClick={()=>navigate('ai-costs')}>Custos de IA</Button></div></div></section><section className="nxa-card"><div className="nxa-card-heading"><h2>Precisa da sua atenção</h2></div><div className="nxa-card-body">{monitoring&&!monitoring.gmailConfigured&&<p className="nx-row">Gmail global ainda não configurado.</p>}{monitoring&&!monitoring.googleCalendarConfigured&&<p className="nx-row">Google Agenda global ainda não configurado.</p>}<SystemLogTimeline items={alerts.slice(0,3)}/></div></section></div>}
            {userList}
            {activeSection==='overview'&&<div className="nxa-grid-three mt-5"><section className="nxa-card"><div className="nxa-card-heading"><h2>Planos</h2></div><div className="nxa-card-body">{plans.map(plan=><div className="nx-row" key={plan.code}><span>{plan.name}</span><strong className="ml-auto">{overview?.planCounts?.[plan.code]||0} usuários</strong></div>)}<button type="button" className="nx-btn is-ghost is-sm" onClick={()=>navigate('plans')}>Ver planos</button></div></section><section className="nxa-card"><div className="nxa-card-heading"><h2>Integrações</h2></div><div className="nxa-card-body"><div className="nx-row"><span>Gmail</span><span className={`nx-badge ml-auto ${monitoring?.gmailConfigured?'is-green':'is-amber'}`}>{monitoring?.gmailConfigured?'Configurado':'Não configurado'}</span></div><div className="nx-row"><span>Google Agenda</span><span className={`nx-badge ml-auto ${monitoring?.googleCalendarConfigured?'is-green':'is-amber'}`}>{monitoring?.googleCalendarConfigured?'Configurado':'Não configurado'}</span></div><button type="button" className="nx-btn is-ghost is-sm" onClick={()=>navigate('integrations')}>Ver integrações</button></div></section><section className="nxa-card"><div className="nxa-card-heading"><h2>Atividade administrativa</h2></div><div className="nxa-card-body"><AuditTimeline items={audit.slice(0,3)}/></div></section></div>}
          </>}
          {(activeSection==='emails'||activeSection==='system-emails')&&<><header className="nxa-page-heading"><div><h1>{activeSection==='system-emails'?'E-mails do sistema':'E-mails'}</h1><p>Remetente, acompanhamento e comunicação administrativa.</p></div><Button variant="primary" onClick={()=>setEmailComposerOpen(true)}><Mail size={16}/>Escrever e-mail</Button></header><SystemEmailSettings token={session.token}/></>}
          {(activeSection==='ai-costs'||activeSection==='ai-tariffs')&&<AiCostsDashboard key={activeSection} token={session.token} actor={session.user} users={users} initialView={activeSection==='ai-tariffs'?'models':'users'}/>}
            {activeSection === "plans" && <AdminSectionFrame eyebrow="Gerenciar" title="Planos" description={`Aplique um plano diretamente ao usuário selecionado: ${selectedUser.nome}.`} icon={ListChecks}><UserSelector users={users} value={selectedUser.id} onChange={setSelectedUserId}/>{selectedIsProtectedOwner&&<ProtectedOwnerNotice/>}{planCards}{!plans.filter(plan=>matchesAdminSearch(query,plan.name,plan.description,plan.code)).length&&<EmptyState title="Nenhum plano neste filtro" description="Altere a busca para ver os planos disponíveis."/>}<Button className="mt-4" onClick={()=>navigate("finance")}>Administrar planos comerciais no financeiro</Button></AdminSectionFrame>}
            {activeSection === "teams" && <AdminSectionFrame eyebrow="Contas" title="Equipes" description="Empresas, usuários principais e quantidade de membros vinculados." icon={Building2}><div className="nxa-card nxa-table-scroll"><table className="nxa-table"><thead><tr><th>Equipe</th><th>Proprietário</th><th>Plano</th><th>Membros</th><th>Assentos do plano</th><th>Ações</th></tr></thead><tbody>{teams.filter(team=>matchesAdminSearch(query,team.name,team.ownerName)).map(team=>{const owner=users.find(user=>user.id===team.ownerUserId);const plan=plans.find(item=>item.code===owner?.plan);return <tr key={team.id}><td><button type="button" onClick={()=>setSelectedTeamId(team.id)}>{team.name}</button></td><td>{team.ownerName||'Não definido'}</td><td>{plan?.name||'Não informado'}</td><td>{team.memberCount}</td><td>{plan?.teamSeats??'Não informado'}</td><td><button type="button" className="nx-btn is-ghost is-sm" onClick={()=>{openUser(team.ownerUserId);setActiveSection('users');}}>Abrir usuário principal →</button></td></tr>})}</tbody></table>{!teams.filter(team=>matchesAdminSearch(query,team.name,team.ownerName)).length&&<EmptyState title="Nenhuma equipe cadastrada" description="Equipes são criadas automaticamente para contas principais."/>}</div></AdminSectionFrame>}
            {activeSection === "permissions" && <AdminSectionFrame eyebrow="Gerenciar" title="Permissões" description="Controle granular das telas, IA, equipe e integrações por usuário." icon={ShieldCheck}><UserSelector users={users} value={selectedUser.id} onChange={setSelectedUserId} />{selectedIsProtectedOwner && <ProtectedOwnerNotice />}<PermissionEditor permissions={selectedPermissions} onToggle={(key) => toggleUserPermission(selectedUser, key)} onToggleAll={toggleAllUserPermissions} disabled={!canEditSelected || selectedUser.systemAdmin || saving === selectedUser.id} /></AdminSectionFrame>}
            {activeSection === "integrations" && <AdminSectionFrame eyebrow="Gerenciar" title="Integrações" description="Libere os conectores externos que cada usuário pode utilizar." icon={Link2}><div className="nxa-grid-three mb-5">{integrationKeys.map(key=><article key={key} className="nxa-card"><div className="nxa-card-heading"><Link2 size={16}/><h3>{permissionLabels[key]}</h3></div><div className="nxa-card-body"><span className={`nx-badge ${selectedPermissions[key]?"is-green":"is-amber"}`}>{selectedPermissions[key]?"Permitido para o usuário":"Não permitido para o usuário"}</span><p className="mt-3 text-xs text-[var(--text-secondary)]">{key==="integracao_gmail"?`OAuth global: ${monitoring?.gmailConfigured?"configurado":"não configurado"}`:key==="integracao_agenda"?`OAuth global: ${monitoring?.googleCalendarConfigured?"configurado":"não configurado"}`:"Disponibilidade do provedor não incluída neste resumo."}</p><button className="nx-btn is-ghost is-sm mt-3" type="button" onClick={()=>setIntegrationDetail(key)}>Ver detalhe</button></div></article>)}</div><UserSelector users={users} value={selectedUser.id} onChange={setSelectedUserId} />{selectedIsProtectedOwner && <ProtectedOwnerNotice />}<PermissionEditor keys={integrationKeys} permissions={selectedPermissions} onToggle={(key) => toggleUserPermission(selectedUser, key)} onToggleAll={toggleAllUserPermissions} disabled={!canEditSelected || selectedUser.systemAdmin || saving === selectedUser.id} /></AdminSectionFrame>}
            {activeSection === "settings" && <AdminSectionFrame eyebrow="Sistema" title="Configurações administrativas" description="Identidade visual, atualização de dados e acesso rápido ao sistema operacional." icon={Settings2}><div className="grid gap-3 md:grid-cols-2"><section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><ShieldCheck size={19} className="text-[var(--primary)]" /><h3 className="mt-3 text-sm font-semibold">Hierarquia protegida</h3><p className="mt-2 text-xs font-semibold leading-6 text-[var(--text-secondary)]">O proprietário pode definir administradores auxiliares. Eles recebem acesso global, mas a API impede qualquer alteração na conta do proprietário.</p></section><section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><Settings2 size={19} className="text-[var(--primary)]" /><h3 className="mt-3 text-sm font-semibold">Ações do painel</h3><div className="mt-4 flex flex-wrap gap-2"><LocalThemeToggle storageKey="norium-admin-theme" label="tema do admin" /><Button size="sm" onClick={() => void refresh()}><RefreshCw size={14} /> Atualizar</Button><Button size="sm" variant="primary" onClick={onUseSystem}><LayoutDashboard size={14} /> Usar sistema</Button></div></section></div></AdminSectionFrame>}
            {activeSection === "logs" && <AdminSectionFrame eyebrow="Sistema" title="Logs do sistema" description="Requisições, falhas e tempos de resposta armazenados sem corpos, senhas, cookies ou tokens." icon={FileClock}><AdminActivityTable logs={systemLogs.filter(item=>matchesAdminSearch(query,item))} /></AdminSectionFrame>}
            {activeSection === "audit" && <AdminSectionFrame eyebrow="Sistema" title="Auditoria administrativa" description="Registro das criações, alterações de plano, permissões, status e administradores auxiliares." icon={ListChecks}><AdminActivityTable audit={audit.filter(item=>matchesAdminSearch(query,item))} /></AdminSectionFrame>}
            {activeSection === "monitoring" && <AdminSectionFrame eyebrow="Sistema" title="Monitoramento" description="Estado atual do cadastro central, contas administrativas e OAuth Google." icon={MonitorCheck}><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><MonitorCard label="Sistema" value={monitoring?.status === "operational" ? "Operacional" : monitoring?.status || "Carregando"} healthy={monitoring?.status === "operational"} /><MonitorCard label="Banco de usuários" value={monitoring?.userStore === "online" ? "Online" : monitoring?.userStore || "Carregando"} healthy={monitoring?.userStore === "online"} /><MonitorCard label="Usuários ativos" value={String(monitoring?.activeUsers ?? overview?.activeUsers ?? 0)} healthy /><MonitorCard label="Admins" value={String(monitoring?.adminUsers ?? overview?.adminUsers ?? 0)} healthy /><MonitorCard label="OAuth Gmail" value={monitoring?.gmailConfigured ? "Configurado" : "Não configurado"} healthy={Boolean(monitoring?.gmailConfigured)} /><MonitorCard label="OAuth Google Agenda" value={monitoring?.googleCalendarConfigured ? "Configurado" : "Não configurado"} healthy={Boolean(monitoring?.googleCalendarConfigured)} /></div>{monitoring && <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-[10px] font-semibold text-[var(--text-secondary)]"><p>Callback Gmail: <code className="text-[var(--text)]">{monitoring.gmailRedirectUri || "não definido"}</code></p><p className="mt-1">Callback Google Agenda: <code className="text-[var(--text)]">{monitoring.googleRedirectUri || "não definido"}</code></p></div>}<p className="mt-4 text-[10px] font-semibold text-[var(--text-secondary)]">Última verificação: {formatDate(monitoring?.checkedAt)}</p></AdminSectionFrame>}
            {activeSection === "backup" && <AdminSectionFrame eyebrow="Sistema" title="Backup administrativo" description="Exporte usuários, equipes, planos e auditoria. Senhas e segredos nunca entram no arquivo." icon={Archive}><section className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--background)] p-5 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-sm font-semibold">Snapshot seguro do painel</h3><p className="mt-2 max-w-2xl text-xs font-semibold leading-6 text-[var(--text-secondary)]">O arquivo JSON é gerado sob demanda e contém somente dados administrativos sanitizados.</p></div><Button variant="primary" onClick={() => void downloadBackup()} disabled={saving === "backup"}><Archive size={15} /> {saving === "backup" ? "Gerando..." : "Gerar backup"}</Button></section></AdminSectionFrame>}

        </div>}
        </div>
      </div>
      <AdminOverlay open={mobileNavigationOpen} variant="drawer" width={288} title="Navegação administrativa" onClose={()=>setMobileNavigationOpen(false)}><div className="nxa-mobile-nav"><AdminSidebar groups={groups} active={activeArea === 'finance'?'finance':activeSection} onNavigate={navigate} onUseSystem={onUseSystem} onSettings={()=>navigate('settings')}/></div></AdminOverlay>
      <AdminOverlay open={userDrawerOpen} variant="drawer" title="Ficha do usuário" subtitle={selectedUser.email} onClose={()=>setUserDrawerOpen(false)} width={600}>{selectedUserPanel}</AdminOverlay>
      <AdminOverlay open={Boolean(openedTeam)} variant="drawer" title={openedTeam?.name||'Equipe'} onClose={()=>setSelectedTeamId('')} width={560}>{openedTeam&&<><InfoTile label="Proprietário" value={openedTeam.ownerName}/><InfoTile label="Membros" value={String(openedTeam.memberCount)}/><InfoTile label="Criada em" value={formatDate(openedTeam.createdAt)}/><div className="nxa-card nxa-table-scroll mt-5"><table className="nxa-table"><thead><tr><th>Membro</th><th>Perfil</th><th>Status</th></tr></thead><tbody>{users.filter(user=>(user.teamOwnerId||user.id)===openedTeam.id).map(user=><tr key={user.id}><td><button type="button" className="nxa-person-button" onClick={()=>{setSelectedTeamId('');openUser(user.id);}}><AvatarImage src={user.fotoUrl} userId={user.id} name={user.nome} className="nx-av"/>{user.nome}</button></td><td>{adminLabel(user)}</td><td>{user.status==='ativo'?'Ativo':'Inativo'}</td></tr>)}</tbody></table></div><Button className="mt-4" onClick={()=>{setSelectedTeamId('');openUser(openedTeam.ownerUserId);setActiveSection('users');}}>Abrir usuário principal →</Button></>}</AdminOverlay>
      <AdminOverlay open={Boolean(integrationDetail)} title={integrationDetail?permissionLabels[integrationDetail]:"Integração"} variant="drawer" width={600} onClose={()=>setIntegrationDetail(null)}>{integrationDetail&&<><InfoTile label="Usuário selecionado" value={selectedUser.nome}/><InfoTile label="Permissão do usuário" value={selectedPermissions[integrationDetail]?"Permitida":"Não permitida"}/><p className="my-4 text-sm text-[var(--text-secondary)]">Uso e latência por conector não estão disponíveis neste resumo. As permissões continuam na tela de integrações.</p><h3>Eventos disponíveis</h3><SystemLogTimeline items={systemLogs.filter(item=>matchesAdminSearch(integrationDetail.replace("integracao_",""),item.event,item.message))}/></>}</AdminOverlay>
      <AdminOverlay open={alertsOpen} title="Avisos do sistema" onClose={()=>setAlertsOpen(false)}><InfoTile label="Situação do sistema" value={monitoring?.status==='operational'?'Sistema operacional':monitoring?.status||'Monitoramento não disponível'}/><SystemLogTimeline items={alerts}/><Button className="mt-4" onClick={()=>{setAlertsOpen(false);navigate('monitoring');}}>Abrir monitoramento</Button></AdminOverlay>
      <AdminOverlay open={emailComposerOpen} title="Escrever e-mail" subtitle="Nora, contexto, tom e assinatura existentes" onClose={()=>setEmailComposerOpen(false)} width={880}><ManualEmailSender token={session.token}/></AdminOverlay>
      <AdminOverlay open={createOpen} title="Novo usuário" subtitle="Crie uma conta manual com plano, equipe e permissões." onClose={()=>setCreateOpen(false)} footer={<><Button onClick={() => setCreateOpen(false)}>Cancelar</Button><Button variant="primary" onClick={() => void createUser()} disabled={saving === "create"}>{saving === "create" ? "Criando..." : "Criar usuário"}</Button></>}><div className="mt-5 grid gap-3 sm:grid-cols-2"><input aria-label="Nome do novo usuário" value={createForm.nome} onChange={(event) => setCreateForm({ ...createForm, nome: event.target.value })} placeholder="Nome" className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-medium outline-none" /><input aria-label="E-mail do novo usuário" value={createForm.email} onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })} placeholder="E-mail" className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-medium outline-none" /><input aria-label="Senha inicial do novo usuário" type="password" value={createForm.password} onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })} placeholder="Senha inicial (mínimo 10 caracteres)" className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-medium outline-none" /><select aria-label="Plano do novo usuário" value={createForm.plan} onChange={(event) => setCreateForm({ ...createForm, plan: event.target.value as UserPlan })} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-medium outline-none">{plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}</select><label className="grid gap-1 sm:col-span-2"><span className="text-[10px] font-medium text-[var(--text-secondary)]">Vincular à empresa/equipe</span><select value={createForm.teamOwnerId} onChange={(event) => setCreateForm({ ...createForm, teamOwnerId: event.target.value })} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-medium outline-none"><option value="">Sem equipe</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name} · principal: {team.ownerName}</option>)}</select></label></div><PermissionEditor permissions={createForm.permissions} onToggle={toggleCreatePermission} /></AdminOverlay>
    </main>
    </AdminSearchContext>
  );
}

function UserBadge({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return <span className={`rounded-full px-2 py-0.5 text-[8px] font-semibold uppercase ${accent ? "bg-cyan-500/15 text-cyan-300" : "bg-[var(--surface-hover)] text-[var(--text-secondary)]"}`}>{children}</span>;
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><p className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{label}</p><p className="mt-2 truncate text-xs font-semibold capitalize">{value}</p></div>;
}

function AdminSectionFrame({ eyebrow, title, description, icon: Icon, children }: { eyebrow: string; title: string; description: string; icon: LucideIcon; children: ReactNode }) {
  return <section className="nxa-section-frame"><header className="mb-5 flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--primary)]/15 text-[var(--primary)]"><Icon size={18} /></span><div><p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--primary)]">{eyebrow}</p><h2 className="text-base font-semibold">{title}</h2><p className="mt-1 text-[10px] font-semibold text-[var(--text-secondary)]">{description}</p></div></header>{children}</section>;
}

function UserSelector({ users, value, onChange }: { users: NoriumUser[]; value: string; onChange: (value: string) => void }) {
  return <label className="mb-4 grid gap-1"><span className="text-[10px] font-semibold text-[var(--text-secondary)]">Usuário</span><select aria-label="Selecionar usuário" value={value} onChange={(event) => onChange(event.target.value)} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-medium outline-none">{users.map((user) => <option key={user.id} value={user.id}>{user.nome} · {user.email}</option>)}</select></label>;
}

function ProtectedOwnerNotice() {
  return <div role="alert" className="mb-4 mt-4 flex items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 p-3 text-xs font-semibold text-amber-200"><LockKeyhole size={16} /> A conta do proprietário está protegida contra alterações feitas por administradores auxiliares.</div>;
}

function PermissionEditor({ permissions, onToggle, onToggleAll, disabled = false, keys }: { permissions: PermissionMap; onToggle: (key: PermissionKey) => void; onToggleAll?: (keys: PermissionKey[]) => void; disabled?: boolean; keys?: PermissionKey[] }) {
  const groups = keys ? [{ title: "Integrações", keys }] : permissionGroups;
  const visibleKeys = groups.flatMap((group) => group.keys);
  const allSelected = visibleKeys.every((key) => permissions[key]);
  return <section className="nxa-card mt-4"><div className="nxa-card-heading"><SlidersHorizontal size={16}/><div><h3>Módulos e permissões</h3><p className="text-xs text-[var(--text-secondary)]">Defina quais recursos o usuário pode acessar.</p></div>{onToggleAll&&<button type="button" disabled={disabled} onClick={()=>onToggleAll(visibleKeys)} className="nx-btn is-sm ml-auto"><CheckCircle2 size={16}/>{allSelected?'Limpar seleção':'Selecionar todos'}</button>}</div><div className="nxa-table-scroll"><table className="nxa-table nxa-permissions-table"><thead><tr><th>Grupo</th><th>Permissão</th><th>Acesso do usuário selecionado</th></tr></thead><tbody>{groups.flatMap(group=>group.keys.map(key=><tr key={key}><td>{group.title}</td><td><label htmlFor={`permission-${key}`}>{permissionLabels[key]}</label></td><td><input id={`permission-${key}`} type="checkbox" checked={Boolean(permissions[key])} disabled={disabled} onChange={()=>onToggle(key)} className="nxa-switch"/></td></tr>))}</tbody></table></div></section>;
}

function AuditTimeline({ items }: { items: AdminAuditItem[] }) {
  if (!items.length) return <EmptyState title="Nenhuma ação administrativa registrada" description="As próximas alterações de usuários aparecerão aqui." />;
  return <div className="space-y-2">{items.map((item) => <article key={item.id} className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--primary)]/12 text-[var(--primary)]"><FileClock size={14} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-[10px]">{item.actorName} · {item.action.replaceAll("_", " ")}</strong><time className="text-[9px] font-semibold text-[var(--text-secondary)]">{formatDate(item.createdAt)}</time></div><p className="mt-1 text-[10px] font-semibold text-[var(--text-secondary)]">{item.detail}{item.targetName ? ` Alvo: ${item.targetName}.` : ""}</p></div></article>)}</div>;
}

function SystemLogTimeline({ items }: { items: SystemLogItem[] }) {
  if (!items.length) return <EmptyState title="Nenhum log registrado" description="As próximas requisições e falhas aparecerão aqui." />;
  return <div className="space-y-2">{items.map((item) => <article key={item.id} className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${item.level === "error" ? "bg-rose-400" : item.level === "warning" ? "bg-amber-400" : "bg-emerald-400"}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-[10px]">{item.message || item.event}</strong><time className="text-[9px] font-semibold text-[var(--text-secondary)]">{formatDate(item.createdAt)}</time></div><p className="mt-1 break-all text-[9px] font-semibold text-[var(--text-secondary)]">Usuário: {item.userId} · Workspace: {item.workspaceId}{item.metadata?.durationMs != null ? ` · ${Math.round(item.metadata.durationMs)} ms` : ""}{item.metadata?.requestId ? ` · ${item.metadata.requestId}` : ""}</p></div></article>)}</div>;
}

function MonitorCard({ label, value, healthy }: { label: string; value: string; healthy: boolean }) {
  return <article className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><MonitorCheck size={18} className={healthy ? "text-emerald-400" : "text-amber-400"} /><p className="mt-3 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></article>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)] p-5 text-center"><Crown size={18} className="mx-auto text-[var(--primary)]" /><h3 className="mt-2 text-xs font-semibold">{title}</h3><p className="mt-1 text-[10px] font-semibold text-[var(--text-secondary)]">{description}</p></div>;
}
