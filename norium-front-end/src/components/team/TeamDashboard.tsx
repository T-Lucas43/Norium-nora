import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Badge, BarChart3, Building2, Check, CheckCircle2, Clock3, ListChecks, Lock, MessageCircle, PlayCircle, Plus, RefreshCw, Settings2, ShieldCheck, Target, Trash2, UserPlus, UsersRound, type LucideIcon } from "lucide-react";
import type { AuthSession, NoriumTeam, NoriumUser, PermissionKey, PermissionMap } from "../../types/auth";
import { defaultMemberPermissions, permissionGroups, permissionLabels } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import Button from "../shared/Button";

interface TeamDashboardProps {
  session: AuthSession;
  onSessionUpdate: (session: AuthSession) => void;
  onOpenTeamChat: () => void;
}

interface TeamTaskReportMember {
  id: string;
  nome: string;
  email: string;
  role: string;
  jobTitle?: string;
  fotoUrl?: string;
  status: string;
  stats: {
    total: number;
    pendentes: number;
    andamento: number;
    revisao: number;
    concluidas: number;
    vencidas: number;
    urgentes: number;
  };
  recentes: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    projectId?: string;
    category?: string;
    dueDate?: string;
  }>;
}

interface TeamTaskReport {
  members: TeamTaskReportMember[];
  totals: Record<string, number>;
  updatedAt: string;
}

const initialForm = {
  nome: "",
  jobTitle: "Membro",
  email: "",
  password: "",
  permissions: defaultMemberPermissions,
};

function mergePermissions(value?: Partial<PermissionMap>) {
  return { ...defaultMemberPermissions, ...(value || {}) };
}

