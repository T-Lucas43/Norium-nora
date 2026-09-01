function isSameCalendarDay(first: Date, second: Date) {
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

export function formatMemberLastAccess(value?: string | null, now = new Date()) {
  if (!value) return "Último acesso não registrado";
  const accessedAt = new Date(value);
  if (Number.isNaN(accessedAt.getTime())) return "Último acesso não registrado";

  const time = accessedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (isSameCalendarDay(accessedAt, now)) return `Último acesso hoje às ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(accessedAt, yesterday)) return `Último acesso ontem às ${time}`;

  const date = accessedAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `Último acesso em ${date} às ${time}`;
}
