// Concentra o roteamento visual e carrega cada modulo somente quando necessario.
import { lazy, Suspense } from "react";
import type { AuthSession } from "../../types/auth";
import type {
  EventSource,
  OmnichannelEvent,
  PerfilOperador,
  SystemNotification,
} from "../../types/omnichannel";
import ModuleCoach, { type GuidedModule } from "../../components/shared/ModuleCoach";

const AgendaDashboard = lazy(() => import("../../components/agenda/AgendaDashboard"));
const AutomationsDashboard = lazy(() => import("../../components/automations/AutomationsDashboard"));
const BrainstormDashboard = lazy(() => import("../../components/brainstorm/BrainstormDashboard"));
const ChatCentral = lazy(() => import("../../components/chat/ChatCentral"));
const ClientsDashboard = lazy(() => import("../../components/clients/ClientsDashboard"));
const CommercialDashboard = lazy(() => import("../../components/commercial/CommercialDashboard"));
const Dashboard = lazy(() => import("../../components/dashboard/Dashboard"));
const EmailDashboard = lazy(() => import("../../components/emails/EmailDashboard"));
const FinanceDashboard = lazy(() => import("../../components/finance/FinanceDashboard"));
const HelpDashboard = lazy(() => import("../../components/help/HelpDashboard"));
const InboxUniversal = lazy(() => import("../../components/inbox/InboxUniversal"));
const IntelligenceHubDashboard = lazy(() => import("../../components/intelligence/IntelligenceHubDashboard"));
const MoreDashboard = lazy(() => import("../../components/more/MoreDashboard"));
const OperationsDashboard = lazy(() => import("../../components/operations/OperationsDashboard"));
const ProfileSettings = lazy(() => import("../../components/profile/ProfileSettings"));
const PlatformDashboard = lazy(() => import("../../components/platform/PlatformDashboard"));
const ReportsDashboard = lazy(() => import("../../components/reports/ReportsDashboard"));
const SettingsDashboard = lazy(() => import("../../components/settings/SettingsDashboard"));
const SystemNotificationsCenter = lazy(() => import("../../components/notifications/SystemNotificationsCenter"));
const TasksDashboard = lazy(() => import("../../components/tasks/TasksDashboard"));
const TeamDashboard = lazy(() => import("../../components/team/TeamDashboard"));
const TeamChatDrawer = lazy(() => import("../../components/team-chat/TeamChatDrawer"));
const WorkHubDashboard = lazy(() => import("../../components/workhub/WorkHubDashboard"));

function PanelLoading() {
  return (
    <div className="grid min-h-[calc(100vh-74px)] place-items-center bg-[var(--background)] text-sm font-semibold text-[var(--text-secondary)]">
      Carregando modulo...
    </div>
  );
}

type EventGroups = Record<EventSource, OmnichannelEvent[]>;

type AppPanelsProps = {
  activeTab: string;
  authSession: AuthSession;
  canUseNora: boolean;
  connected: boolean;
  emailToOpenId: string | null;
  eventsBySource: EventGroups;
  profile: PerfilOperador | null;
  systemNotifications: SystemNotification[];
  onActiveConversationChange: (conversationId: string | null) => void;
  onEmailHandled: () => void;
  onLogout: () => void;
  onOpenAdmin: () => void;
  onNavigate: (tab: string) => void;
  onOpenDeepLink: (link: { tab: string; entityType: string; entityId: string; metadata?: Record<string, unknown> }) => void;
  onOpenNora: (prompt?: string) => void;
  onOpenTeamChat: () => void;
  onProfileSaved: (profile: PerfilOperador) => void;
  onRefreshEvents: () => void;
  onSessionUpdate: (session: AuthSession) => void;
  onClearSystemNotifications: () => void;
};

