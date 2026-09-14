// Orquestra sessao e paineis; regras de API e telas ficam em modulos proprios.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import Header from "../components/layout/Header";
import Sidebar from "../components/layout/Sidebar";
import SystemNotificationToasts from "../components/notifications/SystemNotificationToasts";
import { useWebSockets } from "../hooks/useWebSockets";
import type { AppMode, AuthSession, PermissionKey } from "../types/auth";
import { canUse } from "../types/auth";
import { applyNoriumTheme } from "../utils/theme";
import { authJson } from "../utils/authApi";
import { CallSessionProvider } from "../components/team-chat/CallSession";
import AppPanels from "./components/AppPanels";
import { preloadPanel } from "./navigation/panelModules";
import { useAuthSession } from "./hooks/useAuthSession";
import { useOperatorProfile } from "./hooks/useOperatorProfile";
import {
  ACTIVE_TAB_STORAGE,
  canonicalTab,
  initialTab,
  navigateNoriumTab,
  PRIMARY_TABS,
  tabFromPath,
  TAB_PERMISSIONS,
} from "./navigation/tabs";
import {
  currentNoriumView,
  legacyViewFromHash,
  navigateNoriumView,
  NORIUM_VIEW_EVENT,
  type NoriumView,
} from "./navigation/view";

const AdminDashboard = lazy(() => import("../components/admin/AdminDashboard"));
const AuthScreen = lazy(() => import("../components/auth/AuthScreen"));
const AccountEmailAction = lazy(() => import("../components/auth/AccountEmailAction"));
const Nora = lazy(() => import("../components/layout/Nora"));
const PublicAccess = lazy(() => import("../components/public/PublicAccess"));
const LegalPage = lazy(() => import("../components/public/LegalPage"));
const TeamChatDrawer = lazy(() => import("../components/team-chat/TeamChatDrawer"));
const SIMULATION_BACKUP_STORAGE = "norium-simulation-backup";

type NoriumDeepLink = {
  tab: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
};

