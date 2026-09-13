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
      className={`brainstorm-node relative min-h-[112px] min-w-[190px] max-w-[280px] border p-4 shadow-lg transition ${selected ? "ring-2 ring-cyan-300 ring-offset-2 ring-offset-blue-950" : ""} ${frameStyle ? "border-dashed bg-transparent" : ""}`}
      style={{
        background: frameStyle ? "rgba(8,47,73,.12)" : textStyle ? "rgba(7,24,66,.9)" : data.color,
        borderColor: frameStyle ? data.color : "rgba(255,255,255,.28)",
        color: frameStyle || textStyle ? "white" : "#10204a",
      }}
    >
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-white !bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-white !bg-blue-500" />
      <p className="whitespace-pre-wrap break-words text-sm font-bold leading-5">{data.label || "Nova ideia"}</p>
      {data.description && <p className="mt-2 line-clamp-3 break-words text-xs font-semibold opacity-75">{data.description}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs font-bold uppercase opacity-70">
        {data.completed && <span className="inline-flex items-center gap-1"><Check size={12} /> Concluído</span>}
        {data.dueDate && <span>{new Date(`${data.dueDate}T12:00:00`).toLocaleDateString("pt-BR")}</span>}
        {data.category && <span className="rounded-full border border-current/20 px-2 py-0.5">{data.category}</span>}
        {votes > 0 && <span className="inline-flex items-center gap-1"><ThumbsUp size={11} /> {votes}</span>}
        {comments > 0 && <span className="inline-flex items-center gap-1"><MessageSquareText size={11} /> {comments}</span>}
      </div>
    </div>
  );
}

