import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Eye, Lock, MessageCircle, Plus, RefreshCw, ShieldCheck, Target, Trash2, UserPlus } from "lucide-react";
import "../../styles/screens/inteligencia-equipe-conta.css";
import AvatarImage from "../profile/AvatarImage";
import type { AuthSession, NoriumTeam, NoriumUser, PermissionKey, PermissionMap } from "../../types/auth";
import { defaultMemberPermissions, permissionGroups, permissionLabels } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import TeamProductivity from "./TeamProductivity";
import TeamRoles, { type TeamRole } from "./TeamRoles";
import Button from "../shared/Button";
import TeamMemberPresenceDialog from "../team-chat/TeamMemberPresenceDialog";

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
  const [profileOpen, setProfileOpen] = useState(false);
  const [jobTitleDraft, setJobTitleDraft] = useState("");
  const [newMemberOpen, setNewMemberOpen] = useState(false);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) || users[0] || session.user,
    [selectedUserId, session.user, users],
  );

  useEffect(() => { setJobTitleDraft(selectedUser.jobTitle || "Membro"); }, [selectedUser.id, selectedUser.jobTitle]);

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
      <section className="nx-page nxi-screen" style={{ justifyContent: "center", alignItems: "center" }}>
        <div className="nx-card" style={{ maxWidth: 480, padding: 32, textAlign: "center" }}>
          <span className="nxi-tile is-blue" style={{ margin: "0 auto", width: 48, height: 48 }}>
            <Lock size={22} />
          </span>
          <h1 style={{ margin: "16px 0 0", fontSize: 20, fontWeight: 600 }}>Modo equipe indisponível</h1>
          <p className="nx-muted" style={{ margin: "8px 0 0", lineHeight: 1.6 }}>
            Esta área faz parte da assinatura Equipe. O admin do sistema pode liberar o plano para este usuário.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="nx-page nxi-screen team-workspace">
      <header className="nx-ph">
        <div>
          <h1>Equipe</h1>
          <p>{team?.name ? `${team.name} · ` : ""}{users.length} {users.length === 1 ? "usuário" : "usuários"} · metas, produtividade e acessos</p>
        </div>
        <div className="nx-ph-actions">
          <div className="nx-seg" role="group" aria-label="Áreas da equipe">
            <button type="button" aria-pressed={view === "overview"} className={view === "overview" ? "is-active" : ""} onClick={() => setView("overview")}>Visão da equipe</button>
            <button type="button" aria-pressed={view === "access"} className={view === "access" ? "is-active" : ""} onClick={() => setView("access")}>Membros e acessos</button>
            <button type="button" aria-pressed={view === "roles"} className={view === "roles" ? "is-active" : ""} onClick={() => setView("roles")}>Cargos</button>
          </div>
          <button type="button" className="nx-btn" onClick={onOpenTeamChat}><MessageCircle size={16} /> Abrir chat</button>
          <button type="button" className="nx-btn" onClick={() => void refresh()}>
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Atualizar
          </button>
          <button type="button" className="nx-btn is-primary" onClick={() => { setView("access"); setNewMemberOpen(true); }}><UserPlus size={16} /> Novo membro</button>
        </div>
      </header>

      {view === "overview" ? (
        <div className="nxi-stack">
          {(notice || error) && <p role={error ? "alert" : "status"} className={`nxi-alert ${error ? "is-error" : "is-success"}`}>{error || notice}</p>}
          <TeamProductivity data={report} name={team?.name || "Equipe"} onManage={id => { setSelectedUserId(id); setView("access"); }}/>
          <details className="nx-card nxi-card-pad is-sm nxi-details"><summary>Nome da equipe e objetivos</summary>
            {team && session.user.id === team.ownerUserId && <div className="nxi-actions" style={{ marginTop: 12 }}><input aria-label="Nome da equipe" className="nxi-field" style={{ flex: 1, width: "auto", minWidth: 180 }} value={teamName} onChange={e => setTeamName(e.target.value)} maxLength={140}/><Button size="sm" onClick={() => void saveTeamName()} disabled={saving === "team-name" || !teamName.trim() || teamName === team.name}>Salvar nome</Button></div>}
            <div style={{ marginTop: 16 }}><TeamGoals storageKey={`norium:team-goals:${session.user.teamOwnerId || session.user.id}`} /></div>
          </details>
        </div>
      ) : view === "access" ? (
      <div className="nxi-stack">
          {(notice || error) && (
            <div role={error ? "alert" : "status"} className={`nxi-alert ${error ? "is-error" : "is-success"}`}>
              {error || notice}
            </div>
          )}

          <div className="nx-card" style={{ overflow: "hidden" }}>
            <div className="nx-card-h"><h2>Membros e acessos</h2><span className="nx-faint nx-small">{users.length} {users.length === 1 ? "pessoa" : "pessoas"} · selecione para gerenciar</span></div>
            <div className="nxi-table-wrap"><table className="nx-table"><thead><tr><th>Pessoa</th><th>Cargo</th><th>Status</th><th>Perfil</th></tr></thead><tbody>
              {users.map((user) => (
                <tr key={user.id} className={selectedUser.id === user.id ? "is-selected" : ""}>
                  <td><button type="button" className="nxi-cell-btn" aria-pressed={selectedUser.id === user.id} onClick={() => setSelectedUserId(user.id)}>
                    <MemberAvatar user={user} />
                    <span className="nx-grow"><span className="block" style={{ fontWeight: 500 }}>{user.nome}</span><small className="block nx-faint nx-small" style={{ overflowWrap: "anywhere" }}>{user.email}</small></span>
                  </button></td>
                  <td><span className="nx-badge">{user.jobTitle || "Membro"}</span></td>
                  <td><span className={`nx-badge ${user.status === "ativo" ? "is-green" : "is-red"}`} style={{ textTransform: "capitalize" }}>{user.status}{user.online ? " · online" : ""}</span></td>
                  <td className="nx-muted">{user.role === "owner" ? "Principal" : "Membro"}</td>
                </tr>
              ))}
            </tbody></table></div>
            {!users.length && <p className="nxi-empty">{loading ? "Carregando equipe…" : "Nenhum usuário encontrado."}</p>}
          </div>

          <details className="nx-card nxi-card-pad is-sm nxi-details" open={newMemberOpen} onToggle={(event) => setNewMemberOpen(event.currentTarget.open)}>
            <summary>
              <span className="nxi-tile is-sm is-blue"><UserPlus size={16} /></span>
              <span><span className="block" style={{ color: "var(--nx-text)", fontWeight: 600, fontSize: 14 }}>Novo membro</span><span className="block nx-faint nx-small" style={{ fontWeight: 400 }}>Clique para cadastrar e liberar acessos.</span></span>
            </summary>
            <form className="nxi-cols" style={{ marginTop: 16 }} autoComplete="off" onSubmit={(event) => event.preventDefault()}>
              <input value={form.nome} onChange={(event) => setForm({ ...form, nome: event.target.value })} placeholder="Nome" aria-label="Nome do novo membro" autoComplete="off" className="nxi-field" />
              <select aria-label="Cargo do novo membro" value={form.jobRoleId} onChange={event=>{ const role=roles.find(r=>r.id===event.target.value); setForm({...form,jobRoleId:role?.id || '',jobTitle:role?.name || 'Membro',permissions:role ? {...role.permissions} : {...defaultMemberPermissions}}); }} className="nxi-field"><option value="">Acessos personalizados</option>{roles.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select>
              <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="E-mail" aria-label="E-mail do novo membro" name="new-member-email" autoComplete="off" className="nxi-field" />
              <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Senha inicial" aria-label="Senha inicial" name="new-member-password" autoComplete="new-password" className="nxi-field" />
            </form>
            <MiniPermissionEditor permissions={form.permissions} onToggle={toggleFormPermission} full />
            <div className="nxi-actions is-end" style={{ marginTop: 16 }}>
              <button type="button" onClick={() => void createMember()} disabled={saving === "create"} className="nx-btn is-primary">
                <UserPlus size={16} /> {saving === "create" ? "Criando..." : "Criar usuário"}
              </button>
            </div>
          </details>

          <div className="nx-card nxi-card-pad">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <MemberAvatar user={selectedUser} large />
                <div className="min-w-0">
                <p className="nx-faint nx-small">Membro selecionado</p>
                <h2 style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 600 }}>{selectedUser.nome}</h2>
                <p className="nx-muted nx-small" style={{ margin: "2px 0 0", overflowWrap: "anywhere" }}>{selectedUser.email}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setProfileOpen(true)} icon={<Eye size={16}/>}>Visualizar perfil</Button><Button
                onClick={() => void patchUser(selectedUser, { status: selectedUser.status === "ativo" ? "inativo" : "ativo" }, "Status atualizado.")}
                disabled={selectedUser.id === session.user.id || saving === selectedUser.id}
                variant={selectedUser.status === "ativo" ? "danger" : "secondary"}
              >
                {selectedUser.status === "ativo" ? "Bloquear acesso" : "Ativar acesso"}
              </Button></div>
            </div>

            <div className="mb-5 grid gap-3 md:grid-cols-3">
              <div className="team-role-assignment"><label>Cargo e acessos<select aria-label="Atribuir cargo" value={selectedUser.jobRoleId || ''} disabled={selectedUser.systemAdmin || selectedUser.id === session.user.id || saving === selectedUser.id} onChange={event=>{if(event.target.value) void patchUser(selectedUser,{jobRoleId:event.target.value},'Cargo e permissões aplicados.');}}><option value="">{selectedUser.jobTitle || 'Acessos personalizados'}</option>{roles.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label>{selectedUser.jobRoleId && <Button size="sm" disabled={selectedUser.systemAdmin || selectedUser.id===session.user.id || saving===selectedUser.id} onClick={()=>void patchUser(selectedUser,{jobRoleId:selectedUser.jobRoleId},'Permissões do cargo reaplicadas.')}>Reaplicar acessos</Button>}<small>{selectedUser.systemAdmin ? 'Administrador do sistema mantém seus acessos próprios.' : 'Selecionar um cargo substitui os acessos deste membro.'}</small></div>
              <Info label="Perfil" value={selectedUser.role === "owner" ? "Principal" : "Membro"} />
              <Info label="Status" value={selectedUser.status} />
            </div>

            <div className="mb-5 flex flex-wrap items-end gap-2">
              <label className="nxi-label min-w-[220px] flex-1">Profissão e posição na equipe<input aria-label="Profissão e posição" value={jobTitleDraft} maxLength={120} onChange={(event) => setJobTitleDraft(event.target.value)} className="nxi-field" /></label>
              <Button size="sm" disabled={saving === selectedUser.id || !jobTitleDraft.trim() || jobTitleDraft.trim() === selectedUser.jobTitle} onClick={() => void patchUser(selectedUser, { jobTitle: jobTitleDraft.trim() }, "Profissão e posição atualizadas.")}>Salvar posição</Button>
            </div>

            <details className="nxi-details" style={{ borderTop: "1px solid var(--nx-border)", paddingTop: 14 }}>
              <summary>
                <ShieldCheck size={16} style={{ color: "var(--nx-primary)" }} />
                Permissões e integrações
              </summary>
              <MiniPermissionEditor
                permissions={mergePermissions(selectedUser.permissions)}
                onToggle={(key) => toggleUserPermission(selectedUser, key)}
                disabled={selectedUser.id === session.user.id || saving === selectedUser.id}
                full
              />
            </details>
          </div>
      </div>
      ) : (
        <div>
          <TeamRoles roles={roles} users={users} token={session.token} onSaved={role=>setRoles(current=>current.some(r=>r.id===role.id)?current.map(r=>r.id===role.id?role:r):[...current,role])}/>
        </div>
      )}
      {profileOpen && <TeamMemberPresenceDialog member={selectedUser} online={Boolean(selectedUser.online)} isCurrentUser={selectedUser.id === session.user.id} token={session.token} onClose={() => setProfileOpen(false)} onMessage={() => { setProfileOpen(false); onOpenTeamChat(); }} onCall={() => { setProfileOpen(false); onOpenTeamChat(); }} />}
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
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="nxi-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}><Target size={16} style={{ color: "var(--nx-primary)" }} /> Objetivos acompanhados</h2>
          <p className="nxi-card-sub">Crie metas claras e atualize o progresso sem misturar permissões de acesso.</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_130px_auto]">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: concluir propostas da semana" aria-label="Nova meta" className="nxi-field" />
        <input type="number" min="1" value={target} onChange={(event) => setTarget(Math.max(1, Number(event.target.value)))} aria-label="Meta" className="nxi-field" />
        <Button onClick={addGoal} disabled={!title.trim()} icon={<Plus size={15} />}>Adicionar meta</Button>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {goals.map((goal) => {
          const progress = Math.min(100, Math.round((goal.current / Math.max(goal.target, 1)) * 100));
          return (
            <article key={goal.id} className="nx-card" style={{ padding: 16 }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="truncate" style={{ fontWeight: 600 }}>{goal.title}</p><p className="nx-faint nx-small mt-1">{goal.current} de {goal.target} concluídos</p></div>
                <Button iconOnly size="sm" variant="ghost" onClick={() => setGoals((current) => current.filter((item) => item.id !== goal.id))} aria-label={`Excluir meta ${goal.title}`}><Trash2 size={14} /></Button>
              </div>
              <div className="nx-bar mt-4"><i style={{ width: `${progress}%` }} /></div>
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled={goal.current <= 0} onClick={() => setGoals((current) => current.map((item) => item.id === goal.id ? { ...item, current: Math.max(0, item.current - 1) } : item))}>-1</Button>
                <Button size="sm" variant="secondary" disabled={goal.current >= goal.target} onClick={() => setGoals((current) => current.map((item) => item.id === goal.id ? { ...item, current: Math.min(item.target, item.current + 1) } : item))}>+1 progresso</Button>
                <span className="ml-auto nx-small" style={{ color: "var(--nx-primary-text)", fontWeight: 600 }}>{progress}%</span>
              </div>
            </article>
          );
        })}
        {!goals.length && <p className="nxi-empty is-dashed">Nenhuma meta criada. Use o campo acima para registrar o primeiro objetivo do time.</p>}
      </div>
    </section>
  );
}

