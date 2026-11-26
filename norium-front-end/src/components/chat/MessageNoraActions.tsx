import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clipboard, ListChecks, Loader2, Sparkles, WandSparkles, X } from "lucide-react";

import Button from "../shared/Button";
import type { MsgConteudo } from "./types";
import { noraChatApi, inboxNoraChatApi } from "./noraChatApi";
import { useWhatsAppScope } from "./WhatsAppScope";
import { noraDraftForInsertion } from "./noraDraft";
import { messageTaskApi, type MessageTaskProject } from "./messageTaskApi";

export type MessageNoraRequest = {
  mode: "reply" | "summary" | "task";
  message: MsgConteudo;
};

interface MessageNoraActionsProps {
  conversationId: string;
  request: MessageNoraRequest | null;
  onClose: () => void;
  onUseReply: (message: MsgConteudo, draft: string) => void;
  onFeedback?: (tone: "error" | "success", text: string) => void;
}

function messageText(message: MsgConteudo) {
  return (message.texto || message.nomeArquivo || "Mensagem sem texto").trim();
}

function suggestedTitle(message: MsgConteudo) {
  const cleaned = messageText(message).replace(/\s+/g, " ");
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

export default function MessageNoraActions({ conversationId, request, onClose, onUseReply, onFeedback }: MessageNoraActionsProps) {
  const { inboxId } = useWhatsAppScope();
  const api = useMemo(() => inboxId ? inboxNoraChatApi(inboxId) : noraChatApi, [inboxId]);
  const [draft, setDraft] = useState("");
  const [improvement, setImprovement] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<MessageTaskProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const requestIdRef = useRef(0);

  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId) || null, [projectId, projects]);

  useEffect(() => {
    if (!request) return;
    const requestId = ++requestIdRef.current;
    const content = messageText(request.message);
    setDraft("");
    setImprovement("");
    setError(null);
    setProjects([]);
    setProjectId("");
    setTaskTitle(suggestedTitle(request.message));
    setTaskDescription(content);
    setLoading(true);

    const load = async () => {
      try {
        if (request.mode === "task") {
          const [availableProjects, description] = await Promise.all([
            messageTaskApi.listProjects(),
            api.runCustomAction(
              conversationId,
              `Transforme somente a mensagem abaixo em uma descrição objetiva de tarefa. Preserve fatos, não invente dados e não execute ainda.\n\nMensagem: ${content}`,
            ),
          ]);
          if (requestId !== requestIdRef.current) return;
          setProjects(availableProjects);
          setProjectId(availableProjects[0]?.id || "");
          setTaskDescription(description);
          return;
        }
        const instruction = request.mode === "reply"
          ? `Sugira uma resposta direta e adequada somente para a mensagem abaixo. Retorne apenas o texto da resposta e não envie.\n\nMensagem: ${content}`
          : `Resuma somente a mensagem abaixo, preservando fatos, pedidos e prazos. Não execute ações.\n\nMensagem: ${content}`;
        const result = await api.runCustomAction(conversationId, instruction);
        if (requestId === requestIdRef.current) setDraft(result);
      } catch (loadError) {
        if (requestId === requestIdRef.current) setError(loadError instanceof Error ? loadError.message : "A Nora não conseguiu analisar a mensagem.");
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    };
    void load();
    return () => { requestIdRef.current += 1; };
  }, [conversationId, request, api]);

  if (!request) return null;

  const improve = async () => {
    const instruction = improvement.trim();
    if (!instruction || !draft.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      setDraft(await api.improveDraft(conversationId, draft, instruction));
      setImprovement("");
    } catch (improveError) {
      setError(improveError instanceof Error ? improveError.message : "Não foi possível melhorar o texto.");
    } finally {
      setLoading(false);
    }
  };

  const createTask = async () => {
    if (!selectedProject || !taskTitle.trim() || !taskDescription.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      await messageTaskApi.createFromMessage({ project: selectedProject, title: taskTitle, description: taskDescription });
      onFeedback?.("success", `Tarefa criada no projeto ${selectedProject.name}.`);
      onClose();
    } catch (taskError) {
      const text = taskError instanceof Error ? taskError.message : "Não foi possível criar a tarefa.";
      setError(text);
      onFeedback?.("error", text);
    } finally {
      setLoading(false);
    }
  };

  const confirmReview = async () => {
    if (!draft.trim()) return;
    if (request.mode === "reply") {
      onUseReply(request.message, noraDraftForInsertion(draft));
      onClose();
      return;
    }
    try {
      await navigator.clipboard?.writeText(draft.trim());
      onFeedback?.("success", "Resumo copiado para a área de transferência.");
    } catch {
      onFeedback?.("success", "Resumo gerado e mantido para revisão.");
    }
  };

  return (
    <div className="fixed inset-0 z-[230] flex items-center justify-center bg-black/50 p-4" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="message-nora-title" className="nx-conv-panel w-full max-w-xl overflow-hidden shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--nx-border)] px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--nx-primary-soft)] text-[var(--nx-primary-text)]"><Sparkles size={18} /></span>
            <div><h3 id="message-nora-title" className="text-[15px] font-semibold">{request.mode === "reply" ? "Resposta da Nora" : request.mode === "summary" ? "Resumo da Nora" : "Transformar em tarefa"}</h3><p className="text-[12.5px] text-[var(--nx-text-2)]">Revise tudo antes de confirmar.</p></div>
          </div>
          <button type="button" onClick={onClose} disabled={loading} aria-label="Fechar ação da Nora" className="nx-conv-iconbtn h-8 w-8"><X size={16} /></button>
        </header>

        <div className="space-y-4 p-5">
          <div className="rounded-lg bg-[var(--nx-surface-2)] px-3 py-2 text-[12.5px] text-[var(--nx-text-2)]"><span className="font-medium text-[var(--nx-text)]">Mensagem selecionada:</span> {messageText(request.message)}</div>
          {loading && !draft && request.mode !== "task" && <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--nx-primary-text)]"><Loader2 size={18} className="animate-spin" /> Nora está preparando uma versão para revisão...</div>}
          {error && <p role="alert" className="rounded-lg bg-[var(--nx-danger-soft)] px-3 py-2 text-xs text-[var(--nx-danger)]">{error}</p>}

          {request.mode === "task" ? (
            <>
              <label className="nx-conv-label block">Projeto
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={loading && projects.length === 0} className="nx-conv-field mt-1.5 h-9 w-full px-3 text-sm" aria-label="Projeto da tarefa">
                  <option value="">Selecione o projeto</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              {!loading && projects.length === 0 && <p className="text-xs text-[var(--nx-warning)]">Crie um projeto na Lista de tarefas antes de transformar esta mensagem.</p>}
              <label className="nx-conv-label block">Título
                <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} maxLength={160} className="nx-conv-field mt-1.5 h-9 w-full px-3 text-sm" />
              </label>
              <label className="nx-conv-label block">Descrição revisada pela Nora
                <textarea value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)} rows={6} className="nx-conv-field mt-1.5 w-full resize-y p-3 text-sm leading-6" />
              </label>
              <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={loading}>Cancelar</Button><Button variant="primary" onClick={() => void createTask()} disabled={!selectedProject || !taskTitle.trim() || !taskDescription.trim()} loading={loading}><ListChecks size={15} /> Criar tarefa</Button></div>
            </>
          ) : !loading ? (
            <>
              <label className="nx-conv-label block">Texto para validação
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={7} className="nx-conv-field mt-1.5 w-full resize-y p-3 text-sm leading-6" />
              </label>
              <div className="flex gap-2"><input value={improvement} onChange={(event) => setImprovement(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void improve(); }} placeholder="Peça uma melhoria antes de usar" className="nx-conv-field h-9 min-w-0 flex-1 px-3 text-[13px]" /><Button onClick={() => void improve()} disabled={!improvement.trim()} loading={loading}><WandSparkles size={14} /> Melhorar</Button></div>
              <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={loading}>Descartar</Button><Button variant="primary" onClick={() => void confirmReview()} disabled={!draft.trim() || loading}>{request.mode === "reply" ? <><Check size={15} /> Usar como resposta</> : <><Clipboard size={15} /> Copiar resumo</>}</Button></div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
