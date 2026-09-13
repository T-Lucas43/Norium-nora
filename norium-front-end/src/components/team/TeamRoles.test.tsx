import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import TeamRoles from './TeamRoles';
import { authJson } from '../../utils/authApi';
import { defaultMemberPermissions } from '../../types/auth';

vi.mock('../../utils/authApi', () => ({ authJson: vi.fn() }));

it('saves a named role with the selected access template', async () => {
  const onSaved = vi.fn();
  vi.mocked(authJson).mockResolvedValue({role: {id:'role-1', name:'Operações', permissions:{...defaultMemberPermissions, nora:true}}});
  render(<TeamRoles roles={[]} users={[]} token="test" onSaved={onSaved}/>);
  fireEvent.change(screen.getByLabelText('Nome do cargo'), {target:{value:'Operações'}});
  fireEvent.click(screen.getByRole('checkbox', {name:/Nora/}));
  fireEvent.click(screen.getByRole('button', {name:'Salvar cargo e acessos'}));
  await waitFor(()=>expect(onSaved).toHaveBeenCalled());
  const body = JSON.parse(String(vi.mocked(authJson).mock.calls[0][2]?.body));
  expect(body.name).toBe('Operações');
  expect(body.permissions.nora).toBe(true);
  expect(body.permissions.admin).toBe(false);
});
