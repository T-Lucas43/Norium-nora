import type { EmailCategoryKey } from "../../features/mail/formatters";

/** Cor de etiqueta (nx-badge) de cada categoria de e-mail, igual nos temas claro e escuro. */
export const mailCategoryBadge: Record<EmailCategoryKey, string> = {
  principal: "is-blue",
  financeiro: "is-green",
  trabalho: "is-blue",
  promocoes: "is-red",
  social: "is-violet",
  atualizacoes: "is-blue",
  suporte: "is-amber",
};
