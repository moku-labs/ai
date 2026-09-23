/**
 * @file Batch 6 — cross-plugin store ↔ journal artifact integrity (S22–S24).
 *
 * Runs real build files through the REAL framework composition and verifies
 * the referential integrity between journal rows and CAS objects: every done
 * item's contentHash resolves to hash-stable bytes (S22), identical outputs
 * dedup to a single CAS object while billing stays per-item (S23), and a WAL
 * checkpoint + reopen preserves the run snapshot byte-for-byte (S24).
 */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ItemIntent, RunSnapshot } from "../../src/plugins/journal/types";
import {
  buildFileYaml,
  buildFramework,
  createFakeHandler,
  createFakeProviderPlugin
} from "./helpers";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Builds an `ItemIntent` around a planning key, with per-test overrides. */
function intent(planningKey: string, overrides: Partial<ItemIntent> = {}): ItemIntent {
  return {
    planningKey,
    buildFile: "voice.build.yaml",
    task: "voiceover",
    provider: "elevenlabs",
    // eslint-disable-next-line unicorn/no-null -- ItemIntent.packVersion is typed `string | null`, matching the nullable SQL column
    packVersion: null,
    estimatedCostUsd: 0.1,
    label: planningKey,
    buildName: "voice",
    artifactKey: `ak-${planningKey}`,
    ...overrides
  };
}

/** Lists every committed CAS object file under `storeDir` (tmp files excluded). */
async function listCasObjectFiles(storeDir: string): Promise<string[]> {
  const entries = await readdir(storeDir, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && !entry.name.startsWith(".tmp-"))
    .map(entry => entry.name);
}

/** Normalizes a snapshot for order-independent comparison of recentItems. */
function normalizeSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {
    ...snapshot,
    recentItems: snapshot.recentItems.toSorted((a, b) => a.id.localeCompare(b.id))
  };
}

