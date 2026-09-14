import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompactionService,
  ContextManager,
  InMemoryContextCompactionStore,
  SyntheticConversationGenerator,
  assertReliabilityInvariants,
  percentile,
} from "@mnemos/core";
import { SqliteHistoryStore } from "./sqlite.js";

export async function runReliabilityCampaign(turns: number) {
  const directory = await mkdtemp(join(tmpdir(), "mnemos-reliability-eval-"));
  const path = join(directory, "runtime.sqlite");
  const sessionId = `eval-${turns}`;
  const history = new SqliteHistoryStore(path);
  const context = new ContextManager(undefined, {
    // The fixture uses compact structured messages. A smaller deterministic
    // budget creates real pressure without generating megabytes of filler;
    // the invariant still proves the configured limit is never exceeded.
    contextLimit: 8_000,
    generationReserveTokens: 1_000,
    recentRawTokenBudget: 2_000,
    pinnedTokenBudget: 1_000,
    agentPinnedTokenBudget: 500,
  });
  const compaction = new CompactionService({ history, checkpoints: new InMemoryContextCompactionStore(), context });
  const workload = new SyntheticConversationGenerator({
    seed: `phase12-${turns}`,
    sessionId,
    needleTurns: [83, Math.min(1_003, turns), Math.min(4_938, turns)],
    facts: [
      { turn: Math.min(37, turns), key: "database", value: "SQLite" },
      { turn: Math.min(581, turns), key: "database", value: "PostgreSQL" },
    ],
  }).generate(turns);
  try {
    const latency: number[] = [];
    let compactions = 0;
    let evictedMessages = 0;
    let peakContext = 0;
    const started = Date.now();
    for (let index = 0; index < workload.messages.length; index += 1) {
      await history.append(workload.messages[index]!);
      if (index % 200 === 199 || index === workload.messages.length - 1) {
        const t0 = Date.now();
        const prepared = await compaction.prepare(sessionId);
        latency.push(Date.now() - t0);
        compactions += prepared.evictions.length;
        evictedMessages += prepared.evictions.reduce((sum, event) => sum + event.evictedMessageIds.length, 0);
        peakContext = Math.max(peakContext, prepared.context.stats.usedTokens);
        await assertReliabilityInvariants({ sessionId, history, contexts: [prepared.context] });
      }
    }
    return {
      turns,
      historyMessages: (await history.list(sessionId)).length,
      compactions,
      evictedMessages,
      peakContextTokens: peakContext,
      p50CompactionMs: percentile(latency, 0.5),
      p95CompactionMs: percentile(latency, 0.95),
      durationMs: Date.now() - started,
      deterministicNeedles: workload.needles.length,
    };
  } finally {
    history.close();
    await rm(directory, { recursive: true, force: true });
  }
}
