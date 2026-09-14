import { describe, expect, it } from "vitest";
import {
  apiErrorResponseSchema,
  metaDtoSchema,
  paginationQuerySchema,
  runtimeEventDtoSchema,
  sessionParamsSchema,
  sessionSummaryDtoSchema,
} from "./index.js";

describe("shared console contracts", () => {
  it("accepts valid metadata, pagination, and session DTOs", () => {
    expect(metaDtoSchema.parse({
      version: "0.1.0",
      apiVersion: "v1",
      schemaVersion: 1,
      serverTime: "2026-09-14T00:00:00.000Z",
    })).toMatchObject({ apiVersion: "v1" });

    expect(paginationQuerySchema.parse({ limit: "10" })).toEqual({ limit: 10 });
    expect(sessionSummaryDtoSchema.parse({
      id: "session-1",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
      status: "active",
      messageCount: 2,
      displayName: "Demo",
    })).toMatchObject({ id: "session-1", messageCount: 2 });
  });

  it("rejects malformed DTOs and unknown fields", () => {
    expect(() => metaDtoSchema.parse({ version: "0.1.0", apiVersion: "v2", serverTime: "bad" })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: 101 })).toThrow();
    expect(() => sessionSummaryDtoSchema.parse({
      id: "session-1",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
      status: "active",
      messageCount: 0,
      internalPath: "C:/secret",
    })).toThrow();
    expect(() => sessionParamsSchema.parse({ sessionId: "" })).toThrow();
  });

  it("keeps API errors structured and stack-free", () => {
    const parsed = apiErrorResponseSchema.parse({
      error: { code: "not_found", message: "Session not found", requestId: "req-1" },
    });
    expect(parsed.error).toEqual({ code: "not_found", message: "Session not found", requestId: "req-1" });
    expect(() => apiErrorResponseSchema.parse({ error: { code: "internal_error", message: "x", stack: "secret" } })).toThrow();
  });

  it("accepts allowlisted safe runtime events and rejects unsafe event types", () => {
    const event = runtimeEventDtoSchema.parse({
      id: "evt-1",
      type: "runtime.ready",
      timestamp: "2026-09-14T00:00:00.000Z",
      payload: { status: "ready" },
    });
    expect(event.type).toBe("runtime.ready");
    expect(() => runtimeEventDtoSchema.parse({
      id: "evt-2",
      type: "internal.secret_dump",
      timestamp: "2026-09-14T00:00:00.000Z",
      payload: {},
    })).toThrow();
  });
});
