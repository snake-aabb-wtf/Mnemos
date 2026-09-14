#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CompactionService, ContextManager, Harness, MockModelProvider, resolveRuntimeConfig } from "@mnemos/core";
import { SqliteContextCompactionStore, SqliteEntityGraphStore, SqliteHistoryStore, SqliteMemoryStore, SqliteStateStore, SqliteMigrationRunner, runDoctor, storageDiagnostics } from "@mnemos/storage";

const config = resolveRuntimeConfig();
const databasePath = config.storage.databasePath;
const artifactDirectory = config.storage.artifactDirectory;
const sessionId = process.env.MNEMOS_SESSION_ID ?? "default";

async function operationalCommand(command: string): Promise<boolean> {
  if (command === "doctor") {
    console.log(JSON.stringify(await runDoctor({ databasePath, artifactDirectory }), null, 2));
    return true;
  }
  if (command === "migrate") {
    const migrations = new SqliteMigrationRunner(databasePath);
    try {
      const version = migrations.run([{ version: 1, name: "runtime-metadata", up: (db) => { db.exec("CREATE TABLE IF NOT EXISTS mnemos_runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); } }]);
      console.log(JSON.stringify({ status: "OK", schemaVersion: version }));
    } finally { migrations.close(); }
    return true;
  }
  if (command === "rebuild-indexes") {
    const history = new SqliteHistoryStore(databasePath);
    const store = new SqliteMemoryStore(databasePath);
    const graph = new SqliteEntityGraphStore(databasePath);
    try {
      await graph.clear();
      for (const memory of await store.list({ limit: 20_000 })) await graph.upsertMemory(memory);
      console.log(JSON.stringify({ status: "OK", entityGraph: "rebuilt", memoryVectors: "unchanged; requires an EmbeddingProvider" }));
    } finally { graph.close(); store.close(); history.close(); }
    return true;
  }
  if (command === "diagnostics") {
    console.log(JSON.stringify(await storageDiagnostics({ databasePath, artifactDirectory }), null, 2));
    return true;
  }
  return false;
}

if (await operationalCommand(process.argv[2] ?? "")) process.exit(0);

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
console.log("Mnemos mock chat. Type /exit to quit.");
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
