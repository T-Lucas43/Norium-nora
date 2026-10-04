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
  return <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5" aria-label="Sessões e dispositivos">
    <h2 className="flex items-center gap-2 text-base font-bold"><ShieldCheck size={18} /> Sessões e dispositivos</h2>
    <p className="mt-2 text-sm text-[var(--text-secondary)]">Cada sessão representa um perfil de navegador. Um mesmo aparelho pode aparecer mais de uma vez. O último uso é aproximado.</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
    {message && <p role="status" className="mt-3 text-sm text-[var(--primary)]">{message}</p>}
    {loading && <p role="status" className="mt-3 text-sm text-[var(--text-secondary)]">Carregando sessões…</p>}
    {!loading && !error && devices.length === 0 && <p className="mt-3 text-sm text-[var(--text-secondary)]">Nenhuma sessão ativa encontrada.</p>}
    <ul className="mt-4 space-y-3">
      {devices.map((device) => <li key={device.id} className="rounded-lg border border-[var(--border)] p-3">
        <div className="flex items-start gap-2">
          {device.kind === "Computador" ? <Monitor size={20} /> : <Smartphone size={20} />}
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{device.browser} · {device.system} · {device.kind}{device.current && <span className="ml-2 text-xs text-[var(--primary)]">Este navegador</span>}</p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">Criada em {date(device.createdAt)} · Último uso {date(device.lastUsedAt)}</p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">Válida até {date(device.expiresAt)}{device.persistent ? " · Login persistente" : " · Cookie de sessão"}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input aria-label={`Nome da sessão ${device.browser}`} maxLength={80} value={labels[device.id] ?? ""} onChange={(event) => setLabels((current) => ({ ...current, [device.id]: event.target.value }))} placeholder="Nome opcional, como Notebook" className="min-w-0 rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm" />
              <Button disabled={busy} onClick={() => void action(async () => { await apiRequest(`/api/auth/sessions/${encodeURIComponent(device.id)}`, { method: "PATCH", body: JSON.stringify({ label: labels[device.id] ?? "" }) }); setMessage("Nome atualizado."); })}>Salvar nome</Button>
              <Button variant="danger" disabled={busy} onClick={() => revoke(device)}>Encerrar sessão</Button>
            </div>
          </div>
        </div>
      </li>)}
    </ul>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <input type="password" aria-label="Senha atual para encerrar sessões" autoComplete="current-password" maxLength={180} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Senha atual" className="rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm" />
      <Button disabled={busy} onClick={() => revokeMany(false)}>Encerrar outras sessões</Button>
      <Button variant="danger" disabled={busy} onClick={() => revokeMany(true)}>Sair de todos os dispositivos</Button>
      <Button disabled={busy} onClick={() => void action(load)}>Atualizar lista</Button>
    </div>
  </section>;
}
