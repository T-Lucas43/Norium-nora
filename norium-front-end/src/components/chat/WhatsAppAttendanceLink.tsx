import { tabPath } from "../../app/navigation/tabs";

export default function WhatsAppAttendanceLink({ metadata }: { metadata?: Record<string, unknown> | null }) {
  if (!metadata || !["whatsapp_internal_mention", "whatsapp_assignment"].includes(String(metadata.action))) return null;
  const inbox = String(metadata.inboxId || ""), reference = String(metadata.attendanceRef || "");
  if (!/^[a-f0-9]{64}$/.test(inbox) || !/^[a-f0-9]{64}$/.test(reference)) return null;
  return <a className="nx-btn is-sm mt-2" href={`${tabPath("Chat")}?inbox=${inbox}&attendance=${reference}`}>Abrir atendimento WhatsApp</a>;
}
