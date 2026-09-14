import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryIntelligenceService, MemoryService } from "@mnemos/core";
import { SqliteHistoryStore } from "./sqlite.js";
import { SqliteMemoryStore } from "./memory.js";

describe("memory intelligence offline evaluation", () => {
  it("scans 10k synthetic records without pairwise maintenance growth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mnemos-memory-eval-"));
    const path = join(directory, "runtime.sqlite");
    const history = new SqliteHistoryStore(path);
    const memories = new SqliteMemoryStore(path);
    try {
      const source = await history.append({ sessionId: "eval", role: "user", content: "Synthetic memory evidence" });
      const service = new MemoryService(memories, history);
      for (let index = 0; index < 10_000; index += 1) {
        await memories.create({
          type: "episodic",
          content: `Synthetic independent event ${index}`,
          sourceReferences: [{ sessionId: "eval", messageId: source.id }],
          createdAt: "2026-01-01T00:00:00.000Z",
          importance: 0.4,
          confidence: 0.6,
          sourceType: "tool_observation",
          status: "active",
        });
      }
      const intelligence = new MemoryIntelligenceService({
        memories: service,
        now: () => new Date("2026-01-02T00:00:00.000Z"),
        policy: { staleAfterDays: { semantic: 10_000, episodic: 10_000, decision: 10_000, preference: 10_000, entity: 10_000 } },
      });
      const report = await intelligence.runMaintenance({ enableAbstraction: false });
      expect(report.scanned).toBe(10_000);
      expect(report.staleMarked).toBe(0);
      expect(report.groupsConsidered).toBe(10_000);
      expect(report.durationMs).toBeLessThan(15_000);
      console.log(JSON.stringify({ scanned: report.scanned, durationMs: report.durationMs, groups: report.groupsConsidered }));
    } finally {
      memories.close();
      history.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
