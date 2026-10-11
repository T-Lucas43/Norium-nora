import { useCallback, useEffect, useState } from "react";
import { Monitor, ShieldCheck, Smartphone } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { notifySessionClosed } from "../../core/api/cookieSession";
import Button from "../shared/Button";

interface DeviceSession {
  id: string; label: string; browser: string; system: string; kind: string;
  createdAt: number; lastUsedAt: number; expiresAt: number; current: boolean; persistent: boolean;
}
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString("pt-BR");

export default function SessionDevices() {
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const result = await apiRequest<{ sessions: DeviceSession[] }>("/api/auth/sessions");
    setDevices(result.sessions);
    setLabels(Object.fromEntries(result.sessions.map((row) => [row.id, row.label])));
  }, []);
  useEffect(() => {
    let active = true;
    apiRequest<{ sessions: DeviceSession[] }>("/api/auth/sessions")
      .then((result) => { if (active) { setDevices(result.sessions); setLabels(Object.fromEntries(result.sessions.map((row) => [row.id, row.label]))); } })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Falha ao carregar sessões."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function action(run: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await run(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Não foi possível concluir."); }
    finally { setBusy(false); setPassword(""); }
  }
  function revoke(device: DeviceSession) {
    if (!window.confirm(device.current ? "Encerrar a sessão deste navegador?" : "Encerrar esta sessão? O dispositivo precisará entrar novamente.")) return;
    void action(async () => {
      await apiRequest(`/api/auth/sessions/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      if (device.current) notifySessionClosed(device.id);
      else { await load(); setMessage("Sessão encerrada."); }
    });
  }
  function revokeMany(all: boolean) {
    if (!password) { setError("Informe sua senha atual para confirmar."); return; }
    if (!window.confirm(all ? "Sair de todos os dispositivos, incluindo este navegador?" : "Encerrar todas as outras sessões da sua conta?")) return;
    void action(async () => {
      await apiRequest("/api/auth/reauthenticate", { method: "POST", body: JSON.stringify({ password }) });
      await apiRequest(`/api/auth/sessions/${all ? "revoke-all" : "revoke-others"}`, { method: "POST" });
      if (all) notifySessionClosed();
      else { await load(); setMessage("Outras sessões encerradas."); }
    });
  }
  return <section className="nxi-stack is-sm" aria-label="Sessões e dispositivos">
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1"><h2 className="nxi-h2" style={{ display: "flex", alignItems: "center", gap: 8 }}><ShieldCheck size={18} /> Sessões e dispositivos</h2><p className="nx-muted" style={{ margin: "4px 0 0" }}>Cada sessão representa um perfil de navegador. Um mesmo aparelho pode aparecer mais de uma vez. O último uso é aproximado.</p></div>
      <Button size="sm" disabled={busy} onClick={() => void action(load)}>Atualizar lista</Button>
    </div>
    {error && <p role="alert" className="nxi-alert is-error">{error}</p>}
    {message && <p role="status" className="nxi-alert is-success">{message}</p>}
    {loading && <p role="status" className="nxi-alert">Carregando sessões…</p>}
    <ul className="nx-card" style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {!loading && !error && devices.length === 0 && <li className="nxi-empty">Nenhuma sessão ativa encontrada.</li>}
      {devices.map((device, index) => <li key={device.id} className="flex flex-wrap items-start gap-3.5" style={{ padding: "16px 20px", borderTop: index ? "1px solid var(--nx-border)" : 0 }}>
        <span className="nxi-tile">{device.kind === "Computador" ? <Monitor size={20} /> : <Smartphone size={20} />}</span>
        <div className="min-w-0 flex-1">
          <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{device.browser} · {device.system} · {device.kind}{device.current && <span className="nx-badge is-green" style={{ marginLeft: 6 }}>Este navegador</span>}</p>
          <p className="nx-faint nx-small" style={{ margin: "2px 0 0" }}>Criada em {date(device.createdAt)} · Último uso {date(device.lastUsedAt)}</p>
          <p className="nx-faint nx-small" style={{ margin: "2px 0 0" }}>Válida até {date(device.expiresAt)}{device.persistent ? " · Login persistente" : " · Cookie de sessão"}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input aria-label={`Nome da sessão ${device.browser}`} maxLength={80} value={labels[device.id] ?? ""} onChange={(event) => setLabels((current) => ({ ...current, [device.id]: event.target.value }))} placeholder="Nome opcional, como Notebook" className="nxi-field" style={{ width: 240, height: 30 }} />
            <Button size="sm" disabled={busy} onClick={() => void action(async () => { await apiRequest(`/api/auth/sessions/${encodeURIComponent(device.id)}`, { method: "PATCH", body: JSON.stringify({ label: labels[device.id] ?? "" }) }); setMessage("Nome atualizado."); })}>Salvar nome</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => revoke(device)}>Encerrar sessão</Button>
          </div>
        </div>
      </li>)}
    </ul>
    <div className="nx-card flex flex-wrap items-center gap-3" style={{ padding: "18px 22px" }}>
      <div className="min-w-0 flex-1" style={{ flexBasis: 240 }}><b style={{ fontWeight: 600 }}>Encerrar todas as outras sessões</b><div className="nx-faint nx-small">Você continuará conectado só neste navegador. Pedimos sua senha para confirmar.</div></div>
      <input type="password" aria-label="Senha atual para encerrar sessões" autoComplete="current-password" maxLength={180} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Senha atual" className="nxi-field" style={{ width: 200 }} />
      <Button variant="danger" disabled={busy} onClick={() => revokeMany(false)}>Encerrar outras sessões</Button>
      <Button variant="danger" disabled={busy} onClick={() => revokeMany(true)}>Sair de todos os dispositivos</Button>
    </div>
  </section>;
}
