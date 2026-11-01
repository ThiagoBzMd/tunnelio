// Client-side routes (react-router 7). Auth guards keep the `/pair#CODE` fragment client-side.

import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { createBrowserRouter, Navigate, useLocation } from "react-router";
import { Loader2Icon } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/stores/react";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { authStore } from "@/stores/auth";
import { uiStore } from "@/stores/ui";
import { LoginScreen } from "@/screens/LoginScreen";
import { RegisterScreen } from "@/screens/RegisterScreen";
import { ChatScreen } from "@/screens/ChatScreen";
import { DevicesScreen } from "@/screens/DevicesScreen";

// Secondary screens are code-split; the chat path stays in the main chunk.
const ModelsScreen = lazy(() => import("@/screens/ModelsScreen").then((m) => ({ default: m.ModelsScreen })));
const AgentsScreen = lazy(() => import("@/screens/AgentsScreen").then((m) => ({ default: m.AgentsScreen })));
const SkillsScreen = lazy(() => import("@/screens/SkillsScreen").then((m) => ({ default: m.SkillsScreen })));
const VerifyEmailScreen = lazy(() => import("@/screens/VerifyEmailScreen").then((m) => ({ default: m.VerifyEmailScreen })));
const ForgotPasswordScreen = lazy(() => import("@/screens/ForgotPasswordScreen").then((m) => ({ default: m.ForgotPasswordScreen })));

export function Splash() {
  const { t } = useT();
  const error = useAuth((s) => s.error);
  const status = useAuth((s) => s.status);
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background text-muted-foreground" data-testid="splash">
      {status === "unknown" && error ? (
        <>
          <p className="text-sm">{t("app.unreachable")}</p>
          <p className="max-w-xs text-center text-xs opacity-70">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void authStore.getState().bootstrap()}>
            {t("common.retry")}
          </Button>
        </>
      ) : (
        <Loader2Icon className="size-5 animate-spin" aria-label={t("common.loading")} />
      )}
    </div>
  );
}

interface FromState {
  from?: string;
}

function safeFrom(state: unknown): string | null {
  const from = (state as FromState | null)?.from;
  return typeof from === "string" && from.startsWith("/") && !from.startsWith("//") ? from : null;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const loc = useLocation();
  if (status === "unknown") return <Splash />;
  if (status === "anonymous") {
    // Keep path + hash in router state only: the pairing code never reaches the server (SPEC §2.2).
    return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search + loc.hash }} />;
  }
  return <>{children}</>;
}

function AnonymousOnly({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const loc = useLocation();
  if (status === "unknown") return <Splash />;
  if (status === "authenticated") return <Navigate to={safeFrom(loc.state) ?? "/"} replace />;
  return <>{children}</>;
}

function Lazy({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
          <Loader2Icon className="size-5 animate-spin" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

function NotFound() {
  const { t } = useT();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-lg font-semibold">{t("app.notFound")}</p>
      <Button asChild variant="outline">
        <a href="/">{t("nav.chat")}</a>
      </Button>
    </div>
  );
}

function OpenSettings() {
  const loc = useLocation();
  useEffect(() => {
    // A phone shows a list of pages: "#security" opens that page directly.
    uiStore.getState().openSettings(loc.hash === "#security" || loc.hash === "#account" ? "account" : "general", loc.hash === "#security" ? "security" : null);
  }, [loc.hash]);
  return <Navigate to="/" replace />;
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: (
      <AnonymousOnly>
        <LoginScreen />
      </AnonymousOnly>
    ),
  },
  {
    path: "/register",
    element: (
      <AnonymousOnly>
        <RegisterScreen />
      </AnonymousOnly>
    ),
  },
  {
    path: "/verify-email",
    element: (
      <AnonymousOnly>
        <Lazy>
          <VerifyEmailScreen />
        </Lazy>
      </AnonymousOnly>
    ),
  },
  {
    path: "/forgot-password",
    element: (
      <AnonymousOnly>
        <Lazy>
          <ForgotPasswordScreen />
        </Lazy>
      </AnonymousOnly>
    ),
  },
  // rev. 1.2 e-mail links (`/reset-password#uid.token`) are gone: the reset is a 6-digit code now.
  { path: "/reset-password", element: <Navigate to="/forgot-password" replace /> },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { path: "/", element: <ChatScreen /> },
      { path: "/chat", element: <Navigate to="/" replace /> },
      { path: "/chat/:conversationId", element: <ChatScreen /> },
      { path: "/devices", element: <DevicesScreen /> },
      { path: "/pair", element: <DevicesScreen /> },
      {
        path: "/models",
        element: (
          <Lazy>
            <ModelsScreen />
          </Lazy>
        ),
      },
      {
        path: "/agents",
        element: (
          <Lazy>
            <AgentsScreen />
          </Lazy>
        ),
      },
      {
        path: "/skills",
        element: (
          <Lazy>
            <SkillsScreen />
          </Lazy>
        ),
      },
      // Settings is a window over the current screen; the address opens it over a new chat
      // (`#security` → the Account tab).
      { path: "/settings", element: <OpenSettings /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export { safeFrom };
