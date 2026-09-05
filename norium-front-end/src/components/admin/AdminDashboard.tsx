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
  Menu,
  MonitorCheck,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
  UserPlus,
  UsersRound,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AuthSession, NoriumTeam, NoriumUser, PermissionKey, PermissionMap, PlanInfo, UserPlan } from "../../types/auth";
import { defaultMemberPermissions, permissionGroups, permissionLabels } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import BrandLogo from "../layout/BrandLogo";
import LocalThemeToggle from "../layout/LocalThemeToggle";
import { showConfirm } from "../shared/AppDialogProvider";
import Button from "../shared/Button";
import AdminFinanceDashboard from "./finance/AdminFinanceDashboard";
import SystemEmailSettings from "./SystemEmailSettings";

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

type AdminSection = "overview" | "users" | "plans" | "teams" | "permissions" | "integrations" | "settings" | "logs" | "monitoring" | "backup" | "audit";

const managementNavigation: Array<{ id: AdminSection; label: string; icon: LucideIcon }> = [
  { id: "users", label: "Usuários", icon: UsersRound },
  { id: "plans", label: "Planos", icon: ListChecks },
  { id: "teams", label: "Equipes", icon: Building2 },
  { id: "permissions", label: "Permissões", icon: ShieldCheck },
  { id: "integrations", label: "Integrações", icon: Link2 },
  { id: "settings", label: "Configurações", icon: Settings2 },
];

