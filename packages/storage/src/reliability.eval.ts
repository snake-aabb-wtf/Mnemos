import { describe, expect, it } from "vitest";
import { runReliabilityCampaign } from "./reliability-campaign.js";

describe("Phase 12 reliability evaluation", () => {
  it("runs the deterministic 1k-turn campaign and reports bounded metrics", async () => {
    const metrics = await runReliabilityCampaign(1_000);
    console.log(`phase12 reliability metrics ${JSON.stringify(metrics)}`);
    expect(metrics.historyMessages).toBe(2_000);
    expect(metrics.compactions).toBeGreaterThan(0);
    expect(metrics.peakContextTokens).toBeLessThanOrEqual(128_000);
    expect(metrics.evictedMessages).toBeGreaterThan(0);
  }, 60_000);
});
