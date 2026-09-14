import { describe, expect, it } from "vitest";
import {
  EventBus,
  FaultInjectionController,
  ReliabilityInjectedFailure,
  SeededRandom,
  SyntheticConversationGenerator,
  assertReliabilityInvariants,
  type HarnessEventMap,
} from "./index.js";

describe("Phase 12 reliability primitives", () => {
  it("generates deterministic, replayable synthetic conversations", () => {
    const options = {
      seed: "replay-seed",
      sessionId: "session-replay",
      facts: [{ turn: 37, key: "database", value: "SQLite" }, { turn: 581, key: "database", value: "PostgreSQL" }],
      needleTurns: [83, 581],
    } as const;
    const first = new SyntheticConversationGenerator(options).generate(700);
    const second = new SyntheticConversationGenerator(options).generate(700);
    expect(second).toEqual(first);
    expect(first.messages).toHaveLength(1_400);
    expect(new Set(first.messages.map((message) => message.id)).size).toBe(first.messages.length);
    expect(first.messages[164]?.content).toContain("needle=");
    expect(first.messages[72]?.content).toContain("fact.database=SQLite");
    expect(first.messages[1_160]?.content).toContain("fact.database=PostgreSQL");
  });

  it("provides deterministic seeded randomness and explicit fault schedules", async () => {
    const left = new SeededRandom("fixture");
    const right = new SeededRandom("fixture");
    expect(Array.from({ length: 20 }, () => left.next())).toEqual(Array.from({ length: 20 }, () => right.next()));

    const faults = new FaultInjectionController();
    faults.arm({ operation: "write", failAt: 2 });
    await expect(faults.run("write", async () => "first")).resolves.toBe("first");
    await expect(faults.run("write", async () => "second")).rejects.toBeInstanceOf(ReliabilityInjectedFailure);
    expect(faults.count("write")).toBe(2);
    faults.clear("write");
    await expect(faults.run("write", async () => "recovered")).resolves.toBe("recovered");

    faults.arm({ operation: "decode", failAt: 1, mode: "malformed" });
    await expect(faults.run("decode", async () => ({ ok: true }))).resolves.toBeUndefined();
  });

  it("isolates event subscriber failures from core event delivery", async () => {
    const events = new EventBus<HarnessEventMap>();
    const seen: string[] = [];
    events.on("ptc.started", () => { throw new Error("subscriber failed"); });
    events.on("ptc.started", (event) => { seen.push(event.executionId); });
    await expect(events.emit("ptc.started", { executionId: "exec-1", sessionId: "s", agentId: "a" })).resolves.toBeUndefined();
    expect(seen).toEqual(["exec-1"]);
  });

  it("keeps reliability invariants composable for callers", async () => {
    await expect(assertReliabilityInvariants({})).resolves.toBeUndefined();
  });
});