const systemNavigation: Array<{ id: AdminSection; label: string; icon: LucideIcon }> = [
  { id: "logs", label: "Logs do sistema", icon: FileClock },
  { id: "monitoring", label: "Monitoramento", icon: Gauge },
  { id: "backup", label: "Backup", icon: Archive },
  { id: "audit", label: "Auditoria", icon: ListChecks },
];

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
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(parsed);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] || "N"}${parts[1]?.[0] || ""}`;
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
  const [monitoring, setMonitoring] = useState<AdminMonitoring | null>(null);
  const [selectedUserId, setSelectedUserId] = useState(session.user.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [activeArea, setActiveArea] = useState<"users" | "finance">("users");
  const [activeSection, setActiveSection] = useState<AdminSection>("overview");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  const selectedUser = useMemo(() => users.find((user) => user.id === selectedUserId) || users[0] || session.user, [selectedUserId, session.user, users]);
  const recentUsers = useMemo(() => users.slice(0, 6), [users]);
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
      ]);
      const [overviewResult, usersResult, plansResult, teamsResult, auditResult, monitoringResult] = results;
      if (overviewResult.status === "fulfilled") setOverview(overviewResult.value);
      if (plansResult.status === "fulfilled") setPlans(plansResult.value.plans);
      if (teamsResult.status === "fulfilled") setTeams(teamsResult.value.teams);
      if (auditResult.status === "fulfilled") setAudit(auditResult.value.items);
      if (monitoringResult.status === "fulfilled") setMonitoring(monitoringResult.value);
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
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-black/10">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><h2 className="text-sm font-black">{activeSection === "overview" ? "Usuários recentes" : "Todos os usuários"}</h2><p className="mt-1 text-[11px] font-semibold text-[var(--text-secondary)]">{activeSection === "overview" ? "Últimos usuários cadastrados" : `${users.length} conta(s) visíveis no sistema`}</p></div>
        <button type="button" onClick={() => setCreateOpen(true)} className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--primary)] text-white shadow-lg shadow-blue-950/30" aria-label="Criar novo usuário" title="Criar novo usuário"><UserPlus size={17} /></button>
      </div>
      <div className="space-y-2">
        {(activeSection === "overview" ? recentUsers : users).map((user) => (
          <button key={user.id} type="button" onClick={() => setSelectedUserId(user.id)} className={`w-full rounded-lg border p-3 text-left transition ${selectedUser.id === user.id ? "border-[var(--primary)]/55 bg-[var(--primary)]/10" : "border-[var(--border)] bg-[var(--background)] hover:bg-[var(--surface-hover)]"}`}>
            <span className="flex items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--primary)]/20 text-xs font-black text-[var(--primary)]">{initials(user.nome).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><strong className="truncate text-xs">{user.nome}</strong><span className={`rounded-full px-2 py-0.5 text-[9px] font-black ${user.status === "ativo" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{user.status === "ativo" ? "Ativo" : "Inativo"}</span></span><small className="mt-0.5 block truncate text-[10px] font-semibold text-[var(--text-secondary)]">{user.email}</small><span className="mt-2 flex flex-wrap gap-1"><UserBadge>{user.plan}</UserBadge><UserBadge>{adminLabel(user)}</UserBadge>{user.systemAdmin && <UserBadge accent>{user.systemAdminRole === "owner" ? "Owner" : "Admin"}</UserBadge>}</span></span></span>
          </button>
        ))}
        {!users.length && !loading && <EmptyState title="Nenhum usuário encontrado" description="Novos cadastros aparecerão aqui automaticamente." />}
      </div>
      {activeSection === "overview" && users.length > recentUsers.length && <button type="button" onClick={() => openSection("users")} className="mt-3 w-full rounded-lg border border-[var(--primary)]/25 bg-[var(--primary)]/8 py-2 text-[11px] font-black text-[var(--primary)]">Ver todos os usuários →</button>}
    </section>
  );

  const selectedUserPanel = (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-black/10 lg:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--primary)]/18 text-[var(--primary)]"><UserCog size={19} /></span><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Usuário selecionado</p><h2 className="truncate text-lg font-black">{selectedUser.nome}</h2><p className="truncate text-[11px] font-semibold text-[var(--text-secondary)]">{selectedUser.email}</p></div></div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Plano do usuário selecionado" value={selectedUser.plan} onChange={(event) => void patchUser(selectedUser.id, { plan: event.target.value }, "Plano atualizado.")} disabled={!canEditSelected || saving === selectedUser.id} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-[11px] font-bold outline-none disabled:opacity-50">{plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}</select>
          <Button size="sm" onClick={() => void patchUser(selectedUser.id, { status: selectedUser.status === "ativo" ? "inativo" : "ativo" }, "Status atualizado.")} disabled={!canEditSelected || selectedIsPrimaryOwner || saving === selectedUser.id} className="bg-[var(--background)]"><LockKeyhole size={14} /> {selectedUser.status === "ativo" ? "Bloquear" : "Ativar"}</Button>
          <Button size="sm" variant="danger" onClick={() => void deactivateUser(selectedUser.id)} disabled={!canEditSelected || selectedIsPrimaryOwner || saving === selectedUser.id} className="border-red-500/30 bg-red-500/10 text-red-400">Desativar</Button>
        </div>
      </div>
      {selectedIsProtectedOwner && <ProtectedOwnerNotice />}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><InfoTile label="Perfil" value={adminLabel(selectedUser)} /><InfoTile label="Plano" value={selectedUser.plan} /><InfoTile label="Sistema Admin" value={selectedUser.systemAdmin ? "Sim" : "Não"} /><InfoTile label="Equipe" value={selectedTeam?.name || "Sem equipe"} /></div>
      <label className="mt-4 grid gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><span className="flex items-center gap-2 text-xs font-black"><Building2 size={15} className="text-[var(--primary)]" /> Vínculo com empresa/equipe</span><span className="text-[10px] font-semibold text-[var(--text-secondary)]">Escolha a equipe cujos recursos colaborativos este usuário poderá acessar.</span><select aria-label="Equipe do usuário selecionado" value={selectedUser.teamOwnerId || ""} onChange={(event) => void patchUser(selectedUser.id, { teamOwnerId: event.target.value || null }, "Vínculo de equipe atualizado.")} disabled={!canEditSelected || saving === selectedUser.id} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[11px] font-bold outline-none disabled:opacity-50"><option value="">{selectedUser.role === "owner" ? "Equipe própria" : "Sem equipe"}</option>{teams.filter((team) => team.id !== selectedUser.id).map((team) => <option key={team.id} value={team.id}>{team.name} · principal: {team.ownerName} · {team.memberCount} membro(s)</option>)}</select></label>
      <div className={`mt-4 rounded-lg border p-3 ${selectedUser.systemAdmin ? "border-[var(--primary)]/30 bg-[var(--primary)]/10" : "border-[var(--border)] bg-[var(--background)]"}`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--primary)]/16 text-[var(--primary)]"><ShieldCheck size={18} /></span><span><strong className="block text-xs">{selectedUser.systemAdminRole === "owner" ? "Proprietário do sistema" : selectedUser.systemAdminRole === "assistant" ? "Administrador auxiliar" : "Acesso administrativo opcional"}</strong><small className="mt-1 block max-w-2xl text-[10px] font-semibold leading-5 text-[var(--text-secondary)]">{selectedUser.systemAdminRole === "owner" ? "Conta principal protegida. Administradores auxiliares não podem alterá-la." : selectedUser.systemAdminRole === "assistant" ? "Possui todos os recursos administrativos, exceto alterar a conta do proprietário." : "Torne este usuário administrador auxiliar para liberar o painel ADMIN e a administração global."}</small></span></div>{!selectedIsPrimaryOwner && <Button size="sm" variant={selectedUser.systemAdminRole === "assistant" ? "danger" : "primary"} disabled={!canEditSelected || saving === selectedUser.id} onClick={() => void patchUser(selectedUser.id, { systemAdmin: selectedUser.systemAdminRole !== "assistant" }, selectedUser.systemAdminRole === "assistant" ? "Acesso de admin auxiliar removido." : "Administrador auxiliar definido.")}><ShieldCheck size={14} />{selectedUser.systemAdminRole === "assistant" ? "Remover admin auxiliar" : "Tornar admin auxiliar"}</Button>}</div>
      </div>
      <PermissionEditor permissions={selectedPermissions} onToggle={(key) => toggleUserPermission(selectedUser, key)} onToggleAll={toggleAllUserPermissions} disabled={!canEditSelected || saving === selectedUser.id || selectedUser.systemAdmin} />
    </section>
  );

  const planCards = (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {plans.map((plan) => <article key={plan.code} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-black/10"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-black">{plan.name}</h3><span className="rounded-full bg-[var(--primary)]/12 px-2 py-1 text-[9px] font-black text-[var(--primary)]">{overview?.planCounts?.[plan.code] || 0} usuários</span></div><p className="mt-3 min-h-12 text-[10px] font-semibold leading-5 text-[var(--text-secondary)]">{plan.description}</p><p className="mt-3 text-xl font-black">R$ {plan.monthlyPrice}<span className="text-[10px] text-[var(--text-secondary)]">/mês</span></p>{activeSection === "plans" && <button type="button" disabled={!canEditSelected} onClick={() => void patchUser(selectedUser.id, { plan: plan.code }, `Plano ${plan.name} aplicado.`)} className="mt-3 text-[10px] font-black text-[var(--primary)] disabled:opacity-50">Aplicar a {selectedUser.nome.split(" ")[0]} →</button>}</article>)}
    </div>
  );

  return (
    <main className="norium-modern-shell norium-admin-shell flex h-dvh max-h-dvh overflow-hidden bg-[var(--background)] text-[var(--text)]">
      <aside className="hidden w-[210px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
        <div className="flex h-[74px] items-center border-b border-[var(--border)] px-5"><BrandLogo className="h-9 w-[112px] text-[var(--text)]" /></div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="Navegação administrativa"><AdminNavButton active={activeArea === "users" && activeSection === "overview"} label="Visão geral" icon={LayoutDashboard} onClick={() => openSection("overview")} /><p className="mb-2 mt-5 px-2 text-[9px] font-black uppercase tracking-[0.18em] text-[var(--text-secondary)]">Gerenciar</p>{managementNavigation.map((item) => <AdminNavButton key={item.id} active={activeArea === "users" && activeSection === item.id} {...item} onClick={() => openSection(item.id)} />)}<p className="mb-2 mt-5 px-2 text-[9px] font-black uppercase tracking-[0.18em] text-[var(--text-secondary)]">Sistema</p>{systemNavigation.map((item) => <AdminNavButton key={item.id} active={activeArea === "users" && activeSection === item.id} {...item} onClick={() => openSection(item.id)} />)}</nav>
        <div className="m-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><p className="text-[10px] font-black">Norium Admin</p><p className="mt-1 text-[9px] font-semibold text-[var(--text-secondary)]">Sistema operacional</p><p className="mt-2 flex items-center gap-1.5 text-[9px] font-bold text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online</p></div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-40 flex h-[74px] shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 shadow-lg shadow-black/10 sm:px-5">
          <div className="flex min-w-0 items-center gap-3"><button type="button" onClick={() => setMobileNavigationOpen(true)} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] lg:hidden" aria-label="Abrir navegação administrativa"><Menu size={18} /></button><div className="min-w-0"><p className="truncate text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--text-secondary)]">Norium Admin</p><h1 className="truncate text-sm font-black sm:text-base">Gerenciamento do sistema</h1></div></div>
          <div className="flex items-center gap-1.5"><button type="button" onClick={() => { setActiveArea("users"); setActiveSection("users"); }} className={`hidden h-9 items-center gap-2 rounded-lg border px-3 text-[10px] font-black sm:inline-flex ${activeArea === "users" ? "border-[var(--primary)] bg-[var(--primary)] text-white" : "border-[var(--border)] bg-[var(--background)]"}`}><UsersRound size={14} /> Usuários</button><button type="button" onClick={() => setActiveArea("finance")} className={`hidden h-9 items-center gap-2 rounded-lg border px-3 text-[10px] font-black sm:inline-flex ${activeArea === "finance" ? "border-[var(--primary)] bg-[var(--primary)] text-white" : "border-[var(--border)] bg-[var(--background)]"}`}><WalletCards size={14} /> Financeiro</button><LocalThemeToggle storageKey="norium-admin-theme" label="tema do admin" /><button type="button" onClick={() => void refresh()} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] bg-[var(--background)]" aria-label="Atualizar painel" title="Atualizar painel"><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button><button type="button" onClick={onUseSystem} className="hidden h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-[10px] font-black md:inline-flex"><LayoutDashboard size={14} /> Usar sistema</button><div className="ml-1 hidden items-center gap-2 border-l border-[var(--border)] pl-3 xl:flex"><span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--primary)]/20 text-[10px] font-black text-[var(--primary)]">{initials(session.user.nome).toUpperCase()}</span><span className="max-w-36"><strong className="block truncate text-[10px]">{session.user.nome}</strong><small className="block truncate text-[9px] font-semibold text-[var(--text-secondary)]">{adminLabel(session.user)}</small></span></div></div>
        </header>

        {mobileNavigationOpen && <div className="fixed inset-0 z-[100] bg-black/65 lg:hidden" onClick={() => setMobileNavigationOpen(false)}><aside className="flex h-full w-[280px] flex-col border-r border-[var(--border)] bg-[var(--surface)] p-3 shadow-2xl" onClick={(event) => event.stopPropagation()}><div className="mb-3 flex items-center justify-between border-b border-[var(--border)] px-2 pb-3"><BrandLogo className="h-9 w-[112px] text-[var(--text)]" /><button type="button" onClick={() => setMobileNavigationOpen(false)} aria-label="Fechar navegação"><X size={19} /></button></div><AdminNavButton active={activeSection === "overview"} label="Visão geral" icon={LayoutDashboard} onClick={() => openSection("overview")} />{managementNavigation.map((item) => <AdminNavButton key={item.id} active={activeSection === item.id} {...item} onClick={() => openSection(item.id)} />)}{systemNavigation.map((item) => <AdminNavButton key={item.id} active={activeSection === item.id} {...item} onClick={() => openSection(item.id)} />)}<button type="button" onClick={onUseSystem} className="mt-auto flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--primary)] text-xs font-black text-white"><LayoutDashboard size={15} /> Usar sistema</button></aside></div>}

        {activeArea === "finance" ? <AdminFinanceDashboard session={session} /> : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 lg:p-5"><div className="mx-auto max-w-[1440px] space-y-4">
            {activeSection === "settings" && <SystemEmailSettings token={session.token} />}
            {(notice || error) && <div role={error ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-xs font-bold ${error ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`}>{error || notice}</div>}
            {(activeSection === "overview" || activeSection === "users") && <><div className="grid gap-4 xl:grid-cols-[330px_minmax(0,1fr)]"><div className="space-y-4">{activeSection === "overview" && <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-black/10"><div className="mb-3"><h2 className="text-sm font-black">Resumo geral</h2><p className="mt-1 text-[10px] font-semibold text-[var(--text-secondary)]">Visão rápida do sistema</p></div><div className="grid grid-cols-2 gap-2">{stats.map((stat) => { const Icon = stat.icon; return <div key={stat.label} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><Icon size={16} className={stat.tone} /><p className="mt-3 text-lg font-black">{stat.value}</p><p className="text-[9px] font-bold text-[var(--text-secondary)]">{stat.label}</p></div>; })}</div></section>}{userList}</div>{selectedUserPanel}</div>{planCards}</>}
            {activeSection === "plans" && <AdminSectionFrame eyebrow="Gerenciar" title="Planos" description={`Aplique um plano diretamente ao usuário selecionado: ${selectedUser.nome}.`} icon={ListChecks}>{planCards}</AdminSectionFrame>}
            {activeSection === "teams" && <AdminSectionFrame eyebrow="Gerenciar" title="Equipes" description="Empresas, usuários principais e quantidade de membros vinculados." icon={Building2}><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{teams.map((team) => <article key={team.id} className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><Building2 size={18} className="text-[var(--primary)]" /><h3 className="mt-3 text-sm font-black">{team.name}</h3><p className="mt-1 text-[10px] font-semibold text-[var(--text-secondary)]">Principal: {team.ownerName || "Não definido"}</p><p className="mt-3 text-xs font-bold">{team.memberCount} membro(s)</p><button type="button" onClick={() => { setSelectedUserId(team.ownerUserId); setActiveSection("users"); }} className="mt-3 text-[10px] font-black text-[var(--primary)]">Abrir usuário principal →</button></article>)}{!teams.length && <EmptyState title="Nenhuma equipe cadastrada" description="Equipes são criadas automaticamente para contas principais." />}</div></AdminSectionFrame>}
            {activeSection === "permissions" && <AdminSectionFrame eyebrow="Gerenciar" title="Permissões" description="Controle granular das telas, IA, equipe e integrações por usuário." icon={ShieldCheck}><UserSelector users={users} value={selectedUser.id} onChange={setSelectedUserId} />{selectedIsProtectedOwner && <ProtectedOwnerNotice />}<PermissionEditor permissions={selectedPermissions} onToggle={(key) => toggleUserPermission(selectedUser, key)} onToggleAll={toggleAllUserPermissions} disabled={!canEditSelected || selectedUser.systemAdmin || saving === selectedUser.id} /></AdminSectionFrame>}
            {activeSection === "integrations" && <AdminSectionFrame eyebrow="Gerenciar" title="Integrações" description="Libere os conectores externos que cada usuário pode utilizar." icon={Link2}><UserSelector users={users} value={selectedUser.id} onChange={setSelectedUserId} />{selectedIsProtectedOwner && <ProtectedOwnerNotice />}<PermissionEditor keys={integrationKeys} permissions={selectedPermissions} onToggle={(key) => toggleUserPermission(selectedUser, key)} onToggleAll={toggleAllUserPermissions} disabled={!canEditSelected || selectedUser.systemAdmin || saving === selectedUser.id} /></AdminSectionFrame>}
            {activeSection === "settings" && <AdminSectionFrame eyebrow="Sistema" title="Configurações administrativas" description="Identidade visual, atualização de dados e acesso rápido ao sistema operacional." icon={Settings2}><div className="grid gap-3 md:grid-cols-2"><section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><ShieldCheck size={19} className="text-[var(--primary)]" /><h3 className="mt-3 text-sm font-black">Hierarquia protegida</h3><p className="mt-2 text-xs font-semibold leading-6 text-[var(--text-secondary)]">O proprietário pode definir administradores auxiliares. Eles recebem acesso global, mas a API impede qualquer alteração na conta do proprietário.</p></section><section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><Settings2 size={19} className="text-[var(--primary)]" /><h3 className="mt-3 text-sm font-black">Ações do painel</h3><div className="mt-4 flex flex-wrap gap-2"><LocalThemeToggle storageKey="norium-admin-theme" label="tema do admin" /><Button size="sm" onClick={() => void refresh()}><RefreshCw size={14} /> Atualizar</Button><Button size="sm" variant="primary" onClick={onUseSystem}><LayoutDashboard size={14} /> Usar sistema</Button></div></section></div></AdminSectionFrame>}
            {(activeSection === "logs" || activeSection === "audit") && <AdminSectionFrame eyebrow="Sistema" title={activeSection === "logs" ? "Logs do sistema" : "Auditoria administrativa"} description="Registro das criações, alterações de plano, permissões, status e administradores auxiliares." icon={activeSection === "logs" ? FileClock : ListChecks}><AuditTimeline items={audit} /></AdminSectionFrame>}
            {activeSection === "monitoring" && <AdminSectionFrame eyebrow="Sistema" title="Monitoramento" description="Estado atual do cadastro central, contas administrativas e OAuth Google." icon={MonitorCheck}><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><MonitorCard label="Sistema" value={monitoring?.status === "operational" ? "Operacional" : monitoring?.status || "Carregando"} healthy={monitoring?.status === "operational"} /><MonitorCard label="Banco de usuários" value={monitoring?.userStore === "online" ? "Online" : monitoring?.userStore || "Carregando"} healthy={monitoring?.userStore === "online"} /><MonitorCard label="Usuários ativos" value={String(monitoring?.activeUsers ?? overview?.activeUsers ?? 0)} healthy /><MonitorCard label="Admins" value={String(monitoring?.adminUsers ?? overview?.adminUsers ?? 0)} healthy /><MonitorCard label="OAuth Gmail" value={monitoring?.gmailConfigured ? "Configurado" : "Não configurado"} healthy={Boolean(monitoring?.gmailConfigured)} /><MonitorCard label="OAuth Google Agenda" value={monitoring?.googleCalendarConfigured ? "Configurado" : "Não configurado"} healthy={Boolean(monitoring?.googleCalendarConfigured)} /></div>{monitoring && <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-[10px] font-semibold text-[var(--text-secondary)]"><p>Callback Gmail: <code className="text-[var(--text)]">{monitoring.gmailRedirectUri || "não definido"}</code></p><p className="mt-1">Callback Google Agenda: <code className="text-[var(--text)]">{monitoring.googleRedirectUri || "não definido"}</code></p></div>}<p className="mt-4 text-[10px] font-semibold text-[var(--text-secondary)]">Última verificação: {formatDate(monitoring?.checkedAt)}</p></AdminSectionFrame>}
            {activeSection === "backup" && <AdminSectionFrame eyebrow="Sistema" title="Backup administrativo" description="Exporte usuários, equipes, planos e auditoria. Senhas e segredos nunca entram no arquivo." icon={Archive}><section className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--background)] p-5 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-sm font-black">Snapshot seguro do painel</h3><p className="mt-2 max-w-2xl text-xs font-semibold leading-6 text-[var(--text-secondary)]">O arquivo JSON é gerado sob demanda e contém somente dados administrativos sanitizados.</p></div><Button variant="primary" onClick={() => void downloadBackup()} disabled={saving === "backup"}><Archive size={15} /> {saving === "backup" ? "Gerando..." : "Gerar backup"}</Button></section></AdminSectionFrame>}
          </div></div>
        )}
      </div>

      {createOpen && <div className="fixed inset-0 z-[150] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="admin-create-user-title"><section className="max-h-[92dvh] w-full max-w-3xl overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl"><div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--primary)]/15 text-[var(--primary)]"><UserPlus size={18} /></span><div><h2 id="admin-create-user-title" className="text-base font-black">Novo usuário</h2><p className="text-[10px] font-semibold text-[var(--text-secondary)]">Crie uma conta manual com plano, equipe e permissões.</p></div></div><button type="button" onClick={() => setCreateOpen(false)} aria-label="Fechar criação de usuário"><X size={19} /></button></div><div className="mt-5 grid gap-3 sm:grid-cols-2"><input aria-label="Nome do novo usuário" value={createForm.nome} onChange={(event) => setCreateForm({ ...createForm, nome: event.target.value })} placeholder="Nome" className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none" /><input aria-label="E-mail do novo usuário" value={createForm.email} onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })} placeholder="E-mail" className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none" /><input aria-label="Senha inicial do novo usuário" type="password" value={createForm.password} onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })} placeholder="Senha inicial (mínimo 10 caracteres)" className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none" /><select aria-label="Plano do novo usuário" value={createForm.plan} onChange={(event) => setCreateForm({ ...createForm, plan: event.target.value as UserPlan })} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none">{plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}</select><label className="grid gap-1 sm:col-span-2"><span className="text-[10px] font-bold text-[var(--text-secondary)]">Vincular à empresa/equipe</span><select value={createForm.teamOwnerId} onChange={(event) => setCreateForm({ ...createForm, teamOwnerId: event.target.value })} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none"><option value="">Sem equipe</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name} · principal: {team.ownerName}</option>)}</select></label></div><PermissionEditor permissions={createForm.permissions} onToggle={toggleCreatePermission} /><div className="mt-5 flex justify-end gap-2"><Button onClick={() => setCreateOpen(false)}>Cancelar</Button><Button variant="primary" onClick={() => void createUser()} disabled={saving === "create"}>{saving === "create" ? "Criando..." : "Criar usuário"}</Button></div></section></div>}
    </main>
  );
}

function AdminNavButton({ active, label, icon: Icon, onClick }: { active: boolean; label: string; icon: LucideIcon; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`mb-1 flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-[10px] font-bold transition ${active ? "bg-[var(--primary)] text-white shadow-lg shadow-blue-950/25" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"}`}><Icon size={15} /><span>{label}</span></button>;
}

function UserBadge({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return <span className={`rounded-full px-2 py-0.5 text-[8px] font-black uppercase ${accent ? "bg-cyan-500/15 text-cyan-300" : "bg-[var(--surface-hover)] text-[var(--text-secondary)]"}`}>{children}</span>;
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><p className="text-[9px] font-black uppercase tracking-wide text-[var(--text-secondary)]">{label}</p><p className="mt-2 truncate text-xs font-black capitalize">{value}</p></div>;
}

function AdminSectionFrame({ eyebrow, title, description, icon: Icon, children }: { eyebrow: string; title: string; description: string; icon: LucideIcon; children: ReactNode }) {
  return <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-black/10 lg:p-5"><header className="mb-5 flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--primary)]/15 text-[var(--primary)]"><Icon size={18} /></span><div><p className="text-[9px] font-black uppercase tracking-[0.16em] text-[var(--primary)]">{eyebrow}</p><h2 className="text-base font-black">{title}</h2><p className="mt-1 text-[10px] font-semibold text-[var(--text-secondary)]">{description}</p></div></header>{children}</section>;
}

function UserSelector({ users, value, onChange }: { users: NoriumUser[]; value: string; onChange: (value: string) => void }) {
  return <label className="mb-4 grid gap-1"><span className="text-[10px] font-black text-[var(--text-secondary)]">Usuário</span><select aria-label="Selecionar usuário" value={value} onChange={(event) => onChange(event.target.value)} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none">{users.map((user) => <option key={user.id} value={user.id}>{user.nome} · {user.email}</option>)}</select></label>;
}

function ProtectedOwnerNotice() {
  return <div role="alert" className="mb-4 mt-4 flex items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 p-3 text-xs font-semibold text-amber-200"><LockKeyhole size={16} /> A conta do proprietário está protegida contra alterações feitas por administradores auxiliares.</div>;
}

function PermissionEditor({ permissions, onToggle, onToggleAll, disabled = false, keys }: { permissions: PermissionMap; onToggle: (key: PermissionKey) => void; onToggleAll?: (keys: PermissionKey[]) => void; disabled?: boolean; keys?: PermissionKey[] }) {
  const groups = keys ? [{ title: "Integrações", keys }] : permissionGroups;
  const visibleKeys = groups.flatMap((group) => group.keys);
  const allSelected = visibleKeys.every((key) => permissions[key]);
  return <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><div className="mb-3 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><SlidersHorizontal size={15} className="text-[var(--primary)]" /><div><h3 className="text-xs font-black">Módulos e permissões</h3><p className="text-[9px] font-semibold text-[var(--text-secondary)]">Defina quais recursos o usuário pode acessar.</p></div></div>{onToggleAll && <button type="button" disabled={disabled} onClick={() => onToggleAll(visibleKeys)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-[9px] font-black text-[var(--primary)] disabled:opacity-40"><CheckCircle2 size={12} className="mr-1 inline" /> {allSelected ? "Limpar seleção" : "Selecionar todos"}</button>}</div><div className={`grid gap-2 ${groups.length > 1 ? "xl:grid-cols-3" : "sm:grid-cols-2"}`}>{groups.map((group) => <div key={group.title} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"><h4 className="mb-2 text-[10px] font-black">{group.title}</h4><div className="space-y-1">{group.keys.map((key) => <label key={key} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hover)]"><span className="text-[9px] font-semibold">{permissionLabels[key]}</span><input type="checkbox" checked={Boolean(permissions[key])} disabled={disabled} onChange={() => onToggle(key)} className="h-3.5 w-3.5 accent-[var(--primary)]" /></label>)}</div></div>)}</div></div>;
}

