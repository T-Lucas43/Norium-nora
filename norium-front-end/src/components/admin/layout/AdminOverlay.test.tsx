import {useState} from 'react';
import {render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect} from 'vitest';
import AdminOverlay from './AdminOverlay';
function Fixture(){const [open,setOpen]=useState(false);const [child,setChild]=useState(false);return <><button onClick={()=>setOpen(true)}>Abrir</button><AdminOverlay open={open} title="Principal" onClose={()=>setOpen(false)} footer={<button>Último controle</button>}><label>Nome<input/></label><button onClick={()=>setChild(true)}>Confirmar ação</button><AdminOverlay open={child} title="Confirmação" onClose={()=>setChild(false)}><button onClick={()=>setChild(false)}>Cancelar ação</button></AdminOverlay></AdminOverlay></>}
describe('AdminOverlay',()=>{
 it('contém o foco no modal e devolve ao acionador',async()=>{const user=userEvent.setup();render(<Fixture/>);const trigger=screen.getByRole('button',{name:'Abrir'});await user.click(trigger);expect(screen.getByLabelText('Nome')).toHaveFocus();screen.getByRole('button',{name:'Último controle'}).focus();await user.tab();expect(screen.getByRole('button',{name:'Fechar Principal'})).toHaveFocus();await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(trigger).toHaveFocus();});
 it('Escape fecha somente a confirmação sobreposta',async()=>{const user=userEvent.setup();render(<Fixture/>);await user.click(screen.getByRole('button',{name:'Abrir'}));await user.click(screen.getByRole('button',{name:'Confirmar ação'}));expect(screen.getByRole('dialog',{name:'Confirmação'})).toBeInTheDocument();await user.keyboard('{Escape}');expect(screen.queryByRole('dialog',{name:'Confirmação'})).not.toBeInTheDocument();expect(within(screen.getByRole('dialog',{name:'Principal'})).getByLabelText('Nome')).toBeInTheDocument();});
});
