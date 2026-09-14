import { describe, expect, it } from "vitest";
import { runReliabilityCampaign } from "./reliability-campaign.js";

describe("Phase 12 10k-turn soak evaluation", () => {
  it("keeps a long deterministic workload bounded", async () => {
    const metrics = await runReliabilityCampaign(10_000);
    console.log(`phase12 soak metrics ${JSON.stringify(metrics)}`);
    expect(metrics.historyMessages).toBe(20_000);
    expect(metrics.compactions).toBeGreaterThan(0);
    expect(metrics.peakContextTokens).toBeLessThanOrEqual(128_000);
  }, 180_000);
});
