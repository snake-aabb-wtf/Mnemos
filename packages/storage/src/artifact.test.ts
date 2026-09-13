import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactBodyMissingError,
  ArtifactIntegrityError,
  ArtifactQueryUnsupportedError,
  ArtifactSpillService,
  ContextManager,
} from "@mnemos/core";
import { SqliteArtifactStore } from "./artifact.js";

const directories: string[] = [];
const stores: SqliteArtifactStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function artifactStore(): Promise<{ store: SqliteArtifactStore; directory: string; bodyDirectory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "mnemos-artifacts-"));
  const bodyDirectory = join(directory, "bodies");
  const store = new SqliteArtifactStore({ databasePath: join(directory, "runtime.sqlite"), storageDirectory: bodyDirectory });
  directories.push(directory);
  stores.push(store);
  return { store, directory, bodyDirectory };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function* chunks(totalBytes: number, chunkBytes = 128 * 1024): AsyncIterable<Uint8Array> {
  let remaining = totalBytes;
  while (remaining > 0) {
    const size = Math.min(chunkBytes, remaining);
    yield Buffer.alloc(size, 0x61);
    remaining -= size;
  }
}

describe("SqliteArtifactStore", () => {
  it("stores metadata separately, supports range reads, and exposes only a bounded handle to Context", async () => {
    const { store, bodyDirectory } = await artifactStore();
    const record = await store.create({
      sessionId: "session-a",
      type: "tool-result",
      mimeType: "text/plain",
      displayName: "../../not-a-filename.txt",
      summary: "A small searchable output.",
      metadata: { source: "test" },
      content: "first line\nneedle: exact evidence\nlast line",
    });

    expect(record.scope).toBe("session");
    expect(record.storageLocation).toMatch(/^[0-9a-f-]+\.blob$/);
    expect(record.storageLocation).not.toContain("not-a-filename");
    expect(await store.get(record.id)).toMatchObject({ id: record.id, metadata: { source: "test" } });
    expect(text(await store.read(record.id, { offset: 11, length: 6 }))).toBe("needle");
    expect(await store.verify(record.id)).toBe(true);
    expect(await store.query(record.id, { query: "exact" })).toEqual([
      expect.objectContaining({ artifactId: record.id, lineNumber: 2, snippet: expect.stringContaining("exact") }),
    ]);

    const spill = new ArtifactSpillService(store, { maxInlineBytes: 8, spillThresholdBytes: 16 });
    const result = await spill.spill({
      sessionId: "session-a",
      type: "tool-result",
      mimeType: "text/plain",
      summary: record.summary,
      content: "this value is too large to be inline",
    });
    expect(result.kind).toBe("artifact");
    if (result.kind !== "artifact") throw new Error("expected artifact result");

    const context = new ContextManager().buildVisible("session-a", [], "", [result.handle]);
    expect(context.artifactHandles).toEqual([result.handle]);
    expect(context.stats.artifactHandleTokens).toBeGreaterThan(0);
    expect(context.stats.recentRawTokens).toBe(0);
    expect(await readdir(bodyDirectory)).toContain(record.storageLocation);
  });

  it("keeps small text inline but spills binary and streaming content without converting it into context text", async () => {
    const { store } = await artifactStore();
    const spill = new ArtifactSpillService(store, { maxInlineBytes: 64, spillThresholdBytes: 128 });

    await expect(spill.spill({ sessionId: "s", type: "tool-result", mimeType: "text/plain", content: "short" })).resolves.toEqual({
      kind: "inline",
      content: "short",
      sizeBytes: 5,
    });
    const binary = await spill.spill({ sessionId: "s", type: "tool-result", mimeType: "application/octet-stream", content: new Uint8Array([0, 1, 2]) });
    expect(binary.kind).toBe("artifact");
    const streamed = await spill.spill({
      sessionId: "s",
      type: "tool-result",
      mimeType: "application/octet-stream",
      content: chunks(1_048_576),
    });
    expect(streamed.kind).toBe("artifact");
    if (streamed.kind !== "artifact") throw new Error("expected streamed artifact");
    expect((await store.get(streamed.handle.id))?.sizeBytes).toBe(1_048_576);
  });

  it("handles a 10MB+ streamed tool result while the visible Context accounts for only its handle", async () => {
    const { store } = await artifactStore();
    const totalBytes = 10 * 1024 * 1024 + 1;
    const spill = new ArtifactSpillService(store, { maxInlineBytes: 1024, spillThresholdBytes: 2048 });
    const spilled = await spill.spill({
      sessionId: "large-session",
      type: "tool-result",
      mimeType: "text/plain",
      summary: "10MB streaming result",
      content: chunks(totalBytes),
    });
    expect(spilled.kind).toBe("artifact");
    if (spilled.kind !== "artifact") throw new Error("expected Artifact");
    expect((await store.get(spilled.handle.id))?.sizeBytes).toBe(totalBytes);
    expect(await store.query(spilled.handle.id, { query: "aaaa", maxMatches: 1 })).toHaveLength(1);

    const context = new ContextManager().buildVisible("large-session", [], "", [spilled.handle]);
    expect(context.stats.artifactHandleTokens).toBeLessThan(200);
    expect(context.stats.usedTokens).toBe(context.stats.artifactHandleTokens);
    expect(await store.read(spilled.handle.id, { offset: totalBytes - 3, length: 16 })).toHaveLength(3);
  }, 30_000);

  it("rejects binary queries and detects integrity violations without confusing metadata retrieval", async () => {
    const { store, bodyDirectory } = await artifactStore();
    const binary = await store.create({
      sessionId: "s",
      type: "tool-result",
      mimeType: "application/octet-stream",
      content: new Uint8Array([0, 1, 2, 3]),
    });
    await expect(store.query(binary.id, { query: "1" })).rejects.toBeInstanceOf(ArtifactQueryUnsupportedError);
    expect([...await store.read(binary.id)]).toEqual([0, 1, 2, 3]);
    await writeFile(join(bodyDirectory, binary.storageLocation), randomBytes(4));
    await expect(store.read(binary.id)).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(store.verify(binary.id)).rejects.toBeInstanceOf(ArtifactIntegrityError);
    expect((await store.get(binary.id))?.id).toBe(binary.id);
  });

  it("finds text whose query crosses a derived index chunk boundary", async () => {
    const { store } = await artifactStore();
    const record = await store.create({
      sessionId: "s",
      type: "large-single-line",
      mimeType: "text/plain",
      content: `${"a".repeat(8_190)}boundary-needle`,
    });
    const matches = await store.query(record.id, { query: "boundary-needle" });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ byteOffset: 8_190, snippet: expect.stringContaining("boundary-needle") });
  });

  it("persists records and text indexes across restart, reports a missing body, and recovers unreferenced bodies", async () => {
    const { store, directory, bodyDirectory } = await artifactStore();
    const record = await store.create({
      scope: "persistent",
      type: "report",
      mimeType: "text/plain",
      content: "persisted line\nneedle after restart",
    });
    expect(await store.rebuildTextIndex(record.id)).toBeGreaterThan(0);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const restarted = new SqliteArtifactStore({ databasePath: join(directory, "runtime.sqlite"), storageDirectory: bodyDirectory });
    stores.push(restarted);
    expect((await restarted.get(record.id))?.scope).toBe("persistent");
    expect(await restarted.query(record.id, { query: "needle" })).toHaveLength(1);

    await writeFile(join(bodyDirectory, "unreferenced.blob"), "orphan");
    await unlink(join(bodyDirectory, record.storageLocation));
    expect(await restarted.get(record.id)).toBeDefined();
    await expect(restarted.read(record.id)).rejects.toBeInstanceOf(ArtifactBodyMissingError);
    await expect(restarted.recoverOrphans()).resolves.toEqual({
      deletedOrphanLocations: ["unreferenced.blob"],
      missingBodyIds: [record.id],
    });
    expect(await restarted.delete(record.id)).toBe(true);
    expect(await restarted.delete(record.id)).toBe(false);
  });

  it("cleans up expired records idempotently and leaves failed stream writes without a published body", async () => {
    const { store, bodyDirectory } = await artifactStore();
    const expired = await store.create({
      sessionId: "s",
      type: "temporary-result",
      mimeType: "text/plain",
      expiresAt: "2020-01-01T00:00:00.000Z",
      content: "expire me",
    });
    expect(await store.cleanupExpired(new Date("2026-01-01T00:00:00.000Z"))).toEqual([expired.id]);
    expect(await store.get(expired.id)).toBeUndefined();
    expect(await store.cleanupExpired(new Date("2026-01-01T00:00:00.000Z"))).toEqual([]);

    async function* failingStream(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      throw new Error("simulated stream failure");
    }
    await expect(store.create({ sessionId: "s", type: "broken", mimeType: "application/octet-stream", content: failingStream() }))
      .rejects.toThrow("simulated stream failure");
    await expect(store.create({
      sessionId: "s",
      type: "metadata-serialization-failure",
      mimeType: "application/octet-stream",
      metadata: { unsupported: BigInt(1) },
      content: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow();
    expect((await readdir(bodyDirectory)).filter((name) => name.endsWith(".blob"))).toEqual([]);
  });
});
