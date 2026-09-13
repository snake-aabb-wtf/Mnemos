#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CompactionService, ContextManager, Harness, MockModelProvider } from "@mnemos/core";
import { SqliteContextCompactionStore, SqliteHistoryStore, SqliteStateStore } from "@mnemos/storage";

const databasePath = process.env.MNEMOS_DB_PATH ?? "./mnemos.sqlite";
const sessionId = process.env.MNEMOS_SESSION_ID ?? "default";
const history = new SqliteHistoryStore(databasePath);
const state = new SqliteStateStore(databasePath);
const compactionCheckpoints = new SqliteContextCompactionStore(databasePath);
const context = new ContextManager();
const harness = new Harness({
  history,
  state,
  context,
  compaction: new CompactionService({ history, checkpoints: compactionCheckpoints, context }),
  provider: new MockModelProvider(({ input }) => ({ content: `Mock: ${input}` })),
});

const readline = createInterface({ input, output, terminal: true });
console.log("Mnemos Phase 1 chat (mock provider). Type /exit to quit.");
try {
  readline.setPrompt("> ");
  readline.prompt();
  for await (const line of readline) {
    if (line.trim() === "/exit") break;
    if (line.trim() !== "") {
      const reply = await harness.send(sessionId, line);
      console.log(reply.content);
    }
    readline.prompt();
  }
} finally {
  readline.close();
  history.close();
  state.close();
  compactionCheckpoints.close();
}
