import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import AppErrorBoundary from './AppErrorBoundary';

describe('AppErrorBoundary',()=>{
  it('mantém a tela normal quando não há falha',()=>{render(<AppErrorBoundary><p>Painel funcionando</p></AppErrorBoundary>);expect(screen.getByText('Painel funcionando')).toBeInTheDocument();expect(screen.queryByRole('alert')).toBeNull();});
  it('mostra recuperação para import falho, sem expor a mensagem interna',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const retry=vi.fn();
    function Broken(){throw new Error('Failed to fetch dynamically imported module: private-internal-detail');return null;}
    try{render(<AppErrorBoundary onRetry={retry}><Broken/></AppErrorBoundary>);expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar esta tela');expect(screen.getByAltText('Norium')).toBeInTheDocument();expect(screen.queryByText(/private-internal-detail/)).toBeNull();await userEvent.setup().click(screen.getByRole('button',{name:'Tentar novamente'}));expect(retry).toHaveBeenCalledOnce();}finally{log.mockRestore();}
  });
});
