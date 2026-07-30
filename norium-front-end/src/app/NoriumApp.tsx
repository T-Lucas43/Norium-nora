// Orquestra sessao e paineis; regras de API e telas ficam em modulos proprios.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import Header from "../components/layout/Header";
import Sidebar from "../components/layout/Sidebar";
import SystemNotificationToasts from "../components/notifications/SystemNotificationToasts";
import { useWebSockets } from "../hooks/useWebSockets";
import type { AppMode, AuthSession, PermissionKey } from "../types/auth";
import { canUse } from "../types/auth";
import { applyNoriumTheme } from "../utils/theme";
import AppPanels from "./components/AppPanels";
import { useAuthSession } from "./hooks/useAuthSession";
import { useOperatorProfile } from "./hooks/useOperatorProfile";
import { ACTIVE_TAB_STORAGE, initialTab, PRIMARY_TABS, TAB_PERMISSIONS } from "./navigation/tabs";

const AdminDashboard = lazy(() => import("../components/admin/AdminDashboard"));
const AuthScreen = lazy(() => import("../components/auth/AuthScreen"));
const Nora = lazy(() => import("../components/layout/Nora"));
const PublicAccess = lazy(() => import("../components/public/PublicAccess"));
const TeamChatDrawer = lazy(() => import("../components/team-chat/TeamChatDrawer"));
const SESSION_TABS = ["Dashboard", "Central", "E-mails", "Agenda", "Chat", "Tarefas"];

type NoriumDeepLink = {
  tab: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
};

export default function NoriumApp() {
  const publicMatch = window.location.hash.match(/^#\/(portal|formulario|assinatura)\/([^/?#]+)/i);
  const publicRoute = publicMatch
    ? publicMatch[1].toLowerCase() === "portal"
      ? { kind: "portal" as const, token: decodeURIComponent(publicMatch[2]) }
      : publicMatch[1].toLowerCase() === "assinatura"
        ? { kind: "signature" as const, token: decodeURIComponent(publicMatch[2]) }
        : { kind: "form" as const, token: decodeURIComponent(publicMatch[2]) }
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
  const [teamChatUnread, setTeamChatUnread] = useState(0);
  const [emailToOpenId, setEmailToOpenId] = useState<string | null>(null);
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => new Set(["Dashboard"]));
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
    refreshEvents,
    clearSystemUnread,
    clearSystemNotifications,
    dismissSystemToast,
  } = useWebSockets(activeTab, Boolean(authSession), authSession?.user.id || "lucas123");

  const currentUser = authSession?.user ?? null;
  const simulationBackup = localStorage.getItem("norium-simulation-backup");
  const telegramEnabledForUser =
    currentUser?.id === "lucas123" || currentUser?.email?.toLowerCase() === "tarcisiolucas43@gmail.com";

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
    updateSession(session);
    const nextMode = mode === "admin" && session.availableModes.includes("admin") ? "admin" : "app";
    setAppMode(nextMode);
    if (nextMode === "app" && profile?.tema) {
      applyNoriumTheme(profile.tema, profile.tema_personalizado);
    }
    window.location.hash = nextMode === "admin" ? "#/admin" : "#/app";
  }, [profile?.tema, profile?.tema_personalizado, setAppMode, updateSession]);

  const handleLogout = useCallback(() => {
    clearSession();
    setIsNoraOpen(false);
    setTeamChatOpen(false);
    window.location.hash = "#/login";
  }, [clearSession]);

  const exitPermissionSimulation = useCallback(() => {
    const backup = localStorage.getItem("norium-simulation-backup");
    if (!backup) return;
    try {
      const restored = JSON.parse(backup) as AuthSession;
      updateSession(restored);
      localStorage.removeItem("norium-simulation-backup");
      window.location.hash = "#/app";
      window.location.reload();
    } catch {
      localStorage.removeItem("norium-simulation-backup");
      handleLogout();
    }
  }, [handleLogout, updateSession]);

  const useSystemMode = useCallback(() => {
    setAppMode("app");
    if (profile?.tema) applyNoriumTheme(profile.tema, profile.tema_personalizado);
    window.location.hash = "#/app";
  }, [profile?.tema, profile?.tema_personalizado, setAppMode]);

  useEffect(() => {
    if (activeTab === "Notificações") clearSystemUnread();
  }, [activeTab, clearSystemUnread]);

  useEffect(() => {
    if (TAB_PERMISSIONS[activeTab] !== undefined) localStorage.setItem(ACTIVE_TAB_STORAGE, activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem("norium-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!authSession || canAccessTab(activeTab)) return;
    setActiveTab(allowedTabs[0] || "Perfil");
  }, [activeTab, allowedTabs, authSession, canAccessTab]);

  useEffect(() => {
    setMountedTabs((current) => {
      if (current.has(activeTab)) return current;
      const next = new Set(current);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  useEffect(() => {
    if (!authSession) return;
    setMountedTabs((current) => {
      const next = new Set(current);
      SESSION_TABS.filter(canAccessTab).forEach((tab) => next.add(tab));
      return next.size === current.size ? current : next;
    });
  }, [authSession, canAccessTab]);

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
      {simulationBackup && (
        <div className="fixed left-1/2 top-3 z-[120] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-300/40 bg-amber-950/95 px-4 py-2 text-xs font-black text-amber-100 shadow-2xl">
          Visualizando como {currentUser?.nome || currentUser?.email}
          <button className="rounded-md bg-amber-300 px-3 py-1.5 text-amber-950" onClick={exitPermissionSimulation}>
            Encerrar simulacao
          </button>
        </div>
      )}
      {canAccessPermission("nora") && (
        <Suspense fallback={null}>
          <Nora
            open={isNoraOpen}
            onClose={() => setIsNoraOpen(false)}
            conversaId={activeChatConversationId ?? undefined}
            profile={profile}
            eventsBySource={eventsBySource}
            userId={currentUser?.id || "lucas123"}
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
            open={teamChatOpen}
            onClose={() => setTeamChatOpen(false)}
            session={authSession}
            onUnread={(count) => setTeamChatUnread((current) => (teamChatOpen ? 0 : current + count))}
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
            setTeamChatUnread(0);
          }}
          onOpenNotifications={openNotifications}
          onOpenProfile={() => setActiveTab("Perfil")}
          onOpenSettings={() => setActiveTab("Configurações")}
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
          teamChatUnread={teamChatUnread}
        />

        <main id="norium-main" className="app-main w-full flex-1 overflow-y-auto">
          <AppPanels
            activeTab={activeTab}
            authSession={authSession}
            canUseNora={canAccessPermission("nora")}
            connected={connected}
            emailToOpenId={emailToOpenId}
            eventsBySource={eventsBySource}
            mountedTabs={mountedTabs}
            profile={profile}
            systemNotifications={systemNotifications}
            telegramEnabledForUser={telegramEnabledForUser}
            onActiveConversationChange={setActiveChatConversationId}
            onClearSystemNotifications={clearSystemNotifications}
            onEmailHandled={() => setEmailToOpenId(null)}
            onLogout={handleLogout}
            onNavigate={setActiveTab}
            onOpenDeepLink={openDeepLink}
            onOpenNora={openNora}
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
