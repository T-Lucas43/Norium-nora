import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Maximize, Minus, Plus, Workflow, Zap, Sparkles, Settings2 } from "lucide-react";
import type { AutomationFlow } from "../../features/automations/types";
import Button from "../shared/Button";
import "./automationFlowPreview.css";

export default function AutomationFlowPreview({ flow }: { flow: AutomationFlow }) {
  const viewport = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, "");
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const graph = useMemo(() => {
    const source = flow?.nodes || [];
    const minX = Math.min(0, ...source.map((node) => Number.isFinite(node.x) ? node.x : 0));
    const minY = Math.min(0, ...source.map((node) => Number.isFinite(node.y) ? node.y : 0));
    const nodes = source.map((node, index) => ({ ...node, x: (Number.isFinite(node.x) ? node.x : index * 300) - minX + 32, y: (Number.isFinite(node.y) ? node.y : 80) - minY + 32 }));
    return { nodes, width: Math.max(400, ...nodes.map((node) => node.x + 272)), height: Math.max(300, ...nodes.map((node) => node.y + 200)) };
  }, [flow]);
  function fit() {
    if (!viewport.current) return;
    setZoom(Math.max(.2, Math.min(1, (viewport.current.clientWidth - 24) / graph.width, (viewport.current.clientHeight - 24) / graph.height)));
    viewport.current.scrollTo?.(0, 0);
  }
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => { setZoom(Math.max(.2, Math.min(1, (element.clientWidth - 24) / graph.width, (element.clientHeight - 24) / graph.height))); element.scrollTo?.(0, 0); };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [graph]);
  const detail = graph.nodes.find((node) => node.id === selected);
  const labels = { trigger: "Gatilho", action: "Ação", nora: "Nora IA" };
  return <div className="flow-preview">
    <div className="flow-preview-toolbar"><span>{graph.nodes.length} blocos · {flow.connections.length} conexões</span><div><Button size="sm" iconOnly aria-label="Diminuir zoom" disabled={zoom <= .2} onClick={() => setZoom((value) => Math.max(.2, value - .1))}><Minus size={15} /></Button><output aria-label="Zoom do fluxo">{Math.round(zoom * 100)}%</output><Button size="sm" iconOnly aria-label="Aumentar zoom" disabled={zoom >= 1.5} onClick={() => setZoom((value) => Math.min(1.5, value + .1))}><Plus size={15} /></Button><Button size="sm" onClick={fit} icon={<Maximize size={15} />}>Ajustar à tela</Button></div></div>
    {!graph.nodes.length ? <div className="workspace-empty"><Workflow size={30} /><strong>Este fluxo ainda não tem blocos</strong><p>Abra o editor para configurar o gatilho e as ações.</p></div> : <div ref={viewport} className="flow-preview-viewport" tabIndex={0} aria-label="Diagrama do fluxo, use a rolagem para explorar">
      <div style={{ width: graph.width * zoom, height: graph.height * zoom, position: "relative" }}><div className="flow-preview-canvas" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}>
        <svg width={graph.width} height={graph.height} className="flow-preview-connections" aria-label="Conexões entre os blocos"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>{flow.connections.map((connection, index) => {
          const from = graph.nodes.find((node) => node.id === connection.source), to = graph.nodes.find((node) => node.id === connection.target);
          if (!from || !to) return null;
          const x = from.x + 240, y = from.y + 72, targetY = to.y + 72;
          return <path key={index} d={`M ${x} ${y} C ${x + 60} ${y}, ${to.x - 60} ${targetY}, ${to.x - 4} ${targetY}`} fill="none" stroke="currentColor" strokeWidth="2" markerEnd={`url(#${marker})`}><title>{from.title} → {to.title}</title></path>;
        })}</svg>
        {graph.nodes.map((node) => { const Icon = node.kind === "trigger" ? Zap : node.kind === "nora" ? Sparkles : Settings2; return <button type="button" key={node.id} className={`flow-preview-node is-${node.kind}`} style={{ left: node.x, top: node.y }} onClick={() => setSelected(node.id)} aria-label={`${labels[node.kind]}: ${node.title}`} aria-pressed={selected === node.id}><span className="flow-preview-node-kind"><Icon size={17} />{labels[node.kind]}</span><strong>{node.title}</strong><span className="flow-preview-node-description">{node.description || "Selecione para consultar este bloco."}</span></button>; })}
      </div></div>
    </div>}
    <div className="flow-preview-details">{detail ? <><strong>{labels[detail.kind]} · {detail.title}</strong><p>{detail.description || "Sem descrição adicional."}</p></> : <p>Selecione um bloco para consultar os detalhes. Para alterar o fluxo, use “Editar fluxo”.</p>}</div>
  </div>;
}
