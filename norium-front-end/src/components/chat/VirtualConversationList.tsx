import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChatConversa } from "./types";

const ROW_HEIGHT = 92;
const OVERSCAN = 5;

export default function VirtualConversationList({ items, renderItem, footer, empty, onReachEnd }: {
  items: ChatConversa[]; renderItem: (item: ChatConversa) => ReactNode;
  footer?: ReactNode; empty?: ReactNode;
  onReachEnd?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setPosition(current => ({ ...current, height: element.clientHeight || 600 })));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = ref.current;
    if (element && element.scrollTop > Math.max(0, items.length * ROW_HEIGHT - position.height)) {
      element.scrollTop = 0; setPosition(current => ({ ...current, top: 0 }));
    }
  }, [items.length, position.height]);
  const start = Math.max(0, Math.floor(position.top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((position.top + position.height) / ROW_HEIGHT) + OVERSCAN);
  return <div ref={ref} className="norium-chat-list min-h-0 flex-1 overflow-y-auto overscroll-contain"
    onScroll={event => {
      const element = event.currentTarget;
      setPosition({ top: element.scrollTop, height: element.clientHeight || 600 });
      if (element.scrollHeight - element.scrollTop - element.clientHeight < ROW_HEIGHT * 3) onReachEnd?.();
    }}>
    {items.length ? <div style={{ paddingTop: start * ROW_HEIGHT, paddingBottom: (items.length - end) * ROW_HEIGHT }}>
      {items.slice(start, end).map(renderItem)}
    </div> : empty}
    {footer}
  </div>;
}
