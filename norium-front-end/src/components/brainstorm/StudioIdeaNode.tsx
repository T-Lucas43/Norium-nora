import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, MessageSquareText, ThumbsUp } from "lucide-react";

export type IdeaVariant = "sticky" | "text" | "shape" | "frame";

export type IdeaComment = {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  timestamp: string;
};

export type IdeaData = Record<string, unknown> & {
  label: string;
  description?: string;
  color: string;
  variant: IdeaVariant;
  category?: string;
  completed?: boolean;
  dueDate?: string;
  tags?: string[];
  responsibleId?: string;
  responsibleName?: string;
  comments?: IdeaComment[];
  votes?: string[];
  file?: { name: string; mimeType: string; size: number; dataUrl: string };
};

export type IdeaNode = Node<IdeaData, "idea">;

export default function IdeaCard({ data, selected }: NodeProps<IdeaNode>) {
  const votes = data.votes?.length || 0;
  const comments = data.comments?.length || 0;
  const frameStyle = data.variant === "frame";
  const textStyle = data.variant === "text";
  return (
    <div
      className={`brainstorm-node nxs-node relative min-h-[120px] min-w-[190px] max-w-[280px] border p-[14px] transition ${selected ? "is-selected" : ""} ${frameStyle ? "is-frame" : textStyle ? "is-text" : ""}`}
      style={{
        background: frameStyle ? "color-mix(in srgb, var(--nx-surface) 55%, transparent)" : textStyle ? "var(--nx-surface)" : data.color,
        borderColor: frameStyle ? "var(--nx-border-strong)" : textStyle ? "var(--nx-border)" : "transparent",
        color: frameStyle || textStyle ? "var(--nx-text)" : "#1d2027",
      }}
    >
      <Handle type="target" position={Position.Left} className="nxs-handle" />
      <Handle type="source" position={Position.Right} className="nxs-handle" />
      <p className="whitespace-pre-wrap break-words text-sm font-medium leading-[1.4]">{data.label || "Nova ideia"}</p>
      {data.description && <p className="mt-2 line-clamp-3 break-words text-xs opacity-75">{data.description}</p>}
      {data.responsibleName && <p className="nxs-node-author">{data.responsibleName}</p>}
      <div className="nxs-node-meta mt-3 flex flex-wrap items-center gap-1.5">
        {data.completed && <span className="inline-flex items-center gap-1"><Check size={12} /> Concluído</span>}
        {data.dueDate && <span>{new Date(`${data.dueDate}T12:00:00`).toLocaleDateString("pt-BR")}</span>}
        {data.category && <span className="rounded-full border border-current/20 px-2 py-0.5">{data.category}</span>}
        {votes > 0 && <span className="inline-flex items-center gap-1"><ThumbsUp size={11} /> {votes}</span>}
        {comments > 0 && <span className="inline-flex items-center gap-1"><MessageSquareText size={11} /> {comments}</span>}
      </div>
    </div>
  );
}

