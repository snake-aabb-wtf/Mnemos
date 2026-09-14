import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { useUiStore } from "./lib/ui-store";

const now = "2026-09-14T00:00:00.000Z";
const summary = { status: "ready", version: "0.1.0", uptimeSeconds: 42, sessionsCount: 1, activeSessions: 1, registeredAgents: 6, activeAgents: 0, queuedJobs: 0, runningPtcExecutions: 0, memoryCount: 0, artifactCount: 0, contextLimitTokens: 131072, sandboxBackend: "demo", sandboxStatus: "available", profile: "test" };
const session = { id: "demo-session-01", createdAt: now, updatedAt: now, status: "active", messageCount: 2, agentCount: 1, displayName: "Console smoke session" };

function mockResponse(body: unknown, status = 200): Response { return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body } as Response; }
async function renderRoute(path: "/" | "/sessions"): Promise<void> { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>); await router.navigate({ to: path }); }

beforeEach(() => {
  useUiStore.setState({ eventFilter: "all", eventsPaused: false, theme: "system", sidebarCollapsed: false, mobileNavOpen: false });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("runtime/summary")) return mockResponse(summary);
    if (url.includes("/ready")) return mockResponse({ status: "ok", checks: [], generatedAt: now });
    if (url.includes("/sessions/") && !url.includes("?")) return mockResponse({ ...session, recentMessages: [], activeAgentIds: [] });
    if (url.includes("/sessions")) return mockResponse({ items: [session] });
    if (url.includes("/meta")) return mockResponse({ version: "0.1.0", apiVersion: "v1", schemaVersion: 1, serverTime: now });
    return mockResponse({}, 404);
  }));
});

describe("Console foundation", () => {
  it("renders overview loading then real runtime summary", async () => {
    await renderRoute("/");
    expect(await screen.findByText("A live view of your cognitive runtime.")).toBeInTheDocument();
    expect(await screen.findByText("Ready to observe")).toBeInTheDocument();
    expect(screen.getAllByText("Sessions").length).toBeGreaterThan(0);
  });

  it("renders the session table from Query data", async () => {
    await renderRoute("/sessions");
    expect(await screen.findByText("Console smoke session")).toBeInTheDocument();
    expect(screen.getAllByText("demo-session-01").length).toBeGreaterThan(0);
  });

  it("shows an API error state instead of silently failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ error: { code: "runtime_unavailable", message: "down" } }, 503)));
    await renderRoute("/sessions");
    expect(await screen.findByText("Sessions could not be loaded.")).toBeInTheDocument();
  });

  it("keeps theme preference in UI-only Zustand state", async () => {
    useUiStore.getState().setTheme("dark");
    await waitFor(() => expect(useUiStore.getState().theme).toBe("dark"));
    expect(useUiStore.getState().theme).toBe("dark");
  });
});
