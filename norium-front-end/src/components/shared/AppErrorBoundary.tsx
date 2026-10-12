import {Component,type ReactNode} from 'react';

export default class AppErrorBoundary extends Component<{children:ReactNode;onRetry?:()=>void},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){
    if(this.state.failed)return <main className="norium-boot" role="alert"><section><img src="/norium-logo.png" alt="Norium" width={80} height={80}/><h1>Não foi possível carregar esta tela</h1><p>A conexão pode ter sido interrompida. Tente novamente para carregar a versão disponível do Norium.</p><button type="button" onClick={this.props.onRetry||(()=>window.location.reload())}>Tentar novamente</button></section></main>;
    return this.props.children;
  }
}
