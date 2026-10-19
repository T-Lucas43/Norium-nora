export type ClientStage = "new" | "contacted" | "proposal" | "won" | "lost";
export type ClientStatus = "lead" | "active" | "inactive";
export type ClientAccessPermission = "view" | "edit";
export type ClientAccess = {
  teamPermission: "none" | ClientAccessPermission;
  people: Array<{
    userId: string;
    name?: string;
    email?: string;
    permission: ClientAccessPermission;
  }>;
};
export type Client = {
  id: string;
  name: string;
  company: string;
  document?: string;
  email: string;
  phone: string;
  segment: string;
  status: ClientStatus;
  stage: ClientStage;
  ownerName: string;
  ownerId?: string;
  city?: string;
  state?: string;
  nextActionAt: string | null;
  tags: string[];
  notes: string;
  updatedAt: string;
  archivedAt?: string | null;
  avatarId?: string;
  attachmentCount?: number;
  createdBy?: string;
  createdByName?: string;
  accessRole?: "owner" | "edit" | "view" | null;
  access?: ClientAccess;
};
export type Client360 = {
  summary: Record<
    | "emails"
    | "messages"
    | "tasks"
    | "finance"
    | "calendar"
    | "attachments"
    | "followUps",
    number
  >;
  timeline: Array<{
    id: string;
    type: string;
    title: string;
    description: string;
    timestamp: string;
    deepLink?: {
      tab: string;
      entityType: string;
      entityId: string;
      metadata?: Record<string, unknown>;
    };
  }>;
  lastContactAt: string | null;
};
export const stageLabels: Record<ClientStage, string> = {
  new: "Novo contato",
  contacted: "Em contato",
  proposal: "Em proposta",
  won: "Convertido",
  lost: "Perdido",
};
export const statusLabels: Record<ClientStatus, string> = {
  lead: "Lead",
  active: "Ativo",
  inactive: "Inativo",
};
export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toLocaleUpperCase("pt-BR");
}
export function dateLabel(value?: string | null, time = false) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        ...(time ? { hour: "2-digit" as const, minute: "2-digit" as const } : {}),
      })
        .format(date)
        .replace(",", " às")
    : "Não definido";
}
/** CPF (000.000.000-00) ou CNPJ (00.000.000/0000-00) para exibição; outros valores ficam como vieram. */
export function documentLabel(value?: string) {
  const digits = (value || "").replace(/\D/g, "");
  if (digits.length === 11)
    return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (digits.length === 14)
    return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return value || "";
}
/** Telefone brasileiro (00) 00000-0000 ou (00) 0000-0000 para exibição. */
export function phoneLabel(value?: string) {
  const digits = (value || "").replace(/\D/g, "");
  const local = digits.length === 13 && digits.startsWith("55") ? digits.slice(2) : digits;
  if (!/^\s*(?:\+|00)/.test(value || "") || local !== digits) {
    if (local.length === 11) return local.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
    if (local.length === 10) return local.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  }
  return value || "";
}
export function whatsappUrl(phone: string): string | null {
  let number = phone.replace(/\D/g, "");
  const international = /^\s*(?:\+|00)/.test(phone);
  if (number.startsWith("00")) number = number.slice(2);
  if (!international && (number.length === 10 || number.length === 11))
    number = `55${number}`;
  return /^[1-9]\d{9,14}$/.test(number) ? `https://wa.me/${number}` : null;
}
export function gmailUrl(email: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ? `https://mail.google.com/mail/u/0/?view=cm&fs=1&to=${encodeURIComponent(email.trim())}`
    : null;
}
export async function uploadPayload(file: File) {
  if (!file.size || file.size > 15 * 1024 * 1024)
    throw new Error("Escolha um arquivo de até 15 MB.");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    reader.readAsDataURL(file);
  });
  return { fileName: file.name, dataBase64: data };
}
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function openContract(id: string) {
  const link = { tab: "Propostas", entityType: "contract", entityId: id };
  localStorage.setItem("norium-deep-link", JSON.stringify(link));
  window.dispatchEvent(new CustomEvent("norium:deep-link", { detail: link }));
}
