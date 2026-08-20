const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

function spokenEmail(value: string) {
  return value
    .replace("@", " arroba ")
    .replaceAll(".", " ponto ")
    .replaceAll("_", " sublinhado ")
    .replaceAll("-", " hífen ");
}

function naturalizeList(block: string) {
  const items = block
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+] |\d+[.)]\s*)/, "").trim())
    .filter(Boolean);
  if (!items.length) return "";
  if (items.length === 1) return `${items[0]}.`;
  const last = items.at(-1);
  return `Encontrei ${items.length} pontos: ${items.slice(0, -1).join("; ")}; e ${last}.`;
}

export function speechTextFromDisplay(text: string, maxLength = 1800) {
  let value = text.replace(/\r\n?/g, "\n");

  value = value.replace(/```[\s\S]*?```/g, " Incluí um trecho de código na tela. ");
  value = value.replace(/(?:^|\n)(?:\s*\|.*\|\s*\n?){2,}/gm, "\nOrganizei os detalhes em uma tabela na tela.\n");
  value = value.replace(
    /(?:^|\n)(?:\s*(?:[-*+] |\d+[.)]\s*).+(?:\n|$)){2,}/gm,
    (block) => `\n${naturalizeList(block)}\n`,
  );
  value = value.replace(/^\s*(?:[-*+] |\d+[.)]\s*)/gm, "");
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, label: string) => label ? `Imagem: ${label}.` : "Há uma imagem disponível na tela.");
  value = value.replace(/\[([^\]]+)]\((?:https?:\/\/|mailto:)[^)]+\)/g, "$1");
  value = value.replace(/https?:\/\/\S+/gi, "um link disponível na tela");
  value = value.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (email) => spokenEmail(email));
  value = value.replace(/`([^`]+)`/g, (_, inline: string) => inline.length <= 36 ? inline : "um trecho técnico disponível na tela");
  value = value.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  value = value.replace(/[>*_~]/g, " ");
  value = value.replace(/[|{}\[\]<>]/g, " ");
  value = value.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ");

  value = value.replace(/R\$\s*(\d+(?:[.,]\d{1,2})?)/gi, "$1 reais");
  value = value.replace(/(\d+(?:[.,]\d+)?)\s*%/g, "$1 por cento");
  value = value.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_, day: string, month: string, year: string) => {
    const monthName = MONTHS[Number(month) - 1];
    return monthName ? `${Number(day)} de ${monthName} de ${year}` : `${day} de ${month} de ${year}`;
  });
  value = value.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, hour: string, minute: string) =>
    minute === "00" ? `${Number(hour)} horas` : `${Number(hour)} horas e ${Number(minute)} minutos`,
  );

  const pronunciations: Array<[RegExp, string]> = [
    [/\bNorium\b/gi, "Nórium"],
    [/\bOAuth\b/gi, "ô auth"],
    [/\bWebSockets?\b/gi, "uéb sóquete"],
    [/\bAPIs?\b/g, "A P I"],
    [/\bIA\b/g, "I A"],
    [/\bHTTP\b/g, "H T T P"],
    [/\bJSON\b/g, "jêison"],
    [/\bURLs?\b/gi, "links"],
  ];
  for (const [pattern, replacement] of pronunciations) value = value.replace(pattern, replacement);

  return value
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?]){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function takeNaturalSpeechSegments(buffer: string, flush = false) {
  const segments: string[] = [];
  let consumed = 0;
  const sentenceBoundary = /[.!?…](?=\s|$)/g;
  let match: RegExpExecArray | null;

  while ((match = sentenceBoundary.exec(buffer)) !== null) {
    const end = match.index + match[0].length;
    const candidate = buffer.slice(consumed, end).trim();
    if (candidate) segments.push(candidate);
    consumed = end;
  }

  let remainder = buffer.slice(consumed).trimStart();
  if (!segments.length && remainder.length >= 110) {
    const searchUntil = Math.min(remainder.length, 180);
    const softBoundary = Math.max(
      remainder.lastIndexOf(", ", searchUntil),
      remainder.lastIndexOf(": ", searchUntil),
      remainder.lastIndexOf("; ", searchUntil),
    );
    if (softBoundary >= 60) {
      segments.push(remainder.slice(0, softBoundary + 1));
      remainder = remainder.slice(softBoundary + 1).trimStart();
    }
  }

  if (flush && remainder.trim()) {
    segments.push(remainder.trim());
    remainder = "";
  }

  return {
    segments: segments.map((segment) => speechTextFromDisplay(segment)).filter(Boolean),
    remainder,
  };
}
