// Formatadores e classificadores puros do modulo de e-mail.
// Extraidos de EmailDashboard.tsx sem alteracao de comportamento.
import type { GmailLabel, GmailMessage, GmailStatus } from "./types";

export const inboxCategoryMeta = {
  principal: {
    label: "Principal",
    description: "Conversas e mensagens diretas",
    query: "category:primary",
    gmailLabels: ["CATEGORY_PERSONAL"],
  },
  promocoes: {
    label: "Promoções",
    description: "Ofertas, campanhas e novidades",
    query: "category:promotions",
    gmailLabels: ["CATEGORY_PROMOTIONS"],
  },
  social: {
    label: "Social",
    description: "Redes, contatos e comunidades",
    query: "category:social",
    gmailLabels: ["CATEGORY_SOCIAL"],
  },
  atualizacoes: {
    label: "Atualizações",
    description: "Alertas, confirmações e fóruns",
    query: "{category:updates category:forums}",
    gmailLabels: ["CATEGORY_UPDATES", "CATEGORY_FORUMS"],
  },
} as const;

export type InboxCategoryKey = keyof typeof inboxCategoryMeta;

export function inboxCategoryQuery(category: InboxCategoryKey) {
  return inboxCategoryMeta[category].query;
}

export function inboxCategoryUnreadCounts(labels: GmailLabel[]): Record<InboxCategoryKey, number> {
  const unreadByLabel = new Map(labels.map((label) => [label.id.toUpperCase(), label.messagesUnread || 0]));
  return (Object.keys(inboxCategoryMeta) as InboxCategoryKey[]).reduce<Record<InboxCategoryKey, number>>(
    (counts, category) => {
      counts[category] = inboxCategoryMeta[category].gmailLabels.reduce(
        (total, label) => total + (unreadByLabel.get(label) || 0),
        0,
      );
      return counts;
    },
    { principal: 0, promocoes: 0, social: 0, atualizacoes: 0 },
  );
}

export const emailCategoryMeta = {
  principal: { label: "Principal", tone: "bg-sky-400/12 text-sky-100 border-sky-300/25" },
  financeiro: { label: "Financeiro", tone: "bg-emerald-400/12 text-emerald-100 border-emerald-300/25" },
  trabalho: { label: "Trabalho", tone: "bg-blue-400/12 text-blue-100 border-blue-300/25" },
  promocoes: { label: "Promoções", tone: "bg-pink-400/12 text-pink-100 border-pink-300/25" },
  social: { label: "Social", tone: "bg-violet-400/12 text-violet-100 border-violet-300/25" },
  atualizacoes: { label: "Atualizações", tone: "bg-cyan-400/12 text-cyan-100 border-cyan-300/25" },
  suporte: { label: "Suporte", tone: "bg-amber-400/12 text-amber-100 border-amber-300/25" },
} as const;

export type EmailCategoryKey = keyof typeof emailCategoryMeta;

export function splitRecipients(value: string) {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function initials(name: string) {
  const parts = name.replace(/<.*?>/g, "").trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] || "N") + (parts[1]?.[0] || "");
}

export function accountInitials(status: GmailStatus | null) {
  return initials(status?.name || status?.email || "Conta Norium").slice(0, 2).toUpperCase();
}

export function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function classifyEmailCategory(message: GmailMessage): EmailCategoryKey {
  const labels = new Set((message.labels || []).map((label) => label.toUpperCase()));
  const text = normalizeText(`${message.fromName} ${message.fromEmail} ${message.subject} ${message.snippet}`);
  if (labels.has("CATEGORY_PROMOTIONS") || /promocao|promocoes|oferta|desconto|cupom|black friday/.test(text)) return "promocoes";
  if (labels.has("CATEGORY_SOCIAL") || /linkedin|facebook|instagram|rede social/.test(text)) return "social";
  if (/boleto|fatura|recibo|pagamento|pix|nubank|banco|cartao|nota fiscal/.test(text)) return "financeiro";
  if (labels.has("CATEGORY_UPDATES") || /atualizacao|notificacao|confirmacao|alerta|codigo|acesso/.test(text)) return "atualizacoes";
  if (/cliente|proposta|contrato|reuniao|orcamento|trabalho|comercial|projeto/.test(text)) return "trabalho";
  if (/suporte|ticket|erro|chamado|atendimento|protocolo/.test(text)) return "suporte";
  return "principal";
}

export function friendlyGmailLabel(label: string) {
  const systemLabels: Record<string, string> = {
    CATEGORY_PERSONAL: "Principal",
    CATEGORY_PROMOTIONS: "Promocoes",
    CATEGORY_SOCIAL: "Social",
    CATEGORY_UPDATES: "Atualizacoes",
    CATEGORY_FORUMS: "Foruns",
    INBOX: "Caixa de entrada",
    UNREAD: "Nao lido",
    STARRED: "Com estrela",
    IMPORTANT: "Importante",
    SENT: "Enviado",
    DRAFT: "Rascunho",
    SPAM: "Spam",
    TRASH: "Lixo",
  };
  const key = label.toUpperCase();
  return systemLabels[key] || label.replace(/^CATEGORY_/i, "Categoria ").replace(/^Label_/i, "Marcador ");
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Nao consegui ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

export function isImage(mimeType: string) {
  return mimeType.startsWith("image/");
}

export function cleanEmailSourceText(value?: string) {
  return (value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

export function looksLikeBadEmailSuggestion(value: string) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("historico") ||
    normalized.includes("histórico") ||
    normalized.includes("vazio") ||
    normalized.includes("mais contexto") ||
    normalized.includes("preciso de contexto") ||
    normalized.includes("nao consigo") ||
    normalized.includes("não consigo")
  );
}
