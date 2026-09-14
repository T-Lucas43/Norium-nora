import noriumAgendaIcon from "../../assets/generated/norium-agenda.png";
import noriumAiModelsIcon from "../../assets/generated/norium-ai-models.png";
import noriumAutomationsIcon from "../../assets/generated/norium-automations.svg";
import noriumBrowserAgentIcon from "../../assets/generated/norium-browser-agent.png";
import noriumCentralIcon from "../../assets/generated/norium-central.png";
import noriumClientsIcon from "../../assets/generated/norium-clients.png";
import noriumControlIcon from "../../assets/generated/norium-control.png";
import noriumDashboardIcon from "../../assets/generated/norium-dashboard.png";
import documentModelsIcon from "../../assets/generated/document-models.png";
import noriumFinanceIcon from "../../assets/generated/norium-finance.png";
import noriumGovernanceIcon from "../../assets/generated/norium-governance.png";
import noriumHelpIcon from "../../assets/generated/norium-help.png";
import noriumKnowledgeIcon from "../../assets/generated/norium-knowledge.png";
import noriumMailIcon from "../../assets/generated/norium-mail.png";
import noriumMarketplaceIcon from "../../assets/generated/norium-marketplace.png";
import noriumMoreIcon from "../../assets/generated/norium-more.png";
import noriumReportsIcon from "../../assets/generated/norium-reports.png";
import noriumSettingsIcon from "../../assets/generated/norium-settings.png";
import noriumStudioIcon from "../../assets/generated/norium-studio.png";
import noriumTasksIcon from "../../assets/generated/norium-tasks.png";
import noriumTeamChatIcon from "../../assets/generated/norium-team-chat.png";
import noriumTeamIcon from "../../assets/generated/norium-team.png";
import whatsappIcon from "../../assets/generated/whatsapp-premium.png";

function normalizeModuleName(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

const moduleIconAssets: Record<string, string> = {
  dashboard: noriumDashboardIcon,
  controle: noriumControlIcon,
  "controle operacional": noriumControlIcon,
  central: noriumCentralIcon,
  "central de trabalho": noriumCentralIcon,
  pendencias: noriumTasksIcon,
  notificacoes: noriumCentralIcon,
  emails: noriumMailIcon,
  "e-mails": noriumMailIcon,
  agenda: noriumAgendaIcon,
  chat: whatsappIcon,
  teamchat: noriumTeamChatIcon,
  tarefas: noriumTasksIcon,
  gastos: noriumFinanceIcon,
  financeiro: noriumFinanceIcon,
  automacoes: noriumAutomationsIcon,
  relatorios: noriumReportsIcon,
  propostas: documentModelsIcon,
  documentos: documentModelsIcon,
  "central de documentos": documentModelsIcon,
  "agente navegador": noriumBrowserAgentIcon,
  conhecimento: noriumKnowledgeIcon,
  marketplace: noriumMarketplaceIcon,
  "ia e modelos": noriumAiModelsIcon,
  equipe: noriumTeamIcon,
  "chat da equipe": noriumTeamChatIcon,
  clientes: noriumClientsIcon,
  governanca: noriumGovernanceIcon,
  brainstorm: noriumStudioIcon,
  estudio: noriumStudioIcon,
  "estudio colaborativo": noriumStudioIcon,
  mais: noriumMoreIcon,
  configuracoes: noriumSettingsIcon,
  ajuda: noriumHelpIcon,
};

export function getModuleIconAsset(name: string) {
  return moduleIconAssets[normalizeModuleName(name)];
}
