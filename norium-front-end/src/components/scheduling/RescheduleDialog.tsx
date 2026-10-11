import { useRef, useState } from "react";
import "./scheduling-v2.css";
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
    <div className="nx-sc-overlay" role="dialog" aria-modal="true" aria-label={`Reagendar ${booking.attendee_name}`}>
      <div className="nx-card nx-sc-modal" style={{ maxWidth: 680 }}>
        <div className="nx-sc-modal-h">
          <div className="nx-grow">
            <h2>Reagendar · {booking.attendee_name}</h2>
            <p>{service?.name || "Serviço"} · {booking.timezone || "America/Sao_Paulo"}</p>
          </div>
          <button type="button" className="nx-btn is-sm" onClick={onClose}>Fechar</button>
        </div>

        <div className="nx-sc-modal-b">
          <div className="nx-sc-box">
            <p style={{ margin: 0, fontSize: 13.5 }}><strong style={{ fontWeight: 500 }}>Atual:</strong> {formatDateTime(booking.start_at)}</p>
            <div className={eligibleProfessionals.length ? "nx-sc-3" : "nx-sc-2"}>
              <label className="nx-sc-field"><span>Nova data e hora</span>
                <input type="datetime-local" value={dateTime} onChange={(e) => { operationKey.current = newOperationKey(); setDateTime(e.target.value); setPreview(null); setReceipts(null); setDone(false); }} />
              </label>
              <label className="nx-sc-field"><span>Duração</span>
                <select value={duration} onChange={(e) => { operationKey.current = newOperationKey(); setDuration(Number(e.target.value)); setPreview(null); setReceipts(null); setDone(false); }}>
                  {durations.map((item) => <option key={item} value={item}>{item} min</option>)}
                </select>
              </label>
              {eligibleProfessionals.length > 0 && <label className="nx-sc-field"><span>Profissional</span>
                <select aria-label="Profissional" value={responsibleId} onChange={(e) => { operationKey.current = newOperationKey(); setResponsibleId(e.target.value); setPreview(null); setReceipts(null); setDone(false); }}>
                  {eligibleProfessionals.map((item) => <option key={item.userId} value={item.userId}>{item.name} · {item.profession || item.position || "Profissional"}</option>)}
                </select>
              </label>}
            </div>
            <label className="nx-sc-field" style={{ maxWidth: 360 }}><span>Assinatura da mensagem</span>
              <select aria-label="Assinatura da mensagem" value={signoff} onChange={(e) => { operationKey.current = newOperationKey(); setSignoff(e.target.value as "team" | "professional"); setPreview(null); setReceipts(null); setDone(false); }}>
                <option value="team">Atenciosamente, Equipe Norium</option>
                <option value="professional">Atenciosamente, profissional selecionado</option>
              </select>
            </label>
            <div><button type="button" className="nx-btn is-primary is-sm" disabled={previewLoading || !startIso} onClick={() => void loadPreview()}>{previewLoading ? "Gerando prévia…" : "Gerar prévia e canais"}</button></div>
          </div>

          {preview && (
            <>
              <div className="nx-card" style={{ display: "grid", gap: 6, padding: 14, fontSize: 13.5 }}>
                <p style={{ margin: 0 }}><strong style={{ fontWeight: 500 }}>De:</strong> {formatDateTime(preview.oldStartAt)}</p>
                <p style={{ margin: 0 }}><strong style={{ fontWeight: 500 }}>Para:</strong> {formatDateTime(preview.newStartAt)} <span className="nx-faint nx-small">({preview.timezone})</span></p>
                {preview.professionalChanged && <p className="nx-sc-warn" style={{ margin: 0 }}><strong style={{ fontWeight: 600 }}>Profissional alterado:</strong> {preview.previousProfessionalName || "anterior"} → {preview.newProfessionalName || "novo profissional"}</p>}
                <p style={{ margin: 0 }}><strong style={{ fontWeight: 500 }}>Assinatura:</strong> {preview.signature || "Equipe Norium"}</p>
              </div>
              <div className="nx-sc-2">
                <label className="nx-sc-channel">
                  <input type="checkbox" checked={notifyGmail} disabled={!preview.gmailConnected} onChange={(e) => setNotifyGmail(e.target.checked)} />
                  <span>Avisar por Gmail<small>{preview.gmailConnected ? preview.attendeeEmail : "Gmail não conectado — conecte na tela de E-mails."}</small></span>
                </label>
                <label className="nx-sc-channel">
                  <input type="checkbox" checked={notifyWhatsapp} disabled={!preview.whatsappConnected || !preview.phoneValid} onChange={(e) => setNotifyWhatsapp(e.target.checked)} />
                  <span>Avisar por WhatsApp<small>{!preview.phoneValid ? "Telefone do agendamento inválido." : preview.whatsappConnected ? (preview.attendeePhone || "Telefone do agendamento") : "WhatsApp não conectado — conecte na Central de Chat."}</small></span>
                </label>
              </div>
              {notifyGmail && (
                <div className="nx-sc-box">
                  <p className="nx-sc-lbl" style={{ margin: 0 }}>Prévia do e-mail (editável)</p>
                  <input aria-label="Assunto do e-mail" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
                  <textarea aria-label="Corpo do e-mail" value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 112 }} />
                </div>
              )}
              {notifyWhatsapp && (
                <div className="nx-sc-box">
                  <p className="nx-sc-lbl" style={{ margin: 0 }}>Prévia do WhatsApp (editável)</p>
                  <textarea aria-label="Mensagem do WhatsApp" value={waMessage} maxLength={4000} onChange={(e) => setWaMessage(e.target.value)} style={{ minHeight: 96 }} />
                </div>
              )}
              <div className="nx-sc-btns">
                <button type="button" className="nx-btn is-primary" disabled={saving} onClick={() => void confirm()}>{saving ? "Reagendando…" : done ? "Reagendamento salvo" : "Confirmar reagendamento"}</button>
                {done && retryableFailures && <button type="button" className="nx-btn" disabled={saving} onClick={() => void confirm()}>Tentar canais com falha</button>}
              </div>
            </>
          )}

          {receipts && (
            <div style={{ display: "grid", gap: 8 }}>
              <ReceiptLine channel="Gmail" receipt={receipts.gmail} enabled={notifyGmail} />
              <ReceiptLine channel="WhatsApp" receipt={receipts.whatsapp} enabled={notifyWhatsapp} />
            </div>
          )}
          {calendarWarning && <p role="status" className="nx-sc-warn" style={{ margin: 0 }}>{calendarWarning}</p>}
          {error && <p role="alert" className="nx-sc-alert" style={{ margin: 0 }}>{error}</p>}
        </div>
      </div>
    </div>
  );
}

function ReceiptLine({ channel, receipt, enabled }: { channel: string; receipt: ChannelReceipt; enabled: boolean }) {
  if (!enabled || !receipt) return null;
  if (receipt.sent) return <p className="nx-sc-ok" style={{ margin: 0 }}>{channel} enviado{receipt.replay ? " (recibo reaproveitado, sem duplicar)" : ""} · recibo {receipt.receipt?.messageId || "verificado"}.</p>;
  if (receipt.queued) return <p className="nx-sc-info" style={{ margin: 0 }}>{channel}: envio iniciado em segundo plano. O reagendamento já foi salvo.</p>;
  return <p className="nx-sc-warn" style={{ margin: 0 }}>{channel} não enviado: {receipt.error || "falha temporária."}{receipt.needsConnection ? " Conecte a integração e tente novamente." : ""}{receipt.uncertain ? " Não reenvie antes de conferir o canal." : ""} O reagendamento foi mantido.</p>;
}
