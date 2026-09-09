import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Badge, BarChart3, Lock, MessageCircle, Plus, RefreshCw, Settings2, ShieldCheck, Target, Trash2, UserPlus, UsersRound } from "lucide-react";
import type { AuthSession, NoriumTeam, NoriumUser, PermissionKey, PermissionMap } from "../../types/auth";
import { defaultMemberPermissions, permissionGroups, permissionLabels } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import TeamProductivity from "./TeamProductivity";
import TeamRoles, { type TeamRole } from "./TeamRoles";
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
  jobRoleId: "",
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
  const [roles, setRoles] = useState<TeamRole[]>([]);
  const [selectedUserId, setSelectedUserId] = useState(session.user.id);
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<TeamTaskReport | null>(null);
  const [team, setTeam] = useState<NoriumTeam | null>(null);
  const [teamName, setTeamName] = useState("");
  const memberProfiles = useRef(new Map<string, NoriumUser>());
  const [detailsRevision, setDetailsRevision] = useState(0);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) || users[0] || session.user,
    [selectedUserId, session.user, users],
  );

  const refresh = useCallback(async () => {
    setDetailsRevision((current) => current + 1);
    setLoading(true);
    setError("");
    try {
      const data = await authJson<{ users: NoriumUser[] }>("/api/auth/users", session.token);
      setUsers(data.users.map((user) => ({ ...user, ...memberProfiles.current.get(user.id) })));
      setSelectedUserId((current) => data.users.some((user) => user.id === current) ? current : data.users[0]?.id || session.user.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao foi possivel carregar a equipe.");
    } finally {
      setLoading(false);
    }
  }, [session.token, session.user.id]);

  useEffect(() => {
    if (!detailsRevision) return;
    let active = true;
    const failed = (err: unknown) => { if (active) setError(err instanceof Error ? err.message : "Não foi possível atualizar os indicadores da equipe."); };
    void authJson<{roles: TeamRole[]}>("/api/auth/team-roles", session.token)
      .then(payload => { if (active) setRoles(payload.roles); }).catch(failed);
    void authJson<TeamTaskReport>("/api/tarefas/relatorio-equipe", session.token)
      .then((payload) => { if (active) setReport(payload); }).catch(failed);
    void authJson<{ team: NoriumTeam }>("/api/auth/team-profile", session.token)
      .then((payload) => { if (active) { setTeam(payload.team); setTeamName(payload.team.name); } }).catch(failed);
    void authJson<{ members: NoriumUser[] }>("/api/team-chat/members", session.token)
      .then((payload) => {
        if (!active) return;
        memberProfiles.current = new Map(payload.members.map((member) => [member.id, member]));
        setUsers((current) => current.map((user) => ({ ...user, ...memberProfiles.current.get(user.id) })));
      }).catch(failed);
    return () => { active = false; };
  }, [detailsRevision, session.token]);

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
          jobRoleId: form.jobRoleId || null,
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
      setNotice("Membro criado com sucesso.");
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
      memberProfiles.current.set(result.user.id, result.user);
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
      jobRoleId: "",
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
    <section className="team-workspace flex h-full min-h-0 w-full flex-col bg-[var(--background)] text-[var(--text)]">
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
        <div className="team-overview">
          {(notice || error) && <p role={error ? "alert" : "status"} className="report-feedback">{error || notice}</p>}
          <TeamProductivity data={report} name={team?.name || "Equipe"} onManage={id => { setSelectedUserId(id); setView("access"); }}/>
          <details className="team-settings"><summary>Nome da equipe e objetivos</summary>
            {team && session.user.id === team.ownerUserId && <div className="team-name-editor"><input aria-label="Nome da equipe" value={teamName} onChange={e => setTeamName(e.target.value)} maxLength={140}/><Button size="sm" onClick={() => void saveTeamName()} disabled={saving === "team-name" || !teamName.trim() || teamName === team.name}>Salvar nome</Button></div>}
            <TeamGoals storageKey={`norium:team-goals:${session.user.teamOwnerId || session.user.id}`} />
          </details>
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
                <h2 className="font-black">Novo membro</h2>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">Clique para cadastrar e liberar acessos.</p>
              </div>
            </summary>
            <div className="mt-4 grid gap-3">
              <input value={form.nome} onChange={(event) => setForm({ ...form, nome: event.target.value })} placeholder="Nome" className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none" />
              <select aria-label="Cargo do novo membro" value={form.jobRoleId} onChange={event=>{ const role=roles.find(r=>r.id===event.target.value); setForm({...form,jobRoleId:role?.id || '',jobTitle:role?.name || 'Membro',permissions:role ? {...role.permissions} : {...defaultMemberPermissions}}); }} className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm"><option value="">Acessos personalizados</option>{roles.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select>
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
              <div className="team-role-assignment"><label>Cargo e acessos<select aria-label="Atribuir cargo" value={selectedUser.jobRoleId || ''} disabled={selectedUser.systemAdmin || selectedUser.id === session.user.id || saving === selectedUser.id} onChange={event=>{if(event.target.value) void patchUser(selectedUser,{jobRoleId:event.target.value},'Cargo e permissões aplicados.');}}><option value="">{selectedUser.jobTitle || 'Acessos personalizados'}</option>{roles.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label>{selectedUser.jobRoleId && <Button size="sm" disabled={selectedUser.systemAdmin || selectedUser.id===session.user.id || saving===selectedUser.id} onClick={()=>void patchUser(selectedUser,{jobRoleId:selectedUser.jobRoleId},'Permissões do cargo reaplicadas.')}>Reaplicar acessos</Button>}<small>{selectedUser.systemAdmin ? 'Administrador do sistema mantém seus acessos próprios.' : 'Selecionar um cargo substitui os acessos deste membro.'}</small></div>
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
          <TeamRoles roles={roles} users={users} token={session.token} onSaved={role=>setRoles(current=>current.some(r=>r.id===role.id)?current.map(r=>r.id===role.id?role:r):[...current,role])}/>
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

function MemberAvatar({ user, large = false }: { user: Pick<NoriumUser, "nome" | "fotoUrl">; large?: boolean }) {
  const size = large ? "h-16 w-16 text-lg" : "h-10 w-10 text-sm";
  if (user.fotoUrl) {
    return <img src={user.fotoUrl} alt={`Foto de ${user.nome}`} className={`${size} shrink-0 rounded-full border border-blue-400/35 object-cover`} />;
  }
  const initials = user.nome.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "N";
  return <span aria-label={`Foto de ${user.nome}`} className={`grid ${size} shrink-0 place-items-center rounded-full border border-blue-400/35 bg-blue-500/15 font-black text-blue-200`}>{initials}</span>;
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
