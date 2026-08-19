import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Building2,
  CheckCircle2,
  Crown,
  LayoutDashboard,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  UsersRound,
  WalletCards,
} from "lucide-react";
import type { AuthSession, NoriumTeam, NoriumUser, PermissionKey, PermissionMap, PlanInfo, UserPlan } from "../../types/auth";
import { defaultMemberPermissions, permissionGroups, permissionLabels } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import LocalThemeToggle from "../layout/LocalThemeToggle";
import BrandLogo from "../layout/BrandLogo";
import { showConfirm } from "../shared/AppDialogProvider";
import Button from "../shared/Button";
import AdminFinanceDashboard from "./finance/AdminFinanceDashboard";

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

export default function AdminDashboard({ session, onUseSystem, onSessionUpdate }: AdminDashboardProps) {
  const [users, setUsers] = useState<NoriumUser[]>([]);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [teams, setTeams] = useState<NoriumTeam[]>([]);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [selectedUserId, setSelectedUserId] = useState(session.user.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [activeArea, setActiveArea] = useState<"users" | "finance">("users");

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) || users[0] || session.user,
    [selectedUserId, session.user, users],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [overviewResult, usersResult, plansResult, teamsResult] = await Promise.allSettled([
        authJson<AdminOverview>("/api/auth/admin/overview", session.token),
        authJson<{ users: NoriumUser[] }>("/api/auth/users", session.token),
        authJson<{ plans: PlanInfo[] }>("/api/auth/plans", session.token),
        authJson<{ teams: NoriumTeam[] }>("/api/auth/teams", session.token),
      ]);

      if (overviewResult.status === "fulfilled") setOverview(overviewResult.value);
      if (plansResult.status === "fulfilled") setPlans(plansResult.value.plans);
      if (teamsResult.status === "fulfilled") setTeams(teamsResult.value.teams);
      if (usersResult.status === "fulfilled") {
        const loadedUsers = usersResult.value.users;
        setUsers(loadedUsers);
        if (!loadedUsers.some((user) => user.id === selectedUserId)) {
          setSelectedUserId(loadedUsers[0]?.id || session.user.id);
        }
      }

      const failure = [overviewResult, usersResult, plansResult, teamsResult].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar o admin.");
    } finally {
      setLoading(false);
    }
  }, [selectedUserId, session.token, session.user.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function patchUser(userId: string, payload: Record<string, unknown>, message = "Usuário atualizado.") {
    setSaving(userId);
    setError("");
    setNotice("");
    try {
      const result = await authJson<{ user: NoriumUser }>(`/api/auth/users/${userId}`, session.token, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setUsers((current) => current.map((user) => (user.id === userId ? result.user : user)));
      if (result.user.id === session.user.id) {
        onSessionUpdate({ ...session, user: result.user });
      }
      setNotice(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar usuário.");
    } finally {
      setSaving("");
    }
  }

  async function createUser() {
    setSaving("create");
    setError("");
    setNotice("");
    try {
      const result = await authJson<{ user: NoriumUser }>("/api/auth/users", session.token, {
        method: "POST",
        body: JSON.stringify(createForm),
      });
      setUsers((current) => [result.user, ...current]);
      setSelectedUserId(result.user.id);
      setCreateForm(emptyCreateForm);
      setCreateOpen(false);
      setNotice("Usuario criado com acesso controlado.");
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar usuário.");
    } finally {
      setSaving("");
    }
  }

  async function deactivateUser(userId: string) {
    const confirmed = await showConfirm({
      title: "Desativar usuário?",
      description: "O acesso será bloqueado até que um administrador reative esta conta.",
      confirmLabel: "Desativar usuário",
      tone: "danger",
    });
    if (!confirmed) return;
    setSaving(userId);
    try {
      const result = await authJson<{ user: NoriumUser }>(`/api/auth/users/${userId}`, session.token, {
        method: "DELETE",
      });
      setUsers((current) => current.map((user) => (user.id === userId ? result.user : user)));
      setNotice("Usuario desativado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao desativar usuário.");
    } finally {
      setSaving("");
    }
  }

  function toggleCreatePermission(key: PermissionKey) {
    setCreateForm((current) => ({
      ...current,
      permissions: {
        ...current.permissions,
        [key]: !current.permissions[key],
      },
    }));
  }

  function toggleUserPermission(user: NoriumUser, key: PermissionKey) {
    const permissions = mergePermissions(user.permissions);
    void patchUser(
      user.id,
      {
        permissions: {
          ...permissions,
          [key]: !permissions[key],
        },
      },
      "Permissao atualizada.",
    );
  }

  const stats = [
    { label: "Usuarios", value: overview?.totalUsers ?? users.length, icon: UsersRound },
    { label: "Ativos", value: overview?.activeUsers ?? users.filter((user) => user.status === "ativo").length, icon: CheckCircle2 },
    { label: "Equipe", value: overview?.teamUsers ?? users.filter((user) => user.teamOwnerId).length, icon: BadgeCheck },
    { label: "Admins", value: overview?.adminUsers ?? users.filter((user) => user.systemAdmin).length, icon: ShieldCheck },
  ];

  return (
    <main className="norium-modern-shell norium-admin-shell flex h-dvh max-h-dvh flex-col overflow-hidden bg-[var(--background)] text-[var(--text)]">
      <header className="z-40 shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4 shadow-lg shadow-blue-950/10 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <BrandLogo className="h-11 w-[124px] shrink-0 text-[var(--text)]" />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold uppercase tracking-wide text-[var(--text-secondary)]">Norium Admin</p>
              <h1 className="truncate text-xl font-black">Gerenciamento do sistema</h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--background)] p-1 md:flex">
              <button onClick={() => setActiveArea("users")} className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-black ${activeArea === "users" ? "bg-blue-600 text-white" : "text-[var(--text-secondary)]"}`}><UsersRound size={15}/> Usuários</button>
              <button onClick={() => setActiveArea("finance")} className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-black ${activeArea === "finance" ? "bg-blue-600 text-white" : "text-[var(--text-secondary)]"}`}><WalletCards size={15}/> Financeiro</button>
            </div>
            <LocalThemeToggle storageKey="norium-admin-theme" label="tema do admin" />
            <Button size="lg" iconOnly
              onClick={() => void refresh()}
              className="bg-[var(--background)]"
              title="Atualizar"
             aria-label="Atualizar">
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            </Button>
            <Button size="lg"
              onClick={onUseSystem}
              className="hidden bg-[var(--background)] sm:flex"
            >
              <LayoutDashboard size={17} /> Usar sistema
            </Button>
          </div>
        </div>
      </header>

      <div className="flex shrink-0 gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 md:hidden">
        <Button className={activeArea === "users" ? "bg-blue-600 text-white" : ""} onClick={() => setActiveArea("users")}><UsersRound size={15}/> Usuários</Button>
        <Button className={activeArea === "finance" ? "bg-blue-600 text-white" : ""} onClick={() => setActiveArea("finance")}><WalletCards size={15}/> Financeiro</Button>
      </div>

      {activeArea === "finance" ? <AdminFinanceDashboard session={session}/> : (
      <div className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 content-start gap-5 overflow-y-auto p-5 xl:grid-cols-[360px_1fr]">
        <section className="space-y-5">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-black">Visao geral</h2>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">Usuários, planos e liberações.</p>
              </div>
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-400/16 text-cyan-100">
                <Crown size={19} />
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {stats.map((stat) => {
                const Icon = stat.icon;
                return (
                  <div key={stat.label} className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
                    <Icon size={17} className="mb-3 text-[var(--primary)]" />
                    <p className="text-2xl font-black">{stat.value}</p>
                    <p className="text-xs font-bold text-[var(--text-secondary)]">{stat.label}</p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-black">Usuarios</h2>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">Selecione para editar permissões.</p>
              </div>
              <Button variant="primary" iconOnly
                onClick={() => setCreateOpen((value) => !value)}
                className="bg-blue-600"
              >
                <UserPlus size={18} />
              </Button>
            </div>

            <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
              {users.map((user) => (
                <button
                  key={user.id}
                  onClick={() => setSelectedUserId(user.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    selectedUser.id === user.id
                      ? "border-cyan-300/50 bg-cyan-400/14"
                      : "border-[var(--border)] bg-[var(--background)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">{user.nome}</p>
                      <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">{user.email}</p>
                    </div>
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${user.status === "ativo" ? "bg-emerald-400/18 text-emerald-100" : "bg-red-500/18 text-red-100"}`}>
                      {user.status}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold uppercase">
                    <span className="rounded-full bg-blue-500/16 px-2 py-1 text-blue-100">{user.plan}</span>
                    <span className="rounded-full bg-white/10 px-2 py-1">{user.role}</span>
                    {user.systemAdmin && <span className="rounded-full bg-cyan-400/18 px-2 py-1 text-cyan-100">admin</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-5">
          {(notice || error) && (
            <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${error ? "border-red-400/30 bg-red-500/12 text-red-100" : "border-emerald-300/30 bg-emerald-400/12 text-emerald-100"}`}>
              {error || notice}
            </div>
          )}

          {createOpen && (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
              <div className="mb-4 flex items-center gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-blue-500/16 text-blue-200">
                  <UserPlus size={20} />
                </span>
                <div>
                  <h2 className="text-lg font-black">Novo usuário</h2>
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">Crie um acesso com funcoes liberadas.</p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <input value={createForm.nome} onChange={(event) => setCreateForm({ ...createForm, nome: event.target.value })} placeholder="Nome" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
                <input value={createForm.email} onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })} placeholder="E-mail" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
                <input type="password" value={createForm.password} onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })} placeholder="Senha inicial" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
                <select value={createForm.plan} onChange={(event) => setCreateForm({ ...createForm, plan: event.target.value as UserPlan })} className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none">
                  {plans.map((plan) => (
                    <option key={plan.code} value={plan.code}>{plan.name}</option>
                  ))}
                </select>
                <label className="grid gap-1 md:col-span-2">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">Vincular à empresa/equipe</span>
                  <select value={createForm.teamOwnerId} onChange={(event) => setCreateForm({ ...createForm, teamOwnerId: event.target.value })} className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none">
                    <option value="">Sem equipe</option>
                    {teams.map((team) => <option key={team.id} value={team.id}>{team.name} · principal: {team.ownerName}</option>)}
                  </select>
                </label>
              </div>

              <PermissionEditor permissions={createForm.permissions} onToggle={toggleCreatePermission} />

              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="primary" size="lg" onClick={() => void createUser()} disabled={saving === "create"} className="bg-blue-600">
                  {saving === "create" ? "Criando..." : "Criar usuário"}
                </Button>
                <Button size="lg" onClick={() => setCreateOpen(false)} className="bg-[var(--background)]">
                  Cancelar
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Usuario selecionado</p>
                <h2 className="mt-1 text-2xl font-black">{selectedUser.nome}</h2>
                <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">{selectedUser.email}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <select
                  value={selectedUser.plan}
                  onChange={(event) => void patchUser(selectedUser.id, { plan: event.target.value }, "Plano atualizado.")}
                  className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none"
                >
                  {plans.map((plan) => (
                    <option key={plan.code} value={plan.code}>{plan.name}</option>
                  ))}
                </select>
                <Button
                  onClick={() => void patchUser(selectedUser.id, { status: selectedUser.status === "ativo" ? "inativo" : "ativo" }, "Status atualizado.")}
                  className="bg-[var(--background)]"
                >
                  {selectedUser.status === "ativo" ? "Bloquear" : "Ativar"}
                </Button>
                <Button variant="danger"
                  onClick={() => void deactivateUser(selectedUser.id)}
                  className="border-red-400/30 bg-red-500/12 text-red-100"
                >
                  Desativar
                </Button>
              </div>
            </div>

            <div className="mb-5 grid gap-3 md:grid-cols-4">
              <InfoTile label="Perfil" value={selectedUser.role === "owner" ? "Principal" : "Usuario menor"} />
              <InfoTile label="Plano" value={selectedUser.plan} />
              <InfoTile label="Sistema admin" value={selectedUser.systemAdmin ? "Sim" : "Nao"} />
              <InfoTile label="Equipe" value={teams.find((team) => team.id === (selectedUser.teamOwnerId || selectedUser.id))?.name || "Sem equipe"} />
            </div>

            <label className="mb-5 grid gap-2 rounded-2xl border border-[var(--border)] bg-[var(--background)] p-4">
              <span className="flex items-center gap-2 text-sm font-black"><Building2 size={17} className="text-[var(--primary)]" /> Vínculo com empresa/equipe</span>
              <span className="text-xs font-semibold text-[var(--text-secondary)]">Escolha a equipe cujos recursos colaborativos este usuário poderá acessar.</span>
              <select
                value={selectedUser.teamOwnerId || ""}
                onChange={(event) => void patchUser(selectedUser.id, { teamOwnerId: event.target.value || null }, "Vínculo de equipe atualizado.")}
                disabled={saving === selectedUser.id}
                className="h-11 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-bold outline-none disabled:opacity-60"
              >
                <option value="">{selectedUser.role === "owner" ? "Equipe própria" : "Sem equipe"}</option>
                {teams.filter((team) => team.id !== selectedUser.id).map((team) => (
                  <option key={team.id} value={team.id}>{team.name} · principal: {team.ownerName} · {team.memberCount} membro(s)</option>
                ))}
              </select>
            </label>

            <div className="mb-5 rounded-2xl border border-cyan-300/25 bg-cyan-400/10 p-4">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-400/16 text-cyan-100">
                  <ShieldCheck size={18} />
                </span>
                <span>
                  <span className="block text-sm font-bold">Admin exclusivo do dono</span>
                  <span className="mt-1 block text-xs font-semibold leading-5 text-[var(--text-secondary)]">
                    O modo Admin do sistema fica bloqueado para qualquer usuário diferente do proprietário.
                    Usuários menores podem receber módulos e integrações, mas não recebem acesso administrativo global.
                  </span>
                </span>
              </div>
            </div>

            <PermissionEditor permissions={mergePermissions(selectedUser.permissions)} onToggle={(key) => toggleUserPermission(selectedUser, key)} disabled={saving === selectedUser.id || selectedUser.email === "tarcisiolucas43@gmail.com"} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {plans.map((plan) => (
              <article key={plan.code} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-lg font-black">{plan.name}</h3>
                  <span className="rounded-full bg-blue-500/16 px-3 py-1 text-xs font-bold text-blue-100">
                    {overview?.planCounts?.[plan.code] || 0} usuários
                  </span>
                </div>
                <p className="text-sm font-semibold leading-6 text-[var(--text-secondary)]">{plan.description}</p>
                <p className="mt-4 text-2xl font-black">R$ {plan.monthlyPrice}<span className="text-sm text-[var(--text-secondary)]">/mês</span></p>
                <ul className="mt-4 space-y-2 text-sm font-bold text-[var(--text-secondary)]">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <CheckCircle2 size={16} className="mt-0.5 text-emerald-300" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
      </div>
      )}
    </main>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">{label}</p>
      <p className="mt-2 text-lg font-black capitalize">{value}</p>
    </div>
  );
}

function PermissionEditor({
  permissions,
  onToggle,
  disabled = false,
}: {
  permissions: PermissionMap;
  onToggle: (key: PermissionKey) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-5 grid gap-4 xl:grid-cols-3">
      {permissionGroups.map((group) => (
        <div key={group.title} className="rounded-2xl border border-[var(--border)] bg-[var(--background)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <SlidersHorizontal size={16} className="text-[var(--primary)]" />
            <h3 className="text-sm font-bold">{group.title}</h3>
          </div>
          <div className="space-y-2">
            {group.keys.map((key) => (
              <label key={key} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <span className="text-xs font-bold">{permissionLabels[key]}</span>
                <input
                  type="checkbox"
                  checked={Boolean(permissions[key])}
                  disabled={disabled}
                  onChange={() => onToggle(key)}
                  className="h-4 w-4 accent-cyan-400"
                />
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
