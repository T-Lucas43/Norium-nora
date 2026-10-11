export const DEFAULT_BOOKING_COPY = {
  introEyebrow: "Agende seu serviço",
  introTitle: "Escolha seu melhor horário.",
  introDescription: "Selecione a data e o horário disponíveis e confirme seus dados.",
  serviceLabel: "Seu serviço",
  closingNote: "Seu horário, organizado.\nEscolha a data para continuar.",
};

export type BookingCopy = typeof DEFAULT_BOOKING_COPY;

export function bookingCopy(theme?: Record<string, string>): BookingCopy {
  return Object.fromEntries(Object.entries(DEFAULT_BOOKING_COPY).map(([key, fallback]) =>
    [key, typeof theme?.[key] === "string" ? theme[key] : fallback],
  )) as BookingCopy;
}
