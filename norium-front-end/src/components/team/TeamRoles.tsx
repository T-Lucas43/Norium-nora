import { useState } from 'react';
import { permissionGroups, permissionLabels, defaultMemberPermissions, type PermissionMap, type NoriumUser } from '../../types/auth';
import { authJson } from '../../utils/authApi';
import Button from '../shared/Button';

export type TeamRole = { id: string; name: string; permissions: PermissionMap };
export default function TeamRoles({ roles, users, token, onSaved }: { roles: TeamRole[]; users: NoriumUser[]; token: string; onSaved: (role: TeamRole) => void }) {
  const [id, setId] = useState(''), [name, setName] = useState(''), [permissions, setPermissions] = useState({ ...defaultMemberPermissions }), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function save() {
    setBusy(true); setMessage('');
    try {
      const result = await authJson<{role: TeamRole}>(`/api/auth/team-roles${id ? `/${id}` : ''}`, token, { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ name, permissions }) });
      onSaved(result.role); setId(result.role.id); setPermissions(result.role.permissions); setMessage('Cargo salvo. Selecione-o em Membros e acessos para aplicar suas permissões.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível salvar o cargo.'); }
    finally { setBusy(false); }
  }
  function reset() { setId(''); setName(''); setPermissions({...defaultMemberPermissions}); setMessage(''); }
  return <div className="team-roles-layout"><section className="team-panel"><header><div><h3>Cargos e acessos</h3><p>Modelos reutilizáveis para sua equipe.</p></div><Button size="sm" onClick={reset}>Novo cargo</Button></header><div className="team-role-list">{roles.length ? roles.map(role => <button key={role.id} className={id === role.id ? 'is-selected' : ''} onClick={()=>{setId(role.id);setName(role.name);setPermissions({...role.permissions});setMessage('');}}><strong>{role.name}</strong><small>{Object.values(role.permissions).filter(Boolean).length} acessos · {users.filter(u=>u.jobRoleId===role.id).length} membros</small></button>) : <p className="team-empty">Crie o primeiro cargo definindo nome e acessos.</p>}</div></section><form className="team-panel team-role-editor" onSubmit={e=>{e.preventDefault();void save();}}><h3>{id ? 'Editar cargo' : 'Criar cargo'}</h3><label>Nome do cargo<input aria-label="Nome do cargo" required minLength={2} maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label><p>Ao atribuir este cargo, os acessos abaixo substituem as permissões atuais do membro. Alterar o modelo não modifica membros já cadastrados; atribua novamente para atualizar.</p><div className="team-role-permissions">{permissionGroups.map(group=><fieldset key={group.title}><legend>{group.title}</legend>{group.keys.map(key=><label key={key}><input type="checkbox" checked={permissions[key]} disabled={busy} onChange={e=>setPermissions(current=>({...current,[key]:e.target.checked}))}/>{permissionLabels[key]}</label>)}</fieldset>)}</div><Button type="submit" loading={busy} disabled={name.trim().length<2}>Salvar cargo e acessos</Button>{message&&<p role="status">{message}</p>}</form></div>;
}
