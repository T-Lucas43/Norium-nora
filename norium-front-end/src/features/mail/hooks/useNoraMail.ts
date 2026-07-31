import { useCallback, useState } from "react";
import { mailApiRequest as apiJson } from "../api";
import { clearMailboxCacheForUser } from "../mailboxCache";
import { looksLikeBadEmailSuggestion } from "../formatters";
import {
  NORA_ANALYST_SYSTEM,
  NORA_WRITER_SYSTEM,
  buildContextualPrompt,
  buildSuggestionPrompt,
  fallbackEmailSuggestion,
  type NoraTarget,
} from "../noraPrompts";
import type { AgentMessage, ComposeState, GmailMessage, NoraEmailSuggestion } from "../types";

type UseNoraMailOptions = {
  userId: string;
  canUseNora: boolean;
  selectedMessage: GmailMessage | null;
  compose: ComposeState;
  replyText: string;
  onError: (message: string) => void;
  /** Recarrega a caixa depois que o agente envia um e-mail. */
  onMailSent: () => void;
  /** Aplica o texto aceito no campo certo (corpo da nova mensagem ou resposta). */
  onApplySuggestion: (target: NoraTarget, text: string) => void;
};

/** Assistente da Nora no e-mail: agente conversacional e sugestoes de redacao. */
export function useNoraMail({
  userId,
  canUseNora,
  selectedMessage,
  compose,
  replyText,
  onError,
  onMailSent,
  onApplySuggestion,
}: UseNoraMailOptions) {
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("resumir minha caixa de entrada");
  const [aiMessages, setAiMessages] = useState<AgentMessage[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
  const [noraSuggesting, setNoraSuggesting] = useState<NoraTarget | null>(null);
  const [noraSuggestion, setNoraSuggestion] = useState<NoraEmailSuggestion | null>(null);
  const [noraSuggestionInstruction, setNoraSuggestionInstruction] = useState("");

  const askEmailAgent = useCallback(async (text?: string) => {
    const finalText = (text || aiInput).trim();
    if (!finalText) return;
    setAiOpen(true);
    setAiInput("");
    setAiLoading(true);
    setAiMessages((prev) => [...prev, { role: "user", text: finalText }]);
    try {
      const data = await apiJson<{ session_id: string | null; status: string; response: string }>(
        "/api/emails/gmail/agente/mensagem",
        {
          method: "POST",
          body: JSON.stringify({ user_id: userId, session_id: agentSessionId, message: finalText }),
        },
      );
      setAgentSessionId(data.session_id);
      setAiMessages((prev) => [...prev, { role: "ai", text: data.response }]);
      if (data.status === "enviado") {
        clearMailboxCacheForUser(userId);
        onMailSent();
      }
    } catch (err) {
      // A falha vira mensagem na conversa, nao erro global: o painel ja esta aberto.
      setAiMessages((prev) => [
        ...prev,
        { role: "ai", text: err instanceof Error ? err.message : "Agente de e-mail indisponivel." },
      ]);
    } finally {
      setAiLoading(false);
    }
  }, [agentSessionId, aiInput, onMailSent, userId]);

  const askContextualAssistant = useCallback(async (action: "summary" | "next") => {
    if (!selectedMessage) return;
    const userText = action === "summary" ? "Resumir o e-mail aberto" : "Sugerir a proxima acao para o e-mail aberto";
    setAiOpen(true);
    setAiLoading(true);
    setAiMessages((prev) => [...prev, { role: "user", text: userText }]);
    try {
      const data = await apiJson<{ response: string }>("/api/nora/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [
            { role: "system", content: NORA_ANALYST_SYSTEM },
            { role: "user", content: buildContextualPrompt(action, selectedMessage) },
          ],
        }),
      });
      setAiMessages((prev) => [
        ...prev,
        { role: "ai", text: data.response?.trim() || "Nao encontrei conteudo suficiente para analisar." },
      ]);
    } catch (err) {
      setAiMessages((prev) => [
        ...prev,
        { role: "ai", text: err instanceof Error ? err.message : "A Nora nao conseguiu analisar este e-mail." },
      ]);
    } finally {
      setAiLoading(false);
    }
  }, [selectedMessage]);

  const askSuggestion = useCallback(async (target: NoraTarget, instruction = "") => {
    if (!canUseNora) {
      onError("A Nora nao esta liberada para esta conta.");
      return;
    }
    setNoraSuggesting(target);
    onError("");
    try {
      const currentSuggestion = noraSuggestion?.target === target ? noraSuggestion.text : "";
      const prompt = buildSuggestionPrompt({
        target,
        message: selectedMessage,
        compose,
        replyText,
        currentSuggestion,
        instruction,
      });

      const data = await apiJson<{ response: string }>("/api/nora/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [
            { role: "system", content: NORA_WRITER_SYSTEM },
            { role: "user", content: prompt },
          ],
        }),
      });

      const suggestion = data.response?.trim();
      if (!suggestion) throw new Error("A Nora nao retornou sugestao.");
      // Respostas evasivas ("preciso de contexto") nao servem como e-mail:
      // troca por um texto neutro utilizavel.
      const finalSuggestion = looksLikeBadEmailSuggestion(suggestion)
        ? fallbackEmailSuggestion(target, selectedMessage, compose)
        : suggestion;

      setNoraSuggestion({ target, text: finalSuggestion });
      setNoraSuggestionInstruction("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Nao consegui pedir uma sugestao para a Nora.");
    } finally {
      setNoraSuggesting(null);
    }
  }, [canUseNora, compose, noraSuggestion, onError, replyText, selectedMessage]);

  const acceptSuggestion = useCallback(() => {
    if (!noraSuggestion) return;
    onApplySuggestion(noraSuggestion.target, noraSuggestion.text);
    setNoraSuggestion(null);
    setNoraSuggestionInstruction("");
  }, [noraSuggestion, onApplySuggestion]);

  const discardSuggestion = useCallback(() => {
    setNoraSuggestion(null);
    setNoraSuggestionInstruction("");
  }, []);

  return {
    aiOpen,
    setAiOpen,
    aiInput,
    setAiInput,
    aiMessages,
    aiLoading,
    noraSuggesting,
    noraSuggestion,
    setNoraSuggestion,
    noraSuggestionInstruction,
    setNoraSuggestionInstruction,
    askEmailAgent,
    askContextualAssistant,
    askSuggestion,
    acceptSuggestion,
    discardSuggestion,
  };
}