export default function TeamDashboard({ session, onSessionUpdate, onOpenTeamChat }: TeamDashboardProps) {
  const [view, setView] = useState<"overview" | "access" | "roles">("overview");
  const [users, setUsers] = useState<NoriumUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState(session.user.id);
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<TeamTaskReport | null>(null);
  const [team, setTeam] = useState<NoriumTeam | null>(null);
  const [teamName, setTeamName] = useState("");

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) || users[0] || session.user,
    [selectedUserId, session.user, users],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [data, reportData, teamData, memberData] = await Promise.all([
        authJson<{ users: NoriumUser[] }>("/api/auth/users", session.token),
        authJson<TeamTaskReport>("/api/tarefas/relatorio-equipe", session.token),
        authJson<{ team: NoriumTeam }>("/api/auth/team-profile", session.token),
        authJson<{ members: NoriumUser[] }>("/api/team-chat/members", session.token).catch(() => ({ members: [] })),
      ]);
      const profileById = new Map(memberData.members.map((member) => [member.id, member]));
      setUsers(data.users.map((user) => ({ ...user, ...profileById.get(user.id) })));
      setReport(reportData);
      setTeam(teamData.team);
      setTeamName(teamData.team.name);
      if (!data.users.some((user) => user.id === selectedUserId)) {
        setSelectedUserId(data.users[0]?.id || session.user.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao foi possivel carregar a equipe.");
    } finally {
      setLoading(false);
    }
  }, [selectedUserId, session.token, session.user.id]);

  async function saveTeamName() {
    const normalized = teamName.trim();
    if (!normalized || normalized === team?.name) return;
    setSaving("team-name");
    setNotice("");
    setError("");
    try {
      const result = await authJson<{ team: NoriumTeam }>("/api/auth/team-profile", session.token, {
        method: "PATCH",
        body: JSON.stringify({ name: normalized }),
      });
      setTeam(result.team);
      setTeamName(result.team.name);
      setNotice("Nome da empresa/equipe atualizado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao atualizar o nome da equipe.");
    } finally {
      setSaving("");
    }
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createMember() {
    setSaving("create");
    setNotice("");
    setError("");
    try {
      const result = await authJson<{ user: NoriumUser }>("/api/auth/users", session.token, {
        method: "POST",
        body: JSON.stringify({
          nome: form.nome,
          jobTitle: form.jobTitle,
          email: form.email,
          password: form.password,
          role: "member",
          plan: "individual",
          permissions: form.permissions,
        }),
      });
      setUsers((current) => [result.user, ...current]);
      setSelectedUserId(result.user.id);
      setForm(initialForm);
      setNotice("Usuario menor criado com sucesso.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar usuario.");
    } finally {
      setSaving("");
    }
  }

  async function patchUser(user: NoriumUser, payload: Record<string, unknown>, message = "Usuario atualizado.") {
    setSaving(user.id);
    setNotice("");
    setError("");
    try {
      const result = await authJson<{ user: NoriumUser }>(`/api/auth/users/${user.id}`, session.token, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setUsers((current) => current.map((item) => (item.id === user.id ? result.user : item)));
      if (result.user.id === session.user.id) {
        onSessionUpdate({ ...session, user: result.user });
      }
      setNotice(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao atualizar usuario.");
    } finally {
      setSaving("");
    }
  }

  function toggleFormPermission(key: PermissionKey) {
    setForm((current) => ({
      ...current,
      permissions: { ...current.permissions, [key]: !current.permissions[key] },
    }));
  }

  function toggleUserPermission(user: NoriumUser, key: PermissionKey) {
    const permissions = mergePermissions(user.permissions);
    void patchUser(user, { permissions: { ...permissions, [key]: !permissions[key] } }, "Permissao atualizada.");
  }

  const canUseTeam = session.user.plan === "equipe" || session.user.plan === "enterprise" || session.user.systemAdmin;

  if (!canUseTeam) {
    return (
      <section className="flex h-full min-h-0 w-full items-center justify-center bg-[var(--background)] p-6 text-[var(--text)]">
        <div className="max-w-lg rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center shadow-2xl shadow-blue-950/20 backdrop-blur-2xl">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-blue-500/16 text-blue-200">
            <Lock size={28} />
          </span>
          <h1 className="mt-5 text-2xl font-black">Modo equipe indisponivel</h1>
          <p className="mt-3 text-sm font-semibold leading-6 text-[var(--text-secondary)]">
            Esta area faz parte da assinatura Equipe. O admin do sistema pode liberar o plano para este usuario.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-[var(--background)] text-[var(--text)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-6 py-5 backdrop-blur-2xl">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-xl border border-[var(--border)] bg-[var(--background)] text-[var(--primary)]">
            <UsersRound size={22} />
          </span>
          <div>
            <h1 className="text-2xl font-black">{team?.name || "Equipe"}</h1>
            <p className="text-sm font-semibold text-[var(--text-secondary)]">Acompanhe metas, produtividade e colaboração; gerencie acessos em uma área separada.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onOpenTeamChat} icon={<MessageCircle size={16} />}>Abrir chat</Button>
          <Button onClick={() => void refresh()} className="bg-[var(--background)]">
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Atualizar
          </Button>
        </div>
      </header>

      <nav className="flex gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3">
        <Button variant={view === "overview" ? "primary" : "ghost"} onClick={() => setView("overview")} icon={<BarChart3 size={15} />}>Visão da equipe</Button>
        <Button variant={view === "access" ? "primary" : "ghost"} onClick={() => setView("access")} icon={<Settings2 size={15} />}>Membros e acessos</Button>
        <Button variant={view === "roles" ? "primary" : "ghost"} onClick={() => setView("roles")} icon={<Badge size={15} />}>Cargos</Button>
      </nav>

      {view === "overview" ? (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {(notice || error) && (
            <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${error ? "border-red-400/30 bg-red-500/12 text-red-100" : "border-emerald-300/30 bg-emerald-400/12 text-emerald-100"}`}>
              {error || notice}
            </div>
          )}
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]"><Building2 size={15} /> Empresa ou equipe</p>
                <h2 className="mt-1 text-xl font-black">Identidade da colaboração</h2>
                <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">Esse nome aparece para todos os usuários vinculados à equipe.</p>
              </div>
              {team && session.user.id === team.ownerUserId ? (
                <div className="flex w-full max-w-xl gap-2">
                  <input value={teamName} onChange={(event) => setTeamName(event.target.value)} maxLength={140} placeholder="Nome da empresa ou equipe" className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
                  <Button variant="primary" onClick={() => void saveTeamName()} disabled={!teamName.trim() || teamName.trim() === team.name || saving === "team-name"} icon={<Check size={15} />}>
                    {saving === "team-name" ? "Salvando" : "Salvar"}
                  </Button>
                </div>
              ) : (
                <strong className="rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-3">{team?.name || "Equipe"}</strong>
              )}
            </div>
          </section>
          <TeamGoals storageKey={`norium:team-goals:${session.user.teamOwnerId || session.user.id}`} />
          <TeamPerformanceReport report={report} users={users} selectedUserId={selectedUser.id} onSelect={setSelectedUserId} />
        </div>
      ) : view === "access" ? (
      <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 xl:grid-cols-[360px_1fr]">
        <aside className="space-y-5">
          <details className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
            <summary className="flex cursor-pointer list-none items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-500/16 text-blue-200">
                <UserPlus size={18} />
              </span>
              <div>
                <h2 className="font-black">Novo usuario menor</h2>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">Clique para cadastrar e liberar acessos.</p>
              </div>
            </summary>
            <div className="mt-4 grid gap-3">
              <input value={form.nome} onChange={(event) => setForm({ ...form, nome: event.target.value })} placeholder="Nome" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
              <input value={form.jobTitle} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} placeholder="Cargo na empresa" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
              <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="E-mail" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
              <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Senha inicial" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
            </div>
            <MiniPermissionEditor permissions={form.permissions} onToggle={toggleFormPermission} />
            <button onClick={() => void createMember()} disabled={saving === "create"} className="mt-4 h-11 w-full rounded-xl bg-blue-600 text-sm font-bold text-white disabled:opacity-60">
              {saving === "create" ? "Criando..." : "Criar usuario"}
            </button>
          </details>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
            <h2 className="mb-3 font-black">Usuarios da equipe</h2>
            <div className="max-h-[430px] space-y-2 overflow-y-auto pr-1">
              {users.map((user) => (
                <button
                  key={user.id}
                  onClick={() => setSelectedUserId(user.id)}
                  className={`w-full rounded-xl border p-3 text-left ${
                    selectedUser.id === user.id ? "border-cyan-300/50 bg-cyan-400/14" : "border-[var(--border)] bg-[var(--background)]"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <MemberAvatar user={user} />
                    <span className="min-w-0 flex-1"><strong className="block truncate text-sm">{user.nome}</strong><small className="block truncate text-[var(--text-secondary)]">{user.jobTitle || "Membro"}</small></span>
                  </span>
                  <p className="mt-2 truncate text-xs font-semibold text-[var(--text-secondary)]">{user.email}</p>
                  <span className={`mt-3 inline-flex rounded-full px-2 py-1 text-xs font-bold ${user.status === "ativo" ? "bg-emerald-400/18 text-emerald-100" : "bg-red-500/18 text-red-100"}`}>
                    {user.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="space-y-5">
          {(notice || error) && (
            <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${error ? "border-red-400/30 bg-red-500/12 text-red-100" : "border-emerald-300/30 bg-emerald-400/12 text-emerald-100"}`}>
              {error || notice}
            </div>
          )}

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <MemberAvatar user={selectedUser} large />
                <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Selecionado</p>
                <h2 className="mt-1 text-2xl font-black">{selectedUser.nome}</h2>
                <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">{selectedUser.email}</p>
                </div>
              </div>
              <Button
                onClick={() => void patchUser(selectedUser, { status: selectedUser.status === "ativo" ? "inativo" : "ativo" }, "Status atualizado.")}
                disabled={selectedUser.id === session.user.id || saving === selectedUser.id}
                className="bg-[var(--background)]"
              >
                {selectedUser.status === "ativo" ? "Bloquear acesso" : "Ativar acesso"}
              </Button>
            </div>

            <div className="mb-5 grid gap-3 md:grid-cols-3">
              <label className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"><span className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Cargo</span><input defaultValue={selectedUser.jobTitle || "Membro"} onBlur={(event) => { const jobTitle = event.target.value.trim(); if (jobTitle && jobTitle !== selectedUser.jobTitle) void patchUser(selectedUser, { jobTitle }, "Cargo atualizado."); }} className="mt-2 h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-black outline-none focus:border-blue-500" /></label>
              <Info label="Perfil" value={selectedUser.role === "owner" ? "Principal" : "Membro"} />
              <Info label="Status" value={selectedUser.status} />
            </div>

            <details className="rounded-2xl border border-[var(--border)] bg-[var(--background)] p-4">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-bold">
                <ShieldCheck size={16} className="text-[var(--primary)]" />
                Permissoes e integracoes
              </summary>
              <MiniPermissionEditor
                permissions={mergePermissions(selectedUser.permissions)}
                onToggle={(key) => toggleUserPermission(selectedUser, key)}
                disabled={selectedUser.id === session.user.id || saving === selectedUser.id}
                full
              />
            </details>
          </div>
        </main>
      </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <section className="mx-auto max-w-[1400px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
              <div><p className="text-xs font-bold uppercase text-blue-400">Estrutura da equipe</p><h2 className="mt-1 text-xl font-black">Cargos e membros</h2><p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">Confira quem ocupa cada cargo e edite o cargo na área Membros e acessos.</p></div>
              <Badge size={24} className="text-blue-400" />
            </div>
            <div className="mt-5 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {Array.from(new Set(users.map((user) => user.jobTitle || (user.role === "owner" ? "Lider" : "Membro")))).map((jobTitle) => {
                const occupants = users.filter((user) => (user.jobTitle || (user.role === "owner" ? "Lider" : "Membro")) === jobTitle);
                return <article key={jobTitle} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4"><div className="flex items-center justify-between"><strong>{jobTitle}</strong><span className="rounded-full bg-blue-500/12 px-2 py-1 text-xs font-bold text-blue-300">{occupants.length}</span></div><div className="mt-4 space-y-2">{occupants.map((user) => <button key={user.id} type="button" onClick={() => { setSelectedUserId(user.id); setView("access"); }} className="flex w-full items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-left hover:bg-[var(--surface-hover)]"><MemberAvatar user={user} /><span className="min-w-0"><strong className="block truncate text-xs">{user.nome}</strong><small className="text-[var(--text-secondary)]">{user.status}</small></span></button>)}</div></article>;
              })}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

type TeamGoal = {
  id: string;
  title: string;
  target: number;
  current: number;
};

function TeamGoals({ storageKey }: { storageKey: string }) {
  const [goals, setGoals] = useState<TeamGoal[]>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(storageKey) || "[]") as TeamGoal[];
    } catch {
      return [];
    }
  });
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState(10);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(goals));
  }, [goals, storageKey]);

  function addGoal() {
    if (!title.trim() || target < 1) return;
    setGoals((current) => [...current, { id: crypto.randomUUID(), title: title.trim(), target, current: 0 }]);
    setTitle("");
    setTarget(10);
  }

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Metas da equipe</p>
          <h2 className="mt-1 text-2xl font-black">Objetivos acompanhados</h2>
          <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">Crie metas claras e atualize o progresso sem misturar permissões de acesso.</p>
        </div>
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-blue-500/14 text-blue-300"><Target size={22} /></span>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_130px_auto]">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: concluir propostas da semana" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
        <input type="number" min="1" value={target} onChange={(event) => setTarget(Math.max(1, Number(event.target.value)))} aria-label="Meta" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
        <Button onClick={addGoal} disabled={!title.trim()} icon={<Plus size={15} />}>Adicionar meta</Button>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {goals.map((goal) => {
          const progress = Math.min(100, Math.round((goal.current / Math.max(goal.target, 1)) * 100));
          return (
            <article key={goal.id} className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="truncate font-black">{goal.title}</p><p className="mt-1 text-xs font-bold text-[var(--text-secondary)]">{goal.current} de {goal.target} concluídos</p></div>
                <Button iconOnly size="sm" variant="ghost" onClick={() => setGoals((current) => current.filter((item) => item.id !== goal.id))} aria-label={`Excluir meta ${goal.title}`}><Trash2 size={14} /></Button>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--surface)]"><div className="h-full rounded-full bg-blue-500" style={{ width: `${progress}%` }} /></div>
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled={goal.current <= 0} onClick={() => setGoals((current) => current.map((item) => item.id === goal.id ? { ...item, current: Math.max(0, item.current - 1) } : item))}>-1</Button>
                <Button size="sm" variant="secondary" disabled={goal.current >= goal.target} onClick={() => setGoals((current) => current.map((item) => item.id === goal.id ? { ...item, current: Math.min(item.target, item.current + 1) } : item))}>+1 progresso</Button>
                <span className="ml-auto text-xs font-black text-blue-300">{progress}%</span>
              </div>
            </article>
          );
        })}
        {!goals.length && <p className="rounded-xl border border-dashed border-[var(--border)] p-5 text-sm font-semibold text-[var(--text-secondary)]">Nenhuma meta criada. Use o campo acima para registrar o primeiro objetivo do time.</p>}
      </div>
    </section>
  );
}

function TeamPerformanceReport({
  report,
  users,
  selectedUserId,
  onSelect,
}: {
  report: TeamTaskReport | null;
  users: NoriumUser[];
  selectedUserId: string;
  onSelect: (userId: string) => void;
}) {
  const userById = new Map(users.map((user) => [user.id, user]));
  const selected = report?.members.find((member) => member.id === selectedUserId) || report?.members[0];
  const totals = report?.totals || {};

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl shadow-blue-950/10 backdrop-blur-2xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Relatorio da equipe</p>
          <h2 className="mt-1 text-2xl font-black">Produtividade por usuario</h2>
          <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">
            Tarefas por responsavel, status, vencimento e execucao.
          </p>
        </div>
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-cyan-400/12 text-cyan-200">
          <BarChart3 size={22} />
        </span>
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-5">
        <Metric icon={ListChecks} label="Pendentes" value={totals.pendentes || 0} />
        <Metric icon={PlayCircle} label="Em execucao" value={totals.andamento || 0} />
        <Metric icon={Clock3} label="Em revisao" value={totals.revisao || 0} />
        <Metric icon={CheckCircle2} label="Finalizadas" value={totals.concluidas || 0} />
        <Metric icon={AlertTriangle} label="Vencidas" value={totals.vencidas || 0} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-3 md:grid-cols-2">
          {(report?.members || []).map((member) => {
            const profile = userById.get(member.id);
            const displayMember = { ...profile, ...member } as NoriumUser;
            return (
            <button
              key={member.id}
              type="button"
              onClick={() => onSelect(member.id)}
              className={`rounded-2xl border p-4 text-left transition ${
                selectedUserId === member.id ? "border-cyan-300/60 bg-cyan-400/12" : "border-[var(--border)] bg-[var(--background)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <MemberAvatar user={displayMember} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-black">{member.nome}</p>
                  <p className="truncate text-xs font-bold text-blue-300">{profile?.jobTitle || member.jobTitle || (member.role === "owner" ? "Lider" : "Membro")}</p>
                  <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">{member.email}</p>
                </div>
                <span className="rounded-full border border-[var(--border)] px-2 py-1 text-xs font-bold uppercase text-[var(--text-secondary)]">
                  {member.status}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                <MiniNumber label="Pend." value={member.stats.pendentes} />
                <MiniNumber label="Exec." value={member.stats.andamento} />
                <MiniNumber label="Rev." value={member.stats.revisao} />
                <MiniNumber label="Fim" value={member.stats.concluidas} />
              </div>
            </button>
            );
          })}
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-[var(--background)] p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Tarefas recentes</p>
          <h3 className="mt-1 truncate text-lg font-black">{selected?.nome || "Usuario"}</h3>
          <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
            {(selected?.recentes || []).length === 0 && (
              <p className="rounded-xl border border-[var(--border)] px-3 py-4 text-sm font-semibold text-[var(--text-secondary)]">
                Nenhuma tarefa atribuida ainda.
              </p>
            )}
            {(selected?.recentes || []).map((task) => (
              <div key={task.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                <p className="line-clamp-2 text-sm font-bold">{task.title}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold uppercase">
                  <span className="rounded-full bg-blue-500/14 px-2 py-1 text-blue-100">{task.status}</span>
                  <span className="rounded-full bg-cyan-500/14 px-2 py-1 text-cyan-100">{task.priority}</span>
                  {task.dueDate && <span className="rounded-full bg-amber-500/14 px-2 py-1 text-amber-100">{task.dueDate}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function MemberAvatar({ user, large = false }: { user: Pick<NoriumUser, "nome" | "fotoUrl">; large?: boolean }) {
  const size = large ? "h-16 w-16 text-lg" : "h-10 w-10 text-sm";
  if (user.fotoUrl) {
    return <img src={user.fotoUrl} alt={`Foto de ${user.nome}`} className={`${size} shrink-0 rounded-full border border-blue-400/35 object-cover`} />;
  }
  const initials = user.nome.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "N";
  return <span aria-label={`Foto de ${user.nome}`} className={`grid ${size} shrink-0 place-items-center rounded-full border border-blue-400/35 bg-blue-500/15 font-black text-blue-200`}>{initials}</span>;
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
      <Icon size={16} className="text-[var(--primary)]" />
      <p className="mt-2 text-2xl font-black">{value}</p>
      <p className="text-xs font-bold text-[var(--text-secondary)]">{label}</p>
    </div>
  );
}

function MiniNumber({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 py-2">
      <p className="text-base font-black">{value}</p>
      <p className="text-xs font-bold text-[var(--text-secondary)]">{label}</p>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">{label}</p>
      <p className="mt-2 text-lg font-black capitalize">{value}</p>
    </div>
  );
}

function MiniPermissionEditor({
  permissions,
  onToggle,
  disabled = false,
  full = false,
}: {
  permissions: PermissionMap;
  onToggle: (key: PermissionKey) => void;
  disabled?: boolean;
  full?: boolean;
}) {
  return (
    <div className={`mt-4 grid gap-4 ${full ? "xl:grid-cols-3" : ""}`}>
      {permissionGroups.map((group) => (
        <div key={group.title} className="rounded-2xl border border-[var(--border)] bg-[var(--background)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck size={16} className="text-[var(--primary)]" />
            <h3 className="text-sm font-bold">{group.title}</h3>
          </div>
          <div className="space-y-2">
            {group.keys.map((key) => (
              <label key={key} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <span className="flex items-center gap-2 text-xs font-bold">
                  {permissions[key] ? <CheckCircle2 size={14} className="text-emerald-300" /> : <Lock size={14} className="text-[var(--text-secondary)]" />}
                  {permissionLabels[key]}
                </span>
                <input type="checkbox" checked={Boolean(permissions[key])} disabled={disabled} onChange={() => onToggle(key)} className="h-4 w-4 accent-cyan-400" />
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
