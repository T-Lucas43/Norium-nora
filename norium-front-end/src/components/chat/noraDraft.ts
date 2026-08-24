const LEADING_NORA_WRAPPERS = [
  /^\s*(?:\*\*|__)?\s*segue\s+(?:a\s+)?mensagem\s+que\s+voc[êe]\s+pode\s+enviar\s+(?:(?:para|ao|à)\s+)[^:\r\n]{1,120}\s*:\s*(?:\*\*|__)?\s*/i,
  /^\s*(?:\*\*|__)?\s*aqui\s+est[aá]\s+(?:a|uma)\s+(?:mensagem|resposta|sugest[aã]o\s+de\s+resposta)(?:\s+[^:\r\n]{0,120})?\s*:\s*(?:\*\*|__)?\s*/i,
  /^\s*(?:\*\*|__)?\s*(?:mensagem\s+sugerida|sugest[aã]o\s+de\s+resposta|resposta\s+sugerida)\s*:\s*(?:\*\*|__)?\s*/i,
];

/**
 * Removes only known Nora presentation labels before a reviewed draft is
 * placed in the WhatsApp composer. The operator's actual wording is kept.
 */
export function noraDraftForInsertion(value: string): string {
  const original = value.trim();
  if (!original) return "";

  for (const wrapper of LEADING_NORA_WRAPPERS) {
    const cleaned = original.replace(wrapper, "").trim();
    if (cleaned && cleaned !== original) return cleaned;
  }

  return original;
}
