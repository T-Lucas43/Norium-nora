import { useRef, useState } from "react";
import Button from "../shared/Button";
import { schedulingApi, type Booking, type ChannelReceipt, type NotifyPreview, type SchedulingProfessional, type SchedulingService } from "../../features/scheduling/api";

function newOperationKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatDateTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("pt-BR");
}

function toLocalInput(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (item: number) => String(item).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export default function RescheduleDialog({ booking, services, professionals = [], onClose, onSaved }: {
  booking: Booking; services: SchedulingService[]; professionals?: SchedulingProfessional[]; onClose: () => void; onSaved: () => void;
}) {
  const service = services.find((item) => item.id === booking.service_id);
  const durations = service?.durations?.length ? service.durations : [15, 30, 45, 60];
  const eligibleProfessionals = professionals.filter((item) => item.active && (service?.professionalIds || []).includes(item.userId));
  const operationKey = useRef(newOperationKey());
  const [dateTime, setDateTime] = useState(() => toLocalInput(booking.start_at));
  const [duration, setDuration] = useState(() => {
    const minutes = Math.round((new Date(booking.end_at).getTime() - new Date(booking.start_at).getTime()) / 60000);
    return durations.includes(minutes) ? minutes : durations[0];
  });
  const [responsibleId, setResponsibleId] = useState(booking.responsible_id || eligibleProfessionals[0]?.userId || "");
  const [signoff, setSignoff] = useState<"team" | "professional">("team");
  const [preview, setPreview] = useState<NotifyPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [notifyGmail, setNotifyGmail] = useState(false);
  const [notifyWhatsapp, setNotifyWhatsapp] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [waMessage, setWaMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [receipts, setReceipts] = useState<{ gmail: ChannelReceipt; whatsapp: ChannelReceipt } | null>(null);
  const [calendarWarning, setCalendarWarning] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const startIso = (() => {
    if (!dateTime) return "";
    const parsed = new Date(dateTime);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  })();

  async function loadPreview() {
    if (!startIso) { setError("Escolha a nova data e hora."); return; }
    setPreviewLoading(true); setError(""); setReceipts(null);
    try {
      const data = await schedulingApi.notifyPreview(booking.id, startIso, duration, responsibleId, signoff);
      setPreview(data);
      setNotifyGmail(false);
      setNotifyWhatsapp(false);
      setSubject(data.gmailSubject); setBody(data.gmailBody); setWaMessage(data.whatsappMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível gerar a prévia.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirm() {
    if (!startIso) { setError("Escolha a nova data e hora."); return; }
    setSaving(true); setError("");
    try {
      const result = await schedulingApi.adminReschedule(booking.id, {
        startAt: startIso, duration, responsibleId: responsibleId || null, notifyGmail, notifyWhatsapp,
        gmailSubject: subject, gmailBody: body, whatsappMessage: waMessage,
        operationKey: operationKey.current,
        signoff,
      });
      setReceipts(result.receipts);
      setCalendarWarning(result.calendarSync?.synced === false && !result.calendarSync.queued ? (result.calendarSync.error || "A agenda externa ainda precisa ser conciliada.") : "");
      setDone(true);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível reagendar.");
    } finally {
      setSaving(false);
    }
  }

  const retryableFailures = Boolean(
    (receipts?.gmail && !receipts.gmail.sent && !receipts.gmail.uncertain && !receipts.gmail.queued)
    || (receipts?.whatsapp && !receipts.whatsapp.sent && !receipts.whatsapp.uncertain && !receipts.whatsapp.queued),
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={`Reagendar ${booking.attendee_name}`}>
      <div className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)]">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-black">Reagendar · {booking.attendee_name}</h2>
            <p className="text-xs font-semibold text-[var(--text-secondary)]">{service?.name || "Serviço"} · {booking.timezone || "America/Sao_Paulo"}</p>
          </div>
          <Button size="sm" onClick={onClose}>Fechar</Button>
        </div>

        <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-4 text-sm">
          <p><strong>Atual:</strong> {formatDateTime(booking.start_at)}</p>
          <div className={`grid gap-3 ${eligibleProfessionals.length ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            <label className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">Nova data e hora
              <input type="datetime-local" value={dateTime} onChange={(e) => { operationKey.current = newOperationKey(); setDateTime(e.target.value); setPreview(null); setReceipts(null); setDone(false); }} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3" />
            </label>
            <label className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">Duração
              <select value={duration} onChange={(e) => { operationKey.current = newOperationKey(); setDuration(Number(e.target.value)); setPreview(null); setReceipts(null); setDone(false); }} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3">
                {durations.map((item) => <option key={item} value={item}>{item} min</option>)}
              </select>
            </label>
            {eligibleProfessionals.length > 0 && <label className="grid gap-1 text-xs font-bold text-[var(--text-secondary)]">Profissional
              <select aria-label="Profissional" value={responsibleId} onChange={(e) => { operationKey.current = newOperationKey(); setResponsibleId(e.target.value); setPreview(null); setReceipts(null); setDone(false); }} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3">
                {eligibleProfessionals.map((item) => <option key={item.userId} value={item.userId}>{item.name} · {item.profession || item.position || "Profissional"}</option>)}
              </select>
            </label>}
          </div>
          <div><Button size="sm" variant="primary" disabled={previewLoading || !startIso} onClick={() => void loadPreview()}>{previewLoading ? "Gerando prévia…" : "Gerar prévia e canais"}</Button></div>
          <label className="grid max-w-sm gap-1 text-xs font-bold text-[var(--text-secondary)]">Assinatura da mensagem
            <select aria-label="Assinatura da mensagem" value={signoff} onChange={(e) => { operationKey.current = newOperationKey(); setSignoff(e.target.value as "team" | "professional"); setPreview(null); setReceipts(null); setDone(false); }} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3">
              <option value="team">Atenciosamente, Equipe Norium</option>
              <option value="professional">Atenciosamente, profissional selecionado</option>
            </select>
          </label>
        </div>

        {preview && (
          <div className="mt-4 grid gap-4">
            <div className="grid gap-1 rounded-xl border border-[var(--border)] p-4 text-sm">
              <p><strong>De:</strong> {formatDateTime(preview.oldStartAt)}</p>
              <p><strong>Para:</strong> {formatDateTime(preview.newStartAt)} <span className="text-xs text-[var(--text-secondary)]">({preview.timezone})</span></p>
              {preview.professionalChanged && <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2 font-semibold text-amber-600"><strong>Profissional alterado:</strong> {preview.previousProfessionalName || "anterior"} → {preview.newProfessionalName || "novo profissional"}</p>}
              <p><strong>Assinatura:</strong> {preview.signature || "Equipe Norium"}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-start gap-2 rounded-xl border border-[var(--border)] p-3 text-sm font-bold">
                <input type="checkbox" checked={notifyGmail} disabled={!preview.gmailConnected} onChange={(e) => setNotifyGmail(e.target.checked)} className="mt-1" />
                <span>Avisar por Gmail<br /><small className="font-semibold text-[var(--text-secondary)]">{preview.gmailConnected ? preview.attendeeEmail : "Gmail não conectado — conecte na tela de E-mails."}</small></span>
              </label>
              <label className="flex items-start gap-2 rounded-xl border border-[var(--border)] p-3 text-sm font-bold">
                <input type="checkbox" checked={notifyWhatsapp} disabled={!preview.whatsappConnected || !preview.phoneValid} onChange={(e) => setNotifyWhatsapp(e.target.checked)} className="mt-1" />
                <span>Avisar por WhatsApp<br /><small className="font-semibold text-[var(--text-secondary)]">{!preview.phoneValid ? "Telefone do agendamento inválido." : preview.whatsappConnected ? (preview.attendeePhone || "Telefone do agendamento") : "WhatsApp não conectado — conecte na Central de Chat."}</small></span>
              </label>
            </div>
            {notifyGmail && (
              <div className="grid gap-2 rounded-xl border border-[var(--border)] p-4">
                <p className="text-xs font-black uppercase text-[var(--text-secondary)]">Prévia do e-mail (editável)</p>
                <input aria-label="Assunto do e-mail" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold" />
                <textarea aria-label="Corpo do e-mail" value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} className="min-h-28 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm" />
              </div>
            )}
            {notifyWhatsapp && (
              <div className="grid gap-2 rounded-xl border border-[var(--border)] p-4">
                <p className="text-xs font-black uppercase text-[var(--text-secondary)]">Prévia do WhatsApp (editável)</p>
                <textarea aria-label="Mensagem do WhatsApp" value={waMessage} maxLength={4000} onChange={(e) => setWaMessage(e.target.value)} className="min-h-24 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm" />
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={saving} onClick={() => void confirm()}>{saving ? "Reagendando…" : done ? "Reagendamento salvo" : "Confirmar reagendamento"}</Button>
              {done && retryableFailures && <Button disabled={saving} onClick={() => void confirm()}>Tentar canais com falha</Button>}
            </div>
          </div>
        )}

        {receipts && (
          <div className="mt-4 grid gap-2 text-sm">
            <ReceiptLine channel="Gmail" receipt={receipts.gmail} enabled={notifyGmail} />
            <ReceiptLine channel="WhatsApp" receipt={receipts.whatsapp} enabled={notifyWhatsapp} />
          </div>
        )}
        {calendarWarning && <p role="status" className="mt-4 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm font-semibold text-amber-600">{calendarWarning}</p>}
        {error && <p role="alert" className="mt-4 rounded-lg border border-red-400/40 bg-red-500/10 p-3 text-sm font-semibold text-red-500">{error}</p>}
      </div>
    </div>
  );
}

function ReceiptLine({ channel, receipt, enabled }: { channel: string; receipt: ChannelReceipt; enabled: boolean }) {
  if (!enabled || !receipt) return null;
  if (receipt.sent) return <p className="rounded-lg border border-emerald-400/40 bg-emerald-500/10 p-3 font-semibold text-emerald-600">{channel} enviado{receipt.replay ? " (recibo reaproveitado, sem duplicar)" : ""} · recibo {receipt.receipt?.messageId || "verificado"}.</p>;
  if (receipt.queued) return <p className="rounded-lg border border-sky-400/40 bg-sky-500/10 p-3 font-semibold text-sky-600">{channel}: envio iniciado em segundo plano. O reagendamento já foi salvo.</p>;
  return <p className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 font-semibold text-amber-600">{channel} não enviado: {receipt.error || "falha temporária."}{receipt.needsConnection ? " Conecte a integração e tente novamente." : ""}{receipt.uncertain ? " Não reenvie antes de conferir o canal." : ""} O reagendamento foi mantido.</p>;
}