function MemberAvatar({ user, large = false }: { user: Pick<NoriumUser, "nome" | "fotoUrl">; large?: boolean }) {
  return <AvatarImage src={user.fotoUrl} name={user.nome} size={large ? 64 : 32} />;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="nx-card" style={{ padding: "12px 14px", background: "var(--nx-surface-2)" }}>
      <p className="nx-faint nx-small">{label}</p>
      <p className="mt-1 capitalize" style={{ fontSize: 15, fontWeight: 600 }}>{value}</p>
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
        <div key={group.title} className="nx-card" style={{ padding: "12px 16px" }}>
          <div className="mb-1 flex items-center gap-2">
            <ShieldCheck size={15} style={{ color: "var(--nx-primary)" }} />
            <h3 className="text-sm font-semibold">{group.title}</h3>
          </div>
          <div>
            {group.keys.map((key) => (
              <label key={key} className="nxi-swrow" style={{ padding: "9px 0" }}>
                <span className="flex flex-1 items-center gap-2 text-[13px]">
                  {permissions[key] ? <CheckCircle2 size={14} style={{ color: "var(--nx-success)" }} /> : <Lock size={14} style={{ color: "var(--nx-text-3)" }} />}
                  {permissionLabels[key]}
                </span>
                <input type="checkbox" className="nxi-switch" checked={Boolean(permissions[key])} disabled={disabled} onChange={() => onToggle(key)} />
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