export default function AppPanels({
  activeTab,
  authSession,
  canUseNora,
  connected,
  emailToOpenId,
  eventsBySource,
  profile,
  systemNotifications,
  onActiveConversationChange,
  onClearSystemNotifications,
  onEmailHandled,
  onLogout,
  onOpenAdmin,
  onNavigate,
  onOpenDeepLink,
  onOpenNora,
  onOpenTeamChat,
  onProfileSaved,
  onRefreshEvents,
  onSessionUpdate,
}: AppPanelsProps) {
  const currentUser = authSession.user;
  const activePanelClass = (...tabs: string[]) => (tabs.includes(activeTab) ? "app-panel" : "hidden");
  const isPanelMounted = (...tabs: string[]) => tabs.includes(activeTab);
  const coach = (module: GuidedModule, compact = false) => (
    <ModuleCoach module={module} onAskNora={onOpenNora} compact={compact} />
  );

  return (
    <Suspense fallback={<PanelLoading />}>
      {isPanelMounted("Dashboard", "Resumo") && (
        <section className={activePanelClass("Dashboard", "Resumo")}>
          {coach("Dashboard")}
          <Dashboard
            eventsBySource={eventsBySource}
            connected={connected}
            profile={profile}
            onNavigate={onNavigate}
            onOpenNora={onOpenNora}
          />
        </section>
      )}
      {isPanelMounted("Inbox", "Central") && (
        <section className={activePanelClass("Inbox", "Central")}>
          {coach("Central")}
          <InboxUniversal eventsBySource={eventsBySource} connected={connected} onRefresh={onRefreshEvents} />
        </section>
      )}
      {isPanelMounted("Controle") && (
        <section className={activePanelClass("Controle")}>
          {coach("Controle")}
          <OperationsDashboard onNavigate={onNavigate} userId={currentUser.id} />
        </section>
      )}
      {isPanelMounted("Pendencias") && (
        <section className={activePanelClass("Pendencias")}>
          {coach("Pendencias")}
          <WorkHubDashboard onNavigate={onNavigate} onOpenDeepLink={onOpenDeepLink} />
        </section>
      )}
      {isPanelMounted("Notificacoes", "Notificações") && (
        <section className={activePanelClass("Notificacoes", "Notificações")}>
          {coach("Notificacoes")}
          <SystemNotificationsCenter
            notifications={systemNotifications}
            connected={connected}
            onClear={onClearSystemNotifications}
            onNavigate={onNavigate}
          />
        </section>
      )}
      {isPanelMounted("E-mail", "E-mails") && (
        <section className={activePanelClass("E-mail", "E-mails")}>
          {coach("Emails")}
          <EmailDashboard
            active={activeTab === "E-mail" || activeTab === "E-mails"}
            userId={currentUser.id}
            canUseNora={canUseNora}
            selectedEmailId={emailToOpenId}
            onSelectedEmailHandled={onEmailHandled}
          />
        </section>
      )}
      {isPanelMounted("Agenda") && (
        <section className={activePanelClass("Agenda")}>
          {coach("Agenda")}
          <AgendaDashboard userId={currentUser.id} />
        </section>
      )}
      {isPanelMounted("Chat") && (
        <section className={`${activePanelClass("Chat")} app-panel-chat`}>
          {coach("Chat")}
          <ChatCentral
            active={activeTab === "Chat"}
            userId={currentUser.id}
            onConversaAtivaChange={onActiveConversationChange}
            onOpenNora={onOpenNora}
          />
        </section>
      )}
      {isPanelMounted("Tarefas") && (
        <section className={activePanelClass("Tarefas")}>
          {coach("Tarefas")}
          <TasksDashboard session={authSession} />
        </section>
      )}
      {isPanelMounted("Gastos", "Financeiro") && (
        <section className={activePanelClass("Gastos", "Financeiro")}>
          {coach("Gastos")}
          <FinanceDashboard userId={currentUser.id} />
        </section>
      )}
      {isPanelMounted("Automacoes", "Automações") && (
        <section className={activePanelClass("Automacoes", "Automações")}>
          {coach("Automacoes")}
          <AutomationsDashboard onOpenNora={onOpenNora} userId={currentUser.id} />
        </section>
      )}
      {isPanelMounted("Relatorios", "Relatórios") && (
        <section className={activePanelClass("Relatorios", "Relatórios")}>
          {coach("Relatorios")}
          <ReportsDashboard
            eventsBySource={eventsBySource}
            notifications={systemNotifications}
            connected={connected}
            userId={currentUser.id}
            onOpenNora={onOpenNora}
          />
        </section>
      )}
      {isPanelMounted("Documentos", "Propostas") && (
        <section className={activeTab === "Documentos" || activeTab === "Propostas" ? "app-panel" : "hidden"}>
          {coach("Propostas")}
          <CommercialDashboard session={authSession} onOpenNora={onOpenNora} />
        </section>
      )}
      {isPanelMounted("Agente Navegador") && (
        <section className={activePanelClass("Agente Navegador")}>
          <IntelligenceHubDashboard mode="browser" onOpenNora={onOpenNora} />
        </section>
      )}
      {isPanelMounted("Conhecimento") && (
        <section className={activePanelClass("Conhecimento")}>
          <IntelligenceHubDashboard mode="knowledge" onOpenNora={onOpenNora} />
        </section>
      )}
      {isPanelMounted("Marketplace") && (
        <section className={activePanelClass("Marketplace")}>
          <IntelligenceHubDashboard mode="marketplace" onOpenNora={onOpenNora} />
        </section>
      )}
      {isPanelMounted("IA e Modelos") && (
        <section className={activePanelClass("IA e Modelos")}>
          <IntelligenceHubDashboard mode="models" onOpenNora={onOpenNora} />
        </section>
      )}
      {isPanelMounted("Perfil") && (
        <section className={activePanelClass("Perfil")}>
          {coach("Perfil")}
          <ProfileSettings
            userId={currentUser.id}
            currentUser={currentUser}
            onSaved={onProfileSaved}
            onLogout={onLogout}
          />
        </section>
      )}
      {isPanelMounted("Configuracoes", "Configurações") && (
        <section className={activePanelClass("Configuracoes", "Configurações")}>
          {coach("Configuracoes")}
          <SettingsDashboard
            userId={currentUser.id}
            currentUser={currentUser}
            onSaved={onProfileSaved}
            onOpenAdmin={onOpenAdmin}
          />
        </section>
      )}
      {isPanelMounted("Equipe") && (
        <section className={activePanelClass("Equipe")}>
          {coach("Equipe")}
          <TeamDashboard session={authSession} onSessionUpdate={onSessionUpdate} onOpenTeamChat={onOpenTeamChat} />
        </section>
      )}
      {isPanelMounted("Chat da Equipe") && (
        <section className={activePanelClass("Chat da Equipe")}>
          {coach("TeamChat")}
          <TeamChatDrawer
            open
            variant="page"
            session={authSession}
            onClose={() => onNavigate("Equipe")}
            onUnread={() => undefined}
            onOpenNora={onOpenNora}
            onOpenCalendar={() => onNavigate("Agenda")}
          />
        </section>
      )}
      {isPanelMounted("Clientes") && (
        <section className={activePanelClass("Clientes")}>
          {coach("Clientes")}
          <ClientsDashboard />
        </section>
      )}
      {isPanelMounted("Governanca") && (
        <section className={activePanelClass("Governanca")}>
          {coach("Governanca")}
          <PlatformDashboard session={authSession} onNavigate={onNavigate} />
        </section>
      )}
      {isPanelMounted("Brainstorm") && (
        <section className={activePanelClass("Brainstorm")}>
          {coach("Brainstorm")}
          <BrainstormDashboard session={authSession} onNavigate={onNavigate} />
        </section>
      )}
      {isPanelMounted("Ajuda") && (
        <section className={activePanelClass("Ajuda")}>
          {coach("Ajuda")}
          <HelpDashboard onNavigate={onNavigate} onOpenNora={onOpenNora} />
        </section>
      )}
      {isPanelMounted("Mais") && (
        <section className={activePanelClass("Mais")}>
          {coach("Mais")}
          <MoreDashboard onNavigate={onNavigate} onOpenNora={onOpenNora} onLogout={onLogout} />
        </section>
      )}
    </Suspense>
  );
}
