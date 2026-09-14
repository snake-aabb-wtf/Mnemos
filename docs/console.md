# Mnemos Web Console (Frontend F2)

The console is an adapter and diagnostic surface, not a replacement for the Mnemos runtime. Canonical History,
Memory, Artifacts, tasks, permissions, and runtime policy stay behind the server's injected runtime service.

## Packages

- `packages/contracts` owns the public Zod schemas and inferred TypeScript DTOs.
- `apps/server` owns HTTP validation, request IDs, CORS, safe mapping, and SSE subscription lifecycle.
- `apps/console` owns routing and presentation. TanStack Query owns server state; Zustand owns UI preferences only.

The boundary is:

```text
Harness/runtime → ConsoleRuntimeService → Fastify /api/v1 → shared contracts → React console
                                   └────── EventBus → safe SSE DTOs ───────────────┘
```

## Local development

```bash
pnpm install
pnpm build
pnpm dev:server
pnpm dev:console
```

Vite proxies `/api` to `127.0.0.1:4317`. A different deployment can set
`VITE_MNEMOS_API_BASE_URL`; no URL or provider key is compiled into the client.

The default test/demo server is deterministic and in-memory. `POST /api/v1/dev/demo-session` is available only for
development/test profiles and is disabled in production. It exists only to exercise the UI and SSE chain without an
LLM API key.

## F1 API and F2 Chat API

`GET /api/v1/meta`, `/health`, `/ready`, `/runtime/summary`, `/sessions`, `/sessions/:sessionId`, and `/events` remain
the F1 observer surface. F2 adds `POST /api/v1/sessions`, `GET /api/v1/sessions/:sessionId/messages`,
`POST /api/v1/sessions/:sessionId/messages`, `POST .../messages/:messageId/retry`,
`POST .../generations/:generationId/cancel`, and the named SSE channel
`GET .../generations/:generationId/events`. Every request and response is validated against shared contracts, and
errors are normalized to `{ error: { code, message, requestId } }` without stack traces.

The event stream uses named SSE events from an explicit public allowlist. Payloads are metadata-only, truncated to a
bounded size, and never include prompts, secrets, filesystem paths, raw tool arguments, or large result bodies. SSE
has no replay store in F1: reconnects receive future events. F2 assistant streams are separate from runtime events and
replay a bounded generation event buffer, preventing a POST/subscribe race. Chat events carry only deltas, terminal
message DTOs, and safe activity labels; no hidden reasoning, secrets, or raw tool output. Heartbeats keep idle proxies
open and disconnects unsubscribe from both channels.

## Console pages

F2 includes the F1 Overview, Sessions, Runtime Events, and Settings plus a three-column Chat Workbench. The workbench
has a session rail with New Session, canonical conversation history, streaming assistant output, safe runtime activity,
Stop, retry/regenerate, Markdown/code rendering, and a compact agent/context/tool/PTC inspector. Future areas
are visibly marked as coming later rather than pretending to be implemented. The shell is keyboard accessible,
responsive from mobile through desktop, and supports system/light/dark theme preference. IDs use monospace display and
copy controls; server timestamps are formatted in the browser's local timezone.

## Verification

```bash
pnpm test:server
pnpm test:console
pnpm test:e2e
```

Playwright uses Chromium and starts the built Fastify server plus Vite. The smoke path proves Browser → REST → runtime
fixture → EventBus → SSE → React, entirely offline. F2 E2E covers session creation, streaming, refresh recovery, and
true cancellation. CI installs Chromium explicitly. Canonical messages are always read back from the runtime API.

## Security and roadmap

F2 has an explicit CORS policy and a production-disabled demo mutation, but it does not implement user authentication
or authorization; place it behind the deployment's trusted access boundary before exposing it. The server is not the
runtime lifecycle owner. F1–F6 are intentionally staged:

| Stage | Status | Scope |
| --- | --- | --- |
| F1 | Complete | Console foundation, REST/SSE, runtime overview, sessions, events, tests |
| F2 | Complete | Chat workbench, streaming, cancellation, retry, Markdown, activity summary, E2E |
| F3 | Pending | Context and memory inspectors |
| F4 | Pending | Artifacts, tools, and PTC inspector |
| F5 | Pending | Multi-agent task graph |
| F6 | Pending | Runtime dashboard, UX polish, expanded E2E |
