import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TeamMessage } from "./teamChatTypes";

function upperBound(values: number[], target: number) { let low = 0, high = values.length; while (low < high) { const middle = (low+high)>>>1; if (values[middle] <= target) low = middle+1; else high = middle; } return Math.max(0, low-1); }

export function useMessageWindow(messages: TeamMessage[], list: RefObject<HTMLDivElement | null>, nearBottom: RefObject<boolean>, active: boolean) {
  const heights = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 720 });
  const nodes = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const restoreDelta = useRef(0);
  const frame = useRef(0);
  const offsets = useMemo(() => { void version; const result = [0]; for (const message of messages) result.push(result[result.length-1] + (heights.current.get(message.id) || 128)); return result; }, [messages, version]);
  const offsetMap = useRef(new Map<string, number>()); offsetMap.current = new Map(messages.map((message, index) => [message.id, offsets[index]]));
  const onScroll = useCallback(() => { const element = list.current; if (!element) return; setViewport((previous) => { const top = element.scrollTop, height = element.clientHeight || 720; return previous.top === top && previous.height === height ? previous : { top, height }; }); }, [list]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.virtualId;
        if (!id) continue;
        const height = Math.ceil(entry.target.getBoundingClientRect().height)+12;
        if (height <= 12 || Math.abs((heights.current.get(id) || 128)-height) < 1) continue;
        if ((offsetMap.current.get(id) || 0) < (list.current?.scrollTop || 0)) restoreDelta.current += height-(heights.current.get(id) || 128);
        heights.current.set(id, height); changed = true;
      }
      if (changed && !frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; setVersion((value) => value+1); });
    });
    nodes.current.forEach((node) => observer.current?.observe(node));
    return () => { observer.current?.disconnect(); observer.current = null; cancelAnimationFrame(frame.current); };
  }, [list]);
  useEffect(() => { const keep = new Set(messages.map((message) => message.id)); for (const id of heights.current.keys()) if (!keep.has(id)) heights.current.delete(id); }, [messages]);
  useLayoutEffect(() => {
    if (!active || !list.current) return;
    if (nearBottom.current) list.current.scrollTop = list.current.scrollHeight;
    else if (restoreDelta.current) list.current.scrollTop += restoreDelta.current;
    restoreDelta.current = 0; onScroll();
  }, [version, active, list, nearBottom, onScroll]);
  const virtual = active && messages.length > 120;
  const start = virtual ? Math.max(0, upperBound(offsets, viewport.top-600)) : 0;
  const end = virtual ? Math.min(messages.length, upperBound(offsets, viewport.top+viewport.height+600)+1) : messages.length;
  function measure(id: string, node: HTMLDivElement | null) { const previous = nodes.current.get(id); if (previous && previous !== node) observer.current?.unobserve(previous); if (node) { nodes.current.set(id, node); observer.current?.observe(node); } else nodes.current.delete(id); }
  return { items: messages.slice(start, end), start, top: offsets[start], bottom: offsets[messages.length]-offsets[end], onScroll, measure };
}