function AuditTimeline({ items }: { items: AdminAuditItem[] }) {
  if (!items.length) return <EmptyState title="Nenhuma ação administrativa registrada" description="As próximas alterações de usuários aparecerão aqui." />;
  return <div className="space-y-2">{items.map((item) => <article key={item.id} className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--primary)]/12 text-[var(--primary)]"><FileClock size={14} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-[10px]">{item.actorName} · {item.action.replaceAll("_", " ")}</strong><time className="text-[9px] font-semibold text-[var(--text-secondary)]">{formatDate(item.createdAt)}</time></div><p className="mt-1 text-[10px] font-semibold text-[var(--text-secondary)]">{item.detail}{item.targetName ? ` Alvo: ${item.targetName}.` : ""}</p></div></article>)}</div>;
}

function MonitorCard({ label, value, healthy }: { label: string; value: string; healthy: boolean }) {
  return <article className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><MonitorCheck size={18} className={healthy ? "text-emerald-400" : "text-amber-400"} /><p className="mt-3 text-[9px] font-black uppercase tracking-wide text-[var(--text-secondary)]">{label}</p><p className="mt-1 text-sm font-black">{value}</p></article>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)] p-5 text-center"><Crown size={18} className="mx-auto text-[var(--primary)]" /><h3 className="mt-2 text-xs font-black">{title}</h3><p className="mt-1 text-[10px] font-semibold text-[var(--text-secondary)]">{description}</p></div>;
}