describe("cross-plugin store/journal artifact integrity", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // S22 — journal ↔ store referential integrity after a run
  // ---------------------------------------------------------------------------

  it("S22: every done item's contentHash resolves to hash-stable bytes in the CAS", async () => {
    // Default body is attempt-numbered, so the two items get DISTINCT bytes.
    const handler = createFakeHandler({ costUsd: 0.05 });
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fake-voice", "voiceover", "fake", handler)]
    }).createApp();
    await app.start();

    // Two items, distinct inputs → distinct planning keys and bodies.
    await writeFile(
      path.join(tempDir, "voice.moku.yaml"),
      buildFileYaml("voice", [
        { task: "voiceover", provider: "fake", input: { text: "line-one" } },
        { task: "voiceover", provider: "fake", input: { text: "line-two" } }
      ])
    );
    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    expect(result.status).toBe("done");

    // Every done row's artifact identity is real, readable, and re-hashable.
    const doneRows = app.probe.journal.listItems(result.runId, { status: "done" });
    expect(doneRows).toHaveLength(2);
    const store = app.probe.store;
    const seenHashes = new Set<string>();

    for (const row of doneRows) {
      if (!row.contentHash || !row.artifactKey) {
        throw new Error(`expected done item ${row.id} to carry contentHash + artifactKey`);
      }

      // The CAS holds the object, and its bytes re-hash to the journaled hash.
      expect(await store.has(row.contentHash)).toBe(true);
      const bytes = await store.read(row.contentHash);
      expect(store.hashOf(bytes)).toBe(row.contentHash);

      // artifact_key is the runner's identity digest over {task, provider,
      // packVersion, keyed input, params}, written at planning — NOT the store
      // path; the store path is derived from contentHash alone (shard = first
      // two hex chars).
      expect(row.artifactKey).toMatch(SHA256_HEX);
      expect(row.artifactKey).not.toBe(row.planningKey);
      expect(store.pathOf(row.contentHash)).toBe(
        path.join(tempDir, "store", row.contentHash.slice(0, 2), row.contentHash)
      );
      seenHashes.add(row.contentHash);
    }

    // Distinct bodies landed as distinct CAS objects.
    expect(seenHashes.size).toBe(2);
    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S23 — identical outputs dedup in the CAS (content-level only)
  // ---------------------------------------------------------------------------

  it("S23: identical outputs share ONE CAS object while both items bill separately", async () => {
    // Fixed body: both executions produce byte-identical artifacts.
    const identicalBytes = new TextEncoder().encode("identical-artifact-bytes");
    const handler = createFakeHandler({ costUsd: 0.1, body: () => identicalBytes });
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fake-voice", "voiceover", "fake", handler)]
    }).createApp();
    await app.start();

    // Distinct inputs → distinct planning keys, so BOTH items execute.
    await writeFile(
      path.join(tempDir, "voice.moku.yaml"),
      buildFileYaml("voice", [
        { task: "voiceover", provider: "fake", input: { text: "first-input" } },
        { task: "voiceover", provider: "fake", input: { text: "second-input" } }
      ])
    );
    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    expect(result.status).toBe("done");

    // Two done journal rows, each billed — dedup is CONTENT-level only.
    const doneRows = app.probe.journal.listItems(result.runId, { status: "done" });
    expect(doneRows).toHaveLength(2);
    expect(app.probe.journal.totals(result.runId).spendUsd).toBeCloseTo(0.2, 10);

    // Both rows point at the SAME content hash.
    const [rowA, rowB] = doneRows;
    if (!rowA?.contentHash || !rowB?.contentHash) {
      throw new Error("expected both done items to carry a contentHash");
    }
    expect(rowA.contentHash).toBe(rowB.contentHash);
    expect(rowA.contentHash).toBe(app.probe.store.hashOf(identicalBytes));
    expect(rowA.planningKey).not.toBe(rowB.planningKey);

    // Exactly ONE object file exists in the CAS (first-committer-wins).
    const objectFiles = await listCasObjectFiles(path.join(tempDir, "store"));
    expect(objectFiles).toEqual([rowA.contentHash]);

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S24 — WAL checkpoint + reopen fidelity
  // ---------------------------------------------------------------------------

  it("S24: run snapshot survives a manual WAL checkpoint and a framework reopen", async () => {
    const first = buildFramework(tempDir).createApp();
    await first.start();
    const journal = first.probe.journal;

    // Drive a run to mixed state via the journal API: 1 done, 1 queued.
    const run = journal.openRun({ glob: "voice/*.yaml" });
    const [item1, item2] = journal.insertItems(run.id, [intent("pk-1"), intent("pk-2")]);
    if (!item1 || !item2) {
      throw new Error("expected both items to be inserted");
    }
    expect(journal.gateToDispatching(item1.id)).toEqual({ ok: true });
    journal.commitDone(item1.id, {
      actualCostUsd: 0.1,
      artifactKey: "artifact-key-1",
      contentHash: "content-hash-1"
    });

    // WAL mode is active: the -wal file sits next to journal.db while the
    // app lives, and survives a manual wal_checkpoint(TRUNCATE).
    expect(existsSync(path.join(tempDir, "journal.db-wal"))).toBe(true);
    journal.checkpoint();
    expect(existsSync(path.join(tempDir, "journal.db-wal"))).toBe(true);

    const beforeReopen = journal.readSnapshot(run.id);
    expect(beforeReopen.totals).toMatchObject({ total: 2, done: 1, queued: 1 });
    await first.stop();

    // Reopen: a SECOND framework on the SAME journal.db sees the identical snapshot.
    const second = buildFramework(tempDir).createApp();
    await second.start();
    const afterReopen = second.probe.journal.readSnapshot(run.id);
    expect(normalizeSnapshot(afterReopen)).toEqual(normalizeSnapshot(beforeReopen));

    await second.stop();
  });
});
