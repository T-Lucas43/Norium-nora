import { useCallback, useEffect, useRef, useState } from "react";
import { Languages, X } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";

export const TRANSLATION_LANGUAGES: Record<string, string> = {
  "pt-BR": "Português", en: "Inglês", es: "Espanhol", fr: "Francês", de: "Alemão", it: "Italiano",
};

export function TranslationToolbar({ language, onLanguage, onClose }: {
  language: string; onLanguage: (value: string) => void; onClose: () => void;
}) {
  return <div className="nx-whatsapp-translation-toolbar"><Languages size={16} />
    <label>Traduzir para <select value={language} aria-label="Idioma da tradução" onChange={event => onLanguage(event.target.value)}>
      {Object.entries(TRANSLATION_LANGUAGES).map(([code, name]) => <option value={code} key={code}>{name}</option>)}
    </select></label>
    <small>Escolha a mensagem. Usa tokens da Nora.</small>
    <button type="button" aria-label="Fechar tradução" className="nx-conv-iconbtn" onClick={onClose}><X size={15} /></button>
  </div>;
}

export default function MessageTranslation({ conversationId, messageId, language, trigger = 0 }: {
  conversationId: string; messageId: string; language: string; trigger?: number;
}) {
  const scope = requestScope();
  const key = `${scope}|${conversationId}|${messageId}`;
  const [result, setResult] = useState<{ translation: string; language: string; key: string } | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const lifecycle = useRef({ active: true, key }); lifecycle.current.key = key;
  const inFlight = useRef(false), lastTrigger = useRef(0);
  const epoch = useRef(0);
  const previousKey = useRef(key);
  useEffect(() => { const life = lifecycle.current; life.active = true; return () => { life.active = false; }; }, []);
  useEffect(() => {
    if (previousKey.current === key) return;
    previousKey.current = key; epoch.current++; inFlight.current = false; setBusy(false); setResult(null); setError("");
  }, [key]);
  const translate = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    const generation = ++epoch.current;
    try {
      const response = await apiRequest<{ translation: string; language: string }>(
        `/api/chat/conversas/${encodeURIComponent(conversationId)}/mensagens/${encodeURIComponent(messageId)}/traducao`,
        { method: "POST", body: JSON.stringify({ language }), timeoutMs: 65_000 });
      if (lifecycle.current.active && lifecycle.current.key === key && requestScope() === scope) setResult({ ...response, key });
    } catch (failure) {
      if (lifecycle.current.active && lifecycle.current.key === key && requestScope() === scope)
        setError(failure instanceof Error ? failure.message : "Não foi possível traduzir.");
    } finally { if (generation === epoch.current) { inFlight.current = false; if (lifecycle.current.active && lifecycle.current.key === key) setBusy(false); } }
  }, [conversationId, messageId, language, key, scope]);
  useEffect(() => {
    if (trigger && trigger !== lastTrigger.current) { lastTrigger.current = trigger; void translate(); }
  }, [trigger, translate]);
  return <div className="nx-whatsapp-message-translation">
    {result?.key === key && <><p><strong>Traduzido · {TRANSLATION_LANGUAGES[result.language] || result.language}:</strong> {result.translation}</p><small>Dados pessoais mascarados na tradução.</small></>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void translate()}><Languages size={12} />
      {busy ? "Traduzindo…" : `Traduzir para ${TRANSLATION_LANGUAGES[language]}`}</button>
  </div>;
}
