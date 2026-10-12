import {ArrowLeft,Settings2,ShieldCheck,type LucideIcon} from 'lucide-react';
import BrandLogo from '../../layout/BrandLogo';

export type AdminNavItem={id:string;label:string;icon:LucideIcon;count?:number};
export type AdminNavGroup={label:string;items:AdminNavItem[]};
type Props={groups:AdminNavGroup[];active:string;onNavigate:(id:string)=>void;onUseSystem:()=>void;onSettings:()=>void};
export default function AdminSidebar({groups,active,onNavigate,onUseSystem,onSettings}:Props){
  return <><div className="nxa-side-brand"><BrandLogo className="nxa-logo"/><span className="nx-badge is-blue"><ShieldCheck size={12}/>Admin do sistema</span></div><nav className="nxa-side-nav" aria-label="Navegação administrativa">{groups.map(group=><div key={group.label||'overview'} className="nxa-nav-group">{group.label&&<h2>{group.label}</h2>}{group.items.map(({id,label,icon:Icon,count})=><button key={id} type="button" className={`nxa-nav-item ${active===id?'is-active':''}`} aria-current={active===id?'page':undefined} aria-label={label} onClick={()=>onNavigate(id)}><Icon size={16}/><span>{label}</span>{count!=null&&<small>{count}</small>}</button>)}</div>)}</nav><footer className="nxa-side-footer"><button type="button" onClick={onUseSystem}><ArrowLeft size={16}/>Voltar ao sistema</button><button type="button" onClick={onSettings}><Settings2 size={16}/>Configurações admin</button></footer></>;
}
