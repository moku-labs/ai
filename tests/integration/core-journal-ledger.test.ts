/**
 * @file Batch 1 — core journal ledger integration scenarios (S01–S05).
 *
 * Exercises the journal run/item state machine and the store CAS through the
 * REAL framework composition (all regular plugins + probe fixture), against a
 * per-test tmp-dir journal.db / store dir. No network, no `.moku/` in the repo.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ItemIntent } from "../../src/plugins/journal/types";
import { buildFramework } from "./helpers";

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
    ...overrides
  };
}

describe("core journal ledger integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // S01 — journal run/item state machine survives app restart
  // ---------------------------------------------------------------------------

  it("S01: run/item state machine survives an app restart on the same journal.db", async () => {
    const first = buildFramework(tempDir).createApp();
    await first.start();
    const journal = first.probe.journal;

    // Open a run and plan two items.
    const run = journal.openRun({ glob: "voice/*.yaml" });
    const [item1, item2] = journal.insertItems(run.id, [intent("pk-1"), intent("pk-2")]);
    if (!item1 || !item2) {
      throw new Error("expected both items to be inserted");
    }

    // Drive item1 through the full happy path: gate → attempt → commit.
    expect(journal.gateToDispatching(item1.id)).toEqual({ ok: true });
    const [dispatching] = journal.listItems(run.id, { status: "dispatching" });
    expect(dispatching?.id).toBe(item1.id);

    const attemptId = journal.recordAttempt(item1.id, {
      provider: "elevenlabs",
      account: "default",
      startedAt: Date.now()
    });
    journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome: "done", costUsd: 0.1 });
    journal.commitDone(item1.id, {
      actualCostUsd: 0.1,
      artifactKey: "voice/hello.mp3",
      contentHash: "hash-1"
    });

    // Ledger totals before shutdown.
    expect(journal.totals(run.id)).toMatchObject({
      total: 2,
      done: 1,
      queued: 1,
      spendUsd: 0.1
    });
    await first.stop();

    // Restart: a SECOND framework/app on the SAME journal.db path.
    const second = buildFramework(tempDir).createApp();
    await second.start();
    const reopened = second.probe.journal;

    // The run row and both item rows survived the restart byte-for-byte.
    expect(reopened.getRun(run.id)).toMatchObject({
      id: run.id,
      glob: "voice/*.yaml",
      status: "active"
    });
    const items = reopened.listItems(run.id);
    expect(items).toHaveLength(2);
    const persisted1 = items.find(row => row.id === item1.id);
    const persisted2 = items.find(row => row.id === item2.id);
    expect(persisted1).toMatchObject({
      status: "done",
      actualCostUsd: 0.1,
      artifactKey: "voice/hello.mp3",
      contentHash: "hash-1"
    });
    expect(persisted2).toMatchObject({ status: "queued" });

    await second.stop();
  });

  // ---------------------------------------------------------------------------
  // S02 — atomic gate: budget refusal
  // ---------------------------------------------------------------------------

  it("S02: gate refuses the third item once projected spend would exceed maxCostUsd", async () => {
    const app = buildFramework(tempDir).createApp();
    await app.start();
    const journal = app.probe.journal;

    // A capped run with three 0.1-estimate items.
    const run = journal.openRun({ glob: "voice/*.yaml", maxCostUsd: 0.25 });
    const [item1, item2, item3] = journal.insertItems(run.id, [
      intent("pk-1"),
      intent("pk-2"),
      intent("pk-3")
    ]);
    if (!item1 || !item2 || !item3) {
      throw new Error("expected all three items to be inserted");
    }

    // Items 1 and 2 are admitted and committed at 0.1 each.
    expect(journal.gateToDispatching(item1.id)).toEqual({ ok: true });
    journal.commitDone(item1.id, { actualCostUsd: 0.1, artifactKey: "a1", contentHash: "h1" });
    expect(journal.gateToDispatching(item2.id)).toEqual({ ok: true });
    journal.commitDone(item2.id, { actualCostUsd: 0.1, artifactKey: "a2", contentHash: "h2" });

    // Item 3 is refused: 0.2 spent + 0.1 estimate > 0.25 cap.
    expect(journal.gateToDispatching(item3.id)).toEqual({ ok: false, reason: "budget" });
    const [stillQueued] = journal.listItems(run.id, { status: "queued" });
    expect(stillQueued?.id).toBe(item3.id);
    expect(journal.totals(run.id).spendUsd).toBe(0.2);

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S03 — atomic gate: duplicate admission + planning-key dedup semantics
  //
  // Verified in src/plugins/journal/api.ts: the "duplicate" reason fires when
  // an item is gated while no longer `queued` (a duplicate ADMISSION attempt),
  // and insertItems dedups by (run_id, planning_key) — i.e. planning-key dedup
  // is RUN-SCOPED (idempotent resume path), not cross-run: a second run with
  // the same planningKey+packVersion gets a fresh queued row.
  // ---------------------------------------------------------------------------

  it("S03: duplicate gate on a non-queued item + run-scoped planning-key dedup", async () => {
    const app = buildFramework(tempDir).createApp();
    await app.start();
    const journal = app.probe.journal;
    const shared = intent("pk-shared", { packVersion: "v1" });

    // Run A: full happy path on the shared planning key.
    const runA = journal.openRun({ glob: "voice/*.yaml" });
    const [itemA] = journal.insertItems(runA.id, [shared]);
    if (!itemA) {
      throw new Error("expected the run A item to be inserted");
    }
    expect(journal.gateToDispatching(itemA.id)).toEqual({ ok: true });
    const attemptId = journal.recordAttempt(itemA.id, {
      provider: "elevenlabs",
      account: "default",
      startedAt: Date.now()
    });
    journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome: "done", costUsd: 0.1 });
    journal.commitDone(itemA.id, {
      actualCostUsd: 0.1,
      artifactKey: "voice/shared.mp3",
      contentHash: "hash-shared"
    });

    // A second gate on the same (now done) item is a duplicate admission.
    expect(journal.gateToDispatching(itemA.id)).toEqual({ ok: false, reason: "duplicate" });

    // Re-inserting the same planning key into run A is the idempotent resume
    // path: the SAME row comes back, artifact identity intact.
    const [reinserted] = journal.insertItems(runA.id, [shared]);
    expect(reinserted).toMatchObject({
      id: itemA.id,
      status: "done",
      artifactKey: "voice/shared.mp3",
      contentHash: "hash-shared"
    });

    // Run B: the same planningKey+packVersion produces a FRESH queued row —
    // dedup is scoped per run, so the gate admits it (no cross-run duplicate).
    const runB = journal.openRun({ glob: "voice/*.yaml" });
    const [itemB] = journal.insertItems(runB.id, [shared]);
    if (!itemB) {
      throw new Error("expected the run B item to be inserted");
    }
    expect(itemB.id).not.toBe(itemA.id);
    expect(itemB.status).toBe("queued");
    expect(journal.gateToDispatching(itemB.id)).toEqual({ ok: true });

    // Run B has spent nothing — run A's commit never leaks across runs.
    expect(journal.totals(runB.id).spendUsd).toBe(0);

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S04 — requeueDispatching + latestResumableRun + readSnapshot
  // ---------------------------------------------------------------------------

  it("S04: requeues in-flight items, finds the resumable run, and snapshots state", async () => {
    const app = buildFramework(tempDir).createApp();
    await app.start();
    const journal = app.probe.journal;

    // Three items; two admitted, one of those committed done.
    const run = journal.openRun({ glob: "voice/*.yaml" });
    const [item1, item2, item3] = journal.insertItems(run.id, [
      intent("pk-1"),
      intent("pk-2"),
      intent("pk-3")
    ]);
    if (!item1 || !item2 || !item3) {
      throw new Error("expected all three items to be inserted");
    }
    expect(journal.gateToDispatching(item1.id)).toEqual({ ok: true });
    expect(journal.gateToDispatching(item2.id)).toEqual({ ok: true });
    journal.commitDone(item1.id, { actualCostUsd: 0.1, artifactKey: "a1", contentHash: "h1" });

    // Pause and requeue: only item2 was still dispatching.
    journal.setRunStatus(run.id, "paused");
    expect(journal.requeueDispatching(run.id)).toBe(1);
    const requeued = journal
      .listItems(run.id, { status: "queued" })
      .find(row => row.id === item2.id);
    expect(requeued?.status).toBe("queued");

    // The paused run is the latest resumable one.
    expect(journal.latestResumableRun()?.id).toBe(run.id);

    // Snapshot: run row + all three items with statuses done/queued/queued.
    const snapshot = journal.readSnapshot(run.id);
    expect(snapshot.run).toMatchObject({ id: run.id, status: "paused" });
    expect(snapshot.totals).toMatchObject({ total: 3, done: 1, queued: 2, dispatching: 0 });
    const statusById = new Map(snapshot.recentItems.map(row => [row.id, row.status]));
    expect(statusById.get(item1.id)).toBe("done");
    expect(statusById.get(item2.id)).toBe("queued");
    expect(statusById.get(item3.id)).toBe("queued");

    // Unknown run ids resolve to undefined, not an error.
    expect(journal.getRun("00000000-0000-0000-0000-000000000000")).toBeUndefined();

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S05 — store CAS round-trip + first-committer-wins
  // ---------------------------------------------------------------------------

  it("S05: store CAS round-trips bytes and dedups the second put of identical content", async () => {
    const app = buildFramework(tempDir).createApp();
    await app.start();
    const store = app.probe.store;
    const bytesA = new TextEncoder().encode("store-round-trip-payload");

    // First put lands the object.
    const first = await store.put(bytesA);
    expect(first.existed).toBe(false);
    expect(await store.has(first.hash)).toBe(true);

    // Read re-verifies the hash and returns identical bytes.
    expect(await store.read(first.hash)).toEqual(bytesA);

    // Planning-time hash matches the committed hash; path is absolute and
    // under the tempDir-pinned store root.
    expect(store.hashOf(bytesA)).toBe(first.hash);
    const objectPath = store.pathOf(first.hash);
    expect(path.isAbsolute(objectPath)).toBe(true);
    expect(objectPath.startsWith(path.join(tempDir, "store"))).toBe(true);

    // Second put of identical content: first-committer-wins, no error.
    const second = await store.put(bytesA);
    expect(second).toEqual({ hash: first.hash, path: first.path, existed: true });

    await app.stop();
  });
});
