import { useEffect, useRef, useState } from "react";
import type { CallSessionSnapshot, CallSessionCommands } from "./CallSession";

export default function PresentationAnnotations({ userId, selfId, marks = [], locked = false, updateStage }: {
  userId: string; selfId: string; marks?: CallSessionSnapshot["presentationMarks"];
  locked?: boolean; updateStage: CallSessionCommands["updateStage"];
}) {
  const [drawing, setDrawing] = useState(false);
  const [bounds, setBounds] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current?.parentElement;
    if (!container) return;
    const video = container.querySelector("video");
    const measure = () => {
      const width = container.clientWidth; const height = container.clientHeight;
      const ratio = video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
      const fitWidth = Math.min(width, height * ratio); const fitHeight = fitWidth / ratio;
      setBounds({ left: (width - fitWidth) / 2, top: (height - fitHeight) / 2, width: fitWidth, height: fitHeight });
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    window.addEventListener("resize", measure);
    video?.addEventListener("loadedmetadata", measure);
    measure();
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); video?.removeEventListener("loadedmetadata", measure); };
  }, []);
  const blocked = locked && selfId !== userId;
  useEffect(() => { if (blocked) setDrawing(false); }, [blocked]);
  return <>
    <div ref={ref} className={`team-call-annotations ${drawing && !blocked ? "is-drawing" : ""}`} style={bounds}>
      {drawing && !blocked && <button type="button" className="team-call-annotation-target" aria-label="Adicionar destaque na apresentação" onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const keyboard = event.detail === 0;
        updateStage({ type: "mark", userId, x: keyboard ? .5 : Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: keyboard ? .5 : Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) });
        setDrawing(false);
      }} />}
      {marks.filter((mark) => mark.targetUserId === userId && mark.expiresAt > Date.now()).map((mark) => <span key={mark.id} className="team-call-annotation-mark" style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }} role="status" aria-label={`Destaque de ${mark.fromUserName}`}><i /><small>{mark.fromUserName}</small></span>)}
    </div>
    <div className="team-call-annotation-tools"><button type="button" disabled={blocked} aria-pressed={drawing && !blocked} onClick={() => setDrawing((value) => !value)} title={blocked ? "O apresentador bloqueou as anotações" : "Clique na apresentação para marcar por 10 segundos; Enter marca o centro"}>{drawing && !blocked ? "Cancelar anotação" : blocked ? "Anotações bloqueadas" : "Anotar"}</button>{userId === selfId && <button type="button" onClick={() => updateStage({ type: "lock", locked: !locked })} aria-pressed={locked}>{locked ? "Permitir anotações" : "Bloquear anotações"}</button>}</div>
  </>;
}
