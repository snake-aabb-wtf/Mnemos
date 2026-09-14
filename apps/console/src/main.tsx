import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { useUiStore } from "./lib/ui-store";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });

function ThemeController(): null {
  const theme = useUiStore((state) => state.theme);
  useEffect(() => {
    const root = document.documentElement;
    const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", dark);
  }, [theme]);
  return null;
}

createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={queryClient}><ThemeController /><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
