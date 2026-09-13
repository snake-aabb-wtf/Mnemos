import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ModelProviderHiddenAgent,
  MockModelProvider,
  consolidationJobSchema,
  type HiddenExtractionRequest,
} from "./index.js";

describe("ModelProviderHiddenAgent", () => {
  it("uses an independent configured context budget and returns provider JSON without a Memory capability", async () => {
    const seen: unknown[] = [];
    const agent = new ModelProviderHiddenAgent(new MockModelProvider((request) => {
      seen.push({ input: JSON.parse(request.input) as unknown, context: request.context });
      return { content: '{"candidates":[]}' };
    }), { contextLimit: 1_000 });
    const message = {
      id: randomUUID(),
      sessionId: "session-a",
      role: "user" as const,
      content: "A durable project decision.",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const request: HiddenExtractionRequest = {
      job: consolidationJobSchema.parse({
        id: randomUUID(),
        deduplicationKey: "a".repeat(64),
        origin: "eviction",
        sessionId: message.sessionId,
        sourceRange: { firstMessageId: message.id, lastMessageId: message.id, messageCount: 1 },
        evictedMessageIds: [message.id],
        candidateHints: [],
        status: "pending",
        attempts: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      evictedMessages: [message],
      policyVersion: "phase-4-v1",
    };

    await expect(agent.extract(request)).resolves.toEqual({ candidates: [] });
    expect(agent.config.contextLimit).toBe(1_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      input: { stage: "extract", policyVersion: "phase-4-v1" },
      context: { recentMessages: [message], stats: { contextLimit: 1_000 } },
    });
  });
});
