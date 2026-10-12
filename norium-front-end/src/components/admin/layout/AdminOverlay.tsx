import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type Props = { open: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; variant?: 'modal' | 'drawer'; width?: number; closeLabel?: string };

export default function AdminOverlay({open,title,subtitle,onClose,children,footer,variant='modal',width=640,closeLabel}: Props) {
  const id=useId();
  const panel=useRef<HTMLElement>(null);
  const close=useRef(onClose);
  close.current=onClose;
  useEffect(()=>{
    if(!open) return;
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const focusable=()=>Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')||[]).filter(e=>!e.closest('[hidden],[aria-hidden="true"],.hidden'));
    const initial=panel.current?.querySelector<HTMLElement>('input:not([disabled]),select:not([disabled]),textarea:not([disabled])')||focusable()[0]||panel.current;
    initial?.focus();
    const handle=(event: KeyboardEvent)=>{
      if(document.querySelector('[aria-modal="true"]:not([data-nxa-dialog])'))return;
      const overlays=Array.from(document.querySelectorAll('[data-nxa-dialog]'));
      if(overlays.length&&overlays[overlays.length-1]!==panel.current)return;
      if(event.key==='Escape'){event.preventDefault();close.current();}
      if(event.key==='Tab'){
        const items=focusable();const first=items[0],last=items[items.length-1];
        if(!first){event.preventDefault();panel.current?.focus();return;}
        if(event.shiftKey&&(document.activeElement===first||!panel.current?.contains(document.activeElement))){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&(document.activeElement===last||!panel.current?.contains(document.activeElement))){event.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',handle);
    return()=>{document.removeEventListener('keydown',handle);previous?.focus();};
  },[open]);
  if(!open) return null;
  return createPortal(<div className={`nxa nxa-overlay is-${variant}`} onClick={event=>{if(event.target===event.currentTarget)onClose();}}><section ref={panel} role="dialog" data-nxa-dialog="true" aria-modal="true" aria-labelledby={id} aria-describedby={subtitle?`${id}-description`:undefined} tabIndex={-1} className="nxa-overlay-panel" style={{'--nxa-overlay-width':`${width}px`} as React.CSSProperties}><header className="nxa-overlay-header"><div><h2 id={id}>{title}</h2>{subtitle&&<p id={`${id}-description`}>{subtitle}</p>}</div><button type="button" aria-label={closeLabel||`Fechar ${title}`} className="nxa-icon-button" onClick={onClose}><X size={16}/></button></header><div className="nxa-overlay-body">{children}</div>{footer&&<footer className="nxa-overlay-footer">{footer}</footer>}</section></div>,document.body);
}
