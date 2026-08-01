export function formatMoney(cents: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format((Number(cents) || 0) / 100);
}

export function formatCompactMoney(cents: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format((Number(cents) || 0) / 100);
}

export function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("pt-BR");
}

export function toCents(value: string | number) {
  const normalized = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Math.max(0, Math.round((Number.isFinite(normalized) ? normalized : 0) * 100));
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
