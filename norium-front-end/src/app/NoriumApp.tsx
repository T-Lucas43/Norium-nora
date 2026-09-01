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
import type { TeamCallSocketEvent } from "../components/team-chat/useTeamCall";
import AppPanels from "./components/AppPanels";
import { useAuthSession } from "./hooks/useAuthSession";
import { useOperatorProfile } from "./hooks/useOperatorProfile";
import { ACTIVE_TAB_STORAGE, initialTab, PRIMARY_TABS, TAB_PERMISSIONS } from "./navigation/tabs";
import {
  currentNoriumView,
  legacyViewFromHash,
  navigateNoriumView,
  NORIUM_VIEW_EVENT,
  type NoriumView,
} from "./navigation/view";

const AdminDashboard = lazy(() => import("../components/admin/AdminDashboard"));
const AuthScreen = lazy(() => import("../components/auth/AuthScreen"));
const Nora = lazy(() => import("../components/layout/Nora"));
const PublicAccess = lazy(() => import("../components/public/PublicAccess"));
const LegalPage = lazy(() => import("../components/public/LegalPage"));
const TeamChatDrawer = lazy(() => import("../components/team-chat/TeamChatDrawer"));
const PERSISTENT_TABS = new Set(["E-mail", "E-mails", "Chat", "Propostas"]);
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
  const [pendingTeamCall, setPendingTeamCall] = useState<TeamCallSocketEvent | null>(null);
  const [emailToOpenId, setEmailToOpenId] = useState<string | null>(null);
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => new Set());
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
    const syncHistory = () => setCurrentView(currentNoriumView());
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
    const main = document.getElementById("norium-main");
    main?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem("norium-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!authSession || canAccessTab(activeTab)) return;
    setActiveTab(allowedTabs[0] || "Perfil");
  }, [activeTab, allowedTabs, authSession, canAccessTab]);

  useEffect(() => {
    setMountedTabs(new Set());
    setPendingTeamCall(null);
  }, [authSession?.user.id]);

  useEffect(() => {
    const handleTeamCall = (event: Event) => {
      const callEvent = (event as CustomEvent<TeamCallSocketEvent>).detail;
      if (!callEvent?.callId || activeTab === "Chat da Equipe") return;
      setPendingTeamCall(callEvent);
      setTeamChatOpen(true);
    };
    window.addEventListener("norium:team-call", handleTeamCall);
    return () => window.removeEventListener("norium:team-call", handleTeamCall);
  }, [activeTab]);

  useEffect(() => {
    if (!authSession?.user.id || !PERSISTENT_TABS.has(activeTab)) return;
    setMountedTabs((current) => {
      if (current.has(activeTab)) return current;
      return new Set(current).add(activeTab);
    });
  }, [activeTab, authSession?.user.id]);

  const openNotifications = useCallback(() => {
    setActiveTab("Notificações");
    clearSystemUnread();
  }, [clearSystemUnread]);

  const openNora = useCallback((prompt?: string) => {
    if (!canAccessPermission("nora")) return;
    const contextualPrompt = typeof prompt === "string" ? prompt.trim() : "";
    if (contextualPrompt) {
      setNoraContextRequest({ id: Date.now(), prompt: contextualPrompt });
    }
    setIsNoraOpen(true);
  }, [canAccessPermission]);

  const openDeepLink = useCallback((link: NoriumDeepLink) => {
    localStorage.setItem("norium-deep-link", JSON.stringify(link));
    if (link.tab === "E-mails" && link.entityId) setEmailToOpenId(link.entityId);
    setActiveTab(link.tab || "Central");
  }, []);

  useEffect(() => {
    const handleDeepLink = (event: Event) => {
      const link = (event as CustomEvent<NoriumDeepLink>).detail;
      if (link?.tab) openDeepLink(link);
    };

    window.addEventListener("norium:deep-link", handleDeepLink);
    return () => window.removeEventListener("norium:deep-link", handleDeepLink);
  }, [openDeepLink]);

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
      <Suspense fallback={<AppLoading label="Carregando administracao..." />}>
        <AdminDashboard
          session={authSession}
          onUseSystem={useSystemMode}
          onSessionUpdate={updateSession}
        />
      </Suspense>
    );
  }

  return (
    <div className="app-shell norium-modern-shell flex overflow-hidden bg-[var(--background)] font-sans antialiased">
      <a className="norium-skip-link" href="#norium-main">Pular para o conteudo</a>
      {canAccessPermission("nora") && (
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
              setActiveTab("E-mails");
            }}
          />
        </Suspense>
      )}

      {canAccessPermission("chat") && teamChatOpen && (
        <Suspense fallback={null}>
          <TeamChatDrawer
            key={`team-chat-${currentUser?.id || "anonymous"}`}
            open={teamChatOpen}
            onClose={() => setTeamChatOpen(false)}
            session={authSession}
            onUnread={(count) => addTeamChatUnread(count)}
            onOpenNora={openNora}
            initialCallEvent={pendingTeamCall}
            onInitialCallHandled={(callId) => setPendingTeamCall((current) => current?.callId === callId ? null : current)}
          />
        </Suspense>
      )}

      <SystemNotificationToasts
        toasts={systemToasts}
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
        onNavigate={setActiveTab}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
      />

      <div className="norium-workspace flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onOpenNora={openNora}
          onOpenTeamChat={() => {
            setTeamChatOpen(true);
            clearTeamChatUnread();
          }}
          onOpenNotifications={openNotifications}
          onOpenProfile={() => setActiveTab("Perfil")}
          onOpenSettings={() => setActiveTab("Configurações")}
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
          className={`app-main min-h-0 w-full flex-1 ${activeTab === "E-mail" || activeTab === "E-mails" ? "app-main-mail overflow-hidden" : "overflow-y-auto"}`}
        >
          <AppPanels
            key={`panels-${authSession.user.id}`}
            activeTab={activeTab}
            authSession={authSession}
            canUseNora={canAccessPermission("nora")}
            connected={connected}
            emailToOpenId={emailToOpenId}
            eventsBySource={eventsBySource}
            mountedTabs={mountedTabs}
            profile={profile}
            systemNotifications={systemNotifications}
            onActiveConversationChange={setActiveChatConversationId}
            onClearSystemNotifications={clearSystemNotifications}
            onEmailHandled={() => setEmailToOpenId(null)}
            onLogout={handleLogout}
            onOpenAdmin={useAdminMode}
            onNavigate={setActiveTab}
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
        </main>
      </div>
    </div>
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