export default function NoriumApp() {
  const [currentHash, setCurrentHash] = useState(() => window.location.hash);
  const [currentView, setCurrentView] = useState<NoriumView>(currentNoriumView);
  const publicMatch = currentHash.match(/^#\/(portal|formulario|assinatura)\/([^/?#]+)/i);
  const publicRoute = publicMatch
    ? publicMatch[1].toLowerCase() === "portal"
      ? { kind: "portal" as const, token: decodeURIComponent(publicMatch[2]) }
      : publicMatch[1].toLowerCase() === "assinatura"
        ? { kind: "signature" as const, token: decodeURIComponent(publicMatch[2]) }
        : { kind: "form" as const, token: decodeURIComponent(publicMatch[2]) }
    : null;
  const legalRoute = currentView === "terms"
    ? "terms" as const
    : currentView === "privacy"
      ? "privacy" as const
      : null;
  const [activeTab, setActiveTab] = useState(initialTab);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("norium-sidebar-collapsed") === "true",
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isNoraOpen, setIsNoraOpen] = useState(false);
  const [noraContextRequest, setNoraContextRequest] = useState<{ id: number; prompt: string } | null>(null);
  const [activeChatConversationId, setActiveChatConversationId] = useState<string | null>(null);
  const [teamChatOpen, setTeamChatOpen] = useState(false);
  const [teamThreadToOpen, setTeamThreadToOpen] = useState<string | null>(null);
  const [teamChatMounted, setTeamChatMounted] = useState(false);
  const [emailToOpenId, setEmailToOpenId] = useState<string | null>(null);
  const {
    appMode,
    authLoading,
    authSession,
    clearSession,
    setAppMode,
    updateSession,
  } = useAuthSession();
  const { profile, saveLocalProfile } = useOperatorProfile(authSession, appMode);
  const {
    connected,
    eventsBySource,
    systemNotifications,
    systemUnreadCount,
    systemToasts,
    teamChatUnreadCount,
    refreshEvents,
    clearSystemUnread,
    clearSystemNotifications,
    clearTeamChatUnread,
    addTeamChatUnread,
    dismissSystemToast,
    dismissCallNotifications,
    handleTeamSocketEvent,
  } = useWebSockets(
    activeTab,
    Boolean(authSession),
    authSession?.user.id || "primary",
    teamChatOpen,
  );

  const currentUser = authSession?.user ?? null;

  useEffect(() => {
    const syncHash = () => {
      setCurrentHash(window.location.hash);
      const legacyView = legacyViewFromHash();
      if (legacyView) navigateNoriumView(legacyView);
    };
    const syncView = (event: Event) => setCurrentView((event as CustomEvent<NoriumView>).detail);
    const syncHistory = () => {
      setCurrentView(currentNoriumView());
      const routedTab = tabFromPath();
      if (routedTab) setActiveTab(routedTab);
    };
    window.addEventListener("hashchange", syncHash);
    window.addEventListener(NORIUM_VIEW_EVENT, syncView);
    window.addEventListener("popstate", syncHistory);
    const legacyView = legacyViewFromHash();
    if (legacyView) navigateNoriumView(legacyView);
    return () => {
      window.removeEventListener("hashchange", syncHash);
      window.removeEventListener(NORIUM_VIEW_EVENT, syncView);
      window.removeEventListener("popstate", syncHistory);
    };
  }, []);

  const canAccessPermission = useCallback(
    (permission: PermissionKey | null | undefined) => !permission || canUse(currentUser, permission),
    [currentUser],
  );
  const canAccessTab = useCallback(
    (tab: string) => canAccessPermission(TAB_PERMISSIONS[tab] ?? null),
    [canAccessPermission],
  );
  const allowedTabs = useMemo(
    () => PRIMARY_TABS.filter((tab) => canAccessTab(tab)),
    [canAccessTab],
  );

  const navigateTab = useCallback((tab: string, options: { replace?: boolean } = {}) => {
    const nextTab = canonicalTab(tab);
    preloadPanel(nextTab);
    setActiveTab(nextTab);
    navigateNoriumTab(nextTab, options);
  }, []);

  const handleAuthenticated = useCallback((session: AuthSession, mode: AppMode) => {
    sessionStorage.removeItem(SIMULATION_BACKUP_STORAGE);
    localStorage.removeItem(SIMULATION_BACKUP_STORAGE);
    updateSession(session);
    const nextMode = mode === "admin" && session.availableModes.includes("admin") ? "admin" : "app";
    setAppMode(nextMode);
    if (nextMode === "app" && profile?.tema) {
      applyNoriumTheme(profile.tema, profile.tema_personalizado);
    }
    navigateNoriumView(nextMode);
  }, [profile?.tema, profile?.tema_personalizado, setAppMode, updateSession]);

  const handleLogout = useCallback(() => {
    if (authSession) {
      void authJson("/api/auth/logout", authSession.token, { method: "POST" }).catch(() => undefined);
    }
    sessionStorage.removeItem(SIMULATION_BACKUP_STORAGE);
    localStorage.removeItem(SIMULATION_BACKUP_STORAGE);
    clearSession();
    setIsNoraOpen(false);
    setTeamChatOpen(false);
    setTeamThreadToOpen(null);
    navigateNoriumView("login");
  }, [authSession, clearSession]);

  const useSystemMode = useCallback(() => {
    setAppMode("app");
    if (profile?.tema) applyNoriumTheme(profile.tema, profile.tema_personalizado);
    navigateNoriumView("app");
  }, [profile?.tema, profile?.tema_personalizado, setAppMode]);

  const useAdminMode = useCallback(() => {
    if (!authSession?.availableModes.includes("admin")) return;
    setAppMode("admin");
    navigateNoriumView("admin");
  }, [authSession?.availableModes, setAppMode]);

  useEffect(() => {
    if (activeTab === "Notificações") clearSystemUnread();
  }, [activeTab, clearSystemUnread]);

  useEffect(() => {
    if (TAB_PERMISSIONS[activeTab] !== undefined) localStorage.setItem(ACTIVE_TAB_STORAGE, activeTab);
    if (authSession && appMode === "app" && currentView === "app") {
      navigateNoriumTab(activeTab, { replace: true });
      document.title = `${activeTab} | Norium`;
    }
    const main = document.getElementById("norium-main");
    main?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [activeTab, appMode, authSession, currentView]);

  useEffect(() => {
    localStorage.setItem("norium-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!authSession || canAccessTab(activeTab)) return;
    navigateTab(allowedTabs[0] || "Perfil", { replace: true });
  }, [activeTab, allowedTabs, authSession, canAccessTab, navigateTab]);

  useEffect(() => {
    setTeamChatMounted(false);
  }, [authSession?.user.id]);

  useEffect(() => {
    if (teamChatOpen || activeTab === "Chat da Equipe") setTeamChatMounted(true);
  }, [activeTab, teamChatOpen]);

  const openNotifications = useCallback(() => {
    navigateTab("Notificações");
    clearSystemUnread();
  }, [clearSystemUnread, navigateTab]);

  const openNora = useCallback((prompt?: string) => {
    if (!canAccessPermission("nora")) return;
    const contextualPrompt = typeof prompt === "string" ? prompt.trim() : "";
    if (contextualPrompt) {
      setNoraContextRequest({ id: Date.now(), prompt: contextualPrompt });
      setIsNoraOpen(true);
    } else {
      setIsNoraOpen(false);
      navigateTab("Nora");
    }
  }, [canAccessPermission, navigateTab]);

  const openDeepLink = useCallback((link: NoriumDeepLink) => {
    localStorage.setItem("norium-deep-link", JSON.stringify(link));
    if (link.tab === "E-mails" && link.entityId) setEmailToOpenId(link.entityId);
    if (link.tab === "Chat da Equipe" && link.metadata?.threadId) setTeamThreadToOpen(String(link.metadata.threadId));
    navigateTab(link.tab || "Central");
  }, [navigateTab]);

  useEffect(() => {
    const handleDeepLink = (event: Event) => {
      const link = (event as CustomEvent<NoriumDeepLink>).detail;
      if (link?.tab) openDeepLink(link);
    };

    window.addEventListener("norium:deep-link", handleDeepLink);
    return () => window.removeEventListener("norium:deep-link", handleDeepLink);
  }, [openDeepLink]);

  const emailAction = currentHash.match(/^#\/(redefinir-senha|confirmar-email)\/([A-Za-z0-9_-]{32,128})$/);
  if (emailAction) {
    return <Suspense fallback={<AppLoading label="Abrindo acesso seguro..." />}><AccountEmailAction
      key={currentHash} mode={emailAction[1] === "redefinir-senha" ? "reset" : "verify"} token={emailAction[2]}
      onReset={clearSession} onBack={() => { window.location.hash = ""; }}
    /></Suspense>;
  }

  if (publicRoute) {
    return (
      <Suspense fallback={<AppLoading label="Abrindo acesso publico..." />}>
        <PublicAccess route={publicRoute} />
      </Suspense>
    );
  }

  if (legalRoute) {
    return (
      <Suspense fallback={<AppLoading label="Abrindo documento..." />}>
        <LegalPage kind={legalRoute} authenticated={Boolean(authSession)} />
      </Suspense>
    );
  }

  if (authLoading) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--background)] p-6 text-[var(--text)]">
        <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] px-8 py-6 text-center shadow-2xl shadow-blue-950/25 backdrop-blur-2xl">
          <p className="text-lg font-black">Carregando Norium...</p>
          <p className="mt-2 text-sm font-semibold text-[var(--text-secondary)]">Restaurando sua sessao.</p>
        </div>
      </main>
    );
  }

  if (!authSession) {
    return (
      <Suspense fallback={<AppLoading label="Abrindo acesso seguro..." />}>
        <AuthScreen onAuthenticated={handleAuthenticated} />
      </Suspense>
    );
  }

  if (appMode === "admin") {
    return (
      <CallSessionProvider
        session={authSession}
        onTeamEvent={handleTeamSocketEvent}
        onCallDismissed={dismissCallNotifications}
        onIncomingCall={() => setTeamChatOpen(true)}
      >
        <Suspense fallback={<AppLoading label="Carregando administracao..." />}>
          <AdminDashboard
            session={authSession}
            onUseSystem={useSystemMode}
            onSessionUpdate={updateSession}
          />
        </Suspense>
      </CallSessionProvider>
    );
  }

  return (
    <CallSessionProvider
      session={authSession}
      onTeamEvent={handleTeamSocketEvent}
      onCallDismissed={dismissCallNotifications}
      onIncomingCall={() => {
        setTeamChatMounted(true);
        if (activeTab !== "Chat da Equipe") setTeamChatOpen(true);
      }}
    >
    <div className="app-shell norium-modern-shell flex overflow-hidden bg-[var(--background)] font-sans antialiased">
      <a className="norium-skip-link" href="#norium-main">Pular para o conteudo</a>
      {canAccessPermission("nora") && isNoraOpen && (
        <Suspense fallback={null}>
          <Nora
            key={`nora-${currentUser?.id || "anonymous"}`}
            open={isNoraOpen}
            onClose={() => setIsNoraOpen(false)}
            conversaId={activeChatConversationId ?? undefined}
            profile={profile}
            eventsBySource={eventsBySource}
            userId={currentUser?.id || "primary"}
            activeTab={activeTab}
            contextualRequest={noraContextRequest}
            onOpenEmail={(messageId) => {
              setEmailToOpenId(messageId);
              navigateTab("E-mails");
            }}
          />
        </Suspense>
      )}

      <SystemNotificationToasts
        toasts={profile?.interface_preferences?.showToasts === false ? [] : systemToasts}
        preferences={profile?.interface_preferences}
        onDismiss={dismissSystemToast}
        onOpenNotifications={openNotifications}
      />

      <Sidebar
        activeTab={activeTab}
        allowedTabs={allowedTabs}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileSidebarOpen}
        currentUser={currentUser}
        profile={profile}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onNavigate={navigateTab}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
      />

      <div className="norium-workspace flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          activeTab={activeTab}
          setActiveTab={navigateTab}
          onOpenNora={openNora}
          onOpenTeamChat={() => {
            setTeamChatOpen(true);
            clearTeamChatUnread();
          }}
          onOpenNotifications={openNotifications}
          onOpenProfile={() => navigateTab("Perfil")}
          onOpenSettings={() => navigateTab("Configurações")}
          onOpenLegal={() => navigateNoriumView("terms")}
          onLogout={handleLogout}
          onToggleSidebar={() => {
            if (window.matchMedia("(max-width: 900px)").matches) {
              setMobileSidebarOpen((current) => !current);
            } else {
              setSidebarCollapsed((current) => !current);
            }
          }}
          unreadNotifications={systemUnreadCount}
          profile={profile}
          currentUser={currentUser}
          allowedTabs={allowedTabs}
          canUseNora={canAccessPermission("nora")}
          canUseTeamChat={canAccessPermission("chat")}
          teamChatUnread={teamChatUnreadCount}
        />

        <main
          id="norium-main"
          className={`app-main min-h-0 w-full flex-1 ${activeTab === "E-mail" || activeTab === "E-mails" ? "app-main-mail overflow-hidden" : activeTab === "Chat da Equipe" ? "app-main-team-chat overflow-hidden" : "overflow-y-auto"}`}
        >
          <AppPanels
            key={`panels-${authSession.user.id}`}
            activeTab={activeTab}
            authSession={authSession}
            canUseNora={canAccessPermission("nora")}
            connected={connected}
            emailToOpenId={emailToOpenId}
            eventsBySource={eventsBySource}
            profile={profile}
            systemNotifications={systemNotifications}
            onActiveConversationChange={setActiveChatConversationId}
            onClearSystemNotifications={clearSystemNotifications}
            onEmailHandled={() => setEmailToOpenId(null)}
            onLogout={handleLogout}
            onOpenAdmin={useAdminMode}
            onNavigate={navigateTab}
            onOpenDeepLink={openDeepLink}
            onOpenNora={openNora}
            onOpenTeamChat={() => {
              setTeamChatOpen(true);
              clearTeamChatUnread();
            }}
            onProfileSaved={saveLocalProfile}
            onRefreshEvents={() => void refreshEvents()}
            onSessionUpdate={updateSession}
          />
          {canAccessPermission("chat") && (teamChatMounted || teamChatOpen || activeTab === "Chat da Equipe") && (
            <Suspense fallback={null}>
              <TeamChatDrawer
                initialThreadId={teamThreadToOpen}
                onInitialThreadHandled={() => setTeamThreadToOpen(null)}
                key={`team-chat-${currentUser?.id || "anonymous"}`}
                open={teamChatOpen || activeTab === "Chat da Equipe"}
                variant={activeTab === "Chat da Equipe" ? "page" : "drawer"}
                onClose={() => { setTeamChatOpen(false); if (activeTab === "Chat da Equipe") navigateTab("Equipe"); }}
                session={authSession}
                onUnread={addTeamChatUnread}
                onOpenNora={openNora}
                onOpenCalendar={() => navigateTab("Agenda")}
              />
            </Suspense>
          )}
        </main>
      </div>
    </div>
    </CallSessionProvider>
  );
}

function AppLoading({ label }: { label: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--background)] p-6 text-[var(--text)]">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-8 py-6 text-center shadow-[var(--glass-shadow)] backdrop-blur-2xl">
        <p className="text-lg font-black">{label}</p>
      </div>
    </main>
  );
}
