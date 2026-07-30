import { useEffect, useRef, useState } from "react";
import { GripHorizontal } from "lucide-react";
import NoraAvatar from "./NoraAvatar";

type FloatingNoraButtonProps = {
  open: boolean;
  onClick: () => void;
};

type Position = {
  x: number;
  y: number;
};

const STORAGE_KEY = "norium:nora-floating-position";
const BUTTON_WIDTH = 158;
const BUTTON_HEIGHT = 58;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function defaultPosition(): Position {
  if (typeof window === "undefined") return { x: 24, y: 680 };
  return {
    x: 24,
    y: Math.max(96, window.innerHeight - BUTTON_HEIGHT - 28),
  };
}

export default function FloatingNoraButton({ open, onClick }: FloatingNoraButtonProps) {
  const [position, setPosition] = useState<Position>(defaultPosition);
  const positionRef = useRef(position);
  const dragRef = useRef({
    dragging: false,
    moved: false,
    pointerId: 0,
    offsetX: 0,
    offsetY: 0,
  });

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      setPosition(defaultPosition());
      return;
    }

    try {
      const parsed = JSON.parse(saved) as Position;
        const next = {
          x: clamp(parsed.x, 8, window.innerWidth - BUTTON_WIDTH - 8),
          y: clamp(parsed.y, 88, window.innerHeight - BUTTON_HEIGHT - 8),
        };
        positionRef.current = next;
        setPosition(next);
    } catch {
      setPosition(defaultPosition());
    }
  }, []);

  function persist(next: Position) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  if (open) return null;

  return (
    <button
      type="button"
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        dragRef.current = {
          dragging: true,
          moved: false,
          pointerId: event.pointerId,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragRef.current.dragging) return;
        const next = {
          x: clamp(event.clientX - dragRef.current.offsetX, 8, window.innerWidth - BUTTON_WIDTH - 8),
          y: clamp(event.clientY - dragRef.current.offsetY, 88, window.innerHeight - BUTTON_HEIGHT - 8),
        };
        if (Math.abs(next.x - position.x) > 3 || Math.abs(next.y - position.y) > 3) {
          dragRef.current.moved = true;
        }
        positionRef.current = next;
        setPosition(next);
      }}
      onPointerUp={(event) => {
        if (dragRef.current.pointerId === event.pointerId) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const wasMoved = dragRef.current.moved;
        dragRef.current.dragging = false;
        persist(positionRef.current);
        if (!wasMoved) onClick();
      }}
      className={`fixed z-[60] flex h-[58px] w-[158px] items-center justify-center gap-2 rounded-full border border-cyan-300/25 bg-gradient-to-r from-blue-800 via-sky-700 to-cyan-600 px-3 font-black text-white shadow-2xl shadow-blue-950/35 transition hover:scale-105 active:scale-95 ${open ? "ring-4 ring-cyan-300/20" : ""}`}
      style={{ left: position.x, top: position.y, touchAction: "none" }}
      title="Mover ou abrir Nora"
     aria-label="Mover ou abrir Nora">
      <GripHorizontal size={16} className="opacity-75" />
      <NoraAvatar className="h-9 w-9 shrink-0" />
      Nora
    </button>
  );
}
