// Root component: theme sync, app bootstrap, router, global providers (tooltips, toasts).

import { useEffect } from "react";
import { RouterProvider } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useT } from "@/i18n";
import { boot } from "./bootstrap";
import { router } from "./router";
import { startThemeSync } from "./theme";

export function App() {
  const { lang } = useT();

  useEffect(() => {
    const stopTheme = startThemeSync();
    void boot();
    return stopTheme;
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <TooltipProvider delayDuration={300}>
      <RouterProvider router={router} />
      <Toaster position="top-center" closeButton richColors={false} mobileOffset={{ top: 64 }} />
    </TooltipProvider>
  );
}
