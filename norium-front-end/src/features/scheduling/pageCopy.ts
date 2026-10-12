export const DEFAULT_BOOKING_COPY = {
  introEyebrow: "Agende seu serviço",
  introTitle: "Escolha seu melhor horário.",
  introDescription: "Selecione a data e o horário disponíveis e confirme seus dados.",
  serviceLabel: "Seu serviço",
  closingNote: "Seu horário, organizado.\nEscolha a data para continuar.",
  headerLabel: "Agendamento online",
  dateLabel: "Escolha a data",
  timesLabel: "Horários disponíveis",
  professionalLabel: "Escolha o profissional",
  chooseServiceLabel: "Escolha o serviço",
  durationLabel: "Duração do serviço",
  detailsTitle: "Como podemos chamar você?",
  detailsEyebrow: "Quase lá",
  detailsDescription: "Preencha seus dados para confirmar o atendimento.",
  dateStepLabel: "Data e horário",
  detailsStepLabel: "Seus dados",
  confirmationStepLabel: "Confirmação",
  confirmButton: "Confirmar agendamento",
  nextHint: "Depois de escolher um horário, você poderá preencher seus dados.",
  footerText: "Agendamento organizado com Norium",
  confirmationTitle: "Agendamento confirmado",
  confirmationDescription: "Seu horário foi reservado. Confira os detalhes abaixo.",
  timezoneLabel: "Horários em",
  instructionsLabel: "Antes do atendimento",
  onlineLabel: "Atendimento online",
  emptySlotsTitle: "Nenhum horário disponível nesta data.",
  emptySlotsHint: "Selecione outro dia no calendário.",
  nameLabel: "Nome completo",
  emailLabel: "E-mail",
  phoneLabel: "WhatsApp",
};

export type BookingCopy = typeof DEFAULT_BOOKING_COPY;

export function bookingCopy(theme?: Record<string, string>): BookingCopy {
  return Object.fromEntries(Object.entries(DEFAULT_BOOKING_COPY).map(([key, fallback]) =>
    [key, typeof theme?.[key] === "string" ? theme[key] : fallback],
  )) as BookingCopy;
}

export const DEFAULT_BOOKING_DESIGN = { surface: "#ffffff", muted: "#63728a", border: "#e4eaf3", darkBackground: "#0d1421", darkText: "#edf2fa", darkSurface: "#151f30", darkMuted: "#a5b4cc", darkBorder: "#2b3a50", fontFamily: "inter", cardStyle: "soft", layout: "sidebar", showHeader: "true", showFooter: "true" };
export function bookingDesign(theme?: Record<string, string>) {
  return Object.fromEntries(Object.entries(DEFAULT_BOOKING_DESIGN).map(([key, fallback]) => [key, theme?.[key] || fallback])) as typeof DEFAULT_BOOKING_DESIGN;
}
export const BOOKING_COPY_LABELS: Partial<Record<keyof BookingCopy, string>> = {
  headerLabel: "Texto do cabeçalho", dateLabel: "Título do calendário", timesLabel: "Título dos horários", professionalLabel: "Título dos profissionais", chooseServiceLabel: "Rótulo da escolha de serviço", durationLabel: "Rótulo da duração", detailsTitle: "Título do formulário", detailsEyebrow: "Chamada do formulário", detailsDescription: "Orientação do formulário", dateStepLabel: "Etapa de data e horário", detailsStepLabel: "Etapa dos dados", confirmationStepLabel: "Etapa de confirmação", confirmButton: "Texto do botão de confirmação", nextHint: "Orientação antes do formulário", footerText: "Texto do rodapé", confirmationTitle: "Título após confirmar", confirmationDescription: "Mensagem após confirmar", timezoneLabel: "Rótulo do fuso horário", instructionsLabel: "Título das instruções", onlineLabel: "Rótulo do atendimento online", emptySlotsTitle: "Mensagem sem horários", emptySlotsHint: "Orientação sem horários", nameLabel: "Rótulo do nome", emailLabel: "Rótulo do e-mail", phoneLabel: "Rótulo do telefone",
};
