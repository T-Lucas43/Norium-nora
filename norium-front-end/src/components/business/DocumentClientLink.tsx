import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { ApiError, apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";

export default function DocumentClientLink({ kind, documentId }: { kind: "proposal" | "contract"; documentId: string }) {
  const scope = requestScope(); const [data, setData] = useState<{ key: string; client: { id: string; name: string } | null; unavailable?: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const key = `${scope}:${kind}:${documentId}`;
  useEffect(() => { const controller = new AbortController();
    void apiRequest<{ client: { id: string; name: string } | null }>(`/api/business/documents/${kind}/${encodeURIComponent(documentId)}/client`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && requestScope() === scope) setData({ key, client: result.client }); })
      .catch(err => { if (!controller.signal.aborted && requestScope() === scope) setData({ key, client: null, unavailable: !(err instanceof ApiError) || err.status >= 500 }); });
    return () => controller.abort();
  }, [kind, documentId, key, scope, revision]);
  if (data?.key === key && data.unavailable) return <button type="button" className="nx-btn is-sm" onClick={() => setRevision(value => value+1)}>Consultar vínculo novamente</button>;
  const client = data?.key === key ? data.client : null;
  if (!client) return null;
  return <button type="button" className="nx-btn is-sm" title={`Abrir ficha de ${client.name}`} onClick={() => {
    const link = { tab: "Clientes", entityType: "client", entityId: client.id };
    localStorage.setItem("norium-deep-link", JSON.stringify(link));
    window.dispatchEvent(new CustomEvent("norium:deep-link", { detail: link }));
  }}><UserRound size={13} />{client.name}</button>;
}
